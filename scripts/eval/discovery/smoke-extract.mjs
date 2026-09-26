#!/usr/bin/env node
// Evaluator-side extraction smoke: findings come from the canonical ledger and bug reports in a
// run's artifact root, never from the adapter. Scripted harness validation only; no Argus score.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileJsonSchema } from '../../../argus/runtime/json-schema.mjs';
import { classifyLedgerStatus, extractFindings, LEDGER_PATH, MAX_EXTRACT_BYTES } from './lib/extract.mjs';
import { evalSchema, formatSchemaErrors } from './lib/schemas.mjs';

// The packaged example ledger is kept valid against the canonical schema by the Argus schema
// gate, so this smoke follows the ledger version instead of pinning one.
const exampleLedger = JSON.parse(readFileSync(fileURLToPath(new URL('../../../argus/framework-template/solution/bug-ledger.example.json', import.meta.url)), 'utf8'));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-extract-')));
let cases = 0;

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function artifactRoot(name) {
  const root = join(work, name);
  mkdirSync(root, { mode: 0o700 });
  return root;
}

// Every extraction must fit the private-runs@2 extraction slot it is recorded in.
const validateExtraction = compileJsonSchema({ $defs: evalSchema('private-runs').$defs, $ref: '#/$defs/extraction' });
function assertExtractionShape(extraction) {
  const errors = validateExtraction(extraction);
  assert.deepEqual(errors, [], `extraction violates private-runs@2: ${formatSchemaErrors(errors)}`);
}

const STARTED = Date.UTC(2026, 0, 1, 12, 0, 0);
const ELAPSED = 60_000;
const at = offsetMs => new Date(STARTED + offsetMs);

