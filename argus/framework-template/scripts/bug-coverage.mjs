#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = process.env.SMOKE === '1';
const ledgerPath = join(ROOT, 'solution', 'bug-ledger.json');
const summaryPath = join(ROOT, 'reports', 'summary.json');

const result = {
  status: 'pass',
  smoke: SMOKE,
  total_confirmed: 0,
  wired_confirmed: 0,
  uncovered: [],
  errors: [],
};

if (!existsSync(ledgerPath)) {
  fail(`missing ${rel(ledgerPath)}; Minos must create it from solution/bug-ledger.example.json`);
} else {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    fail(`${rel(ledgerPath)} is not valid JSON: ${err.message}`);
  }

  const entries = Array.isArray(ledger) ? ledger : ledger?.bugs;
  if (!Array.isArray(entries)) {
    fail(`${rel(ledgerPath)} must be an argus/bug-ledger@1 document with a bugs array`);
  } else {
    if (!Array.isArray(ledger)) {
      if (ledger.$schema !== 'argus/bug-ledger@1' || ledger.schemaVersion !== 1) fail(`${rel(ledgerPath)} has an unsupported schema version`);
    } else {
      result.errors.push(`${rel(ledgerPath)} uses the legacy array shape; migrate it to argus/bug-ledger@1`);
    }
    const confirmed = entries.filter((entry) => String(entry.status ?? 'confirmed').toLowerCase() !== 'suspected' && entry.confirmed !== false);
    result.total_confirmed = confirmed.length;

    const { linkedTags: tags, unselectedTags } = collectBugTags(join(ROOT, 'tests'));
    if (unselectedTags.size > 0) {
      fail(`bug provenance without @regression selection marker: ${[...unselectedTags].sort().join(', ')}`);
    }
    for (const entry of confirmed) {
      const ids = [entry.id, ...(Array.isArray(entry.origin) ? entry.origin : [])].filter(Boolean).map(String);
      if (!ids.length) {
        result.uncovered.push('(entry missing id/origin)');
        continue;
      }
      if (ids.some((id) => tags.has(id))) {
        result.wired_confirmed += 1;
      } else {
        result.uncovered.push(ids[0]);
      }
    }

    if (result.uncovered.length) {
      fail(`uncovered confirmed bugs: ${result.uncovered.join(', ')}`);
    }
  }
}

if (result.errors.length) result.status = SMOKE ? 'warning' : 'fail';
writeSummary({ bug_coverage: result });

const line = `bug_coverage: ${result.wired_confirmed}/${result.total_confirmed} wired` +
  (result.uncovered.length ? `; uncovered: ${result.uncovered.join(', ')}` : '; uncovered: none');
console.log(`${SMOKE && result.errors.length ? 'WARNING' : result.status.toUpperCase()}: ${line}`);
if (result.errors.length) {
  for (const error of result.errors) console.error(`bug-coverage: ${error}`);
}
process.exit(result.errors.length && !SMOKE ? 1 : 0);

function fail(message) {
  result.errors.push(message);
}

function collectBugTags(dir) {
  const linkedTags = new Set();
  const unselectedTags = new Set();
  if (!existsSync(dir)) return { linkedTags, unselectedTags };
  for (const file of walk(dir)) {
    const ext = extname(file);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;
    const text = readFileSync(file, 'utf8');
    for (const declaration of text.matchAll(/\b(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(['"`])([\s\S]*?)\1/g)) {
      const title = declaration[2];
      for (const match of title.matchAll(/@bug:([A-Za-z]+-\d{3,4}|BUG-\d{4})/g)) {
        if (/@regression\b/.test(title)) linkedTags.add(match[1]);
        else unselectedTags.add(match[1]);
      }
    }
  }
  return { linkedTags, unselectedTags };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

function writeSummary(fragment) {
  mkdirSync(dirname(summaryPath), { recursive: true });
  let summary = {};
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch {
      summary = {};
    }
  }
  writeFileSync(summaryPath, JSON.stringify({ ...summary, ...fragment, generated_at: new Date().toISOString() }, null, 2) + '\n');
}

function rel(path) {
  return path.replace(`${ROOT}/`, '');
}
