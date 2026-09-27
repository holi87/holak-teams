#!/usr/bin/env node
// Usage: node scripts/eval/discovery/judge.mjs --runs <sealed/private-runs.json> --output <judge-verdicts.json>
//          [--claude <absolute path>] [--passes 2] [--concurrency 2] [--include-suspected true]
//
// First-pass model judge for evaluator-extracted findings (argus-eval/judge-verdicts@1). Every
// finding of a scorable run becomes a packet under <runsDir>/judge-packets/<runId>/: the public
// contract, the run's private seed criteria, the corpus controls, the ledger row, the report and
// up to five cited evidence texts (read only from regular files inside the artifact root), and
// the verdicts already given in that run. Each packet is judged by independent passes of a bare,
// tool-less Claude Code process (Opus, maximum effort) that sees only the packet on stdin, framed
// as untrusted data, and must answer through a per-finding JSON schema whose seedId enum lists
// only that run's truth IDs. A seed credit is then checked with the corpus probe against a fresh
// application (seed confirmation, not independent reproduction).
//
// Verdicts are PROVISIONAL: a human spot-check decides the final verdicts. Cost: every finding
// costs `passes` Opus invocations (two by default), plus one retry for each invalid answer.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileJsonSchema } from '../../../argus/runtime/json-schema.mjs';
import * as builtInCorpus from './corpus/index.mjs';
import { MAX_EXTRACT_BYTES } from './lib/extract.mjs';
import { assertEval, evalSchema, formatSchemaErrors, validateArgus, validateEval } from './lib/schemas.mjs';

const USAGE = 'usage: node scripts/eval/discovery/judge.mjs --runs <sealed/private-runs.json> --output <judge-verdicts.json> [--claude <absolute path>] [--passes 2] [--concurrency 2] [--include-suspected true]';
const SYSTEM_PROMPT = fileURLToPath(new URL('./judge/system-prompt.md', import.meta.url));
const SCORABLE = new Set(['awaiting-adjudication', 'timed-out']);
const OUTCOMES = Object.freeze(['real', 'false-positive', 'duplicate']);
const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
// Only these variables reach the judge process; --bare authenticates strictly with the API key.
const JUDGE_ENV = Object.freeze(['PATH', 'HOME', 'ANTHROPIC_API_KEY']);
const EVIDENCE_INDEX = 'solution/evidence-reference.json';
const MAX_REPORT_BYTES = 40 * 1024;
const MAX_EVIDENCE_BYTES = 20 * 1024;
const MAX_EVIDENCE_ITEMS = 5;
const ATTEMPTS_PER_PASS = 2;
const INVOCATION_TIMEOUT_MS = 600_000;
const VERSION_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_TAIL = 1000;
const MAX_ERROR_CHARS = 2000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

class UsageError extends Error {}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byName = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)} [...]` : text);

function parseArguments(argv) {
  const names = { '--runs': 'runs', '--output': 'output', '--claude': 'claude', '--passes': 'passes', '--concurrency': 'concurrency', '--include-suspected': 'includeSuspected' };
  const raw = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!Object.hasOwn(names, flag)) throw new UsageError(`unknown argument ${flag}`);
    if (value === undefined || value === '') throw new UsageError(`${flag} requires a value`);
    if (Object.hasOwn(raw, names[flag])) throw new UsageError(`${flag} was given twice`);
    raw[names[flag]] = value;
  }
  if (!raw.runs || !raw.output) throw new UsageError('--runs and --output are required');
  const integer = (name, value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || Number(value) < min || Number(value) > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
    return Number(value);
  };
  if (raw.includeSuspected !== undefined && !['true', 'false'].includes(raw.includeSuspected)) throw new UsageError('--include-suspected must be true or false');
  if (raw.claude !== undefined && !isAbsolute(raw.claude)) throw new UsageError('--claude must be an absolute path');
  return {
    runs: resolve(raw.runs),
    output: resolve(raw.output),
    claude: raw.claude ?? null,
    passes: integer('passes', raw.passes, 2, 1, 5),
    concurrency: integer('concurrency', raw.concurrency, 2, 1, 8),
    includeSuspected: raw.includeSuspected === 'true',
  };
}

// The first executable `claude` on an absolute PATH entry.
function findClaude() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      if (lstatSync(realpathSync(candidate)).isFile()) return candidate;
    } catch {
      // Not on this PATH entry.
    }
  }
  throw new Error('claude was not found on PATH; pass --claude <absolute path>');
}

// Refuses symbolic links and special files; returns the file's bytes.
function readRegularFile(path, label, limit = Number.POSITIVE_INFINITY) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} ${path} must be a regular file`);
  if (stat.size > limit) throw new Error(`${label} ${path} exceeds ${limit} bytes`);
  return readFileSync(path);
}

