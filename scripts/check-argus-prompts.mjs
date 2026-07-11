#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? '') : defaultRoot;
const AGENTS = join(ROOT, 'argus/claude/agents');
const CODEX = join(ROOT, 'argus/codex');
const RUN = join(ROOT, 'argus/claude/skills/run/SKILL.md');
const budget = readJson('argus/prompt-budgets.json');
const comparison = readJson('argus/prompt-engagement-contract.json');
const matrix = readJson('argus/capabilities/capability-matrix.json');
const files = readdirSync(AGENTS).filter((file) => file.endsWith('.md')).sort();
const codexFiles = readdirSync(CODEX).filter((file) => file.endsWith('.toml')).sort();
const contracts = new Map(matrix.agents.map((agent) => [agent.slug, agent]));
const sourceSkills = new Map();
const packagedSkills = new Map();

for (const profile of Object.keys(matrix.doctrineProfiles)) {
  const source = read(`argus/shared-skills/${profile}/SKILL.md`);
  const packagedPath = join(ROOT, `argus/claude/skills/${profile}/SKILL.md`);
  assert(existsSync(packagedPath), `packaged doctrine profile is missing: ${profile}`);
  const packaged = readFileSync(packagedPath, 'utf8');
  assert(source === packaged, `packaged doctrine profile differs from source: ${profile}`);
  sourceSkills.set(profile, source);
  packagedSkills.set(profile, packaged);
}

assert(files.length === 27, `expected 27 Claude agents, found ${files.length}`);
assert(codexFiles.length === 27, `expected 27 Codex TOMLs, found ${codexFiles.length}`);

const agents = new Map();
const agentWords = {};
const profileCounts = new Map();
let totalWords = 0;
let totalEffectiveWords = 0;
let boundedWorkers = 0;
let toolNameBytes = 0;
let playwrightEntries = 0;
const corpusHash = createHash('sha256');

for (const file of files) {
  const slug = file.slice(0, -3);
  const content = readFileSync(join(AGENTS, file), 'utf8');
  const contract = contracts.get(slug);
  assert(contract, `${slug}: missing capability contract`);
  agents.set(slug, content);
  const count = words(content);
  agentWords[slug] = count;
  totalWords += count;
  corpusHash.update(`${file}\0${content}`);
  assert(count <= budget.budgets.maxAgentWords, `${slug}: ${count} words exceeds ${budget.budgets.maxAgentWords}`);

  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '';
  assert(description, `${slug}: description missing`);
  assert(words(description) <= budget.budgets.maxDescriptionWords, `${slug}: description exceeds ${budget.budgets.maxDescriptionWords} words`);

  const skills = frontmatterList(frontmatter, 'skills');
  assert(equal(skills, contract.doctrineProfiles), `${slug}: preloaded profiles differ from capability matrix`);
  for (const required of budget.requiredPreloadedProfiles) assert(skills.includes(required), `${slug}: missing required profile ${required}`);
  for (const profile of skills) profileCounts.set(profile, (profileCounts.get(profile) ?? 0) + 1);
  const effectiveWords = count + skills.reduce((sum, profile) => sum + words(sourceSkills.get(profile)), 0);
  totalEffectiveWords += effectiveWords;
  assert(effectiveWords <= budget.budgets.maxEffectiveAgentWords, `${slug}: effective prompt ${effectiveWords} exceeds ${budget.budgets.maxEffectiveAgentWords} words`);

  const tools = (frontmatter.match(/^tools:\s*(.+)$/m)?.[1] ?? '').split(',').map((tool) => tool.trim()).filter(Boolean);
  const expectedTools = resolveTools(contract);
  assert(equal(tools, expectedTools), `${slug}: frontmatter tools differ from requiredTools + toolProfiles`);
  assert(tools.length <= budget.budgets.maxFrontmatterToolEntries, `${slug}: ${tools.length} tools exceeds ${budget.budgets.maxFrontmatterToolEntries}`);
  const bytes = Buffer.byteLength(tools.join(', '));
  toolNameBytes += bytes;
  assert(bytes <= budget.budgets.maxToolNameBytesPerAgent, `${slug}: tool names use ${bytes} bytes`);
  playwrightEntries += tools.filter((tool) => tool.startsWith('mcp__plugin_playwright_playwright__')).length;

  const body = content.replace(/^---[\s\S]*?---\s*/, '');
  assert(!body.includes('qa-doctrine'), `${slug}: legacy qa-doctrine reference remains`);
  if (slug === 'odysseus') {
    assert(body.includes('<!-- MODEL_CONTROLLER_START -->'), 'odysseus: model-controller block missing');
    assert(count <= budget.budgets.maxOdysseusAgentWords, `odysseus: ${count} words exceeds thin-shell budget`);
  } else {
    boundedWorkers += 1;
    assert(body.includes('<!-- MODEL_ESCALATION_START -->'), `${slug}: neutral model-escalation block missing`);
    assert(body.includes('"kind": "MODEL_ESCALATION_REQUEST"'), `${slug}: exact escalation envelope missing`);
    assert(!/\b(?:opus|sonnet|haiku|sol|terra|luna)\b/i.test(body), `${slug}: provider model token leaked into worker instructions`);
    assert(!/\bCodex\b/.test(body), `${slug}: opposite runtime leaked into worker instructions`);
    assert(!body.includes('argus-assets model route'), `${slug}: worker can invoke model routing`);
    assert(!body.includes('argus-assets model telemetry'), `${slug}: worker can invoke model telemetry`);
  }
}

