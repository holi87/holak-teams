#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: refactor-argus-prompts.mjs [--check|--write]');

const roleDir = join(ROOT, 'argus/roles');
const files = readdirSync(roleDir).filter((file) => file.endsWith('.md')).sort();
const sharedHeadings = [
  'Authorization Gate (mandatory)',
  'Evidence Safety (mandatory)',
  'Engagement Lease and Write Guard (mandatory)',
  'Deep-QA Hardening (mandatory)',
  'Adopt-or-Build Gate (mandatory before writing tests/strategy/framework)',
  'Identity & Naming',
  'Working With The Team',
  'Lessons',
  'Heartbeat — progress signal (mandatory)',
  'Token Economy',
  'Artifact Language',
  'Parallel Lanes & Engineering Standards (mandatory, all agents)',
];

assert(files.length === 27, `expected 27 canonical role sources, found ${files.length}`);
for (const file of files) {
  const content = readFileSync(join(roleDir, file), 'utf8');
  assert(count(content, '{{ARGUS_MODEL_POLICY_BLOCK}}') === 1, `${file}: model-policy placeholder is missing or duplicated`);
  assert(count(content, '{{ARGUS_RACI_CONTRACT_BLOCK}}') === 1, `${file}: RACI placeholder is missing or duplicated`);
  for (const heading of sharedHeadings) {
    assert(!content.includes(`## ${heading}`), `${file}: legacy shared section remains: ${heading}`);
  }
}

console.log(`PASS  Retired Argus prompt migration guard: ${files.length} canonical sources; no files written (${mode.slice(2)})`);

function count(content, marker) {
  return content.split(marker).length - 1;
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
