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
const ADAPTERS_PATH = join(ROOT, 'argus', 'runtime-adapters.json');
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
assert(adapters.schemaVersion === 3, 'runtime adapter schemaVersion must be 3');
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
  const semanticContract = renderSemanticContract(resolvedRole, ownership, capability);
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
  const modelPlaceholder = policyRole.slug === 'odysseus'
    ? '{{ARGUS_MODEL_CONTROLLER_BLOCK}}'
    : '{{ARGUS_MODEL_ESCALATION_BLOCK}}';
  assert(source.includes(modelPlaceholder), `${policyRole.slug}: canonical source lacks ${modelPlaceholder}`);
  assert(source.includes('{{ARGUS_RACI_CONTRACT_BLOCK}}'), `${policyRole.slug}: canonical source lacks RACI placeholder`);
  return source
    .replace(modelPlaceholder, policyRole.slug === 'odysseus'
      ? renderModelControllerBlock(policyRole)
      : renderModelEscalationBlock(policyRole))
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
  return `# Codex runtime adapter\n\nYou are ${role.displayName}, generated from \`argus/roles/${role.source}\`. Support is \`${adapters.support.codex.level}\`: require parent orchestration, packaged assets, and equivalent tools; otherwise return \`CAPABILITY_GAP\`. Do not edit this file.\n\n${semanticContract}\n\nRuntime rules:\n- Use only tools and delegation APIs actually available. Never claim unavailable tools or completed dispatches.\n- If a required tool, packaged asset, browser, MCP, or docs capability is unavailable, use a contract-equivalent capability when one exists; otherwise return \`CAPABILITY_GAP\` with the exact missing input.\n- Preserve all ownership, safety, quality, and output contracts below. Runtime adaptation never weakens them.\n\n## Shared QA Doctrine\n\n${sharedDoctrine}\n\n## Role Instructions\n\n${body.trim()}`;
}

function renderSemanticContract(role, ownership, capability) {
  const artifacts = ownership.accountableArtifacts.length ? ownership.accountableArtifacts.join(', ') : 'none';
  const paths = capability.artifactPaths.length ? capability.artifactPaths.join(', ') : 'none';
  const requiredCapabilities = capability.requiredCapabilities?.join(', ') || 'none';
  const riskActions = capability.riskActions?.join(', ') || 'none';
  return `## Generated Semantic Contract\n\n- Identity: \`${role.slug}\`; ${ownership.role}; lane \`${ownership.lane}\`.\n- Inputs: modes ${capability.modes.join(', ')}; required tools ${capability.requiredTools.join(', ')}; required capabilities ${requiredCapabilities}.\n- Responsibilities: ${ownership.responsible.join('; ')}.\n- Outputs: persistence \`${ownership.persistence}\`; accountable artifacts ${artifacts}; allowed artifact paths ${paths}.\n- Safety: canonical qa-doctrine; risk actions ${riskActions}; application-under-test source is immutable.\n- Artifact language: 100% English for every persisted artifact, code comment, test name, report, plan, and commit message.\n- Ownership source: \`argus/raci.json\`; capability source: \`argus/capabilities/capability-matrix.json\`.`;
}

function renderModelEscalationBlock(role) {
  const signals = modelPolicy.escalationProfiles[role.escalationProfile].join(', ');
  return `<!-- MODEL_ESCALATION_START -->\n## Escalation boundary\n\n- Maximum turns: \`${role.maxTurns}\`. Declared signals: ${signals}.\n- On a declared signal, persist a monotonic checkpoint with the engagement controller. Substitute the current identifiers, attempt, declared signal, and returned path in this schema-valid envelope, return only the envelope, then stop:\n\n\`\`\`json\n{\n  "schema": "argus/model-escalation-request@1",\n  "kind": "MODEL_ESCALATION_REQUEST",\n  "engagementId": "engagement-id",\n  "dispatchId": "dispatch-id",\n  "attempt": 1,\n  "agent": "${role.slug}",\n  "signal": "safety",\n  "checkpointRef": "ai_agents_internal/checkpoints/${role.slug}/00000001.json",\n  "resumable": true\n}\n\`\`\`\n\nDo not choose or override a model, downgrade execution, invoke routing or telemetry commands, or continue the task.\n<!-- MODEL_ESCALATION_END -->`;
}

function renderModelControllerBlock(role) {
  const signals = modelPolicy.escalationProfiles[role.escalationProfile].join(', ');
  return `<!-- MODEL_CONTROLLER_START -->\n## Model-control ownership\n\n- Maximum turns: \`${role.maxTurns}\`. Controller signals: ${signals}.\n- Validate every worker envelope with \`argus-assets schema validate --kind model-escalation-request --input <request-file|->\`; reject mismatched engagement, dispatch, attempt, agent, undeclared signal, missing checkpoint, or a checkpoint not bound to the current worker state.\n- Increment the attempt and route exactly once with \`argus-assets model route --manifest <engagement-manifest> --agent <slug> --runtime <runtime> --signal <signal> --dispatch-id <dispatch-id> --attempt <next-attempt>\`. A blocked decision stops the dispatch.\n- For a selected decision, create a new agent thread with the exact selected configuration and checkpoint context; never resume an existing thread under a different model. If that configuration cannot start, route the next attempt with \`model-unavailable\`; never choose a fallback locally. Only you may route or choose dispatch configuration.\n- Bind usage to the persisted decision with \`argus-assets model telemetry --manifest <engagement-manifest> --decision <model-decision.json> --input-tokens <n> --output-tokens <n> --duration-ms <n> --success <true|false>\`. Never reconstruct a decision or accept worker-written telemetry.\n<!-- MODEL_CONTROLLER_END -->`;
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
