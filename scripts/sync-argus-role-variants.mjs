#!/usr/bin/env node

import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTechniqueCatalog,
  validateTechniqueCatalogSet,
} from '../argus/runtime/technique-catalogs.mjs';

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
const SHARED_SKILLS_ROOT = join(ROOT, 'argus', 'shared-skills');
const TECHNIQUE_CATALOGS_ROOT = join(ROOT, 'argus', 'technique-catalogs');
const SCHEMAS_ROOT = join(ROOT, 'argus', 'schemas');
const MAX_CODEX_PROVENANCE_BYTES = 1500;
const MAX_CODEX_PROVENANCE_CORPUS_BYTES = 40000;
const CODEX_PROVENANCE_FIELDS = Object.freeze([
  'schema',
  'slug',
  'display_name',
  'runtime_config',
  'runtime_config_sha256',
  'developer_instructions_sha256',
  'canonical_source',
  'canonical_source_sha256',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'doctrine_profiles',
  'technique_catalogs',
  'generated_by',
  'runtime_consumed',
]);
const ROUTE_SURFACES = Object.freeze({
  api: 'api-rest',
  ui: 'ui-functional',
  security: 'security',
  performance: 'performance',
  resilience: 'resilience',
  data: 'data-public-api',
  accessibility: 'accessibility',
  journey: 'journey-api',
  contract: 'event-protocol',
  reporting: 'ui-functional',
});

preflightDirectory(ROOT, ROOT, 'repository root');
preflightDirectory(ROLE_ROOT, ROOT, 'canonical role root');
preflightDirectory(CLAUDE_ROOT, ROOT, 'Claude generated root');
preflightDirectory(CODEX_ROOT, ROOT, 'Codex generated root');

const manifest = readSourceJson(MANIFEST_PATH, 'role manifest', ROLE_ROOT);
const adapters = readSourceJson(ADAPTERS_PATH, 'runtime adapters', ROOT);
const modelPolicy = readSourceJson(contractPath(manifest, 'modelPolicy'), 'model policy', ROOT);
const raci = readSourceJson(contractPath(manifest, 'ownership'), 'RACI contract', ROOT);
const capabilities = readSourceJson(contractPath(manifest, 'capabilities'), 'capability matrix', ROOT);
const doctrineBodies = loadDoctrineProfiles(capabilities.doctrineProfiles);
const techniqueCatalogs = loadTechniqueCatalogs(capabilities.techniqueCatalogs, raci);
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
const generatedFiles = [];
let codexProvenanceBytes = 0;
for (const role of [...manifest.roles].sort((left, right) => left.slug.localeCompare(right.slug))) {
  validateRole(role);
  const policyRole = rolesByModel.get(role.slug);
  const ownership = rolesByRaci.get(role.slug);
  const capability = rolesByCapability.get(role.slug);
  const resolvedRole = {
    ...role,
    displayName: titleCase(role.slug),
    description: ownership.description,
    claudeTools: resolveClaudeTools(capability),
  };
  const tier = modelPolicy.tiers[policyRole.tier];
  const sourcePath = join(ROLE_ROOT, role.source);
  const sourceRaw = readSourceFile(sourcePath, `${role.slug}: canonical role source`, ROLE_ROOT);
  const sourceBody = sourceRaw.toString('utf8');
  const body = renderCanonicalBody(sourceBody, policyRole, ownership, capability);
  const claude = renderClaude(resolvedRole, tier.claude, policyRole, capability, body);
  const codexInstructions = renderCodexInstructions(resolvedRole, capability, body);
  const codexToml = normalizeGenerated(renderCodexToml(resolvedRole, tier.codex, capability, codexInstructions));
  const codexMarkdown = normalizeGenerated(renderCodexMarkdown(
    resolvedRole,
    tier.codex,
    capability,
    codexToml,
    exactDeveloperInstructions(codexInstructions),
    sha256(sourceRaw),
  ));
  const provenanceBytes = Buffer.byteLength(codexMarkdown);
  assert(
    provenanceBytes < MAX_CODEX_PROVENANCE_BYTES,
    `${role.slug}: Codex provenance stub is ${provenanceBytes} bytes; must be < ${MAX_CODEX_PROVENANCE_BYTES}`,
  );
  codexProvenanceBytes += provenanceBytes;

  generatedFiles.push(
    { path: join(CLAUDE_ROOT, `${role.slug}.md`), root: CLAUDE_ROOT, content: claude },
    { path: join(CODEX_ROOT, `${role.slug}.toml`), root: CODEX_ROOT, content: codexToml },
    { path: join(CODEX_ROOT, `${role.slug}.md`), root: CODEX_ROOT, content: codexMarkdown },
  );
  expectedFiles.add(`${role.slug}.md`);
  expectedFiles.add(`${role.slug}.toml`);
}

