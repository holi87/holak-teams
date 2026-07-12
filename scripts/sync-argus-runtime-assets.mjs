#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SOURCE_MANIFEST_PATH = join(ROOT, 'argus', 'runtime-assets.source.json');
const PLUGIN_ROOT = join(ROOT, 'argus', 'claude');
const GENERATED_MANIFEST_PATH = join(PLUGIN_ROOT, 'runtime-assets.json');
const GENERATED_INVENTORY_PATH = join(PLUGIN_ROOT, 'runtime-reference-inventory.json');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');
const ENTRYPOINTS = [
  { id: '/argus:run', path: 'skills/run/SKILL.md' },
];
const HOST_COMMANDS = [
  'autocannon', 'bash', 'chmod', 'claude', 'cp', 'curl', 'date', 'docker-compose',
  'docker', 'find', 'gh', 'git', 'gradle', 'grep', 'grpc_cli', 'grpcurl', 'java',
  'javac', 'jq', 'k6', 'kafka-console-consumer', 'kafka-console-producer', 'kcat',
  'lsof', 'make', 'mkdir', 'mv', 'mvn', 'mysql', 'netstat', 'node', 'npm', 'npx',
  'pip', 'pip3', 'playwright', 'printf', 'psql', 'pytest', 'python', 'python3',
  'rabbitmqadmin', 'rg', 'rm', 'sed', 'sh', 'sqlite3', 'ss', 'tail', 'tsc',
  'websocat', 'wget', 'wscat',
];
// Short command names are too ambiguous to scan in prose. Count them only in
// Markdown code, where they are executable references rather than English text.
const CODE_CONTEXT_HOST_COMMANDS = ['buf', 'nc'];
const sourceManifest = readJson(SOURCE_MANIFEST_PATH);

if (isDirectInvocation()) main();

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

function main() {
  const mode = process.argv[2] ?? '--check';
  if (!['--write', '--check'].includes(mode)) {
    fail('usage: scripts/sync-argus-runtime-assets.mjs [--write|--check]');
  }

  validateSourceManifest(sourceManifest);
  preflightWritableRoots();
  syncUnownedPackagedPaths(mode);

  for (const [runtime, composition] of Object.entries(sourceManifest.templateCompositions)) {
    syncTemplateCommon(runtime, composition, mode);
  }

  for (const asset of sourceManifest.assets) {
    if (mode === '--write') writeAsset(asset);
    checkAsset(asset);
  }

  for (const [runtime, composition] of Object.entries(sourceManifest.templateCompositions)) {
    checkTemplateComposition(runtime, composition);
  }

  const generatedInventory = buildReferenceInventory();
  const generatedManifest = buildGeneratedManifest(sourceManifest, generatedInventory);

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
    `PASS  Runtime inventory v2: ${generatedInventory.agentsScanned} agents, ` +
    `${generatedInventory.skillsScanned} packaged skills, ` +
    `${generatedInventory.entrypointsScanned} entrypoints, ` +
    `${generatedInventory.assetConsumers.length} consumed assets, ` +
    `${generatedInventory.pluginAssetReferences.length} plugin refs, ` +
    `${generatedInventory.targetFileReferences.length} target refs, ` +
    `${generatedInventory.commandReferences.length} commands`,
  );
}

function validateSourceManifest(manifest) {
  if (manifest.schemaVersion !== 1) fail('runtime asset source manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) fail('runtime asset source manifest has no assets');
  if (!Array.isArray(manifest.buildOnly)) fail('runtime asset source manifest buildOnly must be an array');
  if (!Array.isArray(manifest.maintainerOnly)) fail('runtime asset source manifest maintainerOnly must be an array');
  const ids = new Set();
  const destinations = [];
  for (const asset of manifest.assets) {
    if (!asset.id || ids.has(asset.id)) fail(`duplicate or missing asset id: ${asset.id ?? '(missing)'}`);
    ids.add(asset.id);
    if (!asset.source?.startsWith('argus/')) fail(`asset ${asset.id} source must stay under argus/`);
    if (!/^(bin|capabilities|lib|policies|references|schemas|skills|templates)(?:\/|$)/.test(asset.destination ?? '')) {
      fail(`asset ${asset.id} destination must stay under bin/, capabilities/, lib/, policies/, references/, schemas/, skills/, or templates/`);
    }
    const overlap = destinations.find((destination) =>
      sourceContains(destination, asset.destination) || sourceContains(asset.destination, destination));
    if (overlap) fail(`overlapping asset destinations: ${overlap} and ${asset.destination}`);
    destinations.push(asset.destination);
    safePluginPath(asset.destination);
    if (!existsSync(join(ROOT, asset.source))) fail(`asset ${asset.id} source is missing: ${asset.source}`);
  }
  validateExcludedSources(manifest, ids);
  const compositions = manifest.templateCompositions;
  if (!compositions || JSON.stringify(Object.keys(compositions).sort()) !== JSON.stringify(['java', 'python', 'typescript'])) {
    fail('runtime asset source manifest must define exactly java, python, and typescript template compositions');
  }
  for (const [runtime, composition] of Object.entries(compositions)) {
    const common = manifest.assets.find((asset) => asset.id === composition.commonAsset);
    const layer = manifest.assets.find((asset) => asset.id === composition.runtimeAsset);
    if (!common || common.kind !== 'template') fail(`${runtime} template composition has an invalid common asset`);
    if (!layer || layer.kind !== 'template') fail(`${runtime} template composition has an invalid runtime asset`);
    if (common.id !== 'common-template') fail(`${runtime} template composition must use common-template`);
    if (layer.source !== composition.source) fail(`${runtime} template composition source does not match ${layer.id}`);
    if (composition.runtimeAsset !== `${runtime}-template`) fail(`${runtime} template composition has a mismatched runtime asset`);
  }
}

function sourceFiles(asset) {
  const files = allSourceFiles(asset).filter((file) => !isBuildOnlySource(file.sourceAbs));
  const composition = Object.values(sourceManifest.templateCompositions)
    .find((candidate) => candidate.runtimeAsset === asset.id);
  if (!composition) return files;
  const common = sourceManifest.assets.find((candidate) => candidate.id === composition.commonAsset);
  const commonPaths = new Set(allSourceFiles(common).map((file) => file.relativePath));
  return files.filter((file) => !commonPaths.has(file.relativePath));
}

function validateExcludedSources(manifest) {
  const overlaps = findExcludedSourceOverlaps(manifest);
  if (overlaps.length > 0) fail(overlaps[0]);
  const seen = new Map();
  for (const [kind, records] of [['buildOnly', manifest.buildOnly], ['maintainerOnly', manifest.maintainerOnly]]) {
    for (const record of records) {
      if (!record?.source?.startsWith('argus/') || !record.reason) fail(`${kind} contains an invalid source record`);
      if (seen.has(record.source)) fail(`${record.source} overlaps ${seen.get(record.source)} and ${kind}`);
      seen.set(record.source, kind);
      const absolute = join(ROOT, record.source);
      if (!existsSync(absolute)) fail(`${kind} source is missing: ${record.source}`);
      if (lstatSync(absolute).isSymbolicLink()) fail(`${kind} source cannot be a symbolic link: ${record.source}`);
    }
  }
  for (const record of manifest.buildOnly) {
    const owners = manifest.assets.filter((asset) => sourceContains(asset.source, record.source));
    if (owners.length !== 1) fail(`buildOnly source must belong to exactly one packaged source tree: ${record.source}`);
  }
  for (const record of manifest.maintainerOnly) {
    if (manifest.assets.some((asset) => sourceContains(asset.source, record.source) || sourceContains(record.source, asset.source))) {
      fail(`maintainerOnly source overlaps a packaged asset source: ${record.source}`);
    }
  }
}

export function findExcludedSourceOverlaps(manifest) {
  const records = [
    ...(manifest.buildOnly ?? []).map((record) => ({ ...record, kind: 'buildOnly' })),
    ...(manifest.maintainerOnly ?? []).map((record) => ({ ...record, kind: 'maintainerOnly' })),
  ];
  const diagnostics = [];
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const left = records[leftIndex];
      const right = records[rightIndex];
      if (sourceContains(left.source, right.source) || sourceContains(right.source, left.source)) {
        diagnostics.push(
          `${left.kind} and ${right.kind} sources overlap: ${left.source} and ${right.source}`,
        );
      }
    }
  }
  return diagnostics.sort();
}

