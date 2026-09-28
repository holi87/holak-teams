#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePromptCorpus, evaluateNonRegression, frontmatterList, readArgusPluginVersion, words } from './lib/argus-prompt-corpus.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? '') : defaultRoot;
const PRINT_CORPUS = process.argv.includes('--print-corpus');
const SKIP_CORPUS_APPROVAL = process.argv.includes('--skip-corpus-approval');
const AGENTS = join(ROOT, 'argus/claude/agents');
const CODEX = join(ROOT, 'argus/codex');
const RUN = join(ROOT, 'argus/claude/skills/run/SKILL.md');
const budget = readJson('argus/prompt-budgets.json');
const comparison = readJson('argus/prompt-engagement-contract.json');
const matrix = readJson('argus/capabilities/capability-matrix.json');
assert(budget.schemaVersion === 2, `argus/prompt-budgets.json must be schemaVersion 2, found ${budget.schemaVersion}`);
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
assertSharedExecutionEnvelope(sourceSkills.get('qa-core'));

// Inside an engagement the runner refuses a reset or fault opt-in without the calling lane and
// a window its owner holds (reset: odysseus, fault: tyche), so every lane that runs one and
// each owner carries the exact handshake.
const EXCLUSIVE_WINDOW_DOCTRINE = Object.freeze({
  atlas: ['`ARGUS_ENGAGEMENT_LANE=atlas`', 'exclusive reset window that Odysseus claims on your request'],
  nike: ['`ARGUS_ENGAGEMENT_LANE=nike`', 'Only Tyche can hold the window'],
  tyche: ['`argus-assets engagement claim --manifest <manifest> --lane tyche --token <lane-token> --resource fault`', '`engagement release` it after the last verified restore'],
});
// The selection record that grants the harness root is the operator's, installed at launch;
// the harness architect consumes it and never writes it. Inside an engagement the scaffold is
// staged in Atlas's worker directory and placed at the artifact root: the root configuration
// the selection grants Atlas, and the runner through its revisioned canonical merge.
const TEMPLATE_SELECTION_DOCTRINE = Object.freeze({
  atlas: ['which `argus-launch --template-selection` installs and no lane can write; never write, infer, or relocate it',
    '`argus-assets template scaffold --selection <artifact-root>/ai_agents_internal/template-selection.json --destination <artifact-root>/ai_agents_internal/workers/atlas/scaffold`',
    'the root configuration only you may write', '`--canonical run-tests.sh --input <staged file>`',
    'Never place the staged `.claude/`, `ai_agents_internal/`'],
});
assert(!sourceSkills.get('orchestration-core').includes('persist explicit `template select`'), 'orchestration-core: the controller must consume, never persist, the template selection');
for (const [profile, fragments] of Object.entries({
  'qa-framework-runner': ['`ARGUS_ENGAGEMENT_LANE=<own slug>`', '`argus-assets engagement claim --resource <reset|fault>`', 'Odysseus claims `reset`', 'Tyche claims `fault`'],
  'orchestration-core': ['You own the exclusive `reset` window', '<controller-token> --resource reset`', 'Tyche owns `fault`'],
})) {
  for (const fragment of fragments) assert(sourceSkills.get(profile).includes(fragment), `${profile}: exclusive reset/fault window handshake missing: ${fragment}`);
}

const agents = new Map();
const agentWords = {};
const profileCounts = new Map();
let totalWords = 0;
let totalEffectiveWords = 0;
let boundedWorkers = 0;
let toolNameBytes = 0;
let playwrightEntries = 0;

