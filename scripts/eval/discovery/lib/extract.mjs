// Evaluator-side finding extraction. The evaluator never trusts findings reported by a host
// adapter: it reads the canonical Argus ledger (solution/bug-ledger.json) and the bug reports
// from the run's artifact root itself. Symbolic links (at any path component) and files over
// 2 MB are ignored. A missing or invalid ledger scores as zero findings (an Argus delivery
// defect), never as an invalid run.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSchemaErrors, validateArgus } from './schemas.mjs';

export const MAX_EXTRACT_BYTES = 2 * 1024 * 1024;
export const LEDGER_PATH = 'solution/bug-ledger.json';
export const REPORTS_DIR = 'bugs';
const FRAMEWORK_DEPTH = 4;
const FRAMEWORK_SKIP = new Set(['node_modules', 'ai_agents_internal', 'reports', '.git']);
const MAX_LEDGER_ERRORS = 20;
// bug-ledger status split: confirmed rows are findings; unproven rows (including @2 bounced and
// quarantined entries) are suspected; duplicate and rejected rows are not candidates at all.
const LEDGER_STATUS_CLASS = Object.freeze({
  confirmed: 'finding',
  suspected: 'suspected',
  'needs-oracle': 'suspected',
  bounced: 'suspected',
  quarantined: 'suspected',
  duplicate: 'excluded',
  rejected: 'excluded',
});

// Returns 'finding', 'suspected', 'excluded', or null for a status the evaluator does not know.
export const classifyLedgerStatus = status => (Object.hasOwn(LEDGER_STATUS_CLASS, status) ? LEDGER_STATUS_CLASS[status] : null);

const byName = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// lstat every component of a root-relative path. Returns {state: 'missing' | 'symlink' |
// 'unreadable' | 'file' | 'directory' | 'other', stat?}.
function inspect(root, relativePath) {
  const parts = relativePath.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      return { state: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable' };
    }
    if (stat.isSymbolicLink()) return { state: 'symlink' };
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) return { state: 'missing' };
      continue;
    }
    return { state: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', stat };
  }
  return { state: 'missing' };
}

function readLedger(root) {
  const entry = inspect(root, LEDGER_PATH);
  const invalid = message => ({ ledger: 'invalid', ledgerErrors: [message], document: null, mtimeMs: null });
  if (entry.state === 'missing') return { ledger: 'missing', ledgerErrors: [], document: null, mtimeMs: null };
  if (entry.state === 'symlink') return invalid(`${LEDGER_PATH} is (or is reached through) a symbolic link`);
  if (entry.state === 'unreadable') return invalid(`${LEDGER_PATH} is not readable`);
  if (entry.state !== 'file') return invalid(`${LEDGER_PATH} is not a regular file`);
  if (entry.stat.size > MAX_EXTRACT_BYTES) return invalid(`${LEDGER_PATH} exceeds ${MAX_EXTRACT_BYTES} bytes`);
  let document;
  try {
    document = JSON.parse(readFileSync(join(root, LEDGER_PATH), 'utf8'));
  } catch (error) {
    return invalid(`${LEDGER_PATH} is not valid JSON: ${error.message}`);
  }
  const errors = validateArgus('bug-ledger', document);
  if (errors.length) {
    const messages = errors.slice(0, MAX_LEDGER_ERRORS).map(error => formatSchemaErrors([error]));
    if (errors.length > MAX_LEDGER_ERRORS) messages.push(`... ${errors.length - MAX_LEDGER_ERRORS} more schema errors`);
    return { ledger: 'invalid', ledgerErrors: messages, document: null, mtimeMs: null };
  }
  const seen = new Set();
  for (const bug of document.bugs) {
    if (seen.has(bug.id)) return invalid(`${LEDGER_PATH} repeats bug id ${bug.id}`);
    seen.add(bug.id);
    if (classifyLedgerStatus(bug.status) === null) return invalid(`${LEDGER_PATH} bug ${bug.id} has unknown status ${bug.status}`);
  }
  return { ledger: 'present', ledgerErrors: [], document, mtimeMs: entry.stat.mtimeMs };
}