function isBuildOnlySource(sourceAbs) {
  const source = relative(ROOT, sourceAbs).split(sep).join('/');
  return sourceManifest.buildOnly.some((record) => sourceContains(record.source, source));
}

function sourceContains(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function allSourceFiles(asset) {
  const sourceAbs = join(ROOT, asset.source);
  if (lstatSync(sourceAbs).isSymbolicLink()) fail(`asset ${asset.id} source cannot be a symbolic link`);
  if (statSync(sourceAbs).isFile()) return [sourceFile(sourceAbs, '')];
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', asset.source],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const prefix = `${asset.source}/`;
  const files = output.split('\n').filter(Boolean).filter((path) => path.startsWith(prefix) && existsSync(join(ROOT, path))).sort();
  if (files.length === 0) fail(`asset ${asset.id} directory has no tracked or trackable files: ${asset.source}`);
  return files.map((path) => sourceFile(join(ROOT, path), path.slice(prefix.length)));
}

function sourceFile(sourceAbs, relativePath) {
  const info = lstatSync(sourceAbs);
  if (info.isSymbolicLink()) fail(`runtime asset source contains a symbolic link: ${relative(ROOT, sourceAbs)}`);
  if (!info.isFile()) fail(`runtime asset source contains a non-file entry: ${relative(ROOT, sourceAbs)}`);
  return { sourceAbs, relativePath };
}

function preflightWritableRoots() {
  assertWritablePath(ROOT, PLUGIN_ROOT, 'plugin root', true);
  for (const asset of sourceManifest.assets) {
    assertWritablePath(
      PLUGIN_ROOT,
      safePluginPath(asset.destination),
      `asset destination ${asset.id}`,
      true,
    );
  }
  for (const [runtime, composition] of Object.entries(sourceManifest.templateCompositions)) {
    const sourceRoot = join(ROOT, composition.source);
    assertWritablePath(ROOT, sourceRoot, `${runtime} complete template source`, false);
    const common = sourceManifest.assets.find((asset) => asset.id === composition.commonAsset);
    for (const directory of sourceDirectories(common)) {
      assertWritablePath(ROOT, join(sourceRoot, directory.relativePath), `${runtime} common directory`, true);
    }
    for (const file of allSourceFiles(common)) {
      assertWritablePath(ROOT, join(sourceRoot, file.relativePath), `${runtime} common file`, false);
    }
  }
}

function assertWritablePath(base, candidate, label, scanLeafTree) {
  const basePath = resolve(base);
  const candidatePath = resolve(candidate);
  if (!isWithin(basePath, candidatePath)) fail(`${label} escapes its writable root: ${candidate}`);
  if (!existsSync(basePath)) fail(`${label} writable root is missing: ${basePath}`);
  const realBase = inspectWritableEntry(basePath, label, true);
  const relativePath = relative(basePath, candidatePath);
  let cursor = basePath;
  for (const part of relativePath ? relativePath.split(sep) : []) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    const isLeaf = cursor === candidatePath;
    inspectWritableEntry(cursor, label, !isLeaf);
    const physical = realpathSync(cursor);
    if (!isWithin(realBase, physical)) fail(`${label} resolves outside its writable root: ${candidate}`);
  }
  if (scanLeafTree && existsSync(candidatePath) && lstatSync(candidatePath).isDirectory()) {
    assertTreeHasNoLinks(candidatePath, label);
  }
}

function inspectWritableEntry(path, label, mustBeDirectory) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) fail(`${label} contains a symbolic link: ${path}`);
  if (mustBeDirectory && !info.isDirectory()) fail(`${label} has a non-directory ancestor: ${path}`);
  if (!info.isDirectory() && !info.isFile()) fail(`${label} contains an unsupported filesystem entry: ${path}`);
  return realpathSync(path);
}

function assertTreeHasNoLinks(root, label) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) fail(`${label} contains a symbolic link: ${path}`);
    if (info.isDirectory()) assertTreeHasNoLinks(path, label);
    else if (!info.isFile()) fail(`${label} contains an unsupported filesystem entry: ${path}`);
  }
}

function syncUnownedPackagedPaths(mode) {
  const owned = expectedPackagedPaths();
  const unowned = listPackagedEntries()
    .filter((entry) => !owned.has(entry.relativePath))
    .sort((left, right) => right.relativePath.split('/').length - left.relativePath.split('/').length ||
      right.relativePath.localeCompare(left.relativePath));
  if (unowned.length === 0) return;
  if (mode === '--check') {
    fail(`unowned packaged path: ${unowned.at(-1).relativePath}; run --write`);
  }
  for (const entry of unowned) {
    if (existsSync(entry.path)) rmSync(entry.path, { recursive: true, force: true });
  }
}