assert(boundedWorkers === 26, `expected 26 bounded workers, found ${boundedWorkers}`);
assert(totalWords <= budget.budgets.maxClaudeAgentWords, `Claude corpus ${totalWords} exceeds ${budget.budgets.maxClaudeAgentWords}`);
assert(totalEffectiveWords <= budget.budgets.maxEffectiveClaudeWords, `effective Claude corpus ${totalEffectiveWords} exceeds ${budget.budgets.maxEffectiveClaudeWords}`);
assert(toolNameBytes <= budget.budgets.maxToolNameBytesCorpus, `tool-name corpus ${toolNameBytes} exceeds ${budget.budgets.maxToolNameBytesCorpus} bytes`);
assert(playwrightEntries === budget.budgets.maxPlaywrightMcpEntries, `expected exactly ${budget.budgets.maxPlaywrightMcpEntries} Playwright MCP entries, found ${playwrightEntries}`);
assertPlaywrightBoundary(agents);
assertProfileAssignments(matrix, profileCounts);

const corpusSha256 = corpusHash.digest('hex');
const approvedAgents = budget.approvedCorpus.agents;
assert(Object.keys(approvedAgents).sort().join(',') === [...agents.keys()].sort().join(','), 'approved prompt corpus roster differs from current roster');
const increases = Object.fromEntries(Object.entries(agentWords)
  .filter(([slug, count]) => count > approvedAgents[slug])
  .map(([slug, count]) => [slug, count - approvedAgents[slug]]));