// Top-level bugs/*.md reports that are regular files within the size limit, sorted by name.
function listReports(root) {
  if (inspect(root, REPORTS_DIR).state !== 'directory') return [];
  let entries;
  try {
    entries = readdirSync(join(root, REPORTS_DIR));
  } catch {
    return [];
  }
  return entries.filter(name => name.endsWith('.md')).sort(byName).flatMap(name => {
    const entry = inspect(root, `${REPORTS_DIR}/${name}`);
    if (entry.state !== 'file' || entry.stat.size > MAX_EXTRACT_BYTES) return [];
    return [{ name, path: `${REPORTS_DIR}/${name}`, stem: name.slice(0, -3).toLowerCase(), mtimeMs: entry.stat.mtimeMs }];
  });
}

const stemMatches = (stem, key) => stem === key || stem.startsWith(`${key}-`);

// The first report whose name starts with `${origin}-` or equals `${origin}.md`, trying the
// origins in ledger order (then the canonical id); case-insensitive.
function reportFor(bug, reports) {
  for (const key of [...bug.origin, bug.id].map(value => value.toLowerCase())) {
    const report = reports.find(item => stemMatches(item.stem, key));
    if (report) return report;
  }
  return null;
}

function isRegularFile(root, relativePath) {
  return inspect(root, relativePath).state === 'file';
}

// Directories holding both run-tests.sh and scripts/runner-contract.sh, breadth first to depth 4
// (the artifact root is depth 0), as root-relative POSIX paths ('.' for the root itself).
function findFrameworks(root) {
  const found = [];
  let level = [''];
  for (let depth = 0; depth <= FRAMEWORK_DEPTH && level.length; depth += 1) {
    const next = [];
    for (const relativeDir of level) {
      const prefix = relativeDir ? `${relativeDir}/` : '';
      if (isRegularFile(root, `${prefix}run-tests.sh`) && isRegularFile(root, `${prefix}scripts/runner-contract.sh`)) found.push(relativeDir || '.');
      if (depth === FRAMEWORK_DEPTH) continue;
      let entries;
      try {
        entries = readdirSync(relativeDir ? join(root, relativeDir) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((left, right) => byName(left.name, right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !FRAMEWORK_SKIP.has(entry.name)) next.push(`${prefix}${entry.name}`);
      }
    }
    level = next;
  }
  return found;
}

// Extracts the scored candidates of one run. `startedAtMs` is the epoch time the adapter was
// spawned and `elapsedMs` its wall-clock duration; confirmedAtMs is the report (or ledger)
// modification time relative to the start, clamped to [0, elapsedMs].
export function extractFindings(artifactRoot, { startedAtMs, elapsedMs }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('extractFindings requires startedAtMs and a non-negative elapsedMs');
  const { ledger, ledgerErrors, document, mtimeMs } = readLedger(artifactRoot);
  const reports = listReports(artifactRoot);
  const findings = [];
  const suspected = [];
  const keys = [];
  for (const bug of document?.bugs ?? []) {
    keys.push(...[...bug.origin, bug.id].map(value => value.toLowerCase()));
    const kind = classifyLedgerStatus(bug.status);
    if (kind === 'excluded') continue;
    const report = reportFor(bug, reports);
    const at = (report ? report.mtimeMs : mtimeMs) - startedAtMs;
    const row = {
      id: bug.id,
      origin: [...bug.origin],
      lane: bug.lane,
      severity: bug.severity,
      status: bug.status,
      wired: bug.wired,
      testId: bug.testId,
      title: bug.title,
      reportPath: report ? report.path : null,
      evidenceIds: [...bug.evidenceIds],
      confirmedAtMs: Math.round(Math.min(Math.max(at, 0), elapsedMs)),
    };
    (kind === 'finding' ? findings : suspected).push(row);
  }
  const unledgeredReports = reports
    .filter(report => !report.name.startsWith('_') && !keys.some(key => stemMatches(report.stem, key)))
    .map(report => report.path);
  const frameworks = findFrameworks(artifactRoot);
  return {
    ledger,
    ledgerErrors,
    findings,
    suspected,
    unledgeredReports,
    framework: { root: frameworks[0] ?? null, candidates: frameworks.length },
  };
}