for (const file of files) {
  const slug = file.slice(0, -3);
  const content = readFileSync(join(AGENTS, file), 'utf8');
  const contract = contracts.get(slug);
  assert(contract, `${slug}: missing capability contract`);
  agents.set(slug, content);
  const count = words(content);
  agentWords[slug] = count;
  totalWords += count;
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
  for (const fragment of EXCLUSIVE_WINDOW_DOCTRINE[slug] ?? []) {
    assert(body.includes(fragment), `${slug}: exclusive reset/fault window handshake missing: ${fragment}`);
  }
  for (const fragment of TEMPLATE_SELECTION_DOCTRINE[slug] ?? []) {
    assert(body.includes(fragment), `${slug}: operator template selection doctrine missing: ${fragment}`);
  }
  if (slug === 'odysseus') {
    assert(body.includes('<!-- MODEL_CONTROLLER_START -->'), 'odysseus: model-controller block missing');
    assert(body.includes('Mode/strategy is immutable: `A=FULL_AUDIT`, `B=BUG_HUNT`'), 'odysseus: local Mode A/B strategy binding missing');
    assert(count <= budget.budgets.maxOdysseusAgentWords, `odysseus: ${count} words exceeds thin-shell budget`);
  } else {
    boundedWorkers += 1;
    assert(body.includes('<!-- MODEL_ESCALATION_START -->'), `${slug}: neutral model-escalation block missing`);
    assert(body.includes(`Agent binding: \`${slug}\``), `${slug}: escalation agent binding missing`);
    assert(body.includes('Mode/strategy is immutable: `A=FULL_AUDIT`, `B=BUG_HUNT`'), `${slug}: local Mode A/B strategy binding missing`);
    assert(body.includes('Authorization state follows only the manifest'), `${slug}: local authorization-result binding missing`);
    assert(body.includes('Structured results include every funded surface'), `${slug}: local funded-surface result binding missing`);
    assert(body.includes('use the exact shared `MODEL_ESCALATION_REQUEST` envelope'), `${slug}: shared escalation envelope binding missing`);
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

const promptBodies = new Map([
  ...[...agents].map(([slug, content]) => [`argus/claude/agents/${slug}.md`, content.replace(/^---[\s\S]*?---\s*/, '')]),
  ...[...sourceSkills].map(([profile, content]) => [`argus/shared-skills/${profile}/SKILL.md`, content.replace(/^---[\s\S]*?---\s*/, '')]),
]);
let codexCharacters = 0;
for (const file of codexFiles) {
  const slug = file.slice(0, -5);
  const content = readFileSync(join(CODEX, file), 'utf8');
  codexCharacters += content.length;
  const instructions = content.match(/developer_instructions = '''\n([\s\S]*?)\n'''\s*$/)?.[1];
  assert(instructions, `${slug}: developer_instructions missing`);
  promptBodies.set(`argus/codex/${file}`, instructions);
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
assert(codexEstimatedTokens <= budget.budgets.maxCodexEstimatedTokens, `Codex corpus ${codexEstimatedTokens} estimated tokens exceeds ${budget.budgets.maxCodexEstimatedTokens}`);
const forbiddenPatternCount = assertForbiddenPromptPatterns(promptBodies, comparison.forbiddenPromptPatterns ?? []);

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
assertAdversarialExecutionCases(comparison, sourceSkills.get('qa-core'));

const corpus = computePromptCorpus(ROOT);
assert(corpus.words === totalWords && corpus.effectiveWords === totalEffectiveWords && corpus.codexEstimatedTokens === codexEstimatedTokens && equal(corpus.agents, agentWords),
  'shared prompt-corpus measurement drifted from the structural gate counts');
if (PRINT_CORPUS) {
  console.log(JSON.stringify(corpus, null, 2));
  process.exit(0);
}
const approval = SKIP_CORPUS_APPROVAL ? null : assertCorpusApproval(budget.approvedCorpus, corpus, readArgusPluginVersion(ROOT), budget.nonRegression);

console.log(`PASS  Argus Claude prompts: ${totalWords} raw / ${totalEffectiveWords} effective words, max role ${Math.max(...Object.values(agentWords))}`);
console.log(`PASS  Argus Codex prompts: ${codexCharacters} chars / ${codexEstimatedTokens} estimated tokens (max ${budget.budgets.maxCodexEstimatedTokens})`);
console.log(`PASS  Capability disclosure: profiles core/browser/framework/coverage/orchestration=${['qa-core','qa-browser','qa-framework-runner','qa-coverage-reporting','orchestration-core'].map((profile) => profileCounts.get(profile) ?? 0).join('/')}, /run ${runWords} words`);
console.log(`PASS  Tool boundary: ${toolNameBytes} name bytes, ${playwrightEntries} Playwright MCP entries, Kalchas public recon only`);
console.log(`PASS  Duplicate doctrine: ${duplicates.length} duplicated doctrine paragraphs`);
console.log(`PASS  Forbidden prompt patterns: ${forbiddenPatternCount} patterns absent from ${promptBodies.size} agent, profile, and Codex prompt bodies`);
if (approval) {
  if (approval.warning) console.log(approval.warning);
  console.log(`PASS  Prompt corpus approval: ${corpus.sha256.slice(0, 12)}, benchmark ${approval.status}`);
} else {
  console.log('SKIP  corpus approval (development only; the release gate never passes this flag)');
}

// The corpus digest binds the approval to exact prompt and doctrine text; the counts must agree
// with it; growth is accepted only with adjudicated non-regression evidence for this exact
// corpus, or as a pending approval that expires when the Argus plugin version changes.
function assertCorpusApproval(approved, current, pluginVersion, nonRegression) {
  assert(approved && typeof approved === 'object', 'approvedCorpus is missing');
  assert(approved.sha256 === current.sha256,
    `approvedCorpus.sha256 does not match the current corpus ${current.sha256}: re-approve with scripts/approve-argus-prompts.mjs or restore it`);
  const stale = ['words', 'effectiveWords', 'codexEstimatedTokens', 'agents', 'profiles']
    .filter((field) => !equal(sortedKeys(approved[field]), sortedKeys(current[field])));
  assert(stale.length === 0, `approvedCorpus counts are stale: ${stale.join(', ')} differ from the current corpus`);
  const benchmark = approved.benchmark ?? {};
  if (benchmark.status === 'pending') {
    assert(approved.releaseVersion === pluginVersion, `pending benchmark approval expired: approved for ${approved.releaseVersion}, Argus is ${pluginVersion}`);
    assert(typeof benchmark.reason === 'string' && benchmark.reason.trim(), 'pending benchmark approval must state a reason');
    return { status: 'pending', warning: `WARN  prompt corpus approved for ${approved.releaseVersion} without benchmark evidence: ${benchmark.reason}` };
  }
  assert(benchmark.status === 'non-regressed', `approvedCorpus.benchmark.status must be pending or non-regressed, found ${JSON.stringify(benchmark.status)}`);
  assert(benchmark.candidate?.corpusSha256 === approved.sha256, 'benchmark evidence does not match the approved corpus');
  assert(/^[0-9a-f]{64}$/.test(benchmark.comparisonSha256 ?? ''), 'benchmark comparisonSha256 must be the sha256 of the adjudicated comparison');
  const errors = evaluateNonRegression(benchmark, nonRegression);
  assert(errors.length === 0, errors.join('; '));
  return { status: 'non-regressed', warning: null };
}

function sortedKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

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

// Retired doctrine stays retired: no prompt body (frontmatter stripped) may match a pattern
// the engagement contract forbids, such as the old double-reproduction confirmation gate.
function assertForbiddenPromptPatterns(bodies, patterns) {
  assert(Array.isArray(patterns), 'forbiddenPromptPatterns must be an array');
  const ids = new Set();
  for (const item of patterns) {
    assert(typeof item?.id === 'string' && item.id && !ids.has(item.id), `forbidden prompt pattern id is missing or duplicated: ${JSON.stringify(item?.id)}`);
    ids.add(item.id);
    const flags = item.flags ?? '';
    assert(typeof item.pattern === 'string' && item.pattern, `${item.id}: forbidden prompt pattern is empty`);
    assert(['', 'i'].includes(flags), `${item.id}: unsupported forbidden prompt pattern flags ${JSON.stringify(flags)}`);
    let pattern;
    try {
      pattern = new RegExp(item.pattern, flags);
    } catch (error) {
      assert(false, `${item.id}: invalid forbidden prompt pattern: ${error.message}`);
    }
    for (const [label, body] of bodies) {
      const match = body.match(pattern);
      assert(!match, `${item.id}: forbidden prompt pattern matches ${label}: ${JSON.stringify(match?.[0])}`);
    }
  }
  return patterns.length;
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
  const catalogs = Object.keys(capabilityMatrix.techniqueCatalogs ?? {});
  assert(catalogs.length > 0, 'capability matrix declares no technique catalogs');
  for (const catalog of catalogs) {
    const owners = capabilityMatrix.agents.filter((agent) => agent.techniqueCatalogs.includes(catalog)).map((agent) => agent.slug);
    assert(equal(owners, [catalog]), `${catalog}: technique catalog assignment drifted`);
  }
}

function assertSharedExecutionEnvelope(qaCore) {
  assert(qaCore, 'qa-core profile missing');
  const normalized = qaCore.replace(/\s+/g, ' ');
  for (const marker of [
    'controller-selected primary mode',
    'immutable execution input',
    'Never infer, substitute, broaden, or narrow the selected mode',
    '`A=FULL_AUDIT`, `B=BUG_HUNT`, `C=GREENFIELD`, `D=BROWNFIELD`',
    'Validate before returning and repair within the same attempt',
    'never rely on a retry to repair the first response',
    '"schema": "argus/model-escalation-request@1"',
    '"kind": "MODEL_ESCALATION_REQUEST"',
    '"agent": "bound-agent-slug"',
    'continue the task after returning `MODEL_ESCALATION_REQUEST`',
  ]) assert(normalized.includes(marker), `qa-core shared execution envelope missing: ${marker}`);
}

function assertAdversarialExecutionCases(contract, qaCore) {
  const cases = contract.adversarialExecutionCases ?? [];
  assert(equal(cases.map((item) => item.selectedMode).sort(), ['A', 'B']), 'isolated Mode A/B preservation cases are missing');
  for (const item of cases) {
    assert(item.selectedMode === item.expectedMode, `${item.id}: selected mode is not preserved`);
    assert(item.distractorStrategy !== item.expectedStrategy, `${item.id}: distractor does not oppose the expected strategy`);
  }
  const normalized = qaCore.replace(/\s+/g, ' ');
  for (const marker of contract.firstAttemptStructuredOutput?.requiredBehavior ?? []) {
    assert(normalized.toLowerCase().includes(marker.toLowerCase()), `first-attempt structured-output behavior missing: ${marker}`);
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
