// OS sandbox for the reference adapter's regression replay: hunter-written code runs with
// exactly one writable root. The macOS profile is the argus-launch os-native-target-readonly@3
// profile (smoke-adapter.mjs fails on any drift from argus/bin/argus-launch) with the replay
// root as its single file-write* subpath; Linux uses the same bubblewrap invocation as
// argus-launch. Like the launch sandbox, it confines writes, not reads.
import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const MACOS_SANDBOX = 'macos-sandbox-exec';
export const LINUX_SANDBOX = 'linux-bwrap';
const OUTPUT_DRAIN_MS = 2000;

// Process groups of the sandboxed commands still running, for killActiveSandboxes().
const active = new Set();

function findExecutable(name, searchPath) {
  for (const dir of (searchPath ?? '').split(delimiter)) {
    if (!dir.startsWith('/')) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this PATH entry.
    }
  }
  return null;
}

// {kind, executable, error}: sandbox-exec on macOS, bwrap on Linux, otherwise kind null with
// the reason.
export function detectSandbox({ platform = process.platform, searchPath = process.env.PATH } = {}) {
  if (platform === 'darwin') {
    const executable = findExecutable('sandbox-exec', searchPath) ?? findExecutable('sandbox-exec', '/usr/bin');
    return executable ? { kind: MACOS_SANDBOX, executable, error: null } : { kind: null, executable: null, error: 'sandbox-exec is unavailable' };
  }
  if (platform === 'linux') {
    const executable = findExecutable('bwrap', searchPath);
    return executable ? { kind: LINUX_SANDBOX, executable, error: null } : { kind: null, executable: null, error: 'bubblewrap (bwrap) is unavailable' };
  }
  return { kind: null, executable: null, error: `no supported OS sandbox on ${platform}` };
}

// The escaping argus-launch applies to the writable path inside the profile string.
export const escapeSandboxValue = value => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

// os-native-target-readonly@3 with `writableRoot` (a physical path) as the only writable subpath.
export function macosProfile(writableRoot) {
  return `${[
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow process-info*)',
    '(allow network*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${escapeSandboxValue(writableRoot)}"))`,
    '(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))',
    '(allow mach-register (global-name-regex #"^org\\.chromium\\."))',
    '(allow mach-lookup (global-name-regex #"^org\\.chromium\\."))',
  ].join('\n')}\n`;
}

// {command, args, cleanup} running `argv` in `cwd` with only `writableRoot` writable. The macOS
// profile lives in a private temporary directory outside the writable root until cleanup().
export function sandboxInvocation(sandbox, { writableRoot, cwd, argv }) {
  if (sandbox?.kind === MACOS_SANDBOX) {
    const dir = mkdtempSync(join(tmpdir(), 'argus-replay-sandbox-'));
    const profile = join(dir, 'profile.sb');
    writeFileSync(profile, macosProfile(writableRoot), { mode: 0o600, flag: 'wx' });
    return { command: sandbox.executable, args: ['-f', profile, ...argv], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  if (sandbox?.kind === LINUX_SANDBOX) {
    return {
      command: sandbox.executable,
      args: ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--ro-bind', '/', '/', '--bind', writableRoot, writableRoot,
        '--dev', '/dev', '--proc', '/proc', '--chdir', cwd, ...argv],
      cleanup: () => {},
    };
  }
  throw new Error(sandbox?.error ?? 'no supported OS sandbox');
}

function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process group has already exited.
  }
}

// Kills every sandboxed process group this process started that is still running.
export function killActiveSandboxes() {
  for (const child of active) killGroup(child);
  active.clear();
}

// Runs `argv` inside the sandbox as its own process group with exactly `env`. The group is
// killed after `seconds` (timedOut), and again once the command exits so that no straggler
// survives it. `onOutput`, when given, receives stdout and stderr chunks; otherwise both are
// discarded. Resolves {exitCode, signal, timedOut, spawnError}.
export function runSandboxed(sandbox, { writableRoot, cwd, argv, env, seconds, onOutput = null }) {
  return new Promise(done => {
    let invocation;
    try {
      invocation = sandboxInvocation(sandbox, { writableRoot, cwd, argv });
    } catch (error) {
      done({ exitCode: null, signal: null, timedOut: false, spawnError: error.message });
      return;
    }
    let child = null;
    let timer = null;
    let timedOut = false;
    let settled = false;
    let exit = null;
    const finish = fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      active.delete(child);
      invocation.cleanup();
      done({ ...fields, timedOut });
    };
    const output = onOutput ? 'pipe' : 'ignore';
    try {
      child = spawn(invocation.command, invocation.args, { cwd, env, detached: true, stdio: ['ignore', output, output] });
    } catch (error) {
      finish({ exitCode: null, signal: null, spawnError: error.message });
      return;
    }
    active.add(child);
    if (onOutput) {
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);
    }
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, seconds * 1000);
    child.once('error', error => finish({ exitCode: null, signal: null, spawnError: error.message }));
    // A straggler that inherited stdout or stderr would hold 'close' back: kill the group on
    // exit, and stop waiting for the pipes shortly after (a process that left the group).
    child.once('exit', (code, signal) => {
      exit = { exitCode: code, signal, spawnError: null };
      killGroup(child);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exit);
      }, OUTPUT_DRAIN_MS).unref();
    });
    child.once('close', (code, signal) => finish(exit ?? { exitCode: code, signal, spawnError: null }));
  });
}

const exists = path => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

// Behavior probe: inside the sandbox, writing `deniedPath` (outside `writableRoot`) must fail
// and writing `allowedPath` (inside it) must succeed. Both probe files are removed. Resolves
// {ok, reason}.
export async function probeSandbox(sandbox, { writableRoot, deniedPath, allowedPath, env, seconds = 30 }) {
  const write = path => runSandboxed(sandbox, {
    writableRoot, cwd: writableRoot, env, seconds,
    argv: ['/bin/sh', '-c', 'printf probe >"$1"', 'argus-sandbox-probe', path],
  });
  const denied = await write(deniedPath);
  const escaped = exists(deniedPath);
  if (escaped) rmSync(deniedPath, { force: true });
  if (denied.spawnError) return { ok: false, reason: `the sandbox could not start: ${denied.spawnError}` };
  if (escaped || denied.exitCode === 0) return { ok: false, reason: `the sandbox allowed a write outside ${writableRoot}` };
  const allowed = await write(allowedPath);
  let written = false;
  try {
    written = allowed.exitCode === 0 && readFileSync(allowedPath, 'utf8') === 'probe';
  } catch {
    written = false;
  }
  rmSync(allowedPath, { force: true });
  if (!written) {
    const detail = allowed.spawnError ?? (allowed.timedOut ? `timed out after ${seconds} s` : `exit ${allowed.exitCode ?? allowed.signal}`);
    return { ok: false, reason: `the sandbox blocked a write inside ${writableRoot} (${detail})` };
  }
  return { ok: true, reason: null };
}