assert(
  codexProvenanceBytes < MAX_CODEX_PROVENANCE_CORPUS_BYTES,
  `Codex provenance corpus is ${codexProvenanceBytes} bytes; must be < ${MAX_CODEX_PROVENANCE_CORPUS_BYTES}`,
);

preflightGeneratedLeaves(generatedFiles);
const actualClaude = generatedNames(CLAUDE_ROOT, /\.md$/);
const expectedClaude = manifest.roles.map((role) => `${role.slug}.md`).sort();
const actualCodex = generatedNames(CODEX_ROOT, /\.(?:md|toml)$/);
assert(actualClaude.every((name) => expectedClaude.includes(name)), 'Claude output contains orphan role files');
assert(actualCodex.every((name) => expectedFiles.has(name)), 'Codex output contains orphan role files');
for (const output of generatedFiles) sync(output.path, output.content, output.root);
assert(equal(generatedNames(CLAUDE_ROOT, /\.md$/), expectedClaude), 'Claude output contains missing or orphan role files');
assert(equal(generatedNames(CODEX_ROOT, /\.(?:md|toml)$/), [...expectedFiles].sort()), 'Codex output contains missing or orphan role files');
console.log(
  `PASS  Argus role variants: ${manifest.roles.length} canonical sources -> ` +
  `27 Claude agents + 27 Codex TOML/provenance pairs, ${codexProvenanceBytes} provenance bytes (${mode.slice(2)})`,
);

function validateRole(role) {
  for (const field of ['slug', 'source', 'color']) assert(role[field], `${role.slug ?? '(unknown)'}: missing ${field}`);
  assert(role.source === `${role.slug}.md`, `${role.slug}: source must be its same-slug Markdown file`);
  assert(rolesByRaci.has(role.slug), `${role.slug}: missing RACI role`);
  assert(rolesByModel.has(role.slug), `${role.slug}: missing model policy role`);
  assert(rolesByCapability.has(role.slug), `${role.slug}: missing capability role`);
  resolveClaudeTools(rolesByCapability.get(role.slug));
}

function renderCanonicalBody(source, policyRole, ownership, capability) {
  const modelPlaceholder = policyRole.slug === 'odysseus'
    ? '{{ARGUS_MODEL_CONTROLLER_BLOCK}}'
    : '{{ARGUS_MODEL_ESCALATION_BLOCK}}';
  assert(source.includes(modelPlaceholder), `${policyRole.slug}: canonical source lacks ${modelPlaceholder}`);
  assert(source.includes('{{ARGUS_RACI_CONTRACT_BLOCK}}'), `${policyRole.slug}: canonical source lacks RACI placeholder`);
  const catalogIds = roleContractList(capability, ['techniqueCatalogs', 'technique_catalogs'], []);
  if (catalogIds.length > 0) {
    assert(source.includes('{{ARGUS_TECHNIQUE_CATALOGS}}'), `${policyRole.slug}: canonical source lacks technique-catalog placeholder`);
  } else {
    assert(!source.includes('{{ARGUS_TECHNIQUE_CATALOGS}}'), `${policyRole.slug}: unassigned technique-catalog placeholder`);
  }
  return source
    .replace(modelPlaceholder, policyRole.slug === 'odysseus'
      ? renderModelControllerBlock(policyRole)
      : renderModelEscalationBlock(policyRole))
    .replace('{{ARGUS_RACI_CONTRACT_BLOCK}}', renderRaciBlock(ownership))
    .replace('{{ARGUS_TECHNIQUE_CATALOGS}}', renderTechniqueCatalogs(catalogIds));
}