function expectedPackagedPaths() {
  const owned = new Set();
  const add = (relativePath) => {
    const normalized = relativePath.split(sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized || normalized.split('/').includes('..')) fail(`invalid owned plugin path: ${relativePath}`);
    const parts = normalized.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      owned.add(parts.slice(0, index).join('/'));
    }
  };
  for (const path of [
    '.claude-plugin/plugin.json',
    'bin/argus-assets',
    'hooks/hooks.json',
    'skills/run/SKILL.md',
    'runtime-assets.json',
    'runtime-reference-inventory.json',
  ]) add(path);
  const capabilityMatrix = readJson(join(ROOT, 'argus', 'capabilities', 'capability-matrix.json'));
  for (const agent of capabilityMatrix.agents ?? []) add(`agents/${agent.slug}.md`);
  for (const asset of sourceManifest.assets) {
    add(asset.destination);
    const sourceRoot = join(ROOT, asset.source);
    if (statSync(sourceRoot).isFile()) continue;
    for (const directory of sourceDirectories(asset)) add(`${asset.destination}/${directory.relativePath}`);
    for (const file of sourceFiles(asset)) add(`${asset.destination}/${file.relativePath}`);
  }
  return owned;
}

function listPackagedEntries(root = PLUGIN_ROOT, prefix = '', output = []) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(path);
    output.push({ path, relativePath });
    if (info.isDirectory()) listPackagedEntries(path, relativePath, output);
  }
  return output;
}

