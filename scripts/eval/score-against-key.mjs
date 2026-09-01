#!/usr/bin/env node
// Score one Argus engagement against a PRIVATE answer key.
//
// The key is never committed to this repository. Point ARGUS_ANSWER_KEY at a JSON file that
// lives outside the tree (or pass --key). Nothing in argus/ may reference a concrete target,
// defect, or value from it.
//
//   node scripts/eval/score-against-key.mjs --run <engagement-root> [--key <path>]
//                                           [--overrides <path>] [--json]
//
// Key file shape:
// {
//   "keyId": "loanflow-2026-08",
//   "maximum": 65,
//   "entries": [
//     { "id": "01", "title": "...", "layer": "L1", "points": 1,
//       "keywords": ["email", "format"], "oracleIds": ["ORC-VAL-001"],
//       "components": ["api"] }        components demote a conflicting document, never exclude it
//   ]
// }
//
// Overrides file shape (manual judgment rows only):
// { "01": { "credit": "full", "reason": "..." } }   credit: full | partial | miss

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const CREDIT_FRACTION = Object.freeze({ full: 1, partial: 0.5, miss: 0 });
const COMPONENT_PENALTY = 0.5;

const args = parseArgs(process.argv.slice(2));
const runRoot = resolve(required(args.run, '--run <engagement-root> is required'));
const keyPath = resolve(args.key ?? process.env.ARGUS_ANSWER_KEY
  ?? fail('answer key path is required: pass --key or set ARGUS_ANSWER_KEY'));
const key = readJson(keyPath);
assert(Array.isArray(key.entries) && key.entries.length > 0, `${keyPath}: key has no entries`);
const overrides = args.overrides ? readJson(resolve(args.overrides)) : {};
const warnings = [];

// A typo or a deleted engagement must fail loudly. An all-miss table is a legitimate
// result for a real run that found nothing, so it may never double as an error report.
if (!isDirectory(runRoot)) fail(`--run ${runRoot} is not a directory`);
if (!isDirectory(join(runRoot, 'bugs')) && !isDirectory(join(runRoot, 'solution'))) {
  fail(`--run ${runRoot} has neither bugs/ nor solution/ — not an Argus engagement root`);
}
if (!existsSync(join(runRoot, 'solution', 'bug-ledger.json'))) {
  warn('solution/bug-ledger.json not found — scoring bugs/ only; Minos has not written the canonical ledger yet');
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
    // it points at, so the twin cannot bypass a component demotion the file would take.
    for (const component of inheritedComponents(entry, fileDocuments)) doc.components.add(component);
    return doc;
  }),
];
if (documents.length === 0) {
  warn('no scoreable documents — an all-miss score reflects an empty run, not a scoring failure');
}

const rows = key.entries.map((entry) => score(entry, documents, overrides[entry.id]));
reportContestedDocuments(rows);
const earned = rows.reduce((sum, row) => sum + row.earned, 0);
const maximum = key.maximum ?? key.entries.reduce((sum, entry) => sum + entry.points, 0);
const counts = { full: 0, partial: 0, miss: 0 };
for (const row of rows) counts[row.credit] += 1;

if (args.json) {
  process.stdout.write(`${JSON.stringify({ keyId: key.keyId ?? basename(keyPath), runRoot, warnings, earned, maximum, counts, rows }, null, 2)}\n`);
} else {
  console.log(`Answer key: ${key.keyId ?? basename(keyPath)}   run: ${runRoot}`);
  console.log(`bugs/ files: ${bugFiles.length}   ledger entries: ${ledger.length}`);
  console.log('');
  console.log('| # | layer | pts | credit | earned | matched by |');
  console.log('|---|-------|----:|--------|-------:|------------|');
  for (const row of rows) {
    console.log(`| ${row.id} | ${row.layer} | ${row.points} | ${row.credit}${row.override ? ' (override)' : ''} | ${round(row.earned)} | ${row.matchedBy ?? '—'} |`);
  }
  console.log('');
  console.log(`full ${counts.full} / partial ${counts.partial} / miss ${counts.miss} — ${round(earned)} of ${maximum} points`);
}

function score(entry, docs, override) {
  const keywords = (entry.keywords ?? []).map((value) => value.toLowerCase());
  const oracleIds = (entry.oracleIds ?? []).map((value) => value.toLowerCase());
  const components = (entry.components ?? []).map((value) => value.toLowerCase());
  let best = null;
  for (const doc of docs) {
    const keywordHits = keywords.filter((word) => doc.text.includes(word)).length;
    const oracleHit = oracleIds.some((id) => doc.text.includes(id));
    const ratio = keywords.length === 0 ? (oracleHit ? 1 : 0) : keywordHits / keywords.length;
    const raw = oracleHit ? Math.max(ratio, 0.75) : ratio;
    // A document that names a component the key entry does not claim is demoted, never
    // excluded: the bug template is a placeholder the target may replace, so an absent
    // component must not silently zero out a legitimate match.
    const strength = componentFit(components, doc) === 'conflict' ? raw * COMPONENT_PENALTY : raw;
    if (!best || strength > best.strength) best = { strength, source: doc.source };
  }
  const detected = !best || best.strength === 0 ? 'miss' : best.strength >= 0.75 ? 'full' : 'partial';
  const credit = override?.credit ?? detected;
  assert(Object.hasOwn(CREDIT_FRACTION, credit), `${entry.id}: unknown override credit ${credit}`);
  return {
    id: entry.id,
    layer: entry.layer ?? '—',
    points: entry.points,
    credit,
    override: Boolean(override),
    overrideReason: override?.reason,
    detected,
    matchedBy: best && best.strength > 0 ? best.source : null,
    earned: entry.points * CREDIT_FRACTION[credit],
  };
}

// One document can still satisfy several key entries — that is a judgment call for the
// operator, resolved through the overrides file. It is reported, never resolved silently.
function reportContestedDocuments(scored) {
  const claims = new Map();
  for (const row of scored) {
    if (!row.matchedBy || row.override) continue;
    if (!claims.has(row.matchedBy)) claims.set(row.matchedBy, []);
    claims.get(row.matchedBy).push(row.id);
  }
  for (const [source, ids] of claims) {
    if (ids.length > 1) warn(`${source} was credited to ${ids.length} key entries (${ids.join(', ')}) — adjudicate in the overrides file`);
  }
}

function describeDocument(source, raw) {
  const text = raw.toLowerCase();
  const lane = text.match(/^\s*[-*]\s*\*\*lane:\*\*\s*([^\n<]+)/m)?.[1]?.trim();
  // The filled Lane field is the only component evidence. An unfilled template line still
  // lists the whole enum, so it means nothing. An oracle id's namespace (ORC-VAL, ORC-BIZ)
  // is deliberately NOT a component: it uses a different vocabulary, so reading it would
  // demote correct matches. Oracle ids already carry their own weight as a strength floor.
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
    .filter((name) => name.endsWith('.md') && name !== '_TEMPLATE.md')
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