function renderClaude(role, claudeTier, policyRole, capability, body) {
  const skills = roleContractList(capability, ['doctrineProfiles', 'doctrine_profiles'], []);
  assert(skills.length > 0 && skills[0] === 'qa-core', `${role.slug}: qa-core must be the first doctrine profile`);
  return `---\nname: ${role.slug}\ndescription: ${role.description}\ntools: ${role.claudeTools.join(', ')}\nmodel: ${claudeTier.model}\neffort: ${claudeTier.effort}\nmaxTurns: ${policyRole.maxTurns}\ncolor: ${role.color}\nskills:\n${skills.map((skill) => `  - ${skill}`).join('\n')}\n---\n\n${body.trimStart()}`;
}

function renderCodexToml(role, codexTier, capability, instructions) {
  assert(!instructions.includes("'''"), `${role.slug}: developer instructions cannot contain TOML literal delimiter`);
  const sandbox = capability.requiredTools.includes('Write') ? 'workspace-write' : 'read-only';
  return `name = ${JSON.stringify(role.slug)}\ndescription = ${JSON.stringify(role.description)}\nmodel = ${JSON.stringify(codexTier.model)}\nsandbox_mode = ${JSON.stringify(sandbox)}\nmodel_reasoning_effort = ${JSON.stringify(codexTier.reasoningEffort)}\n\ndeveloper_instructions = '''\n${instructions.trim()}\n'''\n`;
}

function renderCodexMarkdown(role, codexTier, capability, toml, developerInstructions, canonicalSourceSha256) {
  const sandbox = capability.requiredTools.includes('Write') ? 'workspace-write' : 'read-only';
  const fields = {
    schema: 'argus/codex-provenance@1',
    slug: role.slug,
    display_name: role.displayName,
    runtime_config: `argus/codex/${role.slug}.toml`,
    runtime_config_sha256: sha256(toml),
    developer_instructions_sha256: sha256(developerInstructions),
    canonical_source: `argus/roles/${role.source}`,
    canonical_source_sha256: canonicalSourceSha256,
    model: codexTier.model,
    model_reasoning_effort: codexTier.reasoningEffort,
    sandbox_mode: sandbox,
    doctrine_profiles: roleContractList(capability, ['doctrineProfiles', 'doctrine_profiles'], ['qa-core']),
    technique_catalogs: roleContractList(capability, ['techniqueCatalogs', 'technique_catalogs'], []),
    generated_by: 'scripts/sync-argus-role-variants.mjs',
    runtime_consumed: false,
  };
  assert(equal(Object.keys(fields), CODEX_PROVENANCE_FIELDS), `${role.slug}: Codex provenance field order drift`);
  return `---\n${CODEX_PROVENANCE_FIELDS.map((field) => `${field}: ${provenanceValue(fields[field])}`).join('\n')}\n---\n\n# ${role.displayName} - Codex provenance\n\nGenerated metadata only. Codex loads \`${role.slug}.toml\`; this Markdown file is not runtime input.\n`;
}

function roleContractList(capability, fields, fallback) {
  const selected = fields.find((field) => capability[field] !== undefined);
  const values = selected ? capability[selected] : fallback;
  assert(Array.isArray(values), `${capability.slug}: ${selected ?? fields[0]} must be an array`);
  assert(values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0), `${capability.slug}: provenance contract list contains an invalid value`);
  assert(new Set(values).size === values.length, `${capability.slug}: provenance contract list contains duplicates`);
  return values;
}

function provenanceValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

function exactDeveloperInstructions(instructions) {
  return `${instructions.trim()}\n`;
}