function ensureDirectory(path) {
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) throw new Error(`${path} must be a physical directory`);
  return path;
}

// Writes through a temporary file. `exclusive` refuses to replace an existing target (link(2)
// fails on an existing name); otherwise rename(2) replaces it without following a link.
function writeAtomic(path, content, { exclusive = false } = {}) {
  const temporary = join(dirname(path), `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, content, { mode: FILE_MODE, flag: 'wx' });
  try {
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Resolves `candidate` (relative to the physical artifact root, or absolute) to a regular file
// inside the root. Every path component is lstat-checked, so a symbolic link anywhere, a special
// file, or a path that leaves the root is refused, and the result must be its own realpath.
function resolveInside(root, candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return { error: 'has an invalid path' };
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { error: 'is outside the artifact root' };
  const parts = rel.split(sep);
  let current = root;
  let stat = null;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      stat = lstatSync(current);
    } catch (error) {
      return { error: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'does not exist' : 'is not readable' };
    }
    if (stat.isSymbolicLink()) return { error: 'is (or is reached through) a symbolic link' };
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return { error: 'is not a regular file' };
  }
  try {
    if (realpathSync(target) !== target) return { error: 'does not resolve to itself' };
  } catch {
    return { error: 'is not readable' };
  }
  return { path: target, size: stat.size };
}

// The largest prefix length <= limit that does not split a UTF-8 sequence.
function utf8Boundary(bytes, limit) {
  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

// Reads a UTF-8 text file inside the artifact root, truncated to `limit` bytes with a marker.
// Binary content (a NUL byte or invalid UTF-8) is refused. The final component is opened with
// O_NOFOLLOW, so a file swapped for a link after the check is refused too.
function readText(root, candidate, limit) {
  const entry = resolveInside(root, candidate);
  if (entry.error) return entry;
  if (entry.size > MAX_EXTRACT_BYTES) return { error: `exceeds ${MAX_EXTRACT_BYTES} bytes` };
  let bytes;
  let fd = null;
  try {
    fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return { error: 'is not a regular file' };
    bytes = readFileSync(fd);
  } catch {
    return { error: 'is not readable' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (bytes.length > MAX_EXTRACT_BYTES) return { error: `exceeds ${MAX_EXTRACT_BYTES} bytes` };
  if (bytes.includes(0)) return { error: 'is not text' };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(bytes);
  } catch {
    return { error: 'is not UTF-8 text' };
  }
  const truncated = bytes.length > limit;
  const shown = truncated ? utf8Boundary(bytes, limit) : bytes.length;
  let text = decoder.decode(bytes.subarray(0, shown));
  if (truncated) text += `\n[... truncated by the evaluator: ${shown} of ${bytes.length} bytes shown ...]`;
  return { text, truncated, sha256: sha256(bytes) };
}

function readEvidenceIndex(root) {
  const entry = resolveInside(root, EVIDENCE_INDEX);
  if (entry.error) return { error: entry.error };
  if (entry.size > MAX_EXTRACT_BYTES) return { error: `exceeds ${MAX_EXTRACT_BYTES} bytes` };
  let document;
  try {
    document = JSON.parse(readFileSync(entry.path, 'utf8'));
  } catch {
    return { error: 'is not valid JSON' };
  }
  if (validateArgus('evidence-reference', document).length) return { error: 'violates the evidence-reference schema' };
  return { references: new Map(document.references.map(reference => [reference.id, reference])) };
}

// Up to five evidence texts cited by the finding, in ledger order. Hunter-authored source
// paths never enter the packet: only IDs, metadata and text.
function collectEvidence(root, finding, notes) {
  if (!root || !finding.evidenceIds.length) return [];
  const index = readEvidenceIndex(root);
  if (index.error) {
    notes.push(`${EVIDENCE_INDEX} ${index.error}; no evidence text was included.`);
    return [];
  }
  const evidence = [];
  for (const id of new Set(finding.evidenceIds)) {
    if (evidence.length === MAX_EVIDENCE_ITEMS) {
      notes.push(`Evidence ${id} was not included: at most ${MAX_EVIDENCE_ITEMS} evidence texts are included.`);
      continue;
    }
    const reference = index.references.get(id);
    if (!reference) {
      notes.push(`Evidence ${id} has no entry in ${EVIDENCE_INDEX}.`);
      continue;
    }
    const read = readText(root, reference.source, MAX_EVIDENCE_BYTES);
    if (read.error) {
      notes.push(`Evidence ${id} was not included: its source ${read.error}.`);
      continue;
    }
    evidence.push({ id, kind: reference.kind, collectedBy: reference.collectedBy, capturedAt: reference.capturedAt,
      redaction: reference.redaction, digestMatches: read.sha256 === reference.sha256, truncated: read.truncated, text: read.text });
  }
  return evidence;
}

function buildPacket(run, finding, priorFindings, controls) {
  const notes = [];
  let root = null;
  try {
    root = realpathSync(run.artifactRoot);
  } catch {
    notes.push('The run artifact root is missing; no report or evidence text is available.');
  }
  let report = null;
  if (root && finding.reportPath) {
    const read = readText(root, finding.reportPath, MAX_REPORT_BYTES);
    if (read.error) notes.push(`Report ${finding.reportPath} was not included: it ${read.error}.`);
    else report = { path: finding.reportPath, truncated: read.truncated, text: read.text };
  }
  const evidence = collectEvidence(root, finding, notes);
  return {
    schema: 'argus-eval/judge-packet@1',
    contract: run.contract,
    seeds: run.truth.map(({ id, surface, severity, criterion }) => ({ id, surface, severity, criterion })),
    controls,
    finding,
    report,
    evidence,
    notes,
    priorFindings,
  };
}

// The packet as the judge's only user message. `<` and `>` are JSON-escaped (the JSON value is
// unchanged), so no delimiter-like text inside the packet can close the untrusted frame.
function frame(packetJson) {
  return `<untrusted-finding>\n${packetJson.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</untrusted-finding>\n`;
}

// The per-finding output schema: seedId only from this run's truth (so a corrected-build run can
// only answer null), duplicateOf only from the findings already judged in this run, and no
// duplicate outcome when there is none.
function outputSchema(template, run, priorFindings) {
  const schema = structuredClone(template);
  schema.properties.seedId = { type: ['string', 'null'], enum: [...run.truth.map(seed => seed.id), null] };
  schema.properties.duplicateOf = { type: ['string', 'null'], enum: [...priorFindings.map(item => item.findingId), null] };
  if (!priorFindings.length) schema.properties.outcome = { type: 'string', enum: OUTCOMES.filter(outcome => outcome !== 'duplicate') };
  return schema;
}

// The copy given to the CLI keeps only structural keywords (types, enums, required, closed
// objects); identifiers and the length patterns are enforced locally after parsing.
const CLI_STRIPPED = new Set(['$schema', '$id', 'title', 'pattern', 'minLength', 'format']);
function cliSchema(schema) {
  const copy = {};
  for (const [key, value] of Object.entries(schema)) {
    if (CLI_STRIPPED.has(key)) continue;
    if (key === 'properties' || key === '$defs') copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cliSchema(child)]));
    else if (['items', 'additionalProperties', 'if', 'then'].includes(key) && isObject(value)) copy[key] = cliSchema(value);
    else if (key === 'allOf') copy[key] = value.map(cliSchema);
    else copy[key] = value;
  }
  return copy;
}

function outputProblem(output, validate) {
  const errors = validate(output);
  if (errors.length) return `output violates the judge schema: ${formatSchemaErrors(errors)}`;
  if (output.seedId !== null && output.outcome !== 'real') return `output credits seed ${output.seedId} with outcome ${output.outcome}`;
  if ((output.duplicateOf !== null) !== (output.outcome === 'duplicate')) return 'output sets duplicateOf without the duplicate outcome, or the reverse';
  return null;
}

// Strips one surrounding Markdown code fence from a text answer.
function unfence(text) {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match ? match[1] : text;
}

// Reads the CLI's --output-format json envelope: `.structured_output`, else JSON in `.result`.
function parseEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { error: 'claude printed no JSON result', models: [], costUsd: null };
  }
  if (!isObject(envelope)) return { error: 'claude printed a JSON result that is not an object', models: [], costUsd: null };
  const models = isObject(envelope.modelUsage) ? Object.keys(envelope.modelUsage).sort(byName) : [];
  const costUsd = typeof envelope.total_cost_usd === 'number' && Number.isFinite(envelope.total_cost_usd) && envelope.total_cost_usd >= 0 ? envelope.total_cost_usd : null;
  if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== 'success')) {
    return { error: `claude reported ${envelope.subtype ?? 'an error'}`, models, costUsd };
  }
  let output = isObject(envelope.structured_output) ? envelope.structured_output : null;
  if (!output && typeof envelope.result === 'string') {
    try {
      output = JSON.parse(unfence(envelope.result));
    } catch {
      output = null;
    }
  }
  if (!isObject(output)) return { error: 'claude returned no structured output', models, costUsd };
  return { error: null, output, models, costUsd };
}

function lowest(confidences) {
  return confidences.reduce((low, value) => (CONFIDENCE_RANK[value] < CONFIDENCE_RANK[low] ? value : low));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs `task` items through at most `limit` workers; results keep the input order.
async function mapPool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new UsageError('ANTHROPIC_API_KEY is required: the judge runs claude --bare, which never reads OAuth credentials or the keychain');
  }
  const claude = options.claude ?? findClaude();

  const runsBytes = readRegularFile(options.runs, 'private runs');
  let privateRuns;
  try {
    privateRuns = JSON.parse(runsBytes);
  } catch (error) {
    throw new Error(`private runs ${options.runs} are not valid JSON: ${error.message}`);
  }
  const runErrors = validateEval('private-runs', privateRuns);
  if (runErrors.length) throw new Error(`private runs violate argus-eval/private-runs@2: ${formatSchemaErrors(runErrors)}`);
  const runsDir = dirname(realpathSync(options.runs));
  let outputExists = true;
  try {
    lstatSync(options.output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    outputExists = false;
  }
  if (outputExists) throw new Error(`output ${options.output} already exists; pass a new path`);
  let outputParent;
  try {
    outputParent = realpathSync(dirname(options.output));
  } catch {
    throw new Error(`the parent directory of output ${options.output} must exist`);
  }
  const outputPath = join(outputParent, basename(options.output));

  // The corpus the runs were recorded against supplies the controls and the seed probes.
  const corpusPath = privateRuns.config.corpusModule;
  const corpus = corpusPath ? await import(pathToFileURL(corpusPath).href) : builtInCorpus;
  if (corpus.corpusVersion !== privateRuns.corpus.version) {
    throw new Error(`corpus mismatch: the runs recorded ${privateRuns.corpus.version}, the corpus module is ${corpus.corpusVersion}`);
  }
  if (privateRuns.corpus.digest !== null) {
    const digest = typeof corpus.corpusDigest === 'function' ? corpus.corpusDigest() : null;
    if (digest !== privateRuns.corpus.digest) throw new Error('corpus mismatch: the corpus digest changed since the runs were recorded');
  }
  const controls = Array.isArray(corpus.controls) ? corpus.controls.map(({ id, description }) => {
    if (typeof id !== 'string' || typeof description !== 'string') throw new Error('corpus controls must carry string id and description');
    return { id, description };
  }) : [];
  const canProbe = typeof corpus.probe === 'function' && typeof corpus.startApplication === 'function';

  const systemPromptBytes = readRegularFile(SYSTEM_PROMPT, 'judge system prompt');
  const template = evalSchema('judge-output');
  const judgeEnv = Object.fromEntries(JUDGE_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const children = new Set();
  const temporaryDirs = new Set();
  // Set on a fatal error, so no worker still in flight starts another paid invocation.
  let aborted = false;
  const cleanup = () => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
    }
    for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
  };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }

  // One claude process in a fresh, empty, physical working directory with the minimal
  // environment, killed with its process group at the timeout.
  const execute = (args, input, timeoutMs) => new Promise(done => {
    const cwd = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'argus-eval-judge-')));
    temporaryDirs.add(cwd);
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let child;
    let timer = null;
    const finish = fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process group has already exited.
        }
        children.delete(child);
      }
      rmSync(cwd, { recursive: true, force: true });
      temporaryDirs.delete(cwd);
      done({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: stderr.replaceAll(apiKey, '[redacted]'), overflow, timedOut, ...fields });
    };
    try {
      child = spawn(claude, args, { cwd, env: judgeEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      finish({ code: null, signal: null, spawnError: error.message });
      return;
    }
    children.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) overflow = true;
      else stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_TAIL); });
    child.stdin.on('error', () => {
      // The process exited before reading its input; the exit status reports the failure.
    });
    child.once('error', error => finish({ code: null, signal: null, spawnError: error.message }));
    child.once('close', (code, signal) => finish({ code, signal, spawnError: null }));
    child.stdin.end(input);
  });

  const version = await execute(['--version'], '', VERSION_TIMEOUT_MS);
  const versionMatch = /\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(version.stdout);
  if (version.spawnError || version.code !== 0 || !versionMatch) {
    throw new Error(`${claude} --version failed: ${version.spawnError ?? (version.timedOut ? 'timed out' : `status ${version.code}`)} ${clip(version.stdout.trim(), 200)} ${version.stderr.trim()}`.trim());
  }
  const claudeVersion = versionMatch[1];

  const resolvedModels = new Set();
  let invocations = 0;
  let totalCostUsd = null;

  // One judging attempt: the process outcome, then the envelope, then the answer.
  async function attempt(input, schema, validate) {
    if (aborted) return { error: 'the judge was aborted', models: [], costUsd: null };
    const args = ['-p', '--bare', '--model', 'opus', '--effort', 'max', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--disable-slash-commands', '--output-format', 'json',
      '--json-schema', JSON.stringify(cliSchema(schema)), '--system-prompt-file', SYSTEM_PROMPT];
    invocations += 1;
    const result = await execute(args, input, INVOCATION_TIMEOUT_MS);
    if (result.spawnError) return { error: `claude could not start: ${result.spawnError}`, models: [], costUsd: null };
    if (result.timedOut) return { error: `claude timed out after ${INVOCATION_TIMEOUT_MS / 1000} s`, models: [], costUsd: null };
    if (result.overflow) return { error: `claude printed more than ${MAX_STDOUT_BYTES} bytes`, models: [], costUsd: null };
    const parsed = parseEnvelope(result.stdout);
    for (const model of parsed.models) resolvedModels.add(model);
    if (parsed.costUsd !== null) totalCostUsd = (totalCostUsd ?? 0) + parsed.costUsd;
    if (result.code !== 0) {
      const tail = result.stderr.trim();
      return { ...parsed, error: `claude exited with ${result.signal ?? `status ${result.code}`}${parsed.error ? ` (${parsed.error})` : ''}${tail ? `: ${tail}` : ''}` };
    }
    if (parsed.error) return parsed;
    const problem = outputProblem(parsed.output, validate);
    return problem ? { ...parsed, error: problem } : parsed;
  }

  // One pass: an invalid answer is retried once; a second failure fails the pass.
  async function judgePass(pass, input, schema, validate) {
    const record = { pass, attempts: 0, outcome: null, seedId: null, duplicateOf: null, confidence: null, criterionEvidence: null, reason: null, error: null, costUsd: null, models: [] };
    const models = new Set();
    let error = null;
    for (let count = 1; count <= ATTEMPTS_PER_PASS; count += 1) {
      record.attempts = count;
      const result = await attempt(input, schema, validate);
      for (const model of result.models) models.add(model);
      if (result.costUsd !== null) record.costUsd = (record.costUsd ?? 0) + result.costUsd;
      if (!result.error) {
        const { outcome, seedId, duplicateOf, confidence, criterionEvidence, reason } = result.output;
        Object.assign(record, { outcome, seedId, duplicateOf, confidence, criterionEvidence, reason });
        error = null;
        break;
      }
      error = clip(result.error, MAX_ERROR_CHARS);
    }
    record.error = error;
    record.models = [...models].sort(byName);
    return record;
  }

  // Seed confirmation: the corpus probe for the credited seed against a fresh application with
  // the run's seed and enabled seeds. Probes run one at a time (the perf probes measure latency).
  let probeQueue = Promise.resolve();
  function confirmSeed(run, seedId) {
    const task = async () => {
      let app = null;
      try {
        app = await corpus.startApplication({ seed: run.seed, enabledSeeds: [...run.enabledSeeds] });
        const observed = await withTimeout(Promise.resolve(corpus.probe(seedId, app.url, app.contract)), PROBE_TIMEOUT_MS, `probe timed out after ${PROBE_TIMEOUT_MS / 1000} s`);
        return { confirmed: Boolean(observed), error: null };
      } catch (error) {
        return { confirmed: false, error: clip(`seed probe failed: ${error.message}`, MAX_ERROR_CHARS) };
      } finally {
        if (app) {
          try {
            await app.close();
          } catch {
            // The application is already closed.
          }
        }
      }
    };
    const result = probeQueue.then(task, task);
    probeQueue = result.catch(() => {});
    return result;
  }

  // Any failed pass fails the verdict (a human decides it). Otherwise pass 1 decides; agreement
  // means every pass gave the same outcome and seedId, and the confidence is the lowest pass
  // confidence, or 'low' on disagreement.
  function combine(finding, passes, packetPath, packetSha256) {
    const verdict = { findingId: finding.id, status: finding.status, outcome: null, seedId: null, duplicateOf: null, confidence: null,
      agreement: false, judgeFailed: true, seedProbeConfirmed: null, seedProbeError: null, reason: null, criterionEvidence: null,
      packetPath, packetSha256, passes };
    const failed = passes.filter(pass => pass.error);
    if (failed.length) {
      verdict.reason = `judge failed: ${failed.map(pass => `pass ${pass.pass}: ${pass.error}`).join('; ')}`;
      return verdict;
    }
    const [first] = passes;
    const agreement = passes.every(pass => pass.outcome === first.outcome && pass.seedId === first.seedId);
    return Object.assign(verdict, { outcome: first.outcome, seedId: first.seedId, duplicateOf: first.duplicateOf,
      confidence: agreement ? lowest(passes.map(pass => pass.confidence)) : 'low', agreement, judgeFailed: false,
      reason: first.reason, criterionEvidence: first.criterionEvidence });
  }

  const packetsRoot = join(runsDir, 'judge-packets');

  // Findings of one run are judged in order (confirmed rows first, then suspected rows when
  // requested), because each packet lists the verdicts already given in that run.
  async function judgeRun(run) {
    if (!SCORABLE.has(run.status)) return { runId: run.runId, skipped: run.status, verdicts: [] };
    const rows = [...run.extraction.findings, ...(options.includeSuspected ? run.extraction.suspected : [])];
    const verdicts = [];
    if (!rows.length) return { runId: run.runId, skipped: null, verdicts };
    ensureDirectory(packetsRoot);
    const packetDir = ensureDirectory(join(packetsRoot, run.runId));
    const titles = new Map(rows.map(row => [row.id, row.title]));
    for (const finding of rows) {
      if (aborted) throw new Error('the judge was aborted');
      const priorFindings = verdicts.map(verdict => ({ findingId: verdict.findingId, title: titles.get(verdict.findingId), outcome: verdict.outcome, seedId: verdict.seedId }));
      const packetJson = `${JSON.stringify(buildPacket(run, finding, priorFindings, controls), null, 2)}\n`;
      const packetPath = join(packetDir, `${finding.id}.json`);
      writeAtomic(packetPath, packetJson);
      const input = frame(packetJson.trimEnd());
      const schema = outputSchema(template, run, priorFindings);
      const validate = compileJsonSchema(schema);
      const passes = [];
      for (let pass = 1; pass <= options.passes; pass += 1) passes.push(await judgePass(pass, input, schema, validate));
      const verdict = combine(finding, passes, packetPath, sha256(packetJson));
      if (verdict.seedId !== null && canProbe) {
        const probe = await confirmSeed(run, verdict.seedId);
        verdict.seedProbeConfirmed = probe.confirmed;
        verdict.seedProbeError = probe.error;
        if (!probe.confirmed) verdict.confidence = 'low';
      }
      verdicts.push(verdict);
    }
    return { runId: run.runId, skipped: null, verdicts };
  }

  let results;
  try {
    results = await mapPool(privateRuns.runs, options.concurrency, judgeRun);
  } catch (error) {
    aborted = true;
    throw error;
  } finally {
    cleanup();
  }

  const document = {
    schema: 'argus-eval/judge-verdicts@1',
    createdAt: new Date().toISOString(),
    runsSha256: sha256(runsBytes),
    judge: {
      model: 'opus', effort: 'max', claudeVersion, resolvedModels: [...resolvedModels].sort(byName),
      systemPromptSha256: sha256(systemPromptBytes), passes: options.passes, bare: true, tools: 'none',
      includeSuspected: options.includeSuspected, invocations, totalCostUsd,
    },
    runs: results,
  };
  assertEval('judge-verdicts', document, 'judge verdicts');
  writeAtomic(outputPath, `${JSON.stringify(document, null, 2)}\n`, { exclusive: true });

  const verdicts = results.flatMap(run => run.verdicts);
  console.log(JSON.stringify({
    status: 'PROVISIONAL',
    runs: results.length,
    judgedRuns: results.filter(run => run.skipped === null).length,
    verdicts: verdicts.length,
    judgeFailed: verdicts.filter(verdict => verdict.judgeFailed).length,
    lowConfidence: verdicts.filter(verdict => verdict.confidence === 'low').length,
    disagreements: verdicts.filter(verdict => !verdict.judgeFailed && !verdict.agreement).length,
    seedProbeMismatches: verdicts.filter(verdict => verdict.seedProbeConfirmed === false).length,
    invocations,
    totalCostUsd,
    output: outputPath,
  }));
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`judge: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`judge: ${error.message}`);
    process.exitCode = 1;
  }
}
