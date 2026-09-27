#!/usr/bin/env node
// Score one Argus engagement against a PRIVATE answer key.
//
// The key is never committed to this repository. Point ARGUS_ANSWER_KEY at a JSON file that
// lives outside the tree (or pass --key). Nothing in argus/ may reference a concrete target,
// defect, or value from it.
//
//   node scripts/eval/score-against-key.mjs --run <engagement-root> [--key <path>]
//                                           [--verdicts <path>] [--json] [--candidates-only]
//                                           [--entries-only]
//
// `--overrides <path>` is an alias of `--verdicts <path>`, kept for `make eval OVERRIDES=...`.
//
// WHY THIS TOOL DOES NOT SCORE BY ITSELF
//
// Keyword overlap cannot decide whether a report covers a seeded defect. Measured on three
// real engagements, the previous keyword-ratio scorer credited a report about a scoring flag
// with a full hit on an e-mail-validation defect, because the report happened to mention the
// registration endpoint once. It returned 64.5 of 65 for a run whose criteria-based score was
// 37 of 65. A grader that reports green without proof is the same failure this framework
// exists to prevent, so search here is TRIAGE ONLY: it proposes candidate documents and shows
// the matched evidence. Credit comes exclusively from a human-or-model verdict file whose
// author has read the acceptance criteria of the key entry and the body of the candidate.
//
// An entry with no verdict is `unadjudicated`. Unadjudicated entries are never counted as
// earned, never counted as missed, and their presence makes the run UNSCORED with a non-zero
// exit code.
//
// WHAT IS SCORED
//
// Both sides of a run are adjudicated. Every key entry gets a credit (full | partial | miss),
// which yields the points. Every finding the run reported gets an outcome (real |
// false-positive | duplicate), which yields precision. A run that files twenty reports to
// earn three hits is not the run that files three, and only precision tells them apart.
// A finding with no outcome is `unadjudicated` and makes the run UNSCORED exactly like an
// entry with no verdict.
//
// Finding keys, the names a verdict file uses for reported findings:
//   - with solution/bug-ledger.json: one finding per ledger row, keyed by its id (BUG-NNNN;
//     a row without an id is keyed by its triage label `bug-ledger[i]`). A bug file whose
//     name is a row's id or origin, alone or followed by `-<slug>` (ATA-001-a.md), is that
//     row's report, not a separate finding;
//   - plus every bug file that matches no ledger row, keyed by its basename (PRO-001-c.md);
//   - with no ledger: every bug file, keyed by its basename.
//
// Ledger rows are classified with the discovery evaluator's status table (classifyLedgerStatus
// in discovery/lib/extract.mjs). Rows Minos withdrew, bug-ledger@2 status `duplicate` or
// `rejected`, are NOT reported findings: they need no outcome and never cost precision, but
// they still claim their bug files, so those files are not re-counted as unledgered findings.
// Crediting a key entry through a withdrawn row is contested. Every other row is a finding:
// confirmed, the unproven statuses (suspected, needs-oracle, bounced, quarantined), and a row
// with a missing or unknown status, which is never dropped silently.
//
// precision = real / (real + false-positive + duplicate), over adjudicated findings only:
// confirmed rows, unproven rows, rows without a known status, and unledgered bug files, the
// candidate set the Argus final summary headline counts (confirmed plus suspected). It is null
// when no finding is adjudicated (an empty run, or --entries-only). A duplicate is never
// real: the first report earns the finding, every repeat costs precision. confirmedPrecision
// is the same ratio over confirmed rows only, the definition the discovery evaluator scores
// (scripts/eval/discovery/README.md); findings.byStatus counts the findings per ledger status
// (`none` for bug files and rows without a status) and findings.withdrawn lists the withdrawn
// rows.
//
// Key file shape:
// {
//   "keyId": "loanflow-2026-08",
//   "maximum": 65,
//   "entries": [
//     { "id": "01", "title": "...", "layer": "L1", "points": 1, "partialPoints": 0,
//       "keywords": ["email", "format"], "oracleIds": ["ORC-VAL-001"],
//       "components": ["atalanta"] }   components rank a candidate, they never decide credit
//   ]
// }
//
// `partialPoints` is what a partial credit is worth for that entry. Set it explicitly when
// the key defines its own partial scale; it defaults to half the entry's points.
//
// Verdict file v2 (one row per key entry and one per finding, written after reading the
// acceptance criteria and the body of each report):
// {
//   "entries": {
//     "01": { "credit": "full", "reason": "...", "matchedBy": "ATA-004-password-hash-leak.md" }
//   },
//   "findings": {
//     "BUG-0001":     { "outcome": "real", "reason": "...", "entryIds": ["01"] },
//     "BUG-0002":     { "outcome": "duplicate", "reason": "...", "duplicateOf": "BUG-0001" },
//     "PRO-001-c.md": { "outcome": "false-positive", "reason": "..." }
//   }
// }
//   credit: full | partial | miss. matchedBy names the finding that earns the credit: by its
//     key, by the basename of the bug file behind a ledger row, or by its triage label.
//   outcome: real | false-positive | duplicate. Every verdict needs a reason. A duplicate
//     must name the finding it repeats in duplicateOf. entryIds (optional) lists the key
//     entries a finding covers.
//
// A legacy v1 file, entry verdicts at the top level ({ "01": { "credit": ... } }), is read as
// entry verdicts only, so every finding stays unadjudicated. --entries-only scores the entries
// without requiring finding outcomes and prints `precision not measured (--entries-only)`.
//
// Contested verdicts are surfaced for a human to resolve, never silently scored:
//   - one finding carries the verdict for several credited entries (it may genuinely cover
//     both, so it is confirmed, not rejected);
//   - an entry credited full or partial through a finding judged false-positive or duplicate;
//   - an entry credited full or partial through a ledger row Minos withdrew (duplicate or
//     rejected), which the run does not report;
//   - a finding judged real whose entryIds include an entry judged miss.
//
// Exit codes:
//   0   fully adjudicated and consistent (always 0 with --candidates-only)
//   20  UNSCORED: an entry has no verdict, or a finding has no outcome (unless --entries-only)
//   21  contested verdicts left unresolved
//   1   usage or input error: missing run, unreadable key, malformed verdict file

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { classifyLedgerStatus } from './discovery/lib/extract.mjs';

