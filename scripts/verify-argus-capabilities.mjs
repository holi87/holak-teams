#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = join(ROOT, 'argus', 'claude', 'agents');
const MATRIX_PATH = join(ROOT, 'argus', 'capabilities', 'capability-matrix.json');
const LEGACY_PROMPT_PATTERNS = [
  { pattern: /\bGlob\s*\/\s*LS\b/, label: 'Glob/LS' },
  { pattern: /`MultiEdit`|\bMultiEdit tool\b/, label: 'MultiEdit' },
  { pattern: /`TodoWrite`|\bTodoWrite tool\b/, label: 'TodoWrite' },
  { pattern: /`Task` tool|\bTask tool\b/, label: 'Task tool' },
];
const AUTHORIZATION_ACTIONS = new Set([
  'binary-evidence', 'browser-read', 'browser-state-change', 'chaos', 'database-read', 'database-write',
  'destructive', 'load', 'persistent-mutation', 'read', 'security-active', 'security-passive',
]);
const REQUIRED_AUTHORIZATION_AGENTS = new Set([
  'aegis', 'antigone', 'ariadne', 'atalanta', 'charon', 'daidalos', 'hermes',
  'kalchas', 'lynceus', 'mnemosyne', 'nike', 'orion', 'penelope', 'perseus',
  'proteus', 'talos', 'tiresias', 'tyche',
]);

const matrix = readJson(MATRIX_PATH);
assert(matrix.schemaVersion === 1, 'capability matrix schemaVersion must be 1');
assert(Array.isArray(matrix.agents) && matrix.agents.length === 27, 'capability matrix must define exactly 27 agents');

const supported = new Set(matrix.supportedBuiltinTools);
const capabilities = new Set(Object.keys(matrix.capabilities));
const matrixBySlug = new Map();
for (const agent of matrix.agents) {
  assert(!matrixBySlug.has(agent.slug), `duplicate capability matrix agent: ${agent.slug}`);
  matrixBySlug.set(agent.slug, agent);
  for (const capability of [...(agent.requiredCapabilities ?? []), ...(agent.optionalCapabilities ?? [])]) {
    assert(capabilities.has(capability), `${agent.slug} references unknown capability: ${capability}`);
  }
  for (const tool of agent.requiredTools) {
    assert(supported.has(tool), `${agent.slug} requires unsupported built-in tool: ${tool}`);
  }
  for (const action of agent.riskActions ?? []) {
    assert(AUTHORIZATION_ACTIONS.has(action), `${agent.slug} references unknown authorization action: ${action}`);
  }
  for (const path of agent.artifactPaths) {
    assert(!path.startsWith('/') && !path.split('/').includes('..'), `${agent.slug} artifact path escapes the engagement root: ${path}`);
  }
}

const contractedAuthorizationAgents = new Set(matrix.agents.filter((agent) => (agent.riskActions ?? []).length > 0).map((agent) => agent.slug));
for (const slug of REQUIRED_AUTHORIZATION_AGENTS) assert(contractedAuthorizationAgents.has(slug), `risky agent has no shared authorization contract: ${slug}`);
for (const slug of contractedAuthorizationAgents) assert(REQUIRED_AUTHORIZATION_AGENTS.has(slug), `unexpected authorization agent requires review: ${slug}`);

for (const tool of matrix.orchestration.requiredTools) {
  assert(supported.has(tool), `orchestration requires unsupported built-in tool: ${tool}`);
}
for (const path of matrix.orchestration.artifactPaths) {
  assert(!path.startsWith('/') && !path.split('/').includes('..'), `orchestration artifact path escapes the engagement root: ${path}`);
}

const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith('.md')).sort();
assert(agentFiles.length === 27, `expected 27 agent files, found ${agentFiles.length}`);
const fileSlugs = new Set(agentFiles.map((name) => name.slice(0, -3)));

for (const slug of fileSlugs) assert(matrixBySlug.has(slug), `agent missing from capability matrix: ${slug}`);
for (const slug of matrixBySlug.keys()) assert(fileSlugs.has(slug), `capability matrix has no agent file: ${slug}`);

for (const name of agentFiles) {
  const slug = name.slice(0, -3);
  const path = join(AGENTS_DIR, name);
  const text = readFileSync(path, 'utf8');
  const frontmatter = parseFrontmatter(text, name);
  const tools = parseTools(frontmatter.tools, name);
  const toolSet = new Set(tools);
  assert(tools.length === toolSet.size, `${name} has duplicate tool names`);

  for (const tool of tools) {
    const valid = supported.has(tool) || /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.*-]+$/.test(tool);
    assert(valid, `${name} uses unsupported tool vocabulary: ${tool}`);
    assert(!Object.hasOwn(matrix.legacyToolReplacements, tool), `${name} still uses legacy tool: ${tool}`);
  }

  const contract = matrixBySlug.get(slug);
  for (const required of contract.requiredTools) {
    assert(toolSet.has(required), `${name} capability matrix requires missing frontmatter tool: ${required}`);
  }

  const hasContext7 = tools.some((tool) => tool.startsWith('mcp__plugin_context7_context7__'));
  const hasPlaywright = tools.some((tool) => tool.startsWith('mcp__plugin_playwright_playwright__'));
  assert(!hasContext7 || (contract.optionalCapabilities ?? []).includes('context7'), `${name} exposes Context7 without a context7 fallback contract`);
  assert(!hasPlaywright || (contract.optionalCapabilities ?? []).includes('playwright-mcp'), `${name} exposes Playwright MCP without a playwright-mcp fallback contract`);
  assert(text.includes('argus-assets redact'), `${name} does not enforce the shared evidence redactor`);
  assert(text.includes('${CLAUDE_PLUGIN_ROOT}/references/AUTHORIZATION-POLICY.md'), `${name} does not reference the packaged authorization policy`);

  if ((contract.riskActions ?? []).length > 0) {
    assert(text.includes('## Authorization Gate (mandatory)'), `${name} has risk actions but no inline authorization gate`);
    assert(text.includes('argus-assets authorization check'), `${name} does not use the shared authorization evaluator`);
  }

  for (const legacy of LEGACY_PROMPT_PATTERNS) {
    assert(!legacy.pattern.test(text), `${name} prompt still references legacy ${legacy.label}`);
  }
}

for (const assetId of matrix.orchestration.requiredAssets) {
  const manifest = readJson(join(ROOT, 'argus', 'runtime-assets.source.json'));
  assert(manifest.assets.some((asset) => asset.id === assetId), `orchestration references unknown runtime asset: ${assetId}`);
}

assert(existsSync(join(ROOT, 'argus', 'schemas', 'preflight-report.schema.json')), 'preflight report schema is missing');
console.log(`PASS  Argus capability contract: ${agentFiles.length} frontmatters, ${capabilities.size} capabilities, supported tool vocabulary only`);

function parseFrontmatter(text, name) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert(match, `${name} has no YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields[field[1]] = field[2];
  }
  assert(fields.tools, `${name} has no tools field`);
  return fields;
}

function parseTools(value, name) {
  const tools = value.split(',').map((tool) => tool.trim()).filter(Boolean);
  assert(tools.length > 0, `${name} has an empty tools field`);
  return tools;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}