if (Object.keys(increases).length > 0 || totalWords > budget.approvedCorpus.words) {
  const approval = budget.regressionApproval;
  assert(approval, `prompt regression requires explicit regressionApproval: ${JSON.stringify(increases)}`);
  assert(approval.corpusSha256 === corpusSha256, 'regressionApproval does not match current prompt corpus');
  assert(/^#[0-9]+$/.test(approval.issue) && approval.approvedBy && approval.reason, 'regressionApproval metadata is incomplete');
  assert(equal(approval.allowedAgentIncreases, increases), `regressionApproval must exactly enumerate increases: ${JSON.stringify(increases)}`);
}

const reduction = 1 - totalWords / budget.baseline.claudeAgentWords;
assert(reduction >= 0.35, `Claude prompt reduction ${(reduction * 100).toFixed(2)}% is below 35%`);

let codexCharacters = 0;
for (const file of codexFiles) {
  const slug = file.slice(0, -5);
  const content = readFileSync(join(CODEX, file), 'utf8');
  codexCharacters += content.length;
  const instructions = content.match(/developer_instructions = '''\n([\s\S]*?)\n'''\s*$/)?.[1];
  assert(instructions, `${slug}: developer_instructions missing`);
  const delta = instructions.match(/<!-- CODEX_CAPABILITY_DELTA_START -->\n([\s\S]*?)\n<!-- CODEX_CAPABILITY_DELTA_END -->/)?.[1];
  assert(delta, `${slug}: compact capability delta missing`);
  assert(words(delta) <= budget.budgets.maxCodexCapabilityDeltaWords, `${slug}: capability delta exceeds ${budget.budgets.maxCodexCapabilityDeltaWords} words`);
  for (const forbidden of ['Generated Semantic Contract', 'Shared QA Doctrine', 'qa-doctrine']) {
    assert(!instructions.includes(forbidden), `${slug}: legacy Codex duplication remains: ${forbidden}`);
  }
  assert(!/\bClaude\b/.test(instructions), `${slug}: opposite runtime narrative remains in developer instructions`);
  assert(!/\b(?:opus|sonnet|haiku|sol|terra|luna)\b/i.test(instructions), `${slug}: provider model token leaked into developer instructions`);
}
const codexEstimatedTokens = Math.ceil(codexCharacters / 4);
const codexReduction = budget.baseline.codexEstimatedTokens - codexEstimatedTokens;
assert(codexEstimatedTokens <= budget.budgets.maxCodexEstimatedTokens, `Codex corpus ${codexEstimatedTokens} estimated tokens exceeds ${budget.budgets.maxCodexEstimatedTokens}`);
assert(codexReduction >= budget.budgets.minimumCodexTokenReduction, `Codex reduction ${codexReduction} is below ${budget.budgets.minimumCodexTokenReduction}`);

const runWords = words(readFileSync(RUN, 'utf8'));
assert(runWords >= budget.budgets.minRunSkillWords && runWords <= budget.budgets.maxRunSkillWords, `/argus:run has ${runWords} words; expected ${budget.budgets.minRunSkillWords}-${budget.budgets.maxRunSkillWords}`);

const duplicates = duplicatedParagraphs(agents, budget.budgets.duplicateParagraphMinWords);
assert(duplicates.length <= budget.budgets.maxDuplicatedDoctrineInstances, `found duplicated doctrine paragraphs: ${duplicates.map((item) => item.files.join(',')).join('; ')}`);

const optional = new Set(budget.optionalProfiles);
for (const [slug, content] of agents) {
  for (const profile of optional) assert(!frontmatterList(content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '', 'skills').includes(profile), `${slug}: optional profile ${profile} is preloaded`);
}

for (const requirement of comparison.representativeEngagement.requirements) {
  const source = sourceSkills.get(requirement.source) ?? agents.get(requirement.source);
  assert(source, `${requirement.id}: unknown source ${requirement.source}`);
  for (const marker of requirement.markers) assert(source.toLowerCase().includes(marker.toLowerCase()), `${requirement.id}: missing ${JSON.stringify(marker)} in ${requirement.source}`);
}

console.log(`PASS  Argus Claude prompts: ${totalWords} raw / ${totalEffectiveWords} effective words, max role ${Math.max(...Object.values(agentWords))}`);
console.log(`PASS  Argus Codex prompts: ${codexCharacters} chars / ${codexEstimatedTokens} estimated tokens, reduction ${codexReduction}`);
console.log(`PASS  Capability disclosure: profiles core/browser/framework/coverage/orchestration=${['qa-core','qa-browser','qa-framework-runner','qa-coverage-reporting','orchestration-core'].map((profile) => profileCounts.get(profile) ?? 0).join('/')}, /run ${runWords} words`);
console.log(`PASS  Tool boundary: ${toolNameBytes} name bytes, ${playwrightEntries} Playwright MCP entries, Kalchas public recon only`);
console.log(`PASS  Prompt regression: ${Object.keys(increases).length} increases, corpus ${corpusSha256.slice(0, 12)}, ${duplicates.length} duplicated doctrine paragraphs`);

function resolveTools(contract) {
  const tools = [...contract.requiredTools];
  for (const profile of contract.toolProfiles) tools.push(...matrix.toolProfiles[profile].tools);
  return tools;
}

function assertPlaywrightBoundary(agentMap) {
  for (const [slug, content] of agentMap) {
    const tools = (content.match(/^tools:\s*(.+)$/m)?.[1] ?? '').split(',').map((tool) => tool.trim());
    const playwright = tools.filter((tool) => tool.startsWith('mcp__plugin_playwright_playwright__'));
    if (slug === 'kalchas') {
      assert(equal(playwright, [
        'mcp__plugin_playwright_playwright__browser_navigate',
        'mcp__plugin_playwright_playwright__browser_snapshot',
      ]), 'kalchas: public recon MCP contract drifted');
    } else assert(playwright.length === 0, `${slug}: stateful lane exposes Playwright MCP tools`);
  }
}

function assertProfileAssignments(capabilityMatrix, counts) {
  const expected = {
    'qa-core': 27,
    'qa-browser': 8,
    'qa-framework-runner': 11,
    'qa-coverage-reporting': 7,
    'orchestration-core': 1,
  };
  for (const [profile, count] of Object.entries(expected)) assert(counts.get(profile) === count, `${profile}: expected ${count} assignments, found ${counts.get(profile) ?? 0}`);
  const toolExpected = { 'official-docs': 7, 'remote-spec': 9, 'public-browser-recon': 1 };
  for (const [profile, count] of Object.entries(toolExpected)) {
    const actual = capabilityMatrix.agents.filter((agent) => agent.toolProfiles.includes(profile)).length;
    assert(actual === count, `${profile}: expected ${count} assignments, found ${actual}`);
  }
  for (const catalog of ['atalanta', 'proteus', 'metis']) {
    const owners = capabilityMatrix.agents.filter((agent) => agent.techniqueCatalogs.includes(catalog)).map((agent) => agent.slug);
    assert(equal(owners, [catalog]), `${catalog}: technique catalog assignment drifted`);
  }
}

function duplicatedParagraphs(agentMap, minWords) {
  const paragraphs = new Map();
  for (const [slug, raw] of agentMap) {
    const content = raw
      .replace(/^---[\s\S]*?---\s*/, '')
      .replace(/<!-- RACI_CONTRACT_START -->[\s\S]*?<!-- RACI_CONTRACT_END -->/g, '')
      .replace(/<!-- MODEL_(?:ESCALATION|CONTROLLER)_START -->[\s\S]*?<!-- MODEL_(?:ESCALATION|CONTROLLER)_END -->/g, '');
    for (const paragraph of content.split(/\n\s*\n/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      if (words(normalized) < minWords) continue;
      const digest = createHash('sha256').update(normalized).digest('hex');
      const record = paragraphs.get(digest) ?? { files: new Set() };
      record.files.add(slug);
      paragraphs.set(digest, record);
    }
  }
  return [...paragraphs.values()].filter((item) => item.files.size > 1).map((item) => ({ files: [...item.files].sort() }));
}

function frontmatterList(frontmatter, field) {
  const block = frontmatter.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)*)`, 'm'))?.[1] ?? '';
  return [...block.matchAll(/^\s+-\s+([^\s#]+)\s*$/gm)].map((match) => match[1]);
}

function words(value) {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assert(value, message) {
  if (!value) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}
