#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith('--') && value && !value.startsWith('--')) {
    args.set(key, value);
    index += 1;
  } else if (key.startsWith('--')) {
    args.set(key, true);
  }
}

const ROOT = resolve(args.get('--root') || DEFAULT_ROOT);
const plugin = args.get('--plugin') || 'argus';
const mode = args.has('--write') ? 'write' : 'check';
const marketplacePath = join(ROOT, '.claude-plugin', 'marketplace.json');
const pluginPath = join(ROOT, plugin, 'claude', '.claude-plugin', 'plugin.json');
const marketplace = readJson(marketplacePath);
const manifest = readJson(pluginPath);
const entry = marketplace.plugins.find((item) => item.name === plugin);
assert(entry, `marketplace has no ${plugin} plugin`);
assert(manifest.name === plugin, `${plugin} manifest name is ${manifest.name}`);

if (mode === 'write') {
  const requested = args.get('--set') || bump(manifest.version, args.get('--bump'));
  assert(isSemver(requested), `invalid release version: ${requested}`);
  assert(compare(requested, manifest.version) > 0 || args.has('--allow-downgrade'),
    `release version ${requested} must be newer than ${manifest.version}`);
  manifest.version = requested;
  entry.version = requested;
  marketplace.version = marketplace.plugins.map((item) => item.version).sort(compare).at(-1);
  writeJson(pluginPath, manifest);
  writeJson(marketplacePath, marketplace);
  console.log(`PASS  Prepared ${plugin} ${requested}; marketplace release ${marketplace.version}`);
} else {
  assert(isSemver(manifest.version), `${plugin} manifest version is not semver`);
  assert(manifest.version === entry.version, `${plugin} manifest ${manifest.version} != marketplace ${entry.version}`);
  const highest = marketplace.plugins.map((item) => item.version).sort(compare).at(-1);
  assert(marketplace.version === highest, `marketplace release ${marketplace.version} != highest plugin ${highest}`);
  console.log(`PASS  Release versions: ${plugin} ${manifest.version}, marketplace ${marketplace.version}`);
}

function bump(version, kind) {
  assert(['patch', 'minor', 'major'].includes(kind), 'write mode requires --set VERSION or --bump patch|minor|major');
  assert(isSemver(version), `cannot bump invalid semver: ${version}`);
  const values = version.split('.').map(Number);
  if (kind === 'major') return `${values[0] + 1}.0.0`;
  if (kind === 'minor') return `${values[0]}.${values[1] + 1}.0`;
  return `${values[0]}.${values[1]}.${values[2] + 1}`;
}

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function compare(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
