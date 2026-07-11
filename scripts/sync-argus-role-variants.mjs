#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--write', '--check'].includes(mode)) {
  fail('usage: scripts/sync-argus-role-variants.mjs [--write|--check]');
}

const ROLE_ROOT = join(ROOT, 'argus', 'roles');
const MANIFEST_PATH = join(ROLE_ROOT, 'manifest.json');
const ADAPTERS_PATH = join(ROLE_ROOT, 'runtime-adapters.json');
const CLAUDE_ROOT = join(ROOT, 'argus', 'claude', 'agents');
const CODEX_ROOT = join(ROOT, 'argus', 'codex');

const manifest = readJson(MANIFEST_PATH);
const adapters = readJson(ADAPTERS_PATH);
const modelPolicy = readJson(join(ROOT, manifest.contracts.modelPolicy));
const raci = readJson(join(ROOT, manifest.contracts.ownership));
const capabilities = readJson(join(ROOT, manifest.contracts.capabilities));
const doctrineRaw = readFileSync(join(ROOT, manifest.contracts.doctrine), 'utf8');
const doctrine = splitMarkdown(doctrineRaw).body.trim();
const rolesByModel = bySlug(modelPolicy.roles, 'model policy');
const rolesByRaci = bySlug(raci.agents, 'RACI');
const rolesByCapability = bySlug(capabilities.agents, 'capability matrix');

assert(manifest.schemaVersion === 2, 'role manifest schemaVersion must be 2');
assert(adapters.schemaVersion === 2, 'runtime adapter schemaVersion must be 2');
assert(adapters.support.claude.level === 'plugin-native', 'Claude support level must be plugin-native');
assert(adapters.support.codex.level === 'parent-runtime-dependent', 'Codex support level must be parent-runtime-dependent');
assert(adapters.support.codex.parentRuntimeRequired === true, 'Codex support must require a parent runtime');
assert(adapters.support.codex.missingCapabilityOutcome === 'CAPABILITY_GAP', 'Codex missing capabilities must return CAPABILITY_GAP');
assert(adapters.configurationParity.status === 'validated', 'configuration parity must be validated');
assert(adapters.configurationParity.doesNotClaim.includes('behavioral-equivalence'), 'configuration parity must exclude behavioral equivalence');
assert(manifest.roles.length === 27, `role manifest has ${manifest.roles.length} roles; expected 27`);
assert(new Set(manifest.roles.map((role) => role.slug)).size === 27, 'role manifest has duplicate slugs');

const expectedFiles = new Set();
for (const role of [...manifest.roles].sort((left, right) => left.slug.localeCompare(right.slug))) {
  validateRole(role);
  const policyRole = rolesByModel.get(role.slug);
  const ownership = rolesByRaci.get(role.slug);
  const capability = rolesByCapability.get(role.slug);
  const resolvedRole = {
    ...role,
    displayName: titleCase(role.slug),
    description: ownership.description,
  };
  const tier = modelPolicy.tiers[policyRole.tier];
  const sourcePath = join(ROLE_ROOT, role.source);
  const sourceBody = readFileSync(sourcePath, 'utf8');
  const body = renderCanonicalBody(sourceBody, policyRole, ownership);
  const claude = renderClaude(resolvedRole, tier.claude, policyRole, body);
  const semanticContract = renderSemanticContract(resolvedRole, policyRole, ownership, capability, tier);
  const codexInstructions = renderCodexInstructions(resolvedRole, semanticContract, doctrine, body);
  const codexToml = renderCodexToml(resolvedRole, tier.codex, capability, codexInstructions);
  const codexMarkdown = renderCodexMarkdown(resolvedRole, policyRole, tier, capability, codexInstructions);

  sync(join(CLAUDE_ROOT, `${role.slug}.md`), claude);
  sync(join(CODEX_ROOT, `${role.slug}.toml`), codexToml);
  sync(join(CODEX_ROOT, `${role.slug}.md`), codexMarkdown);
  expectedFiles.add(`${role.slug}.md`);
  expectedFiles.add(`${role.slug}.toml`);
}

const actualCodex = readdirSync(CODEX_ROOT).filter((file) => /\.(?:md|toml)$/.test(file)).sort();
assert(equal(actualCodex, [...expectedFiles].sort()), 'Codex output contains missing or orphan role files');
console.log(`PASS  Argus role variants: ${manifest.roles.length} canonical sources -> 27 Claude agents + 27 Codex TOML/Markdown pairs (${mode.slice(2)})`);

