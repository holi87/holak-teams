#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = process.env.SMOKE === '1';
const architecturePath = join(ROOT, 'solution', 'ARCHITECTURE.md');
const summaryPath = join(ROOT, 'reports', 'summary.json');
const defaults = { api: 80, ui: 60, security: 40, perf: 25, db: 25, a11y: 30, e2e: 15 };
const laneDirs = { api: 'tests/api', ui: 'tests/ui', security: 'tests/security', perf: 'tests/perf', db: 'tests/db' };
const result = { status: 'pass', smoke: SMOKE, lanes: {}, errors: [] };

const architecture = existsSync(architecturePath) ? readFileSync(architecturePath, 'utf8') : '';
if (!architecture) {
  fail(`missing ${rel(architecturePath)}; cannot read BASELINE-TARGET / BASELINE-JUSTIFIED lines`);
}

const explicitTargets = parseTargets(architecture);
const liveLanes = new Set([...Object.keys(explicitTargets)]);
for (const [lane, dir] of Object.entries(laneDirs)) {
  if (existsSync(join(ROOT, dir))) liveLanes.add(lane);
}
if (hasTaggedTests('@a11y')) liveLanes.add('a11y');
if (hasTaggedTests('@e2e')) liveLanes.add('e2e');

for (const lane of [...liveLanes].sort()) {
  const target = explicitTargets[lane] ?? defaults[lane];
  if (!target) continue;
  const count = countLaneTests(lane);
  const floor = Math.ceil(target * 0.6);
  const justified = new RegExp(`BASELINE-JUSTIFIED:\\s*${escapeRegExp(lane)}\\b`, 'i').test(architecture);
  const pass = count >= floor || justified;
  result.lanes[lane] = { count, target, floor, justified, status: pass ? 'pass' : SMOKE ? 'warning' : 'fail' };
  if (!pass) fail(`${lane} baseline below floor: ${count}/${target} cases (floor ${floor}) and no BASELINE-JUSTIFIED line`);
}

if (!liveLanes.size) {
  fail('no live test lanes detected');
}

if (result.errors.length) result.status = SMOKE ? 'warning' : 'fail';
writeSummary({ baseline_coverage: result });

for (const [lane, info] of Object.entries(result.lanes)) {
  console.log(`baseline_coverage: ${lane} ${info.count}/${info.target} (floor ${info.floor}, justified: ${info.justified ? 'yes' : 'no'})`);
}
if (result.errors.length) {
  for (const error of result.errors) console.error(`baseline-coverage: ${SMOKE ? 'WARNING: ' : ''}${error}`);
}
process.exit(result.errors.length && !SMOKE ? 1 : 0);

function parseTargets(text) {
  const out = {};
  for (const match of text.matchAll(/BASELINE-TARGET:\s*([a-z0-9_-]+)\s*=\s*(\d+)/gi)) {
    out[match[1].toLowerCase()] = Number(match[2]);
  }
  return out;
}

function countLaneTests(lane) {
  if (lane === 'a11y') return countTaggedTests('@a11y') || countFilesWithName('tests/ui', /a11y/i);
  if (lane === 'e2e') return countTaggedTests('@e2e');
  const dir = laneDirs[lane];
  return dir ? countTestsInDir(join(ROOT, dir)) : 0;
}

function countTestsInDir(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of walk(dir)) {
    if (!isSpec(file)) continue;
    const text = readFileSync(file, 'utf8');
    count += [...text.matchAll(/\btest(?:\.(?:describe|step|use|skip|only|fixme|fail|slow))?\s*\(/g)]
      .filter((match) => !/\btest\.(?:describe|step|use|skip|only|fixme|fail|slow)\s*\(/.test(match[0]))
      .length;
  }
  return count;
}

function countTaggedTests(tag) {
  let count = 0;
  for (const file of walk(join(ROOT, 'tests'))) {
    if (!isSpec(file)) continue;
    const text = readFileSync(file, 'utf8');
    const escaped = escapeRegExp(tag);
    count += [...text.matchAll(new RegExp(`\\btest\\s*\\([^)]*${escaped}`, 'g'))].length;
  }
  return count;
}

function hasTaggedTests(tag) {
  return countTaggedTests(tag) > 0;
}

function countFilesWithName(dir, pattern) {
  if (!existsSync(join(ROOT, dir))) return 0;
  return [...walk(join(ROOT, dir))].filter((file) => pattern.test(file) && isSpec(file)).length;
}

function isSpec(file) {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(file)) && /\.(spec|test|setup)\./.test(file);
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

function fail(message) {
  result.errors.push(message);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