function syncTemplateCommon(runtime, composition, mode) {
  const common = sourceManifest.assets.find((asset) => asset.id === composition.commonAsset);
  const sourceRoot = join(ROOT, composition.source);
  for (const directory of sourceDirectories(common)) {
    const target = join(sourceRoot, directory.relativePath);
    if (mode === '--write') {
      assertWritablePath(ROOT, target, `${runtime} common directory`, true);
      mkdirSync(target, { recursive: true });
      chmodSync(target, directory.mode);
    }
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
      fail(`${runtime} common template directory is unsafe: ${directory.relativePath}`);
    }
    if ((lstatSync(target).mode & 0o777) !== directory.mode) {
      fail(`${runtime} common template directory mode drift: ${directory.relativePath}; run --write`);
    }
  }
  for (const file of allSourceFiles(common)) {
    const target = join(sourceRoot, file.relativePath);
    if (mode === '--write') {
      assertWritablePath(ROOT, target, `${runtime} common file`, false);
      if (existsSync(target) && !lstatSync(target).isFile()) {
        fail(`${runtime} common template path is not a regular file: ${file.relativePath}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(file.sourceAbs));
      chmodSync(target, statSync(file.sourceAbs).mode & 0o777);
    }
    if (!existsSync(target)) fail(`${runtime} template omits common file ${file.relativePath}; run --write`);
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      fail(`${runtime} common template path is not a regular file: ${file.relativePath}`);
    }
    if (readFileSync(file.sourceAbs).compare(readFileSync(target)) !== 0) {
      fail(`${runtime} common template content drift: ${file.relativePath}; run --write`);
    }
    if ((statSync(file.sourceAbs).mode & 0o777) !== (statSync(target).mode & 0o777)) {
      fail(`${runtime} common template mode drift: ${file.relativePath}; run --write`);
    }
  }
}

function writeAsset(asset) {
  const destinationAbs = safePluginPath(asset.destination);
  assertWritablePath(PLUGIN_ROOT, destinationAbs, `asset destination ${asset.id}`, true);
  const files = sourceFiles(asset);
  const sourceIsFile = statSync(join(ROOT, asset.source)).isFile();
  if (sourceIsFile) {
    if (existsSync(destinationAbs) && statSync(destinationAbs).isDirectory()) rmSync(destinationAbs, { recursive: true, force: true });
  } else {
    if (existsSync(destinationAbs) && !statSync(destinationAbs).isDirectory()) rmSync(destinationAbs, { force: true });
    mkdirSync(destinationAbs, { recursive: true });
    const expected = new Set(files.map((file) => file.relativePath));
    for (const existing of walkFiles(destinationAbs)) {
      const relativePath = relative(destinationAbs, existing).split(sep).join('/');
      if (!expected.has(relativePath)) rmSync(existing, { force: true });
    }
    const expectedDirectories = new Set(sourceDirectories(asset).map((entry) => entry.relativePath));
    for (const existing of walkDirectories(destinationAbs).sort((left, right) => right.length - left.length)) {
      const relativePath = relative(destinationAbs, existing).split(sep).join('/');
      if (!expectedDirectories.has(relativePath)) rmSync(existing, { recursive: true, force: true });
    }
    for (const directory of sourceDirectories(asset)) {
      const target = join(destinationAbs, directory.relativePath);
      mkdirSync(target, { recursive: true });
      chmodSync(target, directory.mode);
    }
  }
  for (const file of files) {
    const target = file.relativePath ? join(destinationAbs, file.relativePath) : destinationAbs;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file.sourceAbs));
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
  if (!statSync(destinationAbs).isFile()) {
    const expectedDirectories = sourceDirectories(asset);
    const actualDirectories = walkDirectories(destinationAbs)
      .map((path) => relative(destinationAbs, path).split(sep).join('/'))
      .sort();
    if (JSON.stringify(expectedDirectories.map((entry) => entry.relativePath)) !== JSON.stringify(actualDirectories)) {
      fail(`generated asset directory list drift: ${asset.id}; run --write`);
    }
    for (const directory of expectedDirectories) {
      const target = join(destinationAbs, directory.relativePath);
      if ((lstatSync(target).mode & 0o777) !== directory.mode) {
        fail(`generated asset directory mode drift: ${asset.id}/${directory.relativePath}; run --write`);
      }
    }
  }
  for (const file of sourceFiles(asset)) {
    const target = file.relativePath ? join(destinationAbs, file.relativePath) : destinationAbs;
    if (readFileSync(file.sourceAbs).compare(readFileSync(target)) !== 0) {
      fail(`generated asset content drift: ${asset.id}/${file.relativePath || '(file)'}; run --write`);
    }
    if ((statSync(file.sourceAbs).mode & 0o777) !== (statSync(target).mode & 0o777)) {
      fail(`generated asset mode drift: ${asset.id}/${file.relativePath || '(file)'}; run --write`);
    }
  }
}

function sourceDirectories(asset, files = sourceFiles(asset)) {
  const sourceRoot = join(ROOT, asset.source);
  if (statSync(sourceRoot).isFile()) return [];
  const directories = new Map();
  for (const file of files) {
    let parent = dirname(file.relativePath).split(sep).join('/');
    while (parent && parent !== '.') {
      if (!directories.has(parent)) {
        const source = join(sourceRoot, parent);
        const info = lstatSync(source);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          fail(`runtime asset source contains an unsafe directory: ${relative(ROOT, source)}`);
        }
        directories.set(parent, info.mode & 0o777);
      }
      const next = dirname(parent).split(sep).join('/');
      if (next === parent) break;
      parent = next;
    }
  }
  return [...directories.entries()]
    .map(([relativePath, mode]) => ({ relativePath, mode }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function checkTemplateComposition(runtime, composition) {
  const commonAsset = sourceManifest.assets.find((asset) => asset.id === composition.commonAsset);
  const runtimeAsset = sourceManifest.assets.find((asset) => asset.id === composition.runtimeAsset);
  const complete = allSourceFiles(runtimeAsset);
  const common = allSourceFiles(commonAsset);
  const layer = sourceFiles(runtimeAsset);
  const union = new Map();
  for (const [kind, files] of [['common', common], ['runtime', layer]]) {
    for (const file of files) {
      if (union.has(file.relativePath)) fail(`${runtime} template composition file collision: ${file.relativePath}`);
      union.set(file.relativePath, { kind, file });
    }
  }
  const expectedPaths = complete.map((file) => file.relativePath).sort();
  const composedPaths = [...union.keys()].sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(composedPaths)) {
    fail(`${runtime} template composition does not exactly cover its complete source tree`);
  }
  for (const source of complete) {
    const component = union.get(source.relativePath).file;
    if (readFileSync(source.sourceAbs).compare(readFileSync(component.sourceAbs)) !== 0) {
      fail(`${runtime} template composition content mismatch: ${source.relativePath}`);
    }
    if ((statSync(source.sourceAbs).mode & 0o777) !== (statSync(component.sourceAbs).mode & 0o777)) {
      fail(`${runtime} template composition mode mismatch: ${source.relativePath}`);
    }
  }
  const completeDirectories = sourceDirectories(runtimeAsset, complete);
  const directoryUnion = new Map();
  for (const [kind, directories] of [
    ['common', sourceDirectories(commonAsset)],
    ['runtime', sourceDirectories(runtimeAsset)],
  ]) {
    for (const directory of directories) {
      const prior = directoryUnion.get(directory.relativePath);
      if (prior && prior.mode !== directory.mode) {
        fail(`${runtime} template composition directory mode collision: ${directory.relativePath} (${prior.kind} vs ${kind})`);
      }
      if (!prior) directoryUnion.set(directory.relativePath, { ...directory, kind });
    }
  }
  if (JSON.stringify([...directoryUnion.keys()].sort()) !== JSON.stringify(completeDirectories.map((entry) => entry.relativePath))) {
    fail(`${runtime} template composition directory union does not exactly cover its complete source tree`);
  }
  for (const directory of completeDirectories) {
    if (directoryUnion.get(directory.relativePath).mode !== directory.mode) {
      fail(`${runtime} template composition directory mode mismatch: ${directory.relativePath}`);
    }
  }
  const packagedPaths = new Set();
  for (const asset of [commonAsset, runtimeAsset]) {
    const root = safePluginPath(asset.destination);
    for (const path of walkFiles(root)) {
      const relativePath = relative(root, path).split(sep).join('/');
      if (packagedPaths.has(relativePath)) fail(`${runtime} packaged template layer collision: ${relativePath}`);
      packagedPaths.add(relativePath);
    }
  }
  if (JSON.stringify([...packagedPaths].sort()) !== JSON.stringify(expectedPaths)) {
    fail(`${runtime} packaged template composition does not exactly match the complete source tree`);
  }
}

function buildGeneratedManifest(manifest, inventory) {
  const inventoryStats = jsonDocumentStats(inventory);
  return {
    ...manifest,
    $schema: './schemas/runtime-assets.schema.json',
    generated: true,
    generatedFrom: 'argus/runtime-assets.source.json',
    inventory: {
      path: 'runtime-reference-inventory.json',
      schemaVersion: inventory.schemaVersion,
      bytes: inventoryStats.bytes,
      sha256: inventoryStats.sha256,
    },
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
  const pluginReferenceRecords = [];
  const commandAssetReferences = [];
  const preloadedAssignments = [];

  for (const name of agentFiles) {
    const slug = name.slice(0, -3);
    const agentText = readFileSync(join(AGENTS_DIR, name), 'utf8');
    scanReferenceText(
      agentText,
      slug,
      'agent',
      pluginRefs,
      targetRefs,
      commandRefs,
      pluginReferenceRecords,
      commandAssetReferences,
    );
    const skills = preloadedSkills(agentText);
    for (const skill of skills) {
      const skillPath = `skills/${skill}/SKILL.md`;
      const absolute = safePluginPath(skillPath);
      if (!existsSync(absolute)) fail(`${name} preloads missing plugin skill: ${skill}`);
      addConsumer(pluginRefs, skillPath, slug);
      preloadedAssignments.push({ agent: slug, skill });
    }
  }

  const skills = packagedSkillRecords();
  const entrypointPaths = new Map(ENTRYPOINTS.map((entrypoint) => [entrypoint.path, entrypoint.id]));
  for (const skill of skills) {
    const consumer = entrypointPaths.get(skill.path) ?? `skill:${skill.name}`;
    const sourceKind = entrypointPaths.has(skill.path) ? 'entrypoint' : 'skill';
    scanReferenceText(
      skill.text,
      consumer,
      sourceKind,
      pluginRefs,
      targetRefs,
      commandRefs,
      pluginReferenceRecords,
      commandAssetReferences,
    );
  }

  for (const entrypoint of ENTRYPOINTS) {
    const absolute = safePluginPath(entrypoint.path);
    if (!existsSync(absolute)) fail(`runtime entrypoint is missing: ${entrypoint.path}`);
    if (!skills.some((skill) => skill.path === entrypoint.path)) {
      fail(`runtime entrypoint is not part of the packaged skill inventory: ${entrypoint.path}`);
    }
  }

  const runtimeFiles = walkFiles(safePluginPath('lib')).map((path) => ({
    path: relative(PLUGIN_ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));
  const hooksDocument = readJson(safePluginPath('hooks/hooks.json'));
  const audit = analyzeAssetConsumers({
    manifest: sourceManifest,
    capabilityMatrix: readJson(safePluginPath('capabilities/capability-matrix.json')),
    orchestrationPlan: readJson(safePluginPath('capabilities/orchestration-plan.json')),
    pluginReferences: pluginReferenceRecords,
    commandAssetReferences,
    preloadedAssignments,
    skills,
    cliText: readFileSync(safePluginPath('bin/argus-assets'), 'utf8'),
    runtimeFiles,
    hooksDocument,
  });
  assertAssetAuditClean(audit);

  return {
    schemaVersion: 2,
    generatedFrom: 'all packaged Argus agents, skills, entrypoints, capability declarations, runtime imports, hooks, CLI commands, and template compositions',
    agentsScanned: agentFiles.length,
    skillsScanned: skills.length,
    entrypointsScanned: ENTRYPOINTS.length,
    runtimeFilesScanned: runtimeFiles.length,
    runtimeImportsScanned: audit.runtimeImportsScanned,
    hooksScanned: countHooks(hooksDocument),
    pluginAssetReferences: mapToInventory(pluginRefs),
    targetFileReferences: mapToInventory(targetRefs),
    commandReferences: mapToInventory(commandRefs),
    assetConsumers: audit.assetConsumers,
    unconsumedAssets: audit.unconsumedAssets,
    unknownAssetReferences: audit.unknownAssetReferences,
    unknownProfileReferences: audit.unknownProfileReferences,
    unownedPluginReferences: audit.unownedPluginReferences,
    unownedRuntimeReferences: audit.unownedRuntimeReferences,
    unownedSkills: audit.unownedSkills,
  };
}

function packagedSkillRecords() {
  const skillsRoot = safePluginPath('skills');
  const records = [];
  for (const directory of readdirSync(skillsRoot).sort()) {
    const path = `skills/${directory}/SKILL.md`;
    const absolute = safePluginPath(path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      fail(`packaged skill is missing SKILL.md: skills/${directory}`);
    }
    const text = readFileSync(absolute, 'utf8');
    const metadata = skillMetadata(text);
    if (metadata.name !== directory) {
      fail(`packaged skill name does not match its directory: ${directory} != ${metadata.name ?? '(missing)'}`);
    }
    records.push({
      name: directory,
      path,
      text,
      userInvocable: metadata.userInvocable !== false,
    });
  }
  return records;
}

function skillMetadata(text) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const name = frontmatter.match(/^name:\s*([^\s#]+)\s*$/m)?.[1];
  const userInvocableValue = frontmatter.match(/^user-invocable:\s*(true|false)\s*$/m)?.[1];
  return { name, userInvocable: userInvocableValue === undefined ? undefined : userInvocableValue === 'true' };
}

export function analyzeAssetConsumers({
  manifest,
  capabilityMatrix,
  orchestrationPlan,
  pluginReferences = [],
  commandAssetReferences = [],
  preloadedAssignments = [],
  skills = [],
  cliText = '',
  runtimeFiles = [],
  hooksDocument = {},
}) {
  const assets = new Map((manifest.assets ?? []).map((asset) => [asset.id, asset]));
  const consumers = new Map([...assets.keys()].map((id) => [id, new Map()]));
  const unknownAssetReferences = [];
  const unknownProfileReferences = [];
  const unownedPluginReferences = [];
  const unownedRuntimeReferences = [];
  const unownedSkills = [];

  const consume = (assetId, consumer, kind, mechanism, reference = assetId) => {
    if (!assets.has(assetId)) {
      unknownAssetReferences.push({ assetId, consumer, mechanism, reference });
      return;
    }
    const record = { consumer, kind, mechanism, reference };
    consumers.get(assetId).set(JSON.stringify(record), record);
  };

  for (const reference of pluginReferences) {
    const owners = pluginPathOwners(reference.value, manifest.assets ?? []);
    if (owners.length === 0) {
      unownedPluginReferences.push({
        value: reference.value,
        consumer: reference.consumer,
        sourceKind: reference.sourceKind,
      });
      continue;
    }
    for (const owner of owners) {
      consume(owner.id, reference.consumer, reference.sourceKind, 'plugin-path', reference.value);
    }
  }

  const skillAssets = new Map(
    [...assets.values()]
      .filter((asset) => asset.kind === 'skill' && /^skills\/[^/]+$/.test(asset.destination))
      .map((asset) => [asset.destination.split('/')[1], asset]),
  );
  for (const assignment of preloadedAssignments) {
    const asset = skillAssets.get(assignment.skill);
    if (!asset) {
      unknownAssetReferences.push({
        assetId: null,
        consumer: assignment.agent,
        mechanism: 'preloaded-skill',
        reference: assignment.skill,
      });
      continue;
    }
    consume(asset.id, assignment.agent, 'agent', 'preloaded-skill', assignment.skill);
  }

  const preloadedSkills = new Set(preloadedAssignments.map((assignment) => assignment.skill));
  const explicitlyReferencedSkills = new Set();
  for (const reference of pluginReferences) {
    for (const [skill, asset] of skillAssets) {
      if (pluginPathOwners(reference.value, [asset]).length > 0 && reference.consumer !== `skill:${skill}`) {
        explicitlyReferencedSkills.add(skill);
      }
    }
  }
  const entrypointSkillNames = new Set(
    ENTRYPOINTS.map((entrypoint) => entrypoint.path.split('/')[1]),
  );
  for (const skill of skills) {
    const asset = skillAssets.get(skill.name);
    if (!asset && !entrypointSkillNames.has(skill.name)) {
      unownedSkills.push({ skill: skill.name, reason: 'no-runtime-asset-or-entrypoint-owner' });
      continue;
    }
    if (asset && skill.userInvocable) {
      consume(asset.id, `user:${skill.name}`, 'user', 'user-invocable-skill', skill.path);
    }
    if (!skill.userInvocable && !preloadedSkills.has(skill.name) && !explicitlyReferencedSkills.has(skill.name)) {
      unownedSkills.push({ skill: skill.name, reason: 'non-user-invocable-and-unreachable' });
    }
  }

  const doctrineProfiles = capabilityMatrix.doctrineProfiles ?? {};
  const toolProfiles = capabilityMatrix.toolProfiles ?? {};
  const techniqueCatalogs = capabilityMatrix.techniqueCatalogs ?? {};
  for (const [profile, declaration] of Object.entries(doctrineProfiles)) {
    const requiredAsset = declaration?.requiredAsset;
    if (typeof requiredAsset !== 'string' || requiredAsset.length === 0) {
      unknownAssetReferences.push({
        assetId: requiredAsset ?? null,
        consumer: `profile:${profile}`,
        mechanism: 'doctrine-profile-required-asset',
        reference: profile,
      });
    } else {
      consume(requiredAsset, `profile:${profile}`, 'profile', 'doctrine-profile-required-asset', profile);
    }
  }

  const assignmentsByAgent = new Map();
  for (const assignment of preloadedAssignments) {
    if (!assignmentsByAgent.has(assignment.agent)) assignmentsByAgent.set(assignment.agent, new Set());
    assignmentsByAgent.get(assignment.agent).add(assignment.skill);
  }
  for (const agent of capabilityMatrix.agents ?? []) {
    for (const profile of agent.toolProfiles ?? []) {
      if (!Object.hasOwn(toolProfiles, profile)) {
        unknownProfileReferences.push({ consumer: agent.slug, profileType: 'tool', profile });
      }
    }
    for (const profile of agent.techniqueCatalogs ?? []) {
      const declaration = techniqueCatalogs[profile];
      if (!declaration) {
        unknownProfileReferences.push({ consumer: agent.slug, profileType: 'technique-catalog', profile });
        continue;
      }
      consume(
        declaration.requiredAsset,
        agent.slug,
        'agent',
        'technique-catalog-assignment',
        profile,
      );
    }
    for (const profile of agent.doctrineProfiles ?? []) {
      const declaration = doctrineProfiles[profile];
      if (!declaration) {
        unknownProfileReferences.push({ consumer: agent.slug, profileType: 'doctrine', profile });
        continue;
      }
      consume(
        declaration.requiredAsset,
        agent.slug,
        'agent',
        'doctrine-profile-assignment',
        profile,
      );
      if (!assignmentsByAgent.get(agent.slug)?.has(profile)) {
        unknownProfileReferences.push({
          consumer: agent.slug,
          profileType: 'doctrine',
          profile,
          reason: 'assigned-profile-not-preloaded',
        });
      }
    }
  }

  for (const assetId of capabilityMatrix.orchestration?.requiredAssets ?? []) {
    consume(assetId, 'orchestration:controller', 'orchestration', 'required-asset', assetId);
  }

  for (const [field, value] of [
    ['capabilityMatrix', orchestrationPlan.capabilityMatrix],
    ['raci', orchestrationPlan.raci],
  ]) {
    if (typeof value !== 'string') {
      unownedPluginReferences.push({ value: value ?? null, consumer: 'orchestration-plan', sourceKind: field });
      continue;
    }
    const owners = pluginPathOwners(value, manifest.assets ?? []);
    if (owners.length === 0) {
      unownedPluginReferences.push({ value, consumer: 'orchestration-plan', sourceKind: field });
    }
    for (const owner of owners) {
      consume(owner.id, 'orchestration-plan', 'orchestration', 'plan-reference', `${field}:${value}`);
    }
  }

  for (const reference of commandAssetReferences) {
    consume(reference.assetId, reference.consumer, reference.sourceKind, 'argus-assets-path', reference.assetId);
  }

  const requireAssetAudit = analyzeRequireAssetCalls(cliText, new Set(assets.keys()));
  unknownAssetReferences.push(...requireAssetAudit.unknownAssetReferences);
  for (const call of requireAssetAudit.literalCalls) {
    consume(call.assetId, call.consumer, 'command', 'cli-require-asset', call.assetId);
  }

  for (const [runtime, composition] of Object.entries(manifest.templateCompositions ?? {})) {
    for (const [layer, assetId] of [
      ['common', composition.commonAsset],
      ['runtime', composition.runtimeAsset],
    ]) {
      consume(
        assetId,
        `command:argus-assets template scaffold ${runtime}`,
        'command',
        'validated-template-composition',
        `${runtime}:${layer}`,
      );
    }
  }

  const runtimePaths = new Set(runtimeFiles.map((file) => file.path));
  let runtimeImportsScanned = 0;
  for (const source of [{ path: 'bin/argus-assets', text: cliText }, ...runtimeFiles]) {
    for (const match of source.text.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g)) {
      runtimeImportsScanned += 1;
      const target = resolve('/', dirname(source.path), match[1]).slice(1);
      const normalized = /\.[A-Za-z0-9]+$/.test(target) ? target : `${target}.mjs`;
      if (!runtimePaths.has(normalized)) {
        unownedRuntimeReferences.push({ source: source.path, reference: match[1], resolved: normalized });
        continue;
      }
      for (const owner of pluginPathOwners(normalized, manifest.assets ?? [])) {
        consume(owner.id, source.path, 'runtime', 'runtime-import', match[1]);
      }
    }
  }

  const commandDependencies = [
    {
      consumer: 'command:argus-assets model benchmark',
      assets: ['model-policy-benchmark'],
      markers: ['function modelCommand', "operation === 'benchmark'", 'MODEL_BENCHMARK_PATH'],
    },
    {
      consumer: 'command:argus-assets orchestration plan',
      assets: ['orchestration-plan', 'capability-matrix', 'raci-matrix', 'runtime-library'],
      markers: ['function orchestrationCommand', 'projectOrchestrationPlan', 'ORCHESTRATION_PLAN_PATH', 'RACI_PATH'],
    },
    {
      consumer: 'command:argus-assets schema validate (schema compatibility)',
      assets: ['authorization-policies', 'runtime-schemas', 'runtime-library'],
      markers: ['function schemaCommand', 'validateCanonicalDocument'],
      runtimeMarkers: ['schema-compatibility.json', 'schema-compatibility.schema.json'],
    },
    {
      consumer: 'command:argus-assets template detect/select/scaffold',
      assets: ['template-policy', 'runtime-library'],
      markers: ['function templateCommand', 'TEMPLATE_CONTRACT_PATH', 'validateTemplateContract'],
    },
  ];
  const runtimeCorpus = runtimeFiles.map((file) => file.text).join('\n');
  for (const dependency of commandDependencies) {
    const relevant = dependency.assets.some((assetId) => assets.has(assetId));
    if (!relevant) continue;
    const missingMarkers = dependency.markers.filter((marker) => !cliText.includes(marker));
    const missingRuntimeMarkers = (dependency.runtimeMarkers ?? []).filter((marker) => !runtimeCorpus.includes(marker));
    if (missingMarkers.length > 0 || missingRuntimeMarkers.length > 0) {
      unknownAssetReferences.push({
        assetId: null,
        consumer: dependency.consumer,
        mechanism: 'command-dependency-marker',
        reference: [...missingMarkers, ...missingRuntimeMarkers].join(', '),
      });
      continue;
    }
    for (const assetId of dependency.assets) {
      consume(assetId, dependency.consumer, 'command', 'explicit-command-dependency', assetId);
    }
  }

  const hookCorpus = JSON.stringify(hooksDocument);
  if (hookCorpus.includes('${CLAUDE_PLUGIN_ROOT}/bin/argus-assets') && /\bguard\b/.test(hookCorpus)) {
    for (const assetId of ['authorization-policies', 'runtime-library']) {
      consume(assetId, 'hook:PreToolUse guard', 'hook', 'guard-command-dependency', assetId);
    }
  } else if (Object.keys(hooksDocument).length > 0) {
    unownedRuntimeReferences.push({ source: 'hooks/hooks.json', reference: 'PreToolUse guard', resolved: null });
  }

  const assetConsumers = [...assets.values()].map((asset) => ({
    assetId: asset.id,
    destination: asset.destination,
    consumers: [...consumers.get(asset.id).values()].sort(compareConsumerRecords),
  }));
  const unconsumedAssets = assetConsumers
    .filter((record) => record.consumers.length === 0)
    .map((record) => record.assetId);

  return {
    assetConsumers,
    unconsumedAssets,
    unknownAssetReferences: sortObjects(unknownAssetReferences),
    unknownProfileReferences: sortObjects(unknownProfileReferences),
    unownedPluginReferences: sortObjects(unownedPluginReferences),
    unownedRuntimeReferences: sortObjects(unownedRuntimeReferences),
    unownedSkills: sortObjects(unownedSkills),
    runtimeImportsScanned,
  };
}

export function analyzeRequireAssetCalls(cliText, assetIds) {
  const literalCalls = [];
  const unknownAssetReferences = [];
  for (const usage of scanRequireAssetUsages(cliText)) {
    const functionName = enclosingFunctionName(cliText, usage.index);
    if (usage.kind !== 'call') {
      unknownAssetReferences.push({
        assetId: null,
        consumer: `runtime:${functionName ?? 'top-level'}`,
        mechanism: 'indirect-require-asset-reference',
        reference: usage.reference,
      });
      continue;
    }
    const expression = usage.expression.trim();
    const staticLoopIds = staticRequireAssetLoopIds(cliText, functionName, expression);
    if (staticLoopIds) {
      for (const assetId of staticLoopIds) {
        if (!assetIds.has(assetId)) {
          unknownAssetReferences.push({
            assetId,
            consumer: `runtime:${functionName}`,
            mechanism: 'cli-require-asset',
            reference: assetId,
          });
        } else {
          literalCalls.push({ assetId, consumer: `runtime:${functionName}` });
        }
      }
      continue;
    }
    const literal = expression.match(/^(['"])([a-z0-9][a-z0-9-]*)\1$/)?.[2];
    if (literal) {
      if (!assetIds.has(literal)) {
        unknownAssetReferences.push({
          assetId: literal,
          consumer: `runtime:${functionName ?? 'top-level'}`,
          mechanism: 'cli-require-asset',
          reference: literal,
        });
      } else {
        literalCalls.push({ assetId: literal, consumer: `runtime:${functionName ?? 'top-level'}` });
      }
      continue;
    }
    const validatedCompositionLookup = ['copyTemplate', 'prepareTemplateComposition'].includes(functionName) &&
      ['composition.commonAsset', 'composition.runtimeAsset'].includes(expression);
    const genericPathLookup = functionName === 'printPath' && expression === 'id';
    if (validatedCompositionLookup || genericPathLookup) continue;
    unknownAssetReferences.push({
      assetId: null,
      consumer: `runtime:${functionName ?? 'top-level'}`,
      mechanism: 'dynamic-require-asset',
      reference: expression,
    });
  }
  return { literalCalls, unknownAssetReferences };
}

function staticRequireAssetLoopIds(text, functionName, expression) {
  if (expression !== 'id' || functionName !== 'assertTrustedModelRoutingAssets') return null;
  const functionMatch = text.match(/function\s+assertTrustedModelRoutingAssets\s*\(\)\s*\{([\s\S]*?)\n\}/);
  if (!functionMatch) return null;
  const list = functionMatch[1].match(/for\s*\(\s*const\s+id\s+of\s+\[([^\]]+)\]/)?.[1];
  if (!list) return null;
  const ids = [...list.matchAll(/(['"])([a-z0-9][a-z0-9-]*)\1/g)].map((match) => match[2]);
  const residue = list.replace(/(['"])[a-z0-9][a-z0-9-]*\1/g, '').replace(/[\s,]/g, '');
  return ids.length > 0 && residue === '' ? ids : null;
}

function scanRequireAssetUsages(text) {
  const usages = [];
  let index = 0;
  let previousToken = null;
  while (index < text.length) {
    const skipped = skipTrivia(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const character = text[index];
    if (character === '"' || character === "'") {
      index = skipQuoted(text, index, character);
      previousToken = { type: 'literal', value: character };
      continue;
    }
    if (character === '`') {
      const end = skipQuoted(text, index, '`');
      if (text.slice(index, end).includes('requireAsset')) {
        usages.push({ kind: 'reference', index, reference: 'requireAsset inside template literal' });
      }
      index = end;
      previousToken = { type: 'literal', value: '`' };
      continue;
    }
    if (character === '/' && regexCanStartAfter(previousToken)) {
      index = skipRegexLiteral(text, index);
      previousToken = { type: 'literal', value: '/' };
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) index += 1;
      const value = text.slice(start, index);
      if (value === 'requireAsset' && previousToken?.value !== 'function') {
        const callStart = skipTrivia(text, index);
        if (text[callStart] !== '(' || previousToken?.value === '.' || previousToken?.value === '?.') {
          usages.push({ kind: 'reference', index: start, reference: value });
        } else {
          const call = readCallExpression(text, callStart);
          if (!call) usages.push({ kind: 'reference', index: start, reference: 'unterminated requireAsset call' });
          else {
            usages.push({ kind: 'call', index: start, expression: call.expression });
            index = call.end;
          }
        }
      }
      previousToken = { type: 'identifier', value };
      continue;
    }
    const punctuator = text.startsWith('?.', index) ? '?.' : character;
    previousToken = { type: 'punctuator', value: punctuator };
    index += punctuator.length;
  }
  return usages;
}