function validateRole(role) {
  for (const field of ['slug', 'source', 'color']) assert(role[field], `${role.slug ?? '(unknown)'}: missing ${field}`);
  assert(role.source === `${role.slug}.md`, `${role.slug}: source must be its same-slug Markdown file`);
  assert(rolesByRaci.has(role.slug), `${role.slug}: missing RACI role`);
  assert(rolesByModel.has(role.slug), `${role.slug}: missing model policy role`);
  assert(rolesByCapability.has(role.slug), `${role.slug}: missing capability role`);
  assert(Array.isArray(role.claudeTools) && role.claudeTools.length > 0, `${role.slug}: Claude tool list is empty`);
  for (const tool of rolesByCapability.get(role.slug).requiredTools) {
    assert(role.claudeTools.includes(tool), `${role.slug}: Claude tools omit required capability ${tool}`);
  }
}

function renderCanonicalBody(source, policyRole, ownership) {
  assert(source.includes('{{ARGUS_MODEL_POLICY_BLOCK}}'), `${policyRole.slug}: canonical source lacks model placeholder`);
  assert(source.includes('{{ARGUS_RACI_CONTRACT_BLOCK}}'), `${policyRole.slug}: canonical source lacks RACI placeholder`);
  return source
    .replace('{{ARGUS_MODEL_POLICY_BLOCK}}', renderModelBlock(policyRole))
    .replace('{{ARGUS_RACI_CONTRACT_BLOCK}}', renderRaciBlock(ownership));
}

function renderClaude(role, claudeTier, policyRole, body) {
  return `---\nname: ${role.slug}\ndescription: ${role.description}\ntools: ${role.claudeTools.join(', ')}\nmodel: ${claudeTier.model}\neffort: ${claudeTier.effort}\nmaxTurns: ${policyRole.maxTurns}\ncolor: ${role.color}\nskills:\n  - ${adapters.claude.preloadedSkill}\n---\n\n${body.trimStart()}`;
}

function renderCodexToml(role, codexTier, capability, instructions) {
  assert(!instructions.includes("'''"), `${role.slug}: developer instructions cannot contain TOML literal delimiter`);
  const sandbox = capability.requiredTools.includes('Write') ? 'workspace-write' : 'read-only';
  return `name = ${JSON.stringify(role.slug)}\ndescription = ${JSON.stringify(role.description)}\nmodel = ${JSON.stringify(codexTier.model)}\nsandbox_mode = ${JSON.stringify(sandbox)}\nmodel_reasoning_effort = ${JSON.stringify(codexTier.reasoningEffort)}\n\ndeveloper_instructions = '''\n${instructions.trim()}\n'''\n`;
}

function renderCodexMarkdown(role, policyRole, tier, capability, instructions) {
  const sandbox = capability.requiredTools.includes('Write') ? 'workspace-write' : 'read-only';
  const digest = sha256(readFileSync(join(ROLE_ROOT, role.source), 'utf8'));
  return `---\nname: ${JSON.stringify(role.slug)}\ndescription: ${JSON.stringify(role.description)}\n---\n\n<codex_agent_role>\nrole: ${role.displayName}\nteam: Argus QA\nslug: ${role.slug}\nsource: argus/roles/${role.source}\nsource_sha256: ${digest}\ntier: ${policyRole.tier}\nmodel: ${tier.codex.model}\nmodel_reasoning_effort: ${tier.codex.reasoningEffort}\nsandbox_mode: ${sandbox}\npurpose: ${role.description}\n</codex_agent_role>\n\n${instructions.trim()}\n`;
}

function renderCodexInstructions(role, semanticContract, sharedDoctrine, body) {
  const differences = adapters.explicitDifferences.map((item) => `- ${item.field}: ${item.codex}. Reason: ${item.reason}.`).join('\n');
  return `# Codex runtime adapter\n\nYou are ${role.displayName}, generated from \`argus/roles/${role.source}\`. Codex support is \`${adapters.support.codex.level}\`: require parent orchestration, packaged assets, and equivalent tools; otherwise return \`CAPABILITY_GAP\`. Do not edit this file.\n\n${semanticContract}\n\n## Explicit runtime differences\n\n${differences}\n\nCodex operating rules:\n- Use only tools and delegation APIs actually available in the current Codex runtime. Never claim unavailable tools or completed dispatches.\n- If a required Claude plugin tool, packaged asset, browser, MCP, or docs capability is unavailable, use a contract-equivalent Codex capability when one exists; otherwise return \`CAPABILITY_GAP\` with the exact missing input.\n- Preserve all ownership, safety, quality, and output contracts below. Runtime adaptation never weakens them.\n\n## Shared QA Doctrine\n\n${sharedDoctrine}\n\n## Role Instructions\n\n${body.trim()}`;
}

