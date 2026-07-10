#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_MANIFEST_PATH = join(ROOT, 'argus', 'runtime-assets.source.json');
const PLUGIN_ROOT = join(ROOT, 'argus', 'claude');
const GENERATED_MANIFEST_PATH = join(PLUGIN_ROOT, 'runtime-assets.json');
const GENERATED_INVENTORY_PATH = join(PLUGIN_ROOT, 'runtime-reference-inventory.json');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');
const mode = process.argv[2] ?? '--check';

if (!['--write', '--check'].includes(mode)) {
  fail('usage: scripts/sync-argus-runtime-assets.mjs [--write|--check]');
}

const sourceManifest = readJson(SOURCE_MANIFEST_PATH);
validateSourceManifest(sourceManifest);

for (const asset of sourceManifest.assets) {
  if (mode === '--write') writeAsset(asset);
  checkAsset(asset);
}

const generatedManifest = buildGeneratedManifest(sourceManifest);
const generatedInventory = buildReferenceInventory();

if (mode === '--write') {
  writeJson(GENERATED_MANIFEST_PATH, generatedManifest);
  writeJson(GENERATED_INVENTORY_PATH, generatedInventory);
} else {
  assertJsonEquals(GENERATED_MANIFEST_PATH, generatedManifest, 'generated runtime manifest');
  assertJsonEquals(GENERATED_INVENTORY_PATH, generatedInventory, 'generated prompt reference inventory');
}

validatePromptReferences(sourceManifest, generatedInventory);
validateBudgets(sourceManifest, generatedManifest);

const assetBytes = generatedManifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
const pluginBytes = treeStats(PLUGIN_ROOT).bytes;
console.log(
  `PASS  Argus runtime assets: ${generatedManifest.assets.length} assets, ` +
  `${assetBytes}/${sourceManifest.budgets.generatedAssetsBytes} bytes; ` +
  `plugin ${pluginBytes}/${sourceManifest.budgets.installedPluginBytes} bytes`,
);
console.log(
  `PASS  Prompt inventory: ${generatedInventory.agentsScanned} agents, ` +
  `${generatedInventory.pluginAssetReferences.length} plugin refs, ` +
  `${generatedInventory.targetFileReferences.length} target refs, ` +
  `${generatedInventory.commandReferences.length} commands`,
);

function validateSourceManifest(manifest) {
  if (manifest.schemaVersion !== 1) fail('runtime asset source manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) fail('runtime asset source manifest has no assets');
  const ids = new Set();
  const destinations = new Set();
  for (const asset of manifest.assets) {
    if (!asset.id || ids.has(asset.id)) fail(`duplicate or missing asset id: ${asset.id ?? '(missing)'}`);
    ids.add(asset.id);
    if (!asset.source?.startsWith('argus/')) fail(`asset ${asset.id} source must stay under argus/`);
    if (!/^(references|schemas|templates)(?:\/|$)/.test(asset.destination ?? '')) {
      fail(`asset ${asset.id} destination must stay under references/, schemas/, or templates/`);
    }
    if (destinations.has(asset.destination)) fail(`duplicate asset destination: ${asset.destination}`);
    destinations.add(asset.destination);
    safePluginPath(asset.destination);
    if (!existsSync(join(ROOT, asset.source))) fail(`asset ${asset.id} source is missing: ${asset.source}`);
  }
}

function sourceFiles(asset) {
  const sourceAbs = join(ROOT, asset.source);
  if (statSync(sourceAbs).isFile()) return [{ sourceAbs, relativePath: '' }];
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', asset.source],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const prefix = `${asset.source}/`;
  const files = output.split('\n').filter(Boolean).filter((path) => path.startsWith(prefix)).sort();
  if (files.length === 0) fail(`asset ${asset.id} directory has no tracked or trackable files: ${asset.source}`);
  return files.map((path) => ({ sourceAbs: join(ROOT, path), relativePath: path.slice(prefix.length) }));
}

function writeAsset(asset) {
  const destinationAbs = safePluginPath(asset.destination);
  rmSync(destinationAbs, { recursive: true, force: true });
  const files = sourceFiles(asset);
  for (const file of files) {
    const target = file.relativePath ? join(destinationAbs, file.relativePath) : destinationAbs;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourceAbs, target);
    chmodSync(target, statSync(file.sourceAbs).mode & 0o777);
  }
}

function checkAsset(asset) {
  const destinationAbs = safePluginPath(asset.destination);
  if (!existsSync(destinationAbs)) fail(`generated asset is missing: ${asset.destination}; run --write`);
  const expected = sourceFiles(asset).map((file) => file.relativePath).sort();
  const actual = statSync(destinationAbs).isFile()
    ? ['']
    : walkFiles(destinationAbs).map((path) => relative(destinationAbs, path).split(sep).join('/')).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(`generated asset file list drift: ${asset.id}; run --write`);
  }
  for (const file of sourceFiles(asset)) {
    const target = file.relativePath ? join(destinationAbs, file.relativePath) : destinationAbs;
    if (readFileSync(file.sourceAbs).compare(readFileSync(target)) !== 0) {
      fail(`generated asset content drift: ${asset.id}/${file.relativePath || '(file)'}; run --write`);
    }
  }
}