function readCallExpression(text, openIndex) {
  let depth = 1;
  let index = openIndex + 1;
  while (index < text.length) {
    const skipped = skipTrivia(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(text, index, character);
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { expression: text.slice(openIndex + 1, index), end: index + 1 };
      }
    }
    index += 1;
  }
  return null;
}

function skipTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index + 2);
      index = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return index;
}

function skipQuoted(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === quote) return index + 1;
    else index += 1;
  }
  return text.length;
}

function regexCanStartAfter(token) {
  return !token || ['(', '[', '{', '=', ':', ',', ';', '!', '?', '|', '&'].includes(token.value) ||
    ['return', 'case', 'throw', 'yield'].includes(token.value);
}

function skipRegexLiteral(text, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') index += 2;
    else if (character === '[') {
      inCharacterClass = true;
      index += 1;
    } else if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      index += 1;
    } else if (character === '/' && !inCharacterClass) {
      index += 1;
      while (index < text.length && /[A-Za-z]/.test(text[index])) index += 1;
      return index;
    } else index += 1;
  }
  return text.length;
}

function enclosingFunctionName(text, index) {
  const prefix = text.slice(0, index);
  const matches = [...prefix.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)];
  return matches.at(-1)?.[1] ?? null;
}

function pluginPathOwners(value, assets) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const normalized = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.split('/').includes('..')) return [];
  return assets.filter((asset) => {
    const destination = asset.destination.replace(/\/+$/, '');
    return sourceContains(destination, normalized);
  });
}

