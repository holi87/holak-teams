#!/usr/bin/env node
// Score one Argus engagement against a PRIVATE answer key.
//
// The key is never committed to this repository. Point ARGUS_ANSWER_KEY at a JSON file that
// lives outside the tree (or pass --key). Nothing in argus/ may reference a concrete target,
// defect, or value from it.
//
//   node scripts/eval/score-against-key.mjs --run <engagement-root> [--key <path>]
//                                           [--verdicts <path>] [--json] [--candidates-only]
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
// Verdict file shape (one row per key entry, written after reading the criteria):
// { "01": { "credit": "full", "reason": "...", "matchedBy": "ATA-004-password-hash-leak.md" } }
//   credit: full | partial | miss
//
// Exit codes: 0 fully adjudicated | 20 unadjudicated entries remain | 21 contested candidate
// left unresolved | 1 usage or input error.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const CREDITS = Object.freeze(['full', 'partial', 'miss']);
const CANDIDATE_LIMIT = 3;
const STRONG_CANDIDATE = 0.75;

const args = parseArgs(process.argv.slice(2));
const runRoot = resolve(required(args.run, '--run <engagement-root> is required'));
const keyPath = resolve(args.key ?? process.env.ARGUS_ANSWER_KEY
  ?? fail('answer key path is required: pass --key or set ARGUS_ANSWER_KEY'));
const key = readJson(keyPath);
assert(Array.isArray(key.entries) && key.entries.length > 0, `${keyPath}: key has no entries`);
const verdictPath = args.verdicts ?? args.overrides;
const verdicts = verdictPath ? readJson(resolve(verdictPath)) : {};
const candidatesOnly = Boolean(args['candidates-only']);
const warnings = [];

// A typo or a deleted engagement must fail loudly. An all-miss table is a legitimate
// result for a real run that found nothing, so it may never double as an error report.
if (!isDirectory(runRoot)) fail(`--run ${runRoot} is not a directory`);
if (!isDirectory(join(runRoot, 'bugs')) && !isDirectory(join(runRoot, 'solution'))) {
  fail(`--run ${runRoot} has neither bugs/ nor solution/ — not an Argus engagement root`);
}
if (!existsSync(join(runRoot, 'solution', 'bug-ledger.json'))) {
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

const rows = key.entries.map((entry) => adjudicate(entry, documents, verdicts[entry.id]));
const contested = reportContestedVerdicts(rows);
const adjudicated = rows.filter((row) => row.credit !== 'unadjudicated');
const unadjudicated = rows.filter((row) => row.credit === 'unadjudicated');
const earned = adjudicated.reduce((sum, row) => sum + row.earned, 0);
const maximum = key.maximum ?? key.entries.reduce((sum, entry) => sum + entry.points, 0);
const adjudicatedMaximum = adjudicated.reduce((sum, row) => sum + row.points, 0);
const counts = { full: 0, partial: 0, miss: 0, unadjudicated: 0 };
for (const row of rows) counts[row.credit] += 1;
const complete = unadjudicated.length === 0;
const exitCode = candidatesOnly ? 0 : !complete ? 20 : contested.length > 0 ? 21 : 0;

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    keyId: key.keyId ?? basename(keyPath),
    runRoot,
    verdictFile: verdictPath ? resolve(verdictPath) : null,
    complete,
    scored: complete ? earned : null,
    maximum,
    adjudicatedPoints: adjudicatedMaximum,
    counts,
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
  if (complete) {
    console.log(`full ${counts.full} / partial ${counts.partial} / miss ${counts.miss} — ${round(earned)} of ${maximum} points`);
  } else {
    console.log(`UNSCORED — ${counts.unadjudicated} of ${rows.length} entries have no verdict.`);
    console.log(`Adjudicated so far: ${round(earned)} of ${adjudicatedMaximum} adjudicated points (${maximum} total).`);
    console.log('Write a verdict row for every entry, then re-run. Candidates above are search hits, not evidence of coverage.');
  }
  for (const row of contested) {
    console.log(`CONTESTED  ${row.source} carries the verdict for ${row.ids.join(', ')} — confirm each is genuinely covered by that one report.`);
  }
}

process.exit(exitCode);

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
function reportContestedVerdicts(scored) {
  const claims = new Map();
  for (const row of scored) {
    const source = row.verdictMatchedBy;
    if (!source || row.credit === 'miss' || row.credit === 'unadjudicated') continue;
    if (!claims.has(source)) claims.set(source, []);
    claims.get(source).push(row.id);
  }
  const contested = [];
  for (const [source, ids] of claims) {
    if (ids.length > 1) {
      contested.push({ source, ids });
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
  const origins = [entry.id, ...(Array.isArray(entry.origin) ? entry.origin : [entry.origin])]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());
  const inherited = new Set();
  for (const doc of fileDocuments) {
    const stem = doc.source.replace(/\.md$/, '').toLowerCase();
    if (!origins.some((origin) => stem === origin || stem.startsWith(`${origin}-`))) continue;
    for (const component of doc.components) inherited.add(component);
  }
  return inherited;
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