try {
  // 1. Valid ledger: confirmed rows are findings, unproven rows are suspected, reports resolve
  // by origin (prefix or exact name, later origins included), and timing is clamped.
  {
    const root = artifactRoot('valid');
    const ledger = { ...exampleLedger, engagementId: 'extract-smoke' };
    write(root, LEDGER_PATH, JSON.stringify(ledger));
    utimesSync(join(root, LEDGER_PATH), at(90_000), at(90_000));
    const confirmed = ledger.bugs.filter(bug => bug.status === 'confirmed');
    const unproven = ledger.bugs.filter(bug => classifyLedgerStatus(bug.status) === 'suspected');
    assert(confirmed.length >= 1 && unproven.length >= 1, 'the example ledger must carry confirmed and unproven rows');
    const first = confirmed[0];
    write(root, `bugs/${first.origin[0]}-report.md`, '# confirmed\n');
    utimesSync(join(root, `bugs/${first.origin[0]}-report.md`), at(12_345), at(12_345));
    const multi = ledger.bugs.find(bug => bug.origin.length > 1);
    if (multi) write(root, `bugs/${multi.origin.at(-1)}.md`, '# merged origin\n');
    write(root, 'bugs/_TEMPLATE.md', '# template\n');
    write(root, 'bugs/PRO-901-unrelated.md', '# never entered in the ledger\n');
    const result = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assertExtractionShape(result);
    assert.equal(result.ledger, 'present');
    assert.deepEqual(result.ledgerErrors, []);
    assert.deepEqual(result.findings.map(item => item.id), confirmed.map(bug => bug.id));
    assert.deepEqual(result.suspected.map(item => item.id), unproven.map(bug => bug.id));
    const finding = result.findings[0];
    assert.equal(finding.reportPath, `bugs/${first.origin[0]}-report.md`);
    assert.equal(finding.confirmedAtMs, 12_345, 'confirmation time is the report mtime relative to the start');
    assert.deepEqual([finding.lane, finding.severity, finding.wired, finding.testId, finding.title], [first.lane, first.severity, first.wired, first.testId, first.title]);
    assert.deepEqual(finding.evidenceIds, first.evidenceIds);
    for (const row of result.suspected) assert.notEqual(row.status, 'confirmed');
    if (multi) {
      const row = [...result.findings, ...result.suspected].find(item => item.id === multi.id);
      assert.equal(row.reportPath, `bugs/${multi.origin.at(-1)}.md`, 'an exact <origin>.md report resolves for any origin');
      assert.equal(row.confirmedAtMs, ELAPSED, 'a modification after the run end clamps to elapsedMs');
    }
    for (const row of [...result.findings, ...result.suspected].filter(item => item.reportPath === null)) {
      assert.equal(row.confirmedAtMs, ELAPSED, 'without a report the ledger mtime (after the run end) is used and clamped');
    }
    assert.deepEqual(result.unledgeredReports, ['bugs/PRO-901-unrelated.md'], 'templates and ledgered reports are not unledgered');
    assert.deepEqual(result.framework, { root: null, candidates: 0 });

    // Without reports the ledger mtime is the confirmation time; earlier than the start clamps to 0.
    const ledgerOnly = artifactRoot('ledger-only');
    write(ledgerOnly, LEDGER_PATH, JSON.stringify(ledger));
    utimesSync(join(ledgerOnly, LEDGER_PATH), at(30_000), at(30_000));
    const timed = extractFindings(ledgerOnly, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assertExtractionShape(timed);
    assert([...timed.findings, ...timed.suspected].every(row => row.reportPath === null && row.confirmedAtMs === 30_000));
    utimesSync(join(ledgerOnly, LEDGER_PATH), at(-5_000), at(-5_000));
    assert(extractFindings(ledgerOnly, { startedAtMs: STARTED, elapsedMs: ELAPSED }).findings.every(row => row.confirmedAtMs === 0));
    cases++;
  }

  // 2. Invalid ledger: schema violations score as zero findings, with the errors recorded.
  {
    const root = artifactRoot('invalid');
    write(root, LEDGER_PATH, JSON.stringify({ ...exampleLedger, bugs: [{ id: 'BUG-1' }] }));
    write(root, 'bugs/ATA-001-thing.md', '# report\n');
    const result = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(result.ledger, 'invalid');
    assert(result.ledgerErrors.length > 0);
    assert.deepEqual([result.findings, result.suspected], [[], []]);
    assert.deepEqual(result.unledgeredReports, ['bugs/ATA-001-thing.md'], 'without a valid ledger every report is unledgered');
    write(root, LEDGER_PATH, '{"bugs": [');
    assert.match(extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED }).ledgerErrors[0], /not valid JSON/);
    const duplicate = { ...exampleLedger, bugs: [exampleLedger.bugs[0], exampleLedger.bugs[0]] };
    write(root, LEDGER_PATH, JSON.stringify(duplicate));
    const repeated = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(repeated.ledger, 'invalid');
    assert.match(repeated.ledgerErrors.join(' '), /repeats bug id|duplicate/);
    cases++;
  }

  // 3. Missing ledger: zero findings, not an error.
  {
    const root = artifactRoot('missing');
    const result = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.deepEqual(result, { ledger: 'missing', ledgerErrors: [], findings: [], suspected: [], unledgeredReports: [], framework: { root: null, candidates: 0 } });
    cases++;
  }

  // 4. Symbolic links are ignored: a linked report never resolves, a linked ledger is invalid,
  // and a linked bugs/ directory contributes nothing.
  {
    const outside = join(work, 'outside');
    write(outside, 'forged.md', '# forged outside the artifact root\n');
    write(outside, 'bug-ledger.json', JSON.stringify(exampleLedger));
    const root = artifactRoot('symlink');
    const first = exampleLedger.bugs.find(bug => bug.status === 'confirmed');
    write(root, LEDGER_PATH, JSON.stringify(exampleLedger));
    mkdirSync(join(root, 'bugs'));
    symlinkSync(join(outside, 'forged.md'), join(root, `bugs/${first.origin[0]}-aaa-link.md`));
    symlinkSync(join(outside, 'forged.md'), join(root, 'bugs/ZZZ-001-link.md'));
    write(root, `bugs/${first.origin[0]}-real.md`, '# real\n');
    const result = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(result.findings.find(item => item.id === first.id).reportPath, `bugs/${first.origin[0]}-real.md`, 'the linked report is skipped');
    assert(!result.unledgeredReports.includes('bugs/ZZZ-001-link.md'), 'a linked report is not counted');
    const linkedLedger = artifactRoot('symlink-ledger');
    mkdirSync(join(linkedLedger, 'solution'));
    symlinkSync(join(outside, 'bug-ledger.json'), join(linkedLedger, LEDGER_PATH));
    assert.equal(extractFindings(linkedLedger, { startedAtMs: STARTED, elapsedMs: ELAPSED }).ledger, 'invalid');
    const linkedDir = artifactRoot('symlink-dir');
    symlinkSync(outside, join(linkedDir, 'bugs'));
    symlinkSync(outside, join(linkedDir, 'solution'));
    const viaLinks = extractFindings(linkedDir, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(viaLinks.ledger, 'invalid', 'a ledger reached through a linked solution/ is not trusted');
    assert.deepEqual(viaLinks.unledgeredReports, []);
    cases++;
  }

  // 5. Unledgered reports: a report whose stem matches no ledger origin or id.
  {
    const root = artifactRoot('unledgered');
    write(root, LEDGER_PATH, JSON.stringify(exampleLedger));
    for (const bug of exampleLedger.bugs) write(root, `bugs/${bug.origin[0].toLowerCase()}-case-insensitive.md`, '# ledgered\n');
    write(root, `bugs/${exampleLedger.bugs[0].id}.md`, '# named after the canonical id\n');
    write(root, 'bugs/HER-004-orphan.md', '# orphan\n');
    write(root, 'bugs/notes.txt', 'not a report\n');
    write(root, 'bugs/nested/ATA-777-deep.md', '# only top-level reports count\n');
    assert.deepEqual(extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED }).unledgeredReports, ['bugs/HER-004-orphan.md']);
    cases++;
  }

  // 6. Framework detection: run-tests.sh plus scripts/runner-contract.sh, breadth first to depth 4,
  // skipping node_modules, ai_agents_internal and reports.
  {
    const root = artifactRoot('framework');
    const framework = dir => {
      write(root, `${dir}/run-tests.sh`, '#!/usr/bin/env bash\n');
      write(root, `${dir}/scripts/runner-contract.sh`, '#!/usr/bin/env bash\n');
    };
    framework('harness');
    framework('a/b/c/second');
    framework('node_modules/pkg');
    framework('ai_agents_internal/copy');
    framework('reports/copy');
    framework('a/b/c/d/too-deep');
    write(root, 'half/run-tests.sh', '#!/usr/bin/env bash\n');
    assert.deepEqual(extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED }).framework, { root: 'harness', candidates: 2 });
    const atRoot = artifactRoot('framework-root');
    write(atRoot, 'run-tests.sh', '#!/usr/bin/env bash\n');
    write(atRoot, 'scripts/runner-contract.sh', '#!/usr/bin/env bash\n');
    assert.deepEqual(extractFindings(atRoot, { startedAtMs: STARTED, elapsedMs: ELAPSED }).framework, { root: '.', candidates: 1 });
    const linked = artifactRoot('framework-link');
    symlinkSync(root, join(linked, 'harness'));
    assert.deepEqual(extractFindings(linked, { startedAtMs: STARTED, elapsedMs: ELAPSED }).framework, { root: null, candidates: 0 }, 'linked directories are not traversed');
    cases++;
  }

  // 7. Oversize files are ignored: an oversize report is skipped, an oversize ledger is invalid.
  {
    const root = artifactRoot('oversize');
    const first = exampleLedger.bugs.find(bug => bug.status === 'confirmed');
    write(root, LEDGER_PATH, JSON.stringify(exampleLedger));
    write(root, `bugs/${first.origin[0]}-big.md`, 'x'.repeat(MAX_EXTRACT_BYTES + 1));
    write(root, 'bugs/PRO-002-big.md', 'x'.repeat(MAX_EXTRACT_BYTES + 1));
    const result = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(result.findings.find(item => item.id === first.id).reportPath, null);
    assert.deepEqual(result.unledgeredReports, []);
    write(root, LEDGER_PATH, `${JSON.stringify(exampleLedger)}${' '.repeat(MAX_EXTRACT_BYTES)}`);
    const big = extractFindings(root, { startedAtMs: STARTED, elapsedMs: ELAPSED });
    assert.equal(big.ledger, 'invalid');
    assert.match(big.ledgerErrors[0], /exceeds/);
    cases++;
  }

  // 8. Ledger status classes cover bug-ledger@2: bounced and quarantined rows are unproven;
  // duplicate and rejected rows are not candidates.
  {
    assert.deepEqual(['confirmed', 'suspected', 'needs-oracle', 'bounced', 'quarantined', 'duplicate', 'rejected', 'invented'].map(classifyLedgerStatus),
      ['finding', 'suspected', 'suspected', 'suspected', 'suspected', 'excluded', 'excluded', null]);
    assert.throws(() => extractFindings(work, { startedAtMs: STARTED }), /elapsedMs/);
    cases++;
  }

  console.log(`PASS  evaluator-side extraction: ${cases} cases (valid, invalid and missing ledgers, symbolic links, unledgered reports, framework detection, oversize files, ledger@2 status classes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
