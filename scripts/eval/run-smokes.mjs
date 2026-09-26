#!/usr/bin/env node
// Runs every evaluation smoke suite (files named smoke*.mjs anywhere under scripts/eval), in
// sorted path order, so new suites join the release gate without editing it. Fails fast.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(root, '..', '..');
const TIMEOUT_MS = 900_000;
const SUITE = /^smoke.*\.mjs$/;

function findSuites(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : findSuites(path);
    return entry.isFile() && SUITE.test(entry.name) ? [path] : [];
  });
}

const display = path => relative(repoRoot, path).split(sep).join('/');
const suites = findSuites(root).sort((a, b) => {
  const [left, right] = [display(a), display(b)];
  return left < right ? -1 : left > right ? 1 : 0;
});
if (!suites.length) {
  console.error('FAIL  no evaluation smoke suites found under scripts/eval');
  process.exit(1);
}
for (const suite of suites) {
  const result = spawnSync(process.execPath, [suite], { cwd: repoRoot, stdio: 'inherit', timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
  const reason = result.error?.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 1000} s`
    : result.error ? result.error.message
      : result.signal ? `terminated by ${result.signal}`
        : result.status !== 0 ? `exited with status ${result.status}` : null;
  if (reason) {
    console.error(`FAIL  ${display(suite)} ${reason}`);
    process.exit(1);
  }
}
console.log(`PASS  ${suites.length} evaluation smoke suites`);
