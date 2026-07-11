#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: sync-argus-raci.mjs [--check|--write]');

const source = readJson('argus/raci.json');
const capability = readJson('argus/capabilities/capability-matrix.json');
const engagement = readJson('argus/policies/engagement.template.json');
const agents = new Map(source.agents.map((agent) => [agent.slug, agent]));
const slugs = [...agents.keys()].sort();
const canonicalOwners = new Map(source.artifacts.map((artifact) => [artifact.path, artifact.accountable]));

assert(source.schemaVersion === 1, 'RACI schemaVersion must be 1');
assert(source.agents.length === 27 && agents.size === 27, 'RACI must define exactly 27 unique agents');
assert(equal(slugs, capability.agents.map((agent) => agent.slug).sort()), 'RACI and capability agent inventories differ');
for (const contract of capability.agents) {
  const agent = agents.get(contract.slug);
  assert(agent.lane === contract.lane, `${agent.slug}: RACI lane differs from capability matrix`);
  assert(agent.description.split(/\s+/).length <= 35, `${agent.slug}: description exceeds 35 words`);
  if (agent.persistence === 'candidate-file') assert(/persists?.*candidate/i.test(agent.description), `${agent.slug}: candidate persistence is missing from description`);
  if (agent.persistence === 'fragment-only') assert(/fragments.*Minos.*persists/i.test(agent.description), `${agent.slug}: fragment-only persistence handoff is missing from description`);
  if (agent.persistence === 'tests-only') assert(/owns tests\//i.test(agent.description), `${agent.slug}: test ownership is missing from description`);
  if (agent.persistence === 'candidate-file') assert(contract.requiredTools.includes('Write'), `${agent.slug}: candidate-file role has no Write tool`);
  if (agent.persistence === 'fragment-only' || agent.persistence === 'result-envelope') assert(!contract.requiredTools.includes('Write'), `${agent.slug}: envelope-only role unexpectedly has Write`);
  for (const path of agent.accountableArtifacts) assert(contract.artifactPaths.includes(path), `${agent.slug}: capability paths omit accountable artifact ${path}`);
  for (const path of contract.artifactPaths) {
    if (canonicalOwners.has(path)) assert(canonicalOwners.get(path) === agent.slug, `${agent.slug}: capability path claims canonical artifact owned by ${canonicalOwners.get(path)}: ${path}`);
  }
}

const expectedActivities = ['automate', 'deduplicate', 'discover', 'judge', 'persist', 'report', 'validate'];
assert(equal(source.defectLifecycle.map((item) => item.activity).sort(), expectedActivities), 'defect lifecycle must define seven unique activities');
unique(source.defectLifecycle, (item) => item.activity, 'defect activity');
unique(source.surfaceRoutes, (item) => item.surface, 'surface route');
unique(source.stateTransitions, (item) => `${item.stateMachine}:${item.from}:${item.to}`, 'state transition');
unique(source.artifacts, (item) => item.path, 'canonical artifact');
const requiredTransitions = [
  'engagement:preflight:discovery', 'engagement:discovery:hunting', 'engagement:hunting:automation', 'engagement:automation:verification', 'engagement:verification:reporting', 'engagement:reporting:complete',
  'lane-plan:planned:running', 'lane-plan:planned:blocked', 'lane-plan:running:blocked', 'lane-plan:running:completed',
  'defect:needs-oracle:suspected', 'defect:suspected:confirmed', 'defect:confirmed:automated', 'defect:automated:fixed', 'defect:fixed:closed',
  'runner-lifecycle:discovered:reproduced', 'runner-lifecycle:reproduced:automated', 'runner-lifecycle:automated:fixed', 'runner-lifecycle:fixed:closed',
  'automation:planned:implemented', 'automation:implemented:passed', 'automation:implemented:failed', 'automation:implemented:skipped',
  'evidence:collected:immutable', 'coverage-observations:collected:merged', 'coverage-result:inputs-ready:calculated',
  'final-summary:reporting:completed', 'final-summary:reporting:degraded', 'final-summary:reporting:blocked',
];
const transitionKeys = new Set(source.stateTransitions.map((item) => `${item.stateMachine}:${item.from}:${item.to}`));
for (const transition of requiredTransitions) assert(transitionKeys.has(transition), `missing canonical state transition: ${transition}`);

const realSlugs = new Set(slugs);
for (const item of source.defectLifecycle) assert(realSlugs.has(item.accountable), `${item.activity}: accountable owner must be one real agent`);
for (const item of [...source.stateTransitions, ...source.artifacts]) assert(realSlugs.has(item.accountable), `unknown accountable owner: ${item.accountable}`);
for (const route of source.surfaceRoutes) {
  for (const field of ['discover', 'baseline', 'automate', 'validate', 'report']) {
    assert(realSlugs.has(route[field]), `${route.surface}: unknown ${field} owner ${route[field]}`);
  }
}

const policyArtifacts = engagement.writePolicy.canonicalArtifacts.map((item) => ({ path: item.path, accountable: item.owner })).sort(byPath);
const raciArtifacts = [...source.artifacts].sort(byPath);
assert(equal(policyArtifacts, raciArtifacts), 'RACI artifact owners differ from engagement canonicalArtifacts');
const assignedArtifacts = new Map();
for (const agent of source.agents) {
  for (const path of agent.accountableArtifacts) {
    assert(!assignedArtifacts.has(path), `${path}: multiple accountable agents`);
    assignedArtifacts.set(path, agent.slug);
  }
}
for (const artifact of source.artifacts) assert(assignedArtifacts.get(artifact.path) === artifact.accountable, `${artifact.path}: agent accountability is missing or inconsistent`);

for (const agent of source.agents) {
  syncFile(`argus/claude/agents/${agent.slug}.md`, (content) => updateClaude(content, agent));
  syncFile(`argus/codex/${agent.slug}.md`, (content) => updateCodexMarkdown(content, agent));
  syncFile(`argus/codex/${agent.slug}.toml`, (content) => updateCodexToml(content, agent));
}

syncGenerated('argus/RACI-CONTRACT.md', renderContract(source));
syncFile('argus/README.md', (content) => updateReadme(content, source));

console.log(`PASS  Argus RACI: ${source.agents.length} agents, ${source.artifacts.length} artifacts, ${source.stateTransitions.length} transitions, ${source.surfaceRoutes.length} surface routes`);

function updateClaude(content, agent) {
  assert(/^description:.*$/m.test(content), `${agent.slug}: Claude description missing`);
  content = content.replace(/^description:.*$/m, `description: ${agent.description}`);
  return insertBlock(content, agent);
}

function updateCodexMarkdown(content, agent) {
  assert(/^description:.*$/m.test(content) && /^purpose:.*$/m.test(content), `${agent.slug}: Codex Markdown metadata missing`);
  content = content.replace(/^description:.*$/m, `description: ${JSON.stringify(agent.description)}`);
  content = content.replace(/^purpose:.*$/m, `purpose: ${agent.description}`);
  return insertBlock(content, agent);
}

function updateCodexToml(content, agent) {
  assert(/^description = .*$/m.test(content), `${agent.slug}: Codex TOML description missing`);
  content = content.replace(/^description = .*$/m, `description = ${JSON.stringify(agent.description)}`);
  return insertBlock(content, agent);
}

function insertBlock(content, agent) {
  const block = renderAgentBlock(agent);
  const pattern = /<!-- RACI_CONTRACT_START -->[\s\S]*?<!-- RACI_CONTRACT_END -->\n*/;
  if (pattern.test(content)) content = content.replace(pattern, `${block}\n`);
  else if (/## RACI Contract[\s\S]*?<!-- RACI_CONTRACT_END -->\n*/.test(content)) {
    content = content.replace(/## RACI Contract[\s\S]*?<!-- RACI_CONTRACT_END -->\n*/, `${block}\n`);
  }
  else {
    assert(content.includes('<!-- Author:'), `${agent.slug}: author anchor missing`);
    content = content.replace('<!-- Author:', `${block}\n<!-- Author:`);
  }
  return content;
}

function renderAgentBlock(agent) {
  const artifacts = agent.accountableArtifacts.length ? agent.accountableArtifacts.map((path) => `\`${path}\``).join(', ') : 'none';
  const surfaces = source.surfaceRoutes.flatMap((route) => ['discover', 'baseline', 'automate', 'validate', 'report'].filter((activity) => route[activity] === agent.slug).map((activity) => `${route.surface}:${activity}`));
  const dual = source.dualHome.find((item) => item.slug === agent.slug);
  return `<!-- RACI_CONTRACT_START -->\n## RACI Contract\n\n- Role/lane: ${agent.role} / \`${agent.lane}\`.\n- Responsible: ${agent.responsible.join('; ')}.\n- Accountable artifacts: ${artifacts}.\n- Persistence: \`${agent.persistence}\`. Candidate artifacts never become canonical defects until Minos validates, deduplicates, and persists them.\n- Routing: use \`argus-assets raci route\`; do not infer ownership from agent names or silently perform another role's responsibility.\n<!-- RACI_CONTRACT_END -->`
    .replace('- Routing:', `- Surface routes: ${surfaces.join(', ') || 'none'}.\n${dual ? `- Dual-home rule: ${dual.rule}\n` : ''}- Routing:`);
}

function renderContract(data) {
  const lines = [
    '# Argus RACI Contract', '',
    'This generated document is the human view of `argus/raci.json`. The JSON source is authoritative. `scripts/sync-argus-raci.mjs --check` rejects ownership, prompt, description, roster, or transition drift. Runtime routing uses `argus-assets raci route`.', '',
    'R = responsible, A = exactly one accountable owner, C = consulted, I = informed.', '',
    '## Defect lifecycle', '',
    '| Activity | A | R | C | Handoff |', '|---|---|---|---|---|',
    ...data.defectLifecycle.map((item) => `| ${item.activity} | ${item.accountable} | ${(item.responsible ?? []).join(', ')} | ${(item.consulted ?? []).join(', ') || '—'} | ${item.handoff ?? '—'} |`), '',
    '## Surface routing', '',
    '| Surface | Discover | Baseline | Automate | Validate | Report | Gate |', '|---|---|---|---|---|---|---|',
    ...data.surfaceRoutes.map((item) => `| ${item.surface} | ${item.discover} | ${item.baseline} | ${item.automate} | ${item.validate} | ${item.report} | ${item.gate ?? '—'} |`), '',
    '## Canonical artifacts', '', 'The accountable owner is also the sole owner of that artifact\'s `fragment → canonical` merge transition.', '', '| Path | A / merge owner |', '|---|---|',
    ...data.artifacts.map((item) => `| \`${item.path}\` | ${item.accountable} |`), '',
    '## State transitions', '', '| State machine | Transition | A |', '|---|---|---|',
    ...data.stateTransitions.map((item) => `| ${item.stateMachine} | ${item.from} → ${item.to} | ${item.accountable} |`), '',
    '## Agent contracts', '', '| Agent | Role | Lane | Persistence | Accountable artifacts |', '|---|---|---|---|---|',
    ...data.agents.map((item) => `| ${item.slug} | ${item.role} | ${item.lane} | ${item.persistence} | ${item.accountableArtifacts.map((path) => `\`${path}\``).join(', ') || '—'} |`), '',
    '## Dual-home scheduling', '',
    ...data.dualHome.map((item) => `- **${item.slug}** (${item.workUnits.join(', ')}): ${item.rule}`), '',
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function updateReadme(content, data) {
  const start = '<!-- RACI_ROSTER_START -->';
  const end = '<!-- RACI_ROSTER_END -->';
  const table = [start, '| Agent | Role | Lane | Persistence |', '|---|---|---|---|', ...data.agents.map((item) => `| **${item.slug}** | ${item.role} | \`${item.lane}\` | \`${item.persistence}\` |`), end].join('\n');
  if (content.includes(start)) return content.replace(new RegExp(`${start}[\\s\\S]*?${end}`), table);
  const legacy = /\| Agent \| Role \|\n\|---\|---\|[\s\S]*?\n\(In `odysseus\.md`[\s\S]*?view\.\)\n/;
  assert(legacy.test(content), 'README roster region not found');
  return content.replace(legacy, `${table}\n\nThe generated roster and every prompt description come from \`argus/raci.json\`; detailed ownership is in [\`RACI-CONTRACT.md\`](RACI-CONTRACT.md).\n`);
}

function syncFile(path, transform) {
  const absolute = join(ROOT, path);
  const current = readFileSync(absolute, 'utf8');
  const expected = transform(current);
  if (mode === '--write') writeFileSync(absolute, expected);
  else assert(current === expected, `${path} is out of sync with argus/raci.json`);
}

function syncGenerated(path, expected) {
  const absolute = join(ROOT, path);
  if (mode === '--write') writeFileSync(absolute, expected);
  else assert(readFileSync(absolute, 'utf8') === expected, `${path} is out of sync with argus/raci.json`);
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) { const value = key(item); assert(!seen.has(value), `duplicate ${label}: ${value}`); seen.add(value); }
}
function readJson(path) { return JSON.parse(readFileSync(join(ROOT, path), 'utf8')); }
function byPath(a, b) { return a.path.localeCompare(b.path); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assert(value, message) { if (!value) fail(message); }
function fail(message) { console.error(`FAIL  ${message}`); process.exit(1); }