function normalizeGenerated(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function renderCodexInstructions(role, capability, body) {
  const profiles = roleContractList(capability, ['doctrineProfiles', 'doctrine_profiles'], []);
  const selectedDoctrine = profiles.map((profile) => {
    const content = doctrineBodies.get(profile);
    assert(content, `${role.slug}: unknown doctrine profile ${profile}`);
    return `### ${profile}\n\n${content}`;
  }).join('\n\n');
  const capabilityDelta = `Parent orchestration and packaged Argus assets are required. Use only capabilities actually available in the active runtime. If a required tool, browser, documentation source, asset, or delegation capability has no contract-equivalent substitute, return \`CAPABILITY_GAP\` with the exact missing input. Never claim unavailable tools or completed dispatches. Preserve every ownership, safety, evidence, quality, and output rule below; adaptation cannot weaken them.`;
  assert(words(capabilityDelta) <= 100, `${role.slug}: runtime capability delta exceeds 100 words`);
  return `# Runtime capability delta\n\n<!-- CODEX_CAPABILITY_DELTA_START -->\n${capabilityDelta}\n<!-- CODEX_CAPABILITY_DELTA_END -->\n\n## Capability-selected doctrine\n\n${selectedDoctrine}\n\n## Role instructions\n\n${body.trim()}`;
}

function resolveClaudeTools(capability) {
  const tools = [...capability.requiredTools];
  for (const profile of capability.toolProfiles ?? []) {
    const contract = capabilities.toolProfiles[profile];
    assert(contract, `${capability.slug}: unknown tool profile ${profile}`);
    tools.push(...contract.tools);
  }
  assert(tools.length > 0, `${capability.slug}: resolved Claude tool list is empty`);
  assert(new Set(tools).size === tools.length, `${capability.slug}: resolved Claude tool list contains duplicates`);
  return tools;
}

function loadDoctrineProfiles(definitions) {
  assert(definitions && typeof definitions === 'object', 'capability matrix doctrineProfiles are missing');
  const result = new Map();
  for (const profile of Object.keys(definitions)) {
    assert(/^[a-z][a-z0-9-]*$/.test(profile), `invalid doctrine profile id: ${profile}`);
    const path = join(SHARED_SKILLS_ROOT, profile, 'SKILL.md');
    const raw = readSourceFile(path, `${profile}: doctrine profile`, SHARED_SKILLS_ROOT).toString('utf8');
    const parsed = splitMarkdown(raw);
    assert(new RegExp(`^name:\\s*${escapeRegex(profile)}$`, 'm').test(parsed.frontmatter), `${profile}: skill name differs from profile id`);
    result.set(profile, parsed.body.trim());
  }
  return result;
}

function loadTechniqueCatalogs(definitions, ownership) {
  assert(definitions && typeof definitions === 'object', 'capability matrix techniqueCatalogs are missing');
  const schema = readSourceJson(
    join(SCHEMAS_ROOT, 'technique-catalog.schema.json'),
    'technique catalog schema',
    SCHEMAS_ROOT,
  );
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const result = new Map();
  for (const [id, definition] of Object.entries(definitions)) {
    assert(/^[a-z][a-z0-9-]*$/.test(id), `invalid technique catalog id: ${id}`);
    const path = join(TECHNIQUE_CATALOGS_ROOT, `${id}.json`);
    const raw = readSourceFile(path, `${id}: technique catalog`, TECHNIQUE_CATALOGS_ROOT);
    const document = JSON.parse(raw.toString('utf8'));
    assert(validateSchema(document), `${id}: technique catalog JSON Schema failed: ${JSON.stringify(validateSchema.errors)}`);
    const semanticErrors = validateTechniqueCatalog(document);
    assert(semanticErrors.length === 0, `${id}: technique catalog semantic validation failed: ${semanticErrors.join('; ')}`);
    assert(document.catalogId === definition.catalogId, `${id}: capability catalogId drift`);
    assert(sha256(raw) === definition.sha256, `${id}: reviewed technique catalog digest drift`);
    validateCatalogRoutes(document, ownership);
    result.set(id, { document, sha256: definition.sha256 });
  }
  const setErrors = validateTechniqueCatalogSet([...result.values()].map((entry) => entry.document));
  assert(setErrors.length === 0, `technique catalog set is invalid: ${setErrors.join('; ')}`);
  return result;
}

function validateCatalogRoutes(document, ownership) {
  const surfaces = new Map(ownership.surfaceRoutes.map((route) => [route.surface, route]));
  for (const entry of document.entries ?? []) {
    assert(entry.routes.length > 0, `${document.role}/${entry.id}: route list is empty`);
    for (const route of entry.routes) {
      const surface = ROUTE_SURFACES[route];
      assert(surface, `${document.role}/${entry.id}: unknown catalog route ${route}`);
      const ownershipRoute = surfaces.get(surface);
      assert(ownershipRoute, `${document.role}/${entry.id}: RACI surface is missing for route ${route}`);
      for (const activity of ['discover', 'automate', 'validate', 'report']) {
        assert(ownership.agents.some((agent) => agent.slug === ownershipRoute[activity]), `${document.role}/${entry.id}: route ${route} has an unknown ${activity} owner`);
      }
    }
  }
}

function renderTechniqueCatalogs(ids) {
  return ids.map((id) => {
    const catalog = techniqueCatalogs.get(id);
    assert(catalog, `unknown technique catalog ${id}`);
    const { document, sha256: digest } = catalog;
    const header = `## Technique catalog: ${document.catalogId}\n\nReviewed SHA-256: \`${digest}\`. Apply every applicable entry or record \`${document.absentSurfaceDisposition ?? 'named-gap-with-owner'}\`; discover target values and never assume them.`;
    if (document.catalogType === 'hunter') {
      const entries = document.entries.map((entry) => {
        const routes = entry.routes.map((route) => formatCatalogRoute(route)).join('; ');
        return `### ${entry.id} — ${entry.title}\n\n- Applies: ${entry.appliesWhen}. Scope: ${entry.scope.join(', ')}.\n- Techniques: ${entry.techniques.join(', ')}.\n- Construct: ${entry.construct.join('; ')}.\n- Oracles: ${entry.oracles.join('; ')}.\n- RACI routes: ${routes}.`;
      });
      return `${header}\n\n${entries.join('\n\n')}`;
    }
    const quality = document.iso25010.map((entry) => `- **${entry.id}:** ${entry.focus.join('; ')}. Rule: ${entry.coverageRule}.`).join('\n');
    const journeys = document.journeyClasses.map((entry) => `- **${entry.id}:** outcomes ${entry.requiredOutcomes.join('; ')}; techniques ${entry.techniques.join(', ')}; tag \`${entry.tag}\`; rule ${entry.coverageRule}.`).join('\n');
    const boundary = document.boundaryRegister;
    const archetypes = document.archetypes.map((entry) => `- **${entry.id}:** techniques ${entry.techniques.join(', ')}; lanes ${entry.lanes.join(', ')}; oracle ${entry.oracle}; rule ${entry.coverageRule}.`).join('\n');
    return `${header}\n\n### ISO/IEC 25010 spine\n\n${quality}\n\n### ISTQB process and techniques\n\n- Process: ${document.istqb.process.join(' -> ')}.\n- Techniques: ${document.istqb.techniques.join(', ')}.\n- Mapping rule: ${document.istqb.mappingRule}.\n\n### Journey classes\n\n${journeys}\n\n### Boundary Register\n\n- Required: ${boundary.required}; artifact: \`${boundary.artifact}\`; row IDs: \`${boundary.rowIdPattern}\`.\n- Kinds: ${boundary.kinds.join(', ')}.\n- Columns: ${boundary.requiredColumns.join(', ')}.\n- Mandates: ${boundary.mandates.join('; ')}.\n\n### Coverage archetypes\n\n${archetypes}`;
  }).join('\n\n');
}

function formatCatalogRoute(route) {
  const surface = ROUTE_SURFACES[route];
  const ownership = raci.surfaceRoutes.find((candidate) => candidate.surface === surface);
  return `${route} [discover=${ownership.discover}, automate=${ownership.automate}, validate=${ownership.validate}, report=${ownership.report}]`;
}

function renderModelEscalationBlock(role) {
  const signals = modelPolicy.escalationProfiles[role.escalationProfile].join(', ');
  return `<!-- MODEL_ESCALATION_START -->\n## Escalation boundary\n\n- Maximum turns: \`${role.maxTurns}\`. Declared signals: ${signals}.\n- On a declared signal, persist a checkpoint bound to the active allocation, dispatch ID, and attempt. Fill this envelope with current IDs, next attempt, signal, and returned path; return it, then stop:\n\n\`\`\`json\n{\n  "schema": "argus/model-escalation-request@1",\n  "kind": "MODEL_ESCALATION_REQUEST",\n  "engagementId": "engagement-id",\n  "dispatchId": "dispatch-id",\n  "attempt": 2,\n  "agent": "${role.slug}",\n  "signal": "turn-limit",\n  "checkpointRef": "ai_agents_internal/checkpoints/${role.slug}/00000001.json",\n  "resumable": true\n}\n\`\`\`\n\nDo not choose or override a model, downgrade execution, invoke routing or telemetry commands, or continue the task.\n<!-- MODEL_ESCALATION_END -->`;
}

function renderModelControllerBlock(role) {
  const signals = modelPolicy.escalationProfiles[role.escalationProfile].join(', ');
  return `<!-- MODEL_CONTROLLER_START -->\n## Model-control ownership\n\n- Turn cap: \`${role.maxTurns}\`. Signals: ${signals}.\n- Validate envelopes with \`argus-assets schema validate --kind model-escalation-request --input <request-file|->\`; reject any mismatch.\n- Persist through \`argus-assets model request ... --token <lane-token>\`; route centrally with request, controller token, and next attempt. Running-worker escalation requires its checkpoint; pre-spawn \`model-unavailable\` uses the availability binding and may have none.\n- A blocked decision stops. \`operatorEscalation=true\` requires an external signed \`argus/model-operator-decision@1\`.\n- Before rebind or cleanup, emit one \`argus-assets model telemetry --manifest <manifest> --decision <current-decision> --token <lane-token> --input-tokens <n> --output-tokens <n> --duration-ms <n> --success <bool>\`; reject worker-authored values.\n- Retry with \`argus-assets engagement start-attempt ... --decision <next-decision> --token <lane-token> --controller-token <controller-token> [--dispatch-authorization <MDA-file>]\`; the final option is mandatory only for Codex. Replace the consumed token with the returned token, then start a new thread from the checkpoint or pre-spawn availability binding; never resume an existing thread under a different model. The stale token is revoked.\n<!-- MODEL_CONTROLLER_END -->`;
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

function sync(path, expected, outputRoot) {
  const normalized = expected.endsWith('\n') ? expected : `${expected}\n`;
  preflightGeneratedLeaf(path, outputRoot);
  if (mode === '--write') {
    if (!existsSync(path) || readGeneratedFile(path, outputRoot).toString('utf8') !== normalized) {
      atomicWriteGenerated(path, normalized, outputRoot);
    }
    return;
  }
  assert(existsSync(path), `generated role is missing: ${path}`);
  assert(readGeneratedFile(path, outputRoot).toString('utf8') === normalized, `generated role drift: ${path}; run scripts/sync-argus-role-variants.mjs --write`);
}

function contractPath(document, field) {
  const value = document?.contracts?.[field];
  assert(typeof value === 'string' && value.length > 0, `role manifest contracts.${field} is missing`);
  assert(!isAbsolute(value) && !value.split(/[\\/]/).includes('..'), `role manifest contracts.${field} must stay under the repository root`);
  const path = resolve(ROOT, value);
  assert(isWithin(ROOT, path), `role manifest contracts.${field} escapes the repository root`);
  return path;
}

function preflightGeneratedLeaves(outputs) {
  for (const output of outputs) preflightGeneratedLeaf(output.path, output.root);
}

function generatedNames(root, pattern) {
  preflightDirectory(root, ROOT, `generated root ${relative(ROOT, root)}`);
  return readdirSync(root)
    .filter((name) => pattern.test(name))
    .map((name) => {
      preflightGeneratedLeaf(join(root, name), root);
      return name;
    })
    .sort();
}

function preflightGeneratedLeaf(path, outputRoot) {
  assertPathWithin(outputRoot, path, `generated output ${relative(ROOT, path)}`);
  preflightDirectory(outputRoot, ROOT, `generated root ${relative(ROOT, outputRoot)}`);
  preflightDirectory(dirname(path), outputRoot, `generated output parent ${relative(ROOT, dirname(path))}`);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  assert(!info.isSymbolicLink(), `generated output cannot be a symbolic link: ${relative(ROOT, path)}`);
  assert(info.isFile(), `generated output must be a regular file: ${relative(ROOT, path)}`);
  const physical = realpathSync(path);
  assertPhysicalWithin(outputRoot, physical, `generated output ${relative(ROOT, path)}`);
}

function readGeneratedFile(path, outputRoot) {
  preflightGeneratedLeaf(path, outputRoot);
  return readRegularFileNoFollow(path, `generated output ${relative(ROOT, path)}`);
}

function atomicWriteGenerated(path, content, outputRoot) {
  preflightGeneratedLeaf(path, outputRoot);
  const digest = sha256(`${path}:${process.pid}:${Date.now()}:${content.length}`).slice(0, 16);
  const temporary = join(dirname(path), `.${relative(dirname(path), path)}.${digest}.tmp`);
  assertPathWithin(outputRoot, temporary, `temporary generated output ${relative(ROOT, temporary)}`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    const info = lstatSync(temporary);
    assert(!info.isSymbolicLink() && info.isFile(), `temporary generated output is not a regular file: ${relative(ROOT, temporary)}`);
    preflightGeneratedLeaf(path, outputRoot);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  preflightGeneratedLeaf(path, outputRoot);
}

function readSourceJson(path, label, allowedRoot) {
  const raw = readSourceFile(path, label, allowedRoot);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readSourceFile(path, label, allowedRoot) {
  preflightSourceFile(path, label, allowedRoot);
  return readRegularFileNoFollow(path, label);
}

function preflightSourceFile(path, label, allowedRoot) {
  assertPathWithin(allowedRoot, path, label);
  preflightDirectory(allowedRoot, ROOT, `${label} root`);
  preflightDirectory(dirname(path), allowedRoot, `${label} parent`);
  assert(existsSync(path), `${label} is missing: ${path}`);
  const info = lstatSync(path);
  assert(!info.isSymbolicLink(), `${label} cannot be a symbolic link: ${relative(ROOT, path)}`);
  assert(info.isFile(), `${label} must be a regular file: ${relative(ROOT, path)}`);
  assertPhysicalWithin(allowedRoot, realpathSync(path), label);
}

function preflightDirectory(path, allowedRoot, label) {
  assertPathWithin(allowedRoot, path, label);
  assert(existsSync(path), `${label} is missing: ${path}`);
  assertNoSymlinkPath(allowedRoot, path, label);
  const info = lstatSync(path);
  assert(!info.isSymbolicLink(), `${label} cannot be a symbolic link: ${relative(ROOT, path) || '.'}`);
  assert(info.isDirectory(), `${label} must be a directory: ${path}`);
  assertPhysicalWithin(allowedRoot, realpathSync(path), label);
}

function assertNoSymlinkPath(allowedRoot, candidate, label) {
  const root = resolve(allowedRoot);
  const path = resolve(candidate);
  assertPathWithin(root, path, label);
  const rel = relative(root, path);
  let cursor = root;
  const rootInfo = lstatSync(root);
  assert(!rootInfo.isSymbolicLink(), `${label} root cannot be a symbolic link: ${root}`);
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    assert(!lstatSync(cursor).isSymbolicLink(), `${label} path contains a symbolic link: ${relative(ROOT, cursor)}`);
  }
}

function assertPathWithin(allowedRoot, candidate, label) {
  const root = resolve(allowedRoot);
  const path = resolve(candidate);
  assert(isWithin(root, path), `${label} escapes ${relative(ROOT, root) || 'repository root'}: ${candidate}`);
}

function assertPhysicalWithin(allowedRoot, candidate, label) {
  const root = realpathSync(allowedRoot);
  const path = resolve(candidate);
  assert(isWithin(root, path), `${label} escapes its physical root: ${candidate}`);
}

function readRegularFileNoFollow(path, label) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    assert(fstatSync(descriptor).isFile(), `${label} must be a regular file`);
    return readFileSync(descriptor);
  } catch (error) {
    fail(`${label} could not be read safely: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isWithin(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function bySlug(items, label) {
  const map = new Map(items.map((item) => [item.slug, item]));
  assert(map.size === items.length, `${label} has duplicate slugs`);
  return map;
}

function titleCase(value) {
  return value.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

function words(value) {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
