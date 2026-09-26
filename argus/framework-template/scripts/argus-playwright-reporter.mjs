// Argus outcome adapter for Playwright (template contract v2, RUNNER-CONTRACT.md SD-1 to
// SD-7). It stays inert unless scripts/runner-lib.sh exports ARGUS_RUNNER_MODE, so the
// reporter entry in playwright.config.ts changes nothing for a plain `playwright test`.
//
// - ARGUS_INVENTORY_ONLY=1 (a `--list` pass) writes reports/test-inventory.tsv (SD-3) and
//   reports/expected-bugs.txt (SD-4), and emits the SD-4 ledger events.
// - Otherwise every final test attempt becomes one SD-5/SD-6 event, plus a `.cleanup`
//   event when an ArgusCleanupError accompanies a different primary outcome.
// - Every event goes through scripts/outcome-event.sh. Events never carry titles,
//   messages, URLs, or bodies; those stay in the native per-pass reports.
// - reports/argus-adapter-status.txt records `ok <events>` or `error <failures>`.
//
// Node standard library only: the adapter must load before any dependency is trusted.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'reports');
const LEDGER = join(ROOT, 'solution', 'bug-ledger.json');
const OUTCOME_EVENT = join(ROOT, 'scripts', 'outcome-event.sh');

const MODES = new Set(['baseline', 'defect-evidence', 'candidate-regression', 'full-suite']);
// Counterfactual passes (cf-correct, cf-tamper-<k>) are not supported by this adapter yet;
// an unsupported pass fails the adapter status instead of emitting live semantics.
const PASSES = new Set(['live', 'repeat']);
const PRODUCT_LANES = ['api', 'ui', 'perf', 'security', 'db', 'resilience'];
const LANES = new Set([...PRODUCT_LANES, 'contract-smoke', 'setup']);
const LEDGER_SCHEMAS = new Map([['argus/bug-ledger@1', 1], ['argus/bug-ledger@2', 2]]);
const CANONICAL_BUG = /^BUG-[0-9]{4}$/;
const PROVENANCE_TOKEN = /^(BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$/;
const NETWORK_ERROR = /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|net::ERR_/;
const ANSI = /\u001b\[[0-9;]*m/g;
const ARGUS_ERRORS = new Map([
  ['ArgusCleanupError', ['automation', 'fail', 'cleanup-failed']],
  ['ArgusPrerequisiteError', ['infrastructure', 'fail', 'prerequisite-missing']],
  ['ArgusRestoreError', ['infrastructure', 'fail', 'fault-restore-failed']],
  ['ArgusCounterfactualError', ['automation', 'fail', 'counterfactual-unmatched-request']],
]);
const MAX_REPETITION = 200;

/** SD-2: sanitize a raw case identity into a safe, bounded machine token. */
export function sanitizeCaseId(raw) {
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length <= 200) return cleaned;
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  return `${cleaned.slice(0, 187)}.${digest}`;
}

/**
 * SD-4: read solution/bug-ledger.json. Only bugs[].id, bugs[].origin[], status, and the
 * reproduction record are read; they have the same shape in ledger v1 and v2.
 */
export function loadLedger(path = LEDGER) {
  const empty = { tokens: new Map(), bugs: new Map(), confirmed: [] };
  if (!existsSync(path)) return { state: 'missing', ...empty };
  const invalid = { state: 'invalid', ...empty };
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return invalid;
  }
  const version = LEDGER_SCHEMAS.get(document?.$schema);
  if (!version || document.schemaVersion !== version || !Array.isArray(document.bugs)) return invalid;
  const bugs = new Map();
  const owners = new Map();
  for (const bug of document.bugs) {
    if (!bug || typeof bug !== 'object' || typeof bug.id !== 'string' || !CANONICAL_BUG.test(bug.id)) return invalid;
    if (bugs.has(bug.id)) return invalid;
    const origin = bug.origin ?? [];
    if (!Array.isArray(origin) || origin.some((alias) => typeof alias !== 'string')) return invalid;
    bugs.set(bug.id, bug);
    for (const token of new Set([bug.id, ...origin])) {
      if (!owners.has(token)) owners.set(token, new Set());
      owners.get(token).add(bug.id);
    }
  }
  const tokens = new Map();
  for (const [token, ids] of owners) {
    // An alias that names two bugs cannot be joined safely, so the whole ledger is refused.
    if (ids.size !== 1) return invalid;
    tokens.set(token, [...ids][0]);
  }
  const confirmed = [...bugs.values()].filter((bug) => bug.status === 'confirmed').map((bug) => bug.id).sort();
  return { state: 'valid', tokens, bugs, confirmed };
}