function compareConsumerRecords(left, right) {
  return [left.consumer, left.kind, left.mechanism, left.reference]
    .join('\0')
    .localeCompare([right.consumer, right.kind, right.mechanism, right.reference].join('\0'));
}

function sortObjects(values) {
  return values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertAssetAuditClean(audit) {
  for (const [label, diagnostics] of [
    ['unconsumed runtime assets', audit.unconsumedAssets],
    ['unknown runtime asset references', audit.unknownAssetReferences],
    ['unknown capability profile references', audit.unknownProfileReferences],
    ['unowned plugin references', audit.unownedPluginReferences],
    ['unowned runtime references', audit.unownedRuntimeReferences],
    ['unowned packaged skills', audit.unownedSkills],
  ]) {
    if (diagnostics.length > 0) fail(`${label}: ${JSON.stringify(diagnostics)}`);
  }
}

function countHooks(document) {
  return Object.values(document.hooks ?? {})
    .flatMap((entries) => entries)
    .flatMap((entry) => entry.hooks ?? [])
    .length;
}

function validatePromptReferences(manifest, inventory) {
  const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md')).sort();
  const promptSources = agentFiles.map((name) => ({
    label: `agents/${name}`,
    path: join(AGENTS_DIR, name),
  }));
  const skillPaths = new Set();
  for (const name of agentFiles) {
    const text = readFileSync(join(AGENTS_DIR, name), 'utf8');
    for (const skill of preloadedSkills(text)) skillPaths.add(`skills/${skill}/SKILL.md`);
  }
  for (const path of skillPaths) promptSources.push({ label: path, path: safePluginPath(path) });
  for (const entrypoint of ENTRYPOINTS) {
    promptSources.push({ label: entrypoint.path, path: safePluginPath(entrypoint.path) });
  }
  for (const source of promptSources) {
    const text = readFileSync(source.path, 'utf8');
    for (const forbidden of manifest.forbiddenPromptReferences) {
      if (text.includes(forbidden)) fail(`${source.label} points outside the installed plugin: ${forbidden}`);
    }
  }
  for (const reference of inventory.pluginAssetReferences) {
    const path = safePluginPath(reference.value);
    if (!existsSync(path)) fail(`prompt plugin reference is missing: \${CLAUDE_PLUGIN_ROOT}/${reference.value}`);
  }
  if (inventory.agentsScanned !== 27) fail(`prompt inventory scanned ${inventory.agentsScanned} agents; expected 27`);
  if (inventory.schemaVersion !== 2) fail(`runtime inventory schemaVersion must be 2, got ${inventory.schemaVersion}`);
  if (inventory.skillsScanned !== 7) {
    fail(`runtime inventory scanned ${inventory.skillsScanned} packaged skills; expected 7`);
  }
  if (inventory.entrypointsScanned !== 1) {
    fail(`prompt inventory scanned ${inventory.entrypointsScanned} entrypoints; expected 1`);
  }
  for (const field of [
    'unconsumedAssets',
    'unknownAssetReferences',
    'unknownProfileReferences',
    'unownedPluginReferences',
    'unownedRuntimeReferences',
    'unownedSkills',
  ]) {
    if (!Array.isArray(inventory[field]) || inventory[field].length !== 0) {
      fail(`runtime inventory ${field} must be an empty array`);
    }
  }
  if (inventory.assetConsumers.length !== manifest.assets.length) {
    fail(`runtime inventory owns ${inventory.assetConsumers.length} assets; expected ${manifest.assets.length}`);
  }
  const coreConsumers = inventory.pluginAssetReferences
    .find((reference) => reference.value === 'skills/orchestration-core/SKILL.md')?.consumers ?? [];
  if (!coreConsumers.includes('/argus:run')) {
    fail('prompt inventory did not record /argus:run as a consumer of orchestration-core');
  }
}

function scanReferenceText(
  text,
  consumer,
  sourceKind,
  pluginRefs,
  targetRefs,
  commandRefs,
  pluginReferenceRecords,
  commandAssetReferences,
) {
  for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
    addConsumer(pluginRefs, match[1], consumer);
    pluginReferenceRecords.push({ value: match[1], consumer, sourceKind });
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9_-])argus-assets\s+path\s+([a-z0-9][a-z0-9-]*)(?![A-Za-z0-9_-])/g)) {
    commandAssetReferences.push({ assetId: match[1], consumer, sourceKind });
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1].trim();
    if (isTargetFileReference(value)) addConsumer(targetRefs, value, consumer);
  }
  for (const command of extractCommandReferences(text)) addConsumer(commandRefs, command, consumer);
}

