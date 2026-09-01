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
//       "components": ["api"] }
//   ]
// }
//
// Overrides file shape (manual judgment rows only):
// { "01": { "credit": "full", "reason": "..." } }   credit: full | partial | miss

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const CREDIT_FRACTION = Object.freeze({ full: 1, partial: 0.5, miss: 0 });

const args = parseArgs(process.argv.slice(2));
const runRoot = resolve(required(args.run, '--run <engagement-root> is required'));
const keyPath = resolve(args.key ?? process.env.ARGUS_ANSWER_KEY
  ?? fail('answer key path is required: pass --key or set ARGUS_ANSWER_KEY'));
const key = readJson(keyPath);
assert(Array.isArray(key.entries) && key.entries.length > 0, `${keyPath}: key has no entries`);
const overrides = args.overrides ? readJson(resolve(args.overrides)) : {};

const bugFiles = listBugFiles(join(runRoot, 'bugs'));
const ledger = readLedger(join(runRoot, 'solution', 'bug-ledger.json'));
const documents = [
  ...bugFiles.map((path) => ({ source: basename(path), text: readFileSync(path, 'utf8').toLowerCase() })),
  ...ledger.map((entry, index) => ({ source: `bug-ledger[${index}]`, text: JSON.stringify(entry).toLowerCase() })),
];

const rows = key.entries.map((entry) => score(entry, documents, overrides[entry.id]));
const earned = rows.reduce((sum, row) => sum + row.earned, 0);
const maximum = key.maximum ?? key.entries.reduce((sum, entry) => sum + entry.points, 0);
const counts = { full: 0, partial: 0, miss: 0 };
for (const row of rows) counts[row.credit] += 1;

if (args.json) {
  process.stdout.write(`${JSON.stringify({ keyId: key.keyId ?? basename(keyPath), runRoot, earned, maximum, counts, rows }, null, 2)}\n`);
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
  let best = null;
  for (const doc of docs) {
    const keywordHits = keywords.filter((word) => doc.text.includes(word)).length;
    const oracleHit = oracleIds.some((id) => doc.text.includes(id));
    const ratio = keywords.length === 0 ? (oracleHit ? 1 : 0) : keywordHits / keywords.length;
    const strength = oracleHit ? Math.max(ratio, 0.75) : ratio;
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

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