function renderSemanticContract(role, policyRole, ownership, capability, tier) {
  const artifacts = ownership.accountableArtifacts.length ? ownership.accountableArtifacts.join(', ') : 'none';
  const paths = capability.artifactPaths.length ? capability.artifactPaths.join(', ') : 'none';
  const requiredCapabilities = capability.requiredCapabilities?.join(', ') || 'none';
  const riskActions = capability.riskActions?.join(', ') || 'none';
  return `## Generated Semantic Contract\n\n- Identity: \`${role.slug}\`; ${ownership.role}; lane \`${ownership.lane}\`.\n- Tier: \`${policyRole.tier}\`; Claude \`${tier.claude.model}/${tier.claude.effort}\`; Codex \`${tier.codex.model}/${tier.codex.reasoningEffort}\`; max turns ${policyRole.maxTurns}.\n- Inputs: modes ${capability.modes.join(', ')}; required tools ${capability.requiredTools.join(', ')}; required capabilities ${requiredCapabilities}.\n- Responsibilities: ${ownership.responsible.join('; ')}.\n- Outputs: persistence \`${ownership.persistence}\`; accountable artifacts ${artifacts}; allowed artifact paths ${paths}.\n- Safety: canonical qa-doctrine; risk actions ${riskActions}; application-under-test source is immutable.\n- Artifact language: 100% English for every persisted artifact, code comment, test name, report, plan, and commit message.\n- Ownership source: \`argus/raci.json\`; capability source: \`argus/capabilities/capability-matrix.json\`; model source: \`argus/model-policy.json\`.`;
}

function renderModelBlock(role) {
  const tier = modelPolicy.tiers[role.tier];
  const triggers = `${role.slug}: ${modelPolicy.escalationProfiles[role.escalationProfile].join(', ')}`;
  return `<!-- MODEL_POLICY_START -->\n## Runtime Model Policy\n\n- Source: \`${modelPolicy.policyId}\`; baseline tier: \`${role.tier}\`; maximum turns: \`${role.maxTurns}\`.\n- Claude: \`${tier.claude.model}\` / \`${tier.claude.effort}\`; Codex: \`${tier.codex.model}\` / \`${tier.codex.reasoningEffort}\`.\n- Escalation profile \`${role.escalationProfile}\`: ${triggers}. Route every trigger through \`argus-assets model route\`; standard roles escalate upward, frontier roles retain frontier and escalate the decision.\n- Fallback: \`${role.fallbackPolicy}\`; weaker-model fallback is forbidden. Full-role mechanical downgrade is denied; only a bounded subrole with deterministic schema validation may qualify. If the runtime cannot honor the selected model, effort, and turn cap together, block as capability drift instead of silently approximating.\n- Record only model, token, latency, cost, success, and routing metadata with \`argus-assets model telemetry\`; never record prompts, completions, targets, accounts, or evidence.\n<!-- MODEL_POLICY_END -->`;
}

function renderRaciBlock(agent) {
  const artifacts = agent.accountableArtifacts.length ? agent.accountableArtifacts.map((path) => `\`${path}\``).join(', ') : 'none';
  const surfaces = raci.surfaceRoutes.flatMap((route) => ['discover', 'baseline', 'automate', 'validate', 'report'].filter((activity) => route[activity] === agent.slug).map((activity) => `${route.surface}:${activity}`));
  const dual = raci.dualHome.find((item) => item.slug === agent.slug);
  return `<!-- RACI_CONTRACT_START -->\n## RACI Contract\n\n- Role/lane: ${agent.role} / \`${agent.lane}\`.\n- Responsible: ${agent.responsible.join('; ')}.\n- Accountable artifacts: ${artifacts}.\n- Persistence: \`${agent.persistence}\`. Candidate artifacts never become canonical defects until Minos validates, deduplicates, and persists them.\n- Surface routes: ${surfaces.join(', ') || 'none'}.\n${dual ? `- Dual-home rule: ${dual.rule}\n` : ''}- Routing: use \`argus-assets raci route\`; do not infer ownership from agent names or silently perform another role's responsibility.\n<!-- RACI_CONTRACT_END -->`;
}

function splitMarkdown(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert(match, 'Claude role source has no valid frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

function sync(path, expected) {
  const normalized = expected.endsWith('\n') ? expected : `${expected}\n`;
  if (mode === '--write') {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== normalized) writeFileSync(path, normalized);
    return;
  }
  assert(existsSync(path), `generated role is missing: ${path}`);
  assert(readFileSync(path, 'utf8') === normalized, `generated role drift: ${path}; run scripts/sync-argus-role-variants.mjs --write`);
}

function bySlug(items, label) {
  const map = new Map(items.map((item) => [item.slug, item]));
  assert(map.size === items.length, `${label} has duplicate slugs`);
  return map;
}

function titleCase(value) {
  return value.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