export default class ArgusPlaywrightReporter {
  constructor() {
    const mode = process.env.ARGUS_RUNNER_MODE ?? '';
    this.active = MODES.has(mode);
    if (!this.active) return;
    this.mode = mode;
    this.inventoryOnly = process.env.ARGUS_INVENTORY_ONLY === '1';
    this.pass = process.env.ARGUS_EVIDENCE_PASS || 'live';
    const outcomeFile = process.env.ARGUS_OUTCOME_FILE || join('reports', 'outcomes.raw.tsv');
    this.outcomeFile = isAbsolute(outcomeFile) ? outcomeFile : resolve(ROOT, outcomeFile);
    this.events = 0;
    this.failures = 0;
    this.globalErrors = 0;
    this.entries = null;
    this.byTest = new Map();
    // The pass is irrelevant to a collect-only run; in an executed run only defect-evidence
    // has passes other than live.
    this.passSupported = this.inventoryOnly || (PASSES.has(this.pass) && (this.pass === 'live' || mode === 'defect-evidence'));
    if (!this.passSupported) this.fail(`unsupported evidence pass for mode ${mode}`);
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    if (!this.active) return;
    this.ledger = loadLedger();
    const described = suite.allTests().map((test, index) => ({ test, index, ...this.describe(test, config.rootDir) }));
    described.sort((left, right) => compareText(left.file, right.file)
      || left.line - right.line || left.column - right.column || left.index - right.index);
    const used = new Set();
    for (const entry of described) {
      let id = entry.baseId;
      for (let suffix = 2; used.has(id); suffix += 1) id = `${entry.baseId}.${suffix}`;
      used.add(id);
      entry.id = id;
      this.byTest.set(entry.test, entry);
    }
    this.entries = described;
  }

  onTestEnd(test, result) {
    if (!this.active || this.inventoryOnly || !this.passSupported) return;
    if (!isFinalAttempt(test, result)) return;
    const entry = this.byTest.get(test);
    if (!entry) {
      this.fail('a test ended that was not part of the collected suite');
      return;
    }
    for (const event of this.classify(entry, test, result)) this.emit(event);
  }

  onError() {
    if (this.active) this.globalErrors += 1;
  }

  onEnd() {
    if (!this.active) return undefined;
    if (this.inventoryOnly) this.finishInventory();
    else if (this.globalErrors > 0) {
      // A load, configuration, or worker error outside any test leaves tests unreported.
      this.emit(['playwright-global', 'automation', 'fail', 'false', 'n/a', '-', 'uncaught-error']);
    }
    const status = this.failures > 0 ? `error ${this.failures}\n` : `ok ${this.events}\n`;
    try {
      writeAtomic(join(REPORTS, 'argus-adapter-status.txt'), status);
    } catch {
      process.stderr.write('argus-playwright-reporter: cannot write reports/argus-adapter-status.txt\n');
      return { status: 'failed' };
    }
    return this.failures > 0 ? { status: 'failed' } : undefined;
  }