const CREDITS = Object.freeze(['full', 'partial', 'miss']);
const OUTCOMES = Object.freeze(['real', 'false-positive', 'duplicate']);
const CANDIDATE_LIMIT = 3;
const STRONG_CANDIDATE = 0.75;

const args = parseArgs(process.argv.slice(2));
const runRoot = resolve(required(args.run, '--run <engagement-root> is required'));
const keyPath = resolve(args.key ?? process.env.ARGUS_ANSWER_KEY
  ?? fail('answer key path is required: pass --key or set ARGUS_ANSWER_KEY'));
const key = readJson(keyPath);
assert(Array.isArray(key.entries) && key.entries.length > 0, `${keyPath}: key has no entries`);
const verdictPath = args.verdicts ?? args.overrides;
if (verdictPath === true) fail('--verdicts <path> (or --overrides <path>) needs a path');
const candidatesOnly = Boolean(args['candidates-only']);
const entriesOnly = Boolean(args['entries-only']);
const warnings = [];
const verdicts = verdictPath
  ? normalizeVerdicts(readJson(resolve(verdictPath)), verdictPath)
  : { format: null, entries: {}, findings: {} };
if (verdicts.format === 'legacy' && !entriesOnly && !candidatesOnly) {
  warn(`${verdictPath} is a legacy v1 verdict file — read as entry verdicts only; finding outcomes need the v2 shape { entries, findings }, or pass --entries-only`);
}

// A typo or a deleted engagement must fail loudly. An all-miss table is a legitimate
// result for a real run that found nothing, so it may never double as an error report.
if (!isDirectory(runRoot)) fail(`--run ${runRoot} is not a directory`);
if (!isDirectory(join(runRoot, 'bugs')) && !isDirectory(join(runRoot, 'solution'))) {
  fail(`--run ${runRoot} has neither bugs/ nor solution/ — not an Argus engagement root`);
}
const ledgerPresent = existsSync(join(runRoot, 'solution', 'bug-ledger.json'));
if (!ledgerPresent) {
  warn('solution/bug-ledger.json not found — triaging bugs/ only; Minos has not written the canonical ledger yet');
}

