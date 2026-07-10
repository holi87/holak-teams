#!/usr/bin/env node
// Argus QA light performance probe — autocannon over selected API endpoints.
// Characterisation tool by default (p50/p97.5/p99, err, RPS per endpoint);
// becomes a pass/fail gate ONLY when PERF_BUDGET_MS is set (a STATED budget —
// never invent one). Deliberately light: this runs against the local docker
// stack, not a load farm.
//
// Usage:
//   npm run perf                                          # GET / on API_URL
//   PERF_TARGETS="/api/users,/api/orders" npm run perf
//   PERF_TOKEN="Bearer eyJ..." PERF_TARGETS="/api/me" npm run perf
//   PERF_BUDGET_MS=500 PERF_TARGETS="/api/users" npm run perf   # gate p97.5 <= 500ms
//   PERF_CONNECTIONS=10 PERF_DURATION=10 npm run perf           # defaults shown
import autocannon from 'autocannon';
import { mkdirSync, writeFileSync } from 'node:fs';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const targets = (process.env.PERF_TARGETS ?? '/').split(',').map(t => t.trim()).filter(Boolean);
const connections = Number(process.env.PERF_CONNECTIONS ?? 10); // LIGHT by design
const duration = Number(process.env.PERF_DURATION ?? 10);
const budgetMs = process.env.PERF_BUDGET_MS ? Number(process.env.PERF_BUDGET_MS) : null;
const headers = process.env.PERF_TOKEN ? { authorization: process.env.PERF_TOKEN } : {};

const bench = (url, opts = {}) =>
  autocannon({ url, connections, duration, headers, ...opts });

const rows = [];
for (const path of targets) {
  const url = new URL(path, API_URL).href;
  process.stderr.write(`warmup ${url}\n`);
  await bench(url, { duration: 3 }); // warmup pass, discarded
  process.stderr.write(`measure ${url} (${connections} conn, ${duration}s)\n`);
  const r = await bench(url);
  rows.push({
    path,
    'p50 ms': r.latency.p50,
    'p97.5 ms': r.latency.p97_5,
    'p99 ms': r.latency.p99,
    'err+non2xx': r.errors + r.non2xx + r.timeouts,
    rps: Math.round(r.requests.average),
  });
}

console.table(rows);

mkdirSync('reports/perf', { recursive: true });
const out = `reports/perf/perf-${Date.now()}.json`;
writeFileSync(out, JSON.stringify({ apiUrl: API_URL, connections, duration, budgetMs, rows }, null, 2));
console.log(`raw results: ${out}`);

const broken = rows.filter(r => r['err+non2xx'] > 0);
if (broken.length) {
  console.warn(`WARNING: errors/non-2xx on: ${broken.map(r => r.path).join(', ')} — check PERF_TOKEN/endpoint choice; under light load this may itself be a defect.`);
}

if (budgetMs != null) {
  const over = rows.filter(r => r['p97.5 ms'] > budgetMs);
  if (over.length) {
    console.error(`BUDGET FAIL (p97.5 > ${budgetMs}ms): ${over.map(r => `${r.path}=${r['p97.5 ms']}ms`).join(', ')}`);
    process.exit(1);
  }
  console.log(`BUDGET PASS: all targets p97.5 <= ${budgetMs}ms`);
}