  describe(test, rootDir) {
    const project = test.parent.project()?.name ?? '';
    const file = test.location.file;
    const titles = [];
    for (let suite = test.parent; suite && suite.type === 'describe'; suite = suite.parent) {
      if (suite.title) titles.unshift(suite.title);
    }
    titles.push(test.title);
    const baseId = sanitizeCaseId(`${project}:${toPosix(relative(rootDir, file))}:${titles.join(' > ')}`);
    const tags = test.tags;
    const tokens = tags.filter((tag) => tag.startsWith('@bug:') && tag.length > '@bug:'.length).map((tag) => tag.slice('@bug:'.length));
    const resolved = [];
    const unresolved = [];
    for (const token of tokens) {
      const id = PROVENANCE_TOKEN.test(token) ? this.ledger.tokens.get(token) : undefined;
      if (id) {
        if (!resolved.includes(id)) resolved.push(id);
      } else unresolved.push(safeToken(token));
    }
    const regression = tags.includes('@regression');
    // SD-11: a regression carries exactly one provenance token; only then is its bug bound.
    const bug = regression && tokens.length === 1 && resolved.length === 1 ? resolved[0] : '-';
    const repetition = bug === '-' ? { n: 1, valid: true } : repetitionFor(tags, this.ledger.bugs.get(bug));
    const source = `${toPosix(relative(ROOT, file))}:${test.location.line}`;
    return {
      baseId,
      file: toPosix(relative(rootDir, file)),
      line: test.location.line,
      column: test.location.column,
      lane: laneFor(project),
      regression,
      quarantine: tags.includes('@quarantine'),
      resolved,
      unresolved,
      bug,
      repetition,
      disabled: disabledKind(test),
      source: /^[A-Za-z0-9_./:-]+$/.test(source) ? source : '-',
    };
  }

  classify(entry, test, result) {
    const id = this.pass === 'live' ? entry.id : `${entry.id}.${this.pass}`;
    const bug = entry.regression ? entry.bug : '-';
    const other = (category, status, reason) => [id, category, status, 'false', 'n/a', bug, reason];
    let primary;
    if (test.expectedStatus === 'failed' || hasAnnotation(test, result, 'fail')) {
      primary = other('policy', 'denied', 'expected-failure-forbidden');
    } else if (result.status === 'skipped') {
      primary = entry.regression ? other('policy', 'denied', 'regression-skipped') : [id, 'skip', 'skipped', 'false', 'n/a', '-', 'test-skipped'];
    } else if (result.status === 'timedOut') {
      primary = other('automation', 'fail', 'test-timeout');
    } else if (result.status === 'interrupted') {
      primary = other('infrastructure', 'fail', 'test-interrupted');
    } else if (result.status === 'passed') {
      primary = this.productEvent(id, entry, true);
    } else {
      const outcome = classifyFailure(result);
      primary = outcome === 'product' ? this.productEvent(id, entry, false) : other(...outcome);
    }
    const events = [primary];
    if (primary[6] !== 'cleanup-failed' && hasCleanupError(result)) {
      events.push([`${id}.cleanup`, 'automation', 'fail', 'false', 'n/a', bug, 'cleanup-failed']);
    }
    return events;
  }

  // SD-6. A regression without exactly one resolved bug keeps the non-regression product
  // mapping: it never claims expected RED, and the inventory gate owns the provenance denial.
  productEvent(id, entry, passed) {
    if (!entry.regression || entry.bug === '-') {
      return passed ? [id, 'product', 'pass', 'false', 'n/a', '-', 'passed'] : [id, 'product', 'fail', 'false', 'n/a', '-', 'assertion-failed'];
    }
    const bug = entry.bug;
    if (!entry.repetition.valid) return [id, 'policy', 'denied', 'false', 'n/a', bug, 'repetition-invalid'];
    if (this.mode === 'defect-evidence') {
      if (passed && entry.repetition.n > 1) return [id, 'product', 'pass', 'false', 'n/a', bug, 'intermittent-unreproduced'];
      if (this.pass === 'live') {
        return passed ? [id, 'product', 'pass', 'true', 'automated', bug, 'expected-red-passed'] : [id, 'product', 'fail', 'true', 'reproduced', bug, 'expected-red'];
      }
      return passed ? [id, 'automation', 'fail', 'false', 'n/a', bug, 'flaky-red'] : [id, 'product', 'fail', 'true', 'reproduced', bug, 'expected-red-repeat'];
    }
    // candidate-regression and full-suite are strict. A regression that reaches a baseline
    // run anyway gets the same strict mapping, so it can never read as expected RED.
    return passed ? [id, 'product', 'pass', 'false', 'fixed', bug, 'regression-green'] : [id, 'product', 'fail', 'false', 'automated', bug, 'regression-red'];
  }