function extractCommandReferences(text) {
  const references = new Set();
  const commandPattern = commandRegex(HOST_COMMANDS);
  for (const match of text.matchAll(commandPattern)) references.add(match[1]);

  const codeCommandPattern = commandRegex(CODE_CONTEXT_HOST_COMMANDS);
  for (const segment of markdownCodeSegments(text)) {
    for (const match of segment.matchAll(codeCommandPattern)) references.add(match[1]);
  }

  // Proteus uses this common compact notation to name both Kafka utilities.
  // Expand it deterministically so preflight checks the producer and consumer.
  if (/(?<![A-Za-z0-9_.-])kafka-console-producer\|consumer(?![A-Za-z0-9_.-])/.test(text)) {
    references.add('kafka-console-producer');
    references.add('kafka-console-consumer');
  }
  return references;
}

function commandRegex(commands) {
  return new RegExp(
    `(?<![A-Za-z0-9_.-])(${commands.map(escapeRegex).join('|')})(?![A-Za-z0-9_.-])`,
    'g',
  );
}

function markdownCodeSegments(text) {
  return [
    ...[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]),
    ...[...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => match[1]),
  ];
}

function preloadedSkills(text) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const block = frontmatter.match(/^skills:\s*\n((?:\s+-\s+[^\n]+\n?)*)/m)?.[1] ?? '';
  return [...block.matchAll(/^\s+-\s+([^\s#]+)\s*$/gm)].map((match) => match[1]);
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
  const isFile = statSync(path).isFile();
  const files = isFile ? [path] : walkFiles(path);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files.sort()) {
    const rel = isFile ? file.split(sep).at(-1) : relative(path, file).split(sep).join('/');
    const content = readFileSync(file);
    bytes += content.length;
    hash.update('file\0');
    hash.update(rel);
    hash.update('\0');
    hash.update(statSync(file).mode & 0o111 ? 'x' : '-');
    hash.update('\0');
    hash.update(content);
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const entryStat = lstatSync(path);
    if (entryStat.isSymbolicLink()) fail(`runtime asset contains unsupported symbolic link: ${path}`);
    const stat = entryStat;
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else if (stat.isFile()) out.push(path);
    else fail(`runtime asset contains unsupported filesystem entry: ${path}`);
  }
  return out;
}

function walkDirectories(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`runtime asset contains unsupported symbolic link: ${path}`);
    if (stat.isDirectory()) {
      out.push(path, ...walkDirectories(path));
    } else if (!stat.isFile()) {
      fail(`runtime asset contains unsupported filesystem entry: ${path}`);
    }
  }
  return out;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
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
  writeFileSync(path, serializeJson(value));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonDocumentStats(value) {
  const content = Buffer.from(serializeJson(value));
  return {
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