const bugFiles = listBugFiles(join(runRoot, 'bugs'));
const ledger = readLedger(join(runRoot, 'solution', 'bug-ledger.json'));
const fileDocuments = bugFiles.map((path) => describeDocument(basename(path), readFileSync(path, 'utf8')));
const documents = [
  ...fileDocuments,
  ...ledger.map((entry, index) => {
    const doc = describeDocument(`bug-ledger[${index}]`, JSON.stringify(entry));
    // A ledger row is a twin of the bug file it originates from, and carries no component
    // of its own — its own `lane` names a hunter, not a component. Inherit from the file
    // it points at, so the twin ranks the same way the file does.
    for (const component of inheritedComponents(entry, fileDocuments)) doc.components.add(component);
    return doc;
  }),
];
if (documents.length === 0) {
  warn('no documents to triage — this reflects an empty run, not a triage failure');
}

const entryIds = new Set(key.entries.map((entry) => String(entry.id)));
const { findings, withdrawn } = deriveFindings(ledgerPresent, ledger, bugFiles.map((path) => basename(path)));
const findingKeys = new Set(findings.map((finding) => finding.key));
const findingReferences = indexFindingReferences(findings);
const withdrawnReferences = indexFindingReferences(withdrawn);
reportStaleVerdicts(verdicts, entryIds, findingKeys, withdrawn);

const rows = key.entries.map((entry) => adjudicate(entry, documents, ownValue(verdicts.entries, entry.id)));
for (const row of rows) Object.assign(row, resolveMatchedFindings(row, findingReferences, withdrawnReferences));
const findingRows = findings.map((finding) =>
  adjudicateFinding(finding, ownValue(verdicts.findings, finding.key), entryIds, findingKeys));