function buildGeneratedManifest(manifest) {
  return {
    ...manifest,
    $schema: './schemas/runtime-assets.schema.json',
    generated: true,
    generatedFrom: 'argus/runtime-assets.source.json',
    assets: manifest.assets.map((asset) => {
      const stats = treeStats(safePluginPath(asset.destination));
      return { ...asset, files: stats.files, bytes: stats.bytes, sha256: stats.sha256 };
    }),
  };
}

function buildReferenceInventory() {
  const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md')).sort();
  const pluginRefs = new Map();
  const targetRefs = new Map();
  const commandRefs = new Map();
  const commands = [
    'autocannon', 'bash', 'chmod', 'claude', 'cp', 'curl', 'date', 'docker-compose',
    'docker', 'find', 'gh', 'git', 'gradle', 'grep', 'java', 'javac', 'jq', 'k6',
    'lsof', 'make', 'mkdir', 'mv', 'mvn', 'mysql', 'netstat', 'node', 'npm', 'npx',
    'pip', 'pip3', 'playwright', 'printf', 'psql', 'pytest', 'python', 'python3', 'rg',
    'rm', 'sed', 'sh', 'sqlite3', 'ss', 'tail', 'tsc', 'wget',
  ];
  const commandPattern = new RegExp(`(?<![A-Za-z0-9_.-])(${commands.map(escapeRegex).join('|')})(?![A-Za-z0-9_.-])`, 'g');

  for (const name of agentFiles) {
    const slug = name.slice(0, -3);
    const text = readFileSync(join(AGENTS_DIR, name), 'utf8');
    for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
      addConsumer(pluginRefs, match[1], slug);
    }
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const value = match[1].trim();
      if (isTargetFileReference(value)) addConsumer(targetRefs, value, slug);
    }
    for (const match of text.matchAll(commandPattern)) addConsumer(commandRefs, match[1], slug);
  }

  return {
    schemaVersion: 1,
    generatedFrom: 'argus/claude/agents/*.md',
    agentsScanned: agentFiles.length,
    pluginAssetReferences: mapToInventory(pluginRefs),
    targetFileReferences: mapToInventory(targetRefs),
    commandReferences: mapToInventory(commandRefs),
  };
}

function validatePromptReferences(manifest, inventory) {
  const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md')).sort();
  for (const name of agentFiles) {
    const text = readFileSync(join(AGENTS_DIR, name), 'utf8');
    for (const forbidden of manifest.forbiddenPromptReferences) {
      if (text.includes(forbidden)) fail(`${name} points outside the installed plugin: ${forbidden}`);
    }
  }
  for (const reference of inventory.pluginAssetReferences) {
    const path = safePluginPath(reference.value);
    if (!existsSync(path)) fail(`prompt plugin reference is missing: \${CLAUDE_PLUGIN_ROOT}/${reference.value}`);
  }
  if (inventory.agentsScanned !== 27) fail(`prompt inventory scanned ${inventory.agentsScanned} agents; expected 27`);
}

function validateBudgets(manifest, generatedManifest) {
  const assetBytes = generatedManifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (assetBytes > manifest.budgets.generatedAssetsBytes) {
    fail(`generated assets exceed budget: ${assetBytes} > ${manifest.budgets.generatedAssetsBytes}`);
  }
  const pluginBytes = treeStats(PLUGIN_ROOT).bytes;
  if (pluginBytes > manifest.budgets.installedPluginBytes) {
    fail(`installed plugin exceeds budget: ${pluginBytes} > ${manifest.budgets.installedPluginBytes}`);
  }
}

function isTargetFileReference(value) {
  if (value.startsWith('${CLAUDE_PLUGIN_ROOT}/')) return false;
  if (value.length > 180 || /[\n\r]/.test(value)) return false;
  return /^(?:\.\/)?(?:solution|tests|src|reports|bugs|scripts|ai_agents_internal|\.pw-profiles|\.auth)\//.test(value) ||
    /^(?:run-tests\.sh|README\.md|AGENTS\.md|CLAUDE\.md|package(?:-lock)?\.json|playwright\.config\.ts|tsconfig\.json|pom\.xml|pyproject\.toml|requirements\.txt)$/.test(value);
}

function addConsumer(map, value, consumer) {
  if (!map.has(value)) map.set(value, new Set());
  map.get(value).add(consumer);
}

function mapToInventory(map) {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, consumers]) => ({ value, consumers: [...consumers].sort() }));
}

function treeStats(path) {
  const files = statSync(path).isFile() ? [path] : walkFiles(path);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files.sort()) {
    const rel = statSync(path).isFile() ? file.split(sep).at(-1) : relative(path, file).split(sep).join('/');
    const content = readFileSync(file);
    bytes += content.length;
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else if (stat.isFile()) out.push(path);
    else fail(`runtime asset contains unsupported filesystem entry: ${path}`);
  }
  return out;
}

function safePluginPath(relativePath) {
  const path = resolve(PLUGIN_ROOT, relativePath);
  if (path !== PLUGIN_ROOT && !path.startsWith(`${PLUGIN_ROOT}${sep}`)) fail(`path escapes plugin root: ${relativePath}`);
  return path;
}

function assertJsonEquals(path, expected, label) {
  if (!existsSync(path)) fail(`${label} is missing; run --write`);
  const actual = readJson(path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} is stale; run --write`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot parse JSON ${relative(ROOT, path)}: ${error.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