  finishInventory() {
    const ledger = this.ledger ?? loadLedger();
    if (ledger.state === 'invalid') this.emit(['bug-ledger', 'policy', 'denied', 'false', 'n/a', '-', 'bug-ledger-invalid']);
    else if (ledger.state === 'missing' && this.mode !== 'baseline') {
      this.emit(['bug-ledger', 'policy', 'denied', 'false', 'n/a', '-', 'bug-ledger-missing']);
    }
    const inventory = join(REPORTS, 'test-inventory.tsv');
    const expectedBugs = join(REPORTS, 'expected-bugs.txt');
    if (!this.entries || this.globalErrors > 0) {
      // An incomplete collection must never be published as the inventory.
      rmSync(inventory, { force: true });
      rmSync(expectedBugs, { force: true });
      this.fail('the test collection is incomplete; no inventory was written');
      return;
    }
    const rows = this.entries.map((entry) => [
      entry.id,
      entry.lane,
      String(entry.regression),
      String(entry.quarantine),
      entry.resolved.length ? entry.resolved.join(',') : '-',
      entry.unresolved.length ? entry.unresolved.join(',') : '-',
      entry.disabled,
      entry.source,
    ].join('\t'));
    try {
      writeAtomic(inventory, rows.map((row) => `${row}\n`).join(''));
      writeAtomic(expectedBugs, ledger.confirmed.map((id) => `${id}\n`).join(''));
    } catch {
      this.fail('cannot write the inventory artifacts');
    }
  }