const contested = [
  ...reportContestedVerdicts(rows, findingReferences),
  ...reportInconsistentFindings(rows, findingRows, withdrawn),
];
const adjudicated = rows.filter((row) => row.credit !== 'unadjudicated');
const unadjudicated = rows.filter((row) => row.credit === 'unadjudicated');
const earned = adjudicated.reduce((sum, row) => sum + row.earned, 0);
const maximum = key.maximum ?? key.entries.reduce((sum, entry) => sum + entry.points, 0);
const adjudicatedMaximum = adjudicated.reduce((sum, row) => sum + row.points, 0);
const counts = { full: 0, partial: 0, miss: 0, unadjudicated: 0 };
for (const row of rows) counts[row.credit] += 1;
const findingSummary = summarizeFindings(findingRows, withdrawn, entriesOnly);
const unadjudicatedFindings = findingRows.filter((row) => row.outcome === 'unadjudicated');
const findingsComplete = entriesOnly || unadjudicatedFindings.length === 0;
const complete = unadjudicated.length === 0 && findingsComplete;
const exitCode = candidatesOnly ? 0 : !complete ? 20 : contested.length > 0 ? 21 : 0;

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    keyId: key.keyId ?? basename(keyPath),
    runRoot,
    verdictFile: verdictPath ? resolve(verdictPath) : null,
    verdictFormat: verdicts.format,
    entriesOnly,
    complete,
    scored: complete ? earned : null,
    maximum,
    adjudicatedPoints: adjudicatedMaximum,
    counts,
    findings: findingSummary,
    contested,
    warnings,
    rows,
  }, null, 2)}\n`);
} else {
  console.log(`Answer key: ${key.keyId ?? basename(keyPath)}   run: ${runRoot}`);
  console.log(`bugs/ files: ${bugFiles.length}   ledger entries: ${ledger.length}   verdict file: ${verdictPath ?? 'none'}`);
  console.log('');
  console.log('| # | layer | pts | verdict | earned | candidates (triage only — read before judging) |');
  console.log('|---|-------|----:|---------|-------:|------------------------------------------------|');
  for (const row of rows) {
    const earnedCell = row.credit === 'unadjudicated' ? '—' : round(row.earned);
    console.log(`| ${row.id} | ${row.layer} | ${row.points} | ${row.credit} | ${earnedCell} | ${formatCandidates(row.candidates)} |`);
  }
  console.log('');
  if (!entriesOnly) {
    if (findingRows.length === 0) {
      console.log('No findings reported: no ledger rows and no bug files.');
    } else {
      console.log('| finding | reported as | outcome |');
      console.log('|---------|-------------|---------|');
      for (const row of findingRows) {
        const outcome = row.outcome === 'duplicate' ? `duplicate of ${row.duplicateOf}` : row.outcome;
        console.log(`| ${row.key} | ${formatFindingSources(row)} | ${outcome} |`);
      }
    }
    if (withdrawn.length > 0) {
      console.log('');
      console.log(`Withdrawn ledger rows (not findings, no outcome needed): ${withdrawn.map((row) => `${row.key} (${row.status})`).join(', ')}`);
    }
    console.log('');
  }
  if (complete) {
    console.log(`full ${counts.full} / partial ${counts.partial} / miss ${counts.miss} — ${round(earned)} of ${maximum} points`);
  } else {
    const missing = [];
    if (counts.unadjudicated > 0) missing.push(`${counts.unadjudicated} of ${rows.length} entries have no verdict`);
    if (!findingsComplete) missing.push(`${unadjudicatedFindings.length} of ${findingRows.length} findings have no outcome`);
    console.log(`UNSCORED — ${missing.join('; ')}.`);
    console.log(`Adjudicated so far: ${round(earned)} of ${adjudicatedMaximum} adjudicated points (${maximum} total).`);
    if (!findingsComplete) {
      console.log(`Findings without an outcome: ${unadjudicatedFindings.map((row) => row.key).join(', ')}`);
    }
    const todo = entriesOnly ? 'a verdict row for every entry' : 'a verdict row for every entry and an outcome for every finding';
    console.log(`Write ${todo}, then re-run. Candidates above are search hits, not evidence of coverage.`);
  }
  console.log(formatFindingSummary(findingSummary, entriesOnly));
  for (const row of contested) {
    console.log(`CONTESTED  ${row.message}`);
  }
}

process.exit(exitCode);

// v2 keeps entry verdicts and finding outcomes apart. v1 put entry verdicts at the top level
// and never carried finding outcomes, so it is recognized by any top-level value that holds a
// credit and read as entries only.
function normalizeVerdicts(document, source) {
  assert(isPlainObject(document), `${source}: a verdict file must be a JSON object`);
  if (Object.values(document).some((value) => isPlainObject(value) && 'credit' in value)) {
    return { format: 'legacy', entries: document, findings: {} };
  }
  const unknown = Object.keys(document).filter((name) => name !== 'entries' && name !== 'findings');
  assert(unknown.length === 0,
    `${source}: unknown top-level field ${unknown.join(', ')} — a v2 verdict file holds only "entries" and "findings"`);
  for (const name of ['entries', 'findings']) {
    assert(document[name] === undefined || isPlainObject(document[name]),
      `${source}: "${name}" must be an object keyed by ${name === 'entries' ? 'key entry id' : 'finding key'}`);
  }
  return { format: 'v2', entries: document.entries ?? {}, findings: document.findings ?? {} };
}

// A ledger row and the bug files it originates from are ONE reported finding; counting the
// twin file again would charge the run twice for one report. Only a file no row claims is a
// finding of its own. A row Minos withdrew (duplicate, rejected) is no finding, but it still
// claims its files: they are the withdrawn report, not an unledgered one.
function deriveFindings(hasLedger, ledgerRows, fileNames) {
  const derived = [];
  const withdrawn = [];
  const claimed = new Set();
  if (hasLedger) {
    ledgerRows.forEach((row, index) => {
      const label = `bug-ledger[${index}]`;
      const origins = ledgerOrigins(row);
      const files = fileNames.filter((name) => matchesOrigin(name, origins));
      for (const name of files) claimed.add(name);
      const id = typeof row?.id === 'string' && row.id.trim().length > 0 ? row.id.trim() : null;
      const status = typeof row?.status === 'string' && row.status.length > 0 ? row.status : null;
      const entry = { key: id ?? label, kind: 'ledger', label, files, status };
      if (classifyLedgerStatus(status) === 'excluded') withdrawn.push(entry);
      else derived.push(entry);
    });
  }
  for (const name of fileNames) {
    if (!claimed.has(name)) derived.push({ key: name, kind: 'bug-file', label: name, files: [name], status: null });
  }
  const seen = new Set();
  for (const finding of [...derived, ...withdrawn]) {
    assert(!seen.has(finding.key),
      `finding key ${finding.key} is not unique — solution/bug-ledger.json repeats a row id`);
    seen.add(finding.key);
  }
  return { findings: derived, withdrawn };
}

// Every name an adjudicator may reasonably write in matchedBy: the finding key, the triage
// label the candidates column prints, and each bug file behind the finding (with or without
// its .md suffix). Matching is case-insensitive.
function indexFindingReferences(derived) {
  const index = new Map();
  const add = (name, findingKey) => {
    const normalized = name.toLowerCase();
    if (!index.has(normalized)) index.set(normalized, new Set());
    index.get(normalized).add(findingKey);
  };
  for (const finding of derived) {
    add(finding.key, finding.key);
    add(finding.label, finding.key);
    for (const name of finding.files) {
      add(name, finding.key);
      add(name.replace(/\.md$/i, ''), finding.key);
    }
  }
  return index;
}

function resolveReference(name, index) {
  return [...(index.get(name.trim().toLowerCase()) ?? [])];
}

function matchedByNames(row) {
  return [row.verdictMatchedBy].flat()
    .filter((name) => typeof name === 'string' && name.trim().length > 0);
}

// Resolution feeds the consistency checks. A name that is ambiguous or names nothing in this
// run cannot be checked, so it is surfaced instead of being guessed. A name that resolves only
// to a withdrawn ledger row is recorded in matchedWithdrawn for the consistency checks.
function resolveMatchedFindings(row, index, withdrawnIndex) {
  const matchedFindings = [];
  const matchedWithdrawn = [];
  for (const name of matchedByNames(row)) {
    const matches = resolveReference(name, index);
    const withdrawnMatches = matches.length === 0 ? resolveReference(name, withdrawnIndex) : [];
    if (matches.length === 1) {
      if (!matchedFindings.includes(matches[0])) matchedFindings.push(matches[0]);
    } else if (matches.length > 1) {
      warn(`entry ${row.id}: matchedBy ${name} is ambiguous (${matches.join(', ')}) — name one finding key`);
    } else if (withdrawnMatches.length > 0) {
      for (const match of withdrawnMatches) if (!matchedWithdrawn.includes(match)) matchedWithdrawn.push(match);
    } else if (row.credit === 'full' || row.credit === 'partial') {
      warn(`entry ${row.id}: matchedBy ${name} names no finding in this run — the consistency checks cannot see it`);
    }
  }
  return { matchedFindings, matchedWithdrawn };
}

function adjudicateFinding(finding, verdict, knownEntryIds, knownFindingKeys) {
  const label = `finding ${finding.key}`;
  let outcome = 'unadjudicated';
  let reportedEntryIds = [];
  // null is a placeholder row, exactly as for entries: still unadjudicated.
  if (verdict !== undefined && verdict !== null) {
    assert(isPlainObject(verdict), `${label}: verdict must be an object with outcome and reason`);
    assert(OUTCOMES.includes(verdict.outcome),
      `${label}: outcome must be real, false-positive or duplicate (got ${JSON.stringify(verdict.outcome)})`);
    assert(typeof verdict.reason === 'string' && verdict.reason.trim().length > 0,
      `${label}: verdict needs a reason naming the evidence behind the outcome`);
    if (verdict.entryIds !== undefined) {
      assert(Array.isArray(verdict.entryIds)
        && verdict.entryIds.every((id) => (typeof id === 'string' && id.length > 0) || Number.isInteger(id)),
      `${label}: entryIds must be an array of key entry ids`);
      reportedEntryIds = [...new Set(verdict.entryIds.map(String))];
      for (const id of reportedEntryIds) {
        assert(knownEntryIds.has(id), `${label}: entryIds names ${id}, which is not an entry of the answer key`);
      }
    }
    if (verdict.outcome === 'duplicate') {
      assert(typeof verdict.duplicateOf === 'string' && verdict.duplicateOf.trim().length > 0,
        `${label}: a duplicate verdict must name the finding it repeats in duplicateOf`);
      assert(verdict.duplicateOf !== finding.key, `${label}: a finding cannot duplicate itself`);
      if (!knownFindingKeys.has(verdict.duplicateOf)) {
        warn(`${label}: duplicateOf ${verdict.duplicateOf} names no finding in this run`);
      }
    } else {
      assert(verdict.duplicateOf === undefined, `${label}: duplicateOf is valid only on a duplicate outcome`);
    }
    outcome = verdict.outcome;
  }
  return {
    key: finding.key,
    kind: finding.kind,
    label: finding.label,
    files: finding.files,
    status: finding.status,
    outcome,
    reason: verdict?.reason ?? null,
    entryIds: reportedEntryIds,
    duplicateOf: outcome === 'duplicate' ? verdict.duplicateOf : null,
  };
}

// A verdict whose key matches nothing is not an error by itself (a run can be re-merged), but
// it usually means a misspelled key, which leaves the real row unadjudicated.
function reportStaleVerdicts(normalized, knownEntryIds, knownFindingKeys, withdrawnRows) {
  const withdrawnStatus = new Map(withdrawnRows.map((row) => [row.key, row.status]));
  for (const id of Object.keys(normalized.entries)) {
    if (!knownEntryIds.has(id)) warn(`entry verdict ${id} names no entry of the answer key`);
  }
  for (const id of Object.keys(normalized.findings)) {
    if (withdrawnStatus.has(id)) {
      warn(`finding verdict ${id} names a ledger row withdrawn as ${withdrawnStatus.get(id)}, which is not a reported finding — the verdict is ignored`);
    } else if (!knownFindingKeys.has(id)) {
      warn(`finding verdict ${id} names no ledger row or bug file in this run`);
    }
  }
}

// The two halves of the verdict file must tell one story. Credit earned through a report the
// same file calls false or a repeat, or a real report claiming an entry the file calls a miss,
// is a contradiction for the adjudicator to settle, not for this tool to pick a side in.
function reportInconsistentFindings(entryRows, adjudicatedFindings, withdrawnRows) {
  const byKey = new Map(adjudicatedFindings.map((row) => [row.key, row]));
  const byEntry = new Map(entryRows.map((row) => [String(row.id), row]));
  const withdrawnStatus = new Map(withdrawnRows.map((row) => [row.key, row.status]));
  const inconsistent = [];
  for (const row of entryRows) {
    if (row.credit !== 'full' && row.credit !== 'partial') continue;
    for (const withdrawnKey of row.matchedWithdrawn) {
      const status = withdrawnStatus.get(withdrawnKey);
      inconsistent.push({
        kind: 'credit-through-withdrawn-row',
        entry: row.id,
        finding: withdrawnKey,
        outcome: status,
        message: `entry ${row.id} is credited ${row.credit} through ${withdrawnKey}, a ledger row withdrawn as ${status} that the run does not report — credit a reported finding or change the verdict.`,
      });
    }
    for (const findingKey of row.matchedFindings) {
      const finding = byKey.get(findingKey);
      if (finding?.outcome !== 'false-positive' && finding?.outcome !== 'duplicate') continue;
      const judged = finding.outcome === 'duplicate' ? `duplicate of ${finding.duplicateOf}` : finding.outcome;
      inconsistent.push({
        kind: 'credit-through-non-real-finding',
        entry: row.id,
        finding: findingKey,
        outcome: finding.outcome,
        message: `entry ${row.id} is credited ${row.credit} through ${findingKey}, which is judged ${judged} — credit a real report or change one verdict.`,
      });
    }
  }
  for (const finding of adjudicatedFindings) {
    if (finding.outcome !== 'real') continue;
    for (const id of finding.entryIds) {
      if (byEntry.get(id)?.credit !== 'miss') continue;
      inconsistent.push({
        kind: 'real-finding-covers-missed-entry',
        entry: id,
        finding: finding.key,
        outcome: finding.outcome,
        message: `${finding.key} is judged real and claims entry ${id}, but entry ${id} is judged miss — reconcile the two verdicts.`,
      });
    }
  }
  for (const item of inconsistent) warn(item.message);
  return inconsistent;
}

function summarizeFindings(adjudicatedFindings, withdrawnRows, precisionSkipped) {
  const tally = { real: 0, falsePositive: 0, duplicate: 0, unadjudicated: 0 };
  for (const row of adjudicatedFindings) {
    if (row.outcome === 'real') tally.real += 1;
    else if (row.outcome === 'false-positive') tally.falsePositive += 1;
    else if (row.outcome === 'duplicate') tally.duplicate += 1;
    else tally.unadjudicated += 1;
  }
  const judged = tally.real + tally.falsePositive + tally.duplicate;
  const confirmed = adjudicatedFindings.filter((row) => row.status === 'confirmed' && row.outcome !== 'unadjudicated');
  const byStatus = {};
  for (const row of adjudicatedFindings) byStatus[row.status ?? 'none'] = (byStatus[row.status ?? 'none'] ?? 0) + 1;
  return {
    total: adjudicatedFindings.length,
    ...tally,
    precision: precisionSkipped || judged === 0 ? null : tally.real / judged,
    confirmedPrecision: precisionSkipped || confirmed.length === 0
      ? null
      : confirmed.filter((row) => row.outcome === 'real').length / confirmed.length,
    byStatus,
    withdrawn: withdrawnRows.map((row) => ({ key: row.key, status: row.status, files: row.files })),
    keys: adjudicatedFindings.map((row) => row.key),
    rows: adjudicatedFindings,
  };
}

function formatFindingSummary(summary, precisionSkipped) {
  if (precisionSkipped) return 'precision not measured (--entries-only)';
  const judged = summary.real + summary.falsePositive + summary.duplicate;
  const precision = summary.precision === null
    ? 'not measured (no adjudicated findings)'
    : `${summary.precision.toFixed(3)} (${summary.real} of ${judged} adjudicated)`;
  const statuses = Object.entries(summary.byStatus).map(([status, total]) => `${total} ${status}`).join(', ') || 'none';
  const confirmedPrecision = summary.confirmedPrecision === null ? 'not measured' : summary.confirmedPrecision.toFixed(3);
  return [
    `findings: ${summary.real} real / ${summary.falsePositive} false-positive / ${summary.duplicate} duplicate / ${summary.unadjudicated} unadjudicated — precision ${precision}`,
    `findings by ledger status: ${statuses}; withdrawn rows: ${summary.withdrawn.length}; confirmed-only precision ${confirmedPrecision}`,
  ].join('\n');
}

function formatFindingSources(row) {
  if (row.kind !== 'ledger') return row.label;
  return [row.label, ...row.files].join('; ');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Verdict files are keyed by free-form ids; never let an id such as "constructor" resolve
// through the prototype chain.
function ownValue(record, id) {
  return Object.hasOwn(record, String(id)) ? record[String(id)] : undefined;
}

// Search proposes; the verdict file disposes. `detected` is deliberately absent from the
// output: publishing a machine guess next to a human verdict invites the guess to be copied.
function adjudicate(entry, docs, verdict) {
  const keywords = (entry.keywords ?? []).map((value) => value.toLowerCase());
  const oracleIds = (entry.oracleIds ?? []).map((value) => value.toLowerCase());
  const components = (entry.components ?? []).map((value) => value.toLowerCase());
  const scored = [];
  for (const doc of docs) {
    const hits = keywords.filter((word) => doc.text.includes(word));
    const oracleHit = oracleIds.some((id) => doc.text.includes(id));
    if (hits.length === 0 && !oracleHit) continue;
    const ratio = keywords.length === 0 ? (oracleHit ? 1 : 0) : hits.length / keywords.length;
    const componentMatch = componentFit(components, doc) === 'match';
    scored.push({
      source: doc.source,
      matchedKeywords: hits,
      oracleHit,
      componentMatch,
      // Ranking only. A rank of 1 means "read this one first", never "this one counts".
      rank: Number((ratio + (oracleHit ? 0.5 : 0) + (componentMatch ? 0.25 : 0)).toFixed(3)),
      strong: ratio >= STRONG_CANDIDATE || oracleHit,
    });
  }
  scored.sort((left, right) => right.rank - left.rank);
  const candidates = scored.slice(0, CANDIDATE_LIMIT);

  let credit = 'unadjudicated';
  if (verdict) {
    assert(CREDITS.includes(verdict.credit),
      `${entry.id}: verdict credit must be full, partial or miss (got ${JSON.stringify(verdict.credit)})`);
    assert(typeof verdict.reason === 'string' && verdict.reason.trim().length > 0,
      `${entry.id}: verdict needs a reason naming the criterion that is or is not met`);
    credit = verdict.credit;
  }
  const partialPoints = entry.partialPoints ?? entry.points / 2;
  assert(partialPoints >= 0 && partialPoints <= entry.points,
    `${entry.id}: partialPoints ${partialPoints} must sit between 0 and points ${entry.points}`);
  return {
    id: entry.id,
    title: entry.title ?? '',
    layer: entry.layer ?? '—',
    points: entry.points,
    credit,
    reason: verdict?.reason ?? null,
    verdictMatchedBy: verdict?.matchedBy ?? null,
    candidates,
    earned: credit === 'full' ? entry.points : credit === 'partial' ? partialPoints : 0,
  };
}

// One report genuinely can cover two seeded defects, so this is surfaced for confirmation
// rather than rejected. It is reported against the VERDICT, not against the search hit:
// a shared search hit means nothing, a shared verdict is a claim that needs checking.
// A matchedBy that resolves to a finding is grouped by its finding key, so a ledger id and
// the bug file behind it count as the same report.
function reportContestedVerdicts(scored, index) {
  const claims = new Map();
  for (const row of scored) {
    if (row.credit === 'miss' || row.credit === 'unadjudicated') continue;
    const sources = new Set(matchedByNames(row).map((name) => {
      const matches = resolveReference(name, index);
      return matches.length === 1 ? matches[0] : name;
    }));
    for (const source of sources) {
      if (!claims.has(source)) claims.set(source, []);
      claims.get(source).push(row.id);
    }
  }
  const contested = [];
  for (const [source, ids] of claims) {
    if (ids.length > 1) {
      contested.push({
        kind: 'shared-verdict',
        source,
        ids,
        message: `${source} carries the verdict for ${ids.join(', ')} — confirm each is genuinely covered by that one report.`,
      });
      warn(`${source} is credited to ${ids.length} key entries (${ids.join(', ')})`);
    }
  }
  return contested;
}

function formatCandidates(candidates) {
  if (candidates.length === 0) return '—';
  return candidates
    .map((candidate) => {
      const marks = [
        candidate.oracleHit ? 'oracle' : null,
        candidate.componentMatch ? 'lane' : null,
        candidate.matchedKeywords.length > 0 ? candidate.matchedKeywords.join('+') : null,
      ].filter(Boolean).join(' ');
      return `${candidate.source}${marks ? ` (${marks})` : ''}`;
    })
    .join('; ');
}

function describeDocument(source, raw) {
  const text = raw.toLowerCase();
  const lane = text.match(/^\s*[-*]\s*\*\*lane:\*\*\s*([^\n<]+)/m)?.[1]?.trim();
  // The filled Lane field is the only component evidence. An unfilled template line still
  // lists the whole enum, so it means nothing. An oracle id's namespace (ORC-VAL, ORC-BIZ)
  // is deliberately NOT a component: it uses a different vocabulary.
  const components = new Set(lane && !lane.includes('|') ? [lane] : []);
  return { source, text, components };
}

function inheritedComponents(entry, fileDocuments) {
  const origins = ledgerOrigins(entry);
  const inherited = new Set();
  for (const doc of fileDocuments) {
    if (!matchesOrigin(doc.source, origins)) continue;
    for (const component of doc.components) inherited.add(component);
  }
  return inherited;
}

// A ledger row is known by its own id and by every origin id it was merged from.
function ledgerOrigins(entry) {
  return [entry?.id, ...(Array.isArray(entry?.origin) ? entry.origin : [entry?.origin])]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
}

// A bug file belongs to a ledger row when its stem is an origin id, alone or followed by a
// slug: ATA-001.md and ATA-001-password-hash-leak.md both originate ATA-001.
function matchesOrigin(fileName, origins) {
  const stem = fileName.replace(/\.md$/, '').toLowerCase();
  return origins.some((origin) => stem === origin || stem.startsWith(`${origin}-`));
}

function componentFit(components, doc) {
  if (components.length === 0 || doc.components.size === 0) return 'unknown';
  return components.some((component) => doc.components.has(component)) ? 'match' : 'conflict';
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

function listBugFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md') && !/^(_TEMPLATE|BUG_TEMPLATE|BUG-EXAMPLE)\.md$/i.test(name))
    .sort()
    .map((name) => join(directory, name));
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  const document = readJson(path);
  return Array.isArray(document.bugs) ? document.bugs : Array.isArray(document.entries) ? document.entries : [];
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[name] = next;
      index += 1;
    } else parsed[name] = true;
  }
  return parsed;
}

function required(value, message) {
  if (typeof value !== 'string' || value.length === 0) fail(message);
  return value;
}

function round(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`cannot read ${path}: ${error.message}`); }
}

function assert(value, message) {
  if (!value) fail(message);
}

// stderr only, so --json stdout stays machine-parseable.
function warn(message) {
  warnings.push(message);
  console.error(`WARN  ${message}`);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
