#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg >= 0 ? resolve(process.argv[rootArg + 1] ?? '') : DEFAULT_ROOT;
const expectedCounts = { hephaestus: 22, argus: 27 };
const supportedModels = new Set(['opus', 'sonnet', 'haiku']);
const supportedFrontmatter = new Set(['name', 'description', 'tools', 'model', 'color', 'skills', 'effort', 'maxTurns']);
const supportedTools = new Set([
  'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'LS', 'MultiEdit', 'Read', 'Task',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite', 'WebFetch',
  'WebSearch', 'Write',
]);
const supportedMcpTool = /^mcp__plugin_(?:context7_context7|playwright_playwright)__[a-z0-9_-]+$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const marketplacePath = join(ROOT, '.claude-plugin', 'marketplace.json');
const marketplace = readJson(marketplacePath);
assert(semver.test(marketplace.version), `marketplace version is not semver: ${marketplace.version}`);
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace has no plugins');

const pluginNames = new Set();
const pluginVersions = [];
for (const entry of marketplace.plugins) {
  assert(!pluginNames.has(entry.name), `duplicate marketplace plugin name: ${entry.name}`);
  pluginNames.add(entry.name);
  assert(Object.hasOwn(expectedCounts, entry.name), `unknown marketplace plugin: ${entry.name}`);
  assert(semver.test(entry.version), `${entry.name}: marketplace entry version is not semver`);
  pluginVersions.push(entry.version);

  const pluginRoot = safePath(entry.source);
  assert(existsSync(pluginRoot) && statSync(pluginRoot).isDirectory(), `${entry.name}: plugin source is missing: ${entry.source}`);
  const manifest = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert(manifest.name === entry.name, `${entry.name}: plugin manifest name drift: ${manifest.name}`);
  assert(manifest.version === entry.version, `${entry.name}: plugin ${manifest.version} != marketplace ${entry.version}`);

  const agentsDir = join(pluginRoot, 'agents');
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  assert(entries.every((item) => item.isFile() && item.name.endsWith('.md')),
    `${entry.name}: agents/ must be flat and contain only Markdown agent files`);
  const files = entries.map((item) => item.name).sort();
  assert(files.length === expectedCounts[entry.name],
    `${entry.name}: roster has ${files.length} agents; expected ${expectedCounts[entry.name]}`);

  const slugs = new Set();
  for (const file of files) {
    const slug = file.slice(0, -3);
    assert(!slugs.has(slug), `${entry.name}: duplicate agent slug: ${slug}`);
    slugs.add(slug);
    const frontmatter = parseFrontmatter(join(agentsDir, file));
    for (const field of frontmatter.__keys) {
      assert(supportedFrontmatter.has(field), `${entry.name}/${slug}: unsupported frontmatter field ${field}`);
    }
    for (const field of ['name', 'description', 'tools', 'model', 'color']) {
      assert(frontmatter[field], `${entry.name}/${slug}: missing frontmatter ${field}`);
    }
    assert(frontmatter.name === slug, `${entry.name}/${slug}: frontmatter name is ${frontmatter.name}`);
    assert(supportedModels.has(frontmatter.model), `${entry.name}/${slug}: unsupported model ${frontmatter.model}`);
    for (const tool of frontmatter.tools.split(',').map((value) => value.trim()).filter(Boolean)) {
      assert(supportedTools.has(tool) || supportedMcpTool.test(tool), `${entry.name}/${slug}: unsupported tool ${tool}`);
    }
  }

  const readme = readFileSync(join(ROOT, entry.name, 'README.md'), 'utf8');
  for (const slug of slugs) {
    assert(new RegExp(`(?:^|[^a-z0-9-])${escapeRegex(slug)}(?:[^a-z0-9-]|$)`, 'm').test(readme),
      `${entry.name}: README roster omits ${slug}`);
  }
}

assert(pluginNames.size === Object.keys(expectedCounts).length, 'marketplace roster does not contain both supported plugins');
const highestPluginVersion = pluginVersions.sort(compareSemver).at(-1);
assert(marketplace.version === highestPluginVersion,
  `marketplace release ${marketplace.version} must equal highest plugin version ${highestPluginVersion}`);

console.log(`PASS  Marketplace contracts: ${pluginNames.size} manifests, 49 unique flat agents, supported frontmatter/tools, synchronized semver and README rosters`);

function parseFrontmatter(path) {
  const raw = readFileSync(path, 'utf8');
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  assert(block, `${path}: missing YAML frontmatter`);
  const result = { __keys: [] };
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) {
      result.__keys.push(match[1]);
      if (match[2]) result[match[1]] = match[2];
    }
  }
  return result;
}

function safePath(relativePath) {
  assert(/^\.\/[a-z0-9-]+\/claude$/.test(relativePath), `unsafe plugin source path: ${relativePath}`);
  const path = resolve(ROOT, relativePath);
  assert(path.startsWith(`${ROOT}${sep}`), `plugin source escapes repository: ${relativePath}`);
  return path;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`invalid or missing JSON ${path}: ${error.message}`);
  }
}

function compareSemver(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