  emit(fields) {
    const result = spawnSync('bash', [OUTCOME_EVENT, ...fields], {
      cwd: ROOT,
      env: { ...process.env, ARGUS_OUTCOME_FILE: this.outcomeFile },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (result.error || result.status !== 0) this.fail(`outcome-event.sh rejected an event (exit ${result.status ?? 'spawn-error'})`);
    else this.events += 1;
  }

  fail(reason) {
    this.failures += 1;
    process.stderr.write(`argus-playwright-reporter: ${reason}\n`);
  }
}

// SD-5. Classify a failed attempt from Playwright's own signals: the step category that
// carries the terminal error, then the error class. Argus error names are checked before
// fixture and hook categories on purpose: an ArgusCleanupError thrown in fixture teardown
// is cleanup-failed (not fixture-failed), and the same holds for ArgusCounterfactualError
// and ArgusRestoreError, which are raised from fixture teardown by design.
function classifyFailure(result) {
  const terminal = result.errors?.[0] ?? result.error;
  if (!terminal) return ['automation', 'fail', 'uncaught-error'];
  const step = deepestStepWithError(result.steps ?? [], terminal);
  if (step?.category === 'expect') return 'product';
  const name = errorName(terminal);
  if (ARGUS_ERRORS.has(name)) return ARGUS_ERRORS.get(name);
  if (name === 'TimeoutError') return ['automation', 'fail', 'test-timeout'];
  if (isNetworkError(terminal)) return ['infrastructure', 'fail', 'target-unreachable'];
  if (step?.category === 'fixture') return ['automation', 'fail', 'fixture-failed'];
  if (step?.category === 'hook') return ['automation', 'fail', 'hook-failed'];
  if (step?.category === 'pw:api') return ['automation', 'fail', 'playwright-api-failed'];
  return ['automation', 'fail', 'uncaught-error'];
}

// The same error is attached to every enclosing step (for example `Before Hooks` and the
// fixture inside it), so only the deepest match names the real origin.
function deepestStepWithError(steps, terminal) {
  let best;
  let bestDepth = -1;
  const visit = (list, depth) => {
    for (const step of list) {
      if (step.error && sameError(step.error, terminal) && depth > bestDepth) {
        best = step;
        bestDepth = depth;
      }
      visit(step.steps ?? [], depth + 1);
    }
  };
  visit(steps, 0);
  return best;
}

function sameError(left, right) {
  if (left.message !== undefined || right.message !== undefined) return left.message === right.message;
  return left.value !== undefined && left.value === right.value;
}

function errorName(error) {
  const header = String(error.stack ?? error.message ?? '').replace(ANSI, '').split('\n', 1)[0];
  return /^([A-Za-z_$][\w$]*)(?::|$)/.exec(header)?.[1] ?? '';
}

function isNetworkError(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (NETWORK_ERROR.test(`${current.message ?? ''}\n${current.value ?? ''}`)) return true;
  }
  return false;
}

function hasCleanupError(result) {
  if ((result.errors ?? []).some((error) => errorName(error) === 'ArgusCleanupError')) return true;
  const visit = (steps) => steps.some((step) => (step.error && errorName(step.error) === 'ArgusCleanupError') || visit(step.steps ?? []));
  return visit(result.steps ?? []);
}

function hasAnnotation(test, result, type) {
  return [...(test.annotations ?? []), ...(result.annotations ?? [])].some((annotation) => annotation.type === type);
}

// Retries are disabled in every template; with retries configured, only the attempt after
// which Playwright schedules no further retry is classified.
function isFinalAttempt(test, result) {
  return result.status === 'skipped' || result.status === 'interrupted'
    || result.status === test.expectedStatus || result.retry >= test.retries;
}

// Static modifiers are visible at collection time. `test.fail` keeps expectedStatus
// `passed` until the test runs, so its annotation decides. A callback condition such as
// `test.skip(({ browserName }) => …)` leaves no collection-time trace, so the TypeScript
// adapter never reports `conditional`.
function disabledKind(test) {
  const types = new Set((test.annotations ?? []).map((annotation) => annotation.type));
  if (test.expectedStatus === 'skipped') return types.has('fixme') ? 'fixme' : 'skip';
  if (test.expectedStatus === 'failed' || types.has('fail')) return 'expected-failure';
  return '-';
}

// The Playwright project is the lane (SD-11). A browser or device variant named
// `<product-lane>-<variant>` (for example `ui-firefox`) belongs to its product lane.
function laneFor(project) {
  if (LANES.has(project)) return project;
  const prefix = PRODUCT_LANES.find((lane) => project.startsWith(`${lane}-`));
  return prefix ?? '-';
}

// SD-6 and SD-11: `@repetition:<n>` declares how often one invocation repeats the
// reproduction. The declaration must be one integer in 1..200, exactly 1 for a
// deterministic ledger entry, and at least the 95% detection bound for p = occurrences /
// attempts otherwise.
function repetitionFor(tags, bug) {
  const values = tags.filter((tag) => tag.startsWith('@repetition:')).map((tag) => tag.slice('@repetition:'.length));
  if (values.length > 1 || (values.length === 1 && !/^[1-9][0-9]{0,2}$/.test(values[0]))) return { n: 1, valid: false };
  const n = values.length ? Number(values[0]) : 1;
  const p = reproductionProbability(bug);
  if (p === null) return { n, valid: n === 1 };
  const bound = Math.min(MAX_REPETITION, Math.ceil(Math.log(0.05) / Math.log(1 - p)));
  return { n, valid: n <= MAX_REPETITION && n >= bound };
}

// null means deterministic: no usable reproduction record, or every attempt reproduced.
function reproductionProbability(bug) {
  const reproduction = bug?.verification?.reproduction;
  const attempts = reproduction?.attempts;
  const occurrences = reproduction?.occurrences;
  if (!Number.isInteger(attempts) || !Number.isInteger(occurrences) || occurrences < 1 || occurrences >= attempts) return null;
  return occurrences / attempts;
}

function safeToken(token) {
  const cleaned = token.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unsafe-token';
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
