#!/usr/bin/env node
// Scripted checks for score-against-key.mjs: v2 verdict files, finding keys, precision,
// contested verdicts and exit codes. Every fixture is synthetic and built in a temp directory;
// no private answer key, target or real engagement is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scorer = fileURLToPath(new URL('./score-against-key.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'argus-score-key-'));

const BUG_FILES = {
  'ATA-001-a.md': '# ATA-001 Password hash returned in the profile response\n\n- **Lane:** api\n\nGET /api/profile returns the password hash of the caller.\n',
  'ATA-002-b.md': '# ATA-002 Negative quantity accepted\n\n- **Lane:** api\n\nPOST /api/orders accepts a negative quantity and credits the account.\n',
  'PRO-001-c.md': '# PRO-001 Login response lacks a retry header\n\n- **Lane:** api\n\nA rejected login returns no retry header.\n',
};

function ledgerRow(id, origin, title) {
  return {
    id, origin: [origin], title, severity: 'Major', priority: 'P2', lane: 'minos',
    oracleId: 'ORC-API-001', status: 'confirmed', wired: false, testId: null, evidenceIds: ['EVD-0001'],
  };
}

function engagementRoot(name, { ledger, files = BUG_FILES }) {
  const root = join(work, name);
  mkdirSync(join(root, 'bugs'), { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(root, 'bugs', file), body);
  if (ledger) {
    mkdirSync(join(root, 'solution'), { recursive: true });
    writeFileSync(join(root, 'solution', 'bug-ledger.json'), JSON.stringify({
      $schema: 'argus/bug-ledger@1', schemaVersion: 1, engagementId: 'smoke-score-key', bugs: ledger,
    }, null, 2));
  }
  return root;
}

const ledgerRun = engagementRoot('ledger-run', {
  ledger: [
    ledgerRow('BUG-0001', 'ATA-001', 'Password hash returned in the profile response'),
    ledgerRow('BUG-0002', 'ATA-002', 'Negative quantity accepted'),
  ],
});
const bareRun = engagementRoot('bare-run', {});
const emptyRun = engagementRoot('empty-run', { files: {} });

const keyPath = join(work, 'answer-key.json');
writeFileSync(keyPath, JSON.stringify({
  keyId: 'smoke-key',
  maximum: 4,
  entries: [
    { id: '01', title: 'Password hash exposed', layer: 'L1', points: 2, keywords: ['password', 'hash'] },
    { id: '02', title: 'Negative quantity accepted', layer: 'L1', points: 1, keywords: ['negative', 'quantity'] },
    { id: '03', title: 'Login brute force not throttled', layer: 'L2', points: 1, keywords: ['throttle'] },
  ],
}, null, 2));

const COMPLETE = Object.freeze({
  entries: {
    '01': { credit: 'full', reason: 'The response body carries the hash field', matchedBy: 'ATA-001-a.md' },
    '02': { credit: 'partial', reason: 'Negative quantity shown, credit side effect not shown', matchedBy: 'BUG-0002' },
    '03': { credit: 'miss', reason: 'No report covers login throttling' },
  },
  findings: {
    'BUG-0001': { outcome: 'real', reason: 'Reproduced from the attached response', entryIds: ['01'] },
    'BUG-0002': { outcome: 'real', reason: 'Reproduced with quantity -1', entryIds: ['02'] },
    'PRO-001-c.md': { outcome: 'false-positive', reason: 'The contract does not require a retry header' },
  },
});

let counter = 0;
function verdictFile(document) {
  counter += 1;
  const path = join(work, `verdicts-${counter}.json`);
  writeFileSync(path, JSON.stringify(document, null, 2));
  return path;
}

function variant(mutate) {
  const document = structuredClone(COMPLETE);
  mutate(document);
  return verdictFile(document);
}

function score(args) {
  const env = { ...process.env };
  delete env.ARGUS_ANSWER_KEY;
  return spawnSync(process.execPath, [scorer, '--key', keyPath, ...args], { encoding: 'utf8', timeout: 30_000, env });
}

function expectExit(result, status, label) {
  assert.equal(result.status, status,
    `${label}: expected exit ${status}, got ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  return result;
}

function scoreJson(args, status, label) {
  const result = expectExit(score([...args, '--json']), status, label);
  try { return JSON.parse(result.stdout); }
  catch (error) { assert.fail(`${label}: --json stdout is not JSON (${error.message})\n${result.stdout}`); }
}

function contestedKinds(report) {
  return report.contested.map((item) => `${item.kind}:${item.entry ?? item.ids.join('+')}:${item.finding ?? item.source}`);
}

try {
  const complete = verdictFile(COMPLETE);

  // A complete v2 file: every entry credited, every finding judged, the halves agree.
  const text = expectExit(score(['--run', ledgerRun, '--verdicts', complete]), 0, 'complete v2');
  assert.match(text.stdout, /full 1 \/ partial 1 \/ miss 1 — 2\.5 of 4 points/);
  assert.ok(text.stdout.includes('findings: 2 real / 1 false-positive / 0 duplicate / 0 unadjudicated — precision 0.667 (2 of 3 adjudicated)'),
    `complete v2: findings line missing\n${text.stdout}`);
  assert.match(text.stdout, /\| BUG-0001 \| bug-ledger\[0\]; ATA-001-a\.md \| real \|/);

  const report = scoreJson(['--run', ledgerRun, '--verdicts', complete], 0, 'complete v2 --json');
  assert.equal(report.verdictFormat, 'v2');
  assert.equal(report.complete, true);
  assert.equal(report.scored, 2.5);
  assert.deepEqual(report.contested, []);
  const { rows: findingRows, ...findingTotals } = report.findings;
  assert.deepEqual(findingTotals, {
    total: 3, real: 2, falsePositive: 1, duplicate: 0, unadjudicated: 0,
    precision: 2 / (2 + 1 + 0), confirmedPrecision: 1, byStatus: { confirmed: 2, none: 1 }, withdrawn: [],
    keys: ['BUG-0001', 'BUG-0002', 'PRO-001-c.md'],
  });
  assert.deepEqual(findingRows.map((row) => [row.key, row.kind, row.files, row.status]), [
    ['BUG-0001', 'ledger', ['ATA-001-a.md'], 'confirmed'],
    ['BUG-0002', 'ledger', ['ATA-002-b.md'], 'confirmed'],
    ['PRO-001-c.md', 'bug-file', ['PRO-001-c.md'], null],
  ]);
  assert.deepEqual(report.rows.map((row) => row.matchedFindings), [['BUG-0001'], ['BUG-0002'], []]);
  console.log('PASS  complete v2 verdicts: exit 0, precision 2/3, ledger twins counted once, --json findings block');

  // A duplicate is adjudicated but never real.
  const duplicate = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.findings['PRO-001-c.md'] = { outcome: 'duplicate', reason: 'Repeats BUG-0001', duplicateOf: 'BUG-0001' };
  })], 0, 'duplicate outcome');
  assert.equal(duplicate.findings.duplicate, 1);
  assert.equal(duplicate.findings.precision, 2 / 3);
  console.log('PASS  duplicate outcome counts against precision');

  // A missing finding outcome leaves the run UNSCORED.
  const missingOutcome = variant((document) => { delete document.findings['PRO-001-c.md']; });
  const unscored = expectExit(score(['--run', ledgerRun, '--verdicts', missingOutcome]), 20, 'missing finding outcome');
  assert.match(unscored.stdout, /UNSCORED — 1 of 3 findings have no outcome\./);
  assert.match(unscored.stdout, /Findings without an outcome: PRO-001-c\.md/);
  const unscoredReport = scoreJson(['--run', ledgerRun, '--verdicts', missingOutcome], 20, 'missing finding outcome --json');
  assert.equal(unscoredReport.complete, false);
  assert.equal(unscoredReport.scored, null);
  assert.equal(unscoredReport.findings.unadjudicated, 1);
  assert.equal(unscoredReport.findings.precision, 1, 'precision is measured over adjudicated findings only');
  console.log('PASS  missing finding outcome: exit 20, the unadjudicated key is named');

  // A legacy v1 file carries entry verdicts only.
  const legacy = verdictFile(COMPLETE.entries);
  const legacyRun = expectExit(score(['--run', ledgerRun, '--verdicts', legacy]), 20, 'legacy v1');
  assert.match(legacyRun.stderr, /legacy v1 verdict file/);
  assert.match(legacyRun.stdout, /UNSCORED — 3 of 3 findings have no outcome\./);
  const entriesOnly = expectExit(score(['--run', ledgerRun, '--verdicts', legacy, '--entries-only']), 0, 'legacy v1 --entries-only');
  assert.ok(entriesOnly.stdout.includes('precision not measured (--entries-only)'), entriesOnly.stdout);
  assert.doesNotMatch(entriesOnly.stdout, /^findings:/m);
  const entriesOnlyReport = scoreJson(['--run', ledgerRun, '--verdicts', legacy, '--entries-only'], 0, 'legacy v1 --entries-only --json');
  assert.equal(entriesOnlyReport.verdictFormat, 'legacy');
  assert.equal(entriesOnlyReport.entriesOnly, true);
  assert.equal(entriesOnlyReport.scored, 2.5);
  assert.equal(entriesOnlyReport.findings.precision, null);
  console.log('PASS  legacy v1 verdicts: exit 20, exit 0 with --entries-only and precision not measured');

  // Credit earned through a finding the same file rejects is contested, by every name.
  const throughFalsePositive = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.entries['02'].matchedBy = 'PRO-001-c.md';
  })], 21, 'credit through a false-positive finding');
  assert.deepEqual(contestedKinds(throughFalsePositive), ['credit-through-non-real-finding:02:PRO-001-c.md']);
  for (const [name, matchedBy] of [['bug file behind a ledger row', 'ATA-001-a.md'], ['finding key', 'BUG-0001'],
    ['triage label', 'bug-ledger[0]'], ['stem without suffix', 'ata-001-a']]) {
    const contested = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
      document.entries['01'].matchedBy = matchedBy;
      document.findings['BUG-0001'] = { outcome: 'false-positive', reason: 'The field is a salted placeholder' };
    })], 21, `credit through a false-positive ledger row by ${name}`);
    assert.deepEqual(contestedKinds(contested), ['credit-through-non-real-finding:01:BUG-0001'], name);
  }
  const throughDuplicate = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.findings['BUG-0002'] = { outcome: 'duplicate', reason: 'Same root cause as BUG-0001', duplicateOf: 'BUG-0001' };
  })], 21, 'credit through a duplicate finding');
  assert.deepEqual(contestedKinds(throughDuplicate), ['credit-through-non-real-finding:02:BUG-0002']);
  const text21 = expectExit(score(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.entries['02'].matchedBy = 'PRO-001-c.md';
  })]), 21, 'credit through a false-positive finding (text)');
  assert.match(text21.stdout, /CONTESTED {2}entry 02 is credited partial through PRO-001-c\.md, which is judged false-positive/);
  console.log('PASS  entry credited through a false-positive or duplicate finding: exit 21 by key, bug file, label and stem');

  // A real finding that claims an entry judged miss is contested.
  const coversMiss = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.findings['BUG-0002'].entryIds = ['02', '03'];
  })], 21, 'real finding covers a missed entry');
  assert.deepEqual(contestedKinds(coversMiss), ['real-finding-covers-missed-entry:03:BUG-0002']);
  console.log('PASS  real finding claiming an entry judged miss: exit 21');

  // Two entries credited through one report are grouped by finding key, whatever alias they use.
  const shared = scoreJson(['--run', ledgerRun, '--verdicts', variant((document) => {
    document.entries['02'].matchedBy = 'BUG-0001';
    document.findings['BUG-0001'].entryIds = ['01', '02'];
    document.findings['BUG-0002'].entryIds = [];
  })], 21, 'shared verdict through aliases');
  assert.deepEqual(contestedKinds(shared), ['shared-verdict:01+02:BUG-0001']);
  console.log('PASS  one finding credited to two entries under different aliases: exit 21 shared-verdict');

  // With no ledger every bug file is its own finding, keyed by basename.
  const bare = scoreJson(['--run', bareRun, '--verdicts', verdictFile({
    entries: {
      ...COMPLETE.entries,
      '02': { ...COMPLETE.entries['02'], matchedBy: 'ATA-002-b.md' },
    },
    findings: {
      'ATA-001-a.md': { outcome: 'real', reason: 'Reproduced from the attached response', entryIds: ['01'] },
      'ATA-002-b.md': { outcome: 'real', reason: 'Reproduced with quantity -1' },
      'PRO-001-c.md': { outcome: 'false-positive', reason: 'The contract does not require a retry header' },
    },
  })], 0, 'no ledger');
  assert.deepEqual(bare.findings.keys, ['ATA-001-a.md', 'ATA-002-b.md', 'PRO-001-c.md']);
  assert.equal(bare.findings.precision, 2 / 3);
  const staleKeys = expectExit(score(['--run', bareRun, '--verdicts', complete]), 20, 'ledger keys against a run without a ledger');
  assert.match(staleKeys.stderr, /finding verdict BUG-0001 names no ledger row or bug file in this run/);
  console.log('PASS  run without a ledger: findings keyed by bug-file basename; stale ledger keys stay unadjudicated');

  // An empty run with every entry missed is a legitimate complete result, not a precision.
  const empty = expectExit(score(['--run', emptyRun, '--verdicts', verdictFile({
    entries: Object.fromEntries(['01', '02', '03'].map((id) => [id, { credit: 'miss', reason: 'No report filed' }])),
    findings: {},
  })]), 0, 'empty run');
  assert.ok(empty.stdout.includes('findings: 0 real / 0 false-positive / 0 duplicate / 0 unadjudicated — precision not measured (no adjudicated findings)'),
    empty.stdout);
  console.log('PASS  empty run: exit 0, precision not measured');

  // Malformed finding verdicts are input errors, never silently scored.
  const malformed = [
    ['unknown outcome', (document) => { document.findings['PRO-001-c.md'].outcome = 'maybe'; }, /outcome must be real, false-positive or duplicate/],
    ['missing reason', (document) => { document.findings['BUG-0001'].reason = ' '; }, /needs a reason/],
    ['duplicate without duplicateOf', (document) => { document.findings['PRO-001-c.md'] = { outcome: 'duplicate', reason: 'Repeat' }; }, /must name the finding it repeats/],
    ['self duplicate', (document) => { document.findings['PRO-001-c.md'] = { outcome: 'duplicate', reason: 'Repeat', duplicateOf: 'PRO-001-c.md' }; }, /cannot duplicate itself/],
    ['duplicateOf on a real finding', (document) => { document.findings['BUG-0001'].duplicateOf = 'BUG-0002'; }, /duplicateOf is valid only on a duplicate outcome/],
    ['unknown entry id', (document) => { document.findings['BUG-0001'].entryIds = ['99']; }, /entryIds names 99/],
    ['unknown top-level field', (document) => { document.finding = document.findings; delete document.findings; }, /unknown top-level field finding/],
  ];
  for (const [name, mutate, message] of malformed) {
    const result = expectExit(score(['--run', ledgerRun, '--verdicts', variant(mutate)]), 1, name);
    assert.match(result.stderr, message, name);
  }
  console.log(`PASS  ${malformed.length} malformed finding verdicts: exit 1`);

  // bug-ledger@2 statuses: rows Minos withdrew (duplicate, rejected) are no findings but still
  // claim their bug files; a suspected row stays a finding and is counted per status.
  {
    const triageRun = engagementRoot('triage-run', {
      files: {
        ...BUG_FILES,
        'ATA-003-d.md': '# ATA-003 Password hash returned again\n\n- **Lane:** api\n\nThe profile response carries the password hash.\n',
        'PRO-004-e.md': '# PRO-004 Negative quantity rounding\n\n- **Lane:** api\n\nA negative quantity is rounded.\n',
      },
      ledger: [
        ledgerRow('BUG-0001', 'ATA-001', 'Password hash returned in the profile response'),
        { ...ledgerRow('BUG-0002', 'ATA-002', 'Negative quantity accepted'), status: 'suspected' },
        { ...ledgerRow('BUG-0003', 'ATA-003', 'Password hash returned again'), status: 'duplicate', duplicateOf: 'BUG-0001' },
        { ...ledgerRow('BUG-0004', 'PRO-004', 'Negative quantity rounding'), status: 'rejected' },
      ],
    });
    // The v2 file judges the reported findings only; Minos's own withdrawals need no outcome.
    const triaged = scoreJson(['--run', triageRun, '--verdicts', complete], 0, 'duplicate and rejected ledger rows');
    assert.equal(triaged.complete, true);
    assert.deepEqual(triaged.findings.keys, ['BUG-0001', 'BUG-0002', 'PRO-001-c.md'], 'withdrawn rows are not findings');
    assert.deepEqual(triaged.findings.withdrawn, [
      { key: 'BUG-0003', status: 'duplicate', files: ['ATA-003-d.md'] },
      { key: 'BUG-0004', status: 'rejected', files: ['PRO-004-e.md'] },
    ], 'withdrawn rows still claim their bug files');
    assert.deepEqual([triaged.findings.total, triaged.findings.real, triaged.findings.falsePositive, triaged.findings.duplicate], [3, 2, 1, 0]);
    assert.equal(triaged.findings.precision, 2 / 3, 'withdrawn rows never cost precision');
    assert.deepEqual(triaged.findings.byStatus, { confirmed: 1, suspected: 1, none: 1 }, 'a suspected row is a finding, counted per status');
    assert.equal(triaged.findings.confirmedPrecision, 1, 'confirmed-only precision matches the discovery evaluator definition');
    const text = expectExit(score(['--run', triageRun, '--verdicts', complete]), 0, 'duplicate and rejected ledger rows (text)');
    assert.ok(text.stdout.includes('findings: 2 real / 1 false-positive / 0 duplicate / 0 unadjudicated — precision 0.667 (2 of 3 adjudicated)'), text.stdout);
    assert.ok(text.stdout.includes('findings by ledger status: 1 confirmed, 1 suspected, 1 none; withdrawn rows: 2; confirmed-only precision 1.000'), text.stdout);
    assert.ok(text.stdout.includes('Withdrawn ledger rows (not findings, no outcome needed): BUG-0003 (duplicate), BUG-0004 (rejected)'), text.stdout);
    assert.doesNotMatch(text.stdout, /\| (?:ATA-003-d|PRO-004-e)\.md \|/, 'a withdrawn row\'s bug file is not an unledgered finding');

    // A suspected row without an outcome still leaves the run UNSCORED.
    const suspectedMissing = expectExit(score(['--run', triageRun, '--verdicts', variant((document) => { delete document.findings['BUG-0002']; })]),
      20, 'suspected row without an outcome');
    assert.match(suspectedMissing.stdout, /Findings without an outcome: BUG-0002$/m);

    // A stale verdict for a withdrawn row is ignored with a warning; credit through one is contested.
    const staleWithdrawn = expectExit(score(['--run', triageRun, '--verdicts', variant((document) => {
      document.findings['BUG-0003'] = { outcome: 'duplicate', reason: 'Repeats BUG-0001', duplicateOf: 'BUG-0001' };
    })]), 0, 'verdict for a withdrawn row');
    assert.match(staleWithdrawn.stderr, /finding verdict BUG-0003 names a ledger row withdrawn as duplicate, which is not a reported finding/);
    for (const matchedBy of ['BUG-0004', 'PRO-004-e.md']) {
      const throughWithdrawn = scoreJson(['--run', triageRun, '--verdicts', variant((document) => {
        document.entries['02'].matchedBy = matchedBy;
      })], 21, `credit through a withdrawn row by ${matchedBy}`);
      assert.deepEqual(contestedKinds(throughWithdrawn), ['credit-through-withdrawn-row:02:BUG-0004'], matchedBy);
    }
    console.log('PASS  bug-ledger@2 statuses: duplicate and rejected rows need no outcome, never cost precision and still claim their bug files; suspected rows are counted per status; credit through a withdrawn row is contested');
  }

  // A nonexistent run fails loudly instead of printing an all-miss table.
  const missingRun = expectExit(score(['--run', join(work, 'no-such-run'), '--verdicts', complete]), 1, 'nonexistent run');
  assert.match(missingRun.stderr, /is not a directory/);
  console.log('PASS  nonexistent run: exit 1');

  // `make eval OVERRIDES=...` passes --overrides; the alias reads the same v2 file.
  const overrides = scoreJson(['--run', ledgerRun, '--overrides', complete], 0, '--overrides alias');
  assert.equal(overrides.verdictFile, complete);
  assert.equal(overrides.findings.precision, 2 / 3);
  expectExit(score(['--run', ledgerRun, '--candidates-only']), 0, '--candidates-only without verdicts');
  console.log('PASS  --overrides alias and --candidates-only');
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('PASS  score-against-key: entries and findings adjudicated, precision and contested verdicts enforced. Synthetic fixtures only; no Argus model score claimed.');
