#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePhasePlan } from '../argus/runtime/orchestration-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: sync-argus-raci.mjs [--check|--write]');

const source = readJson('argus/raci.json');
const capability = readJson('argus/capabilities/capability-matrix.json');
const engagement = readJson('argus/policies/engagement.template.json');
const orchestrationPlan = readJson('argus/orchestration-plan.json');
const MODES = ['A', 'B', 'C', 'D'];
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

const expectedActivities = ['automate', 'deduplicate', 'discover', 'judge', 'persist', 'repair', 'report', 'reproduce', 'source-oracle', 'validate'];
assert(equal(source.defectLifecycle.map((item) => item.activity).sort(), expectedActivities), 'defect lifecycle must define ten unique activities');
unique(source.defectLifecycle, (item) => item.activity, 'defect activity');
unique(source.surfaceRoutes, (item) => item.surface, 'surface route');
unique(source.stateTransitions, transitionKey, 'state transition');
unique(source.artifacts, (item) => item.path, 'canonical artifact');
const requiredTransitions = [
  'lane-plan:planned:running', 'lane-plan:planned:blocked', 'lane-plan:running:blocked', 'lane-plan:running:completed',
  'defect:candidate:bounced', 'defect:candidate:suspected', 'defect:candidate:confirmed',
  'defect:bounced:needs-oracle', 'defect:bounced:suspected', 'defect:bounced:confirmed', 'defect:needs-oracle:confirmed',
  'defect:confirmed:quarantined', 'defect:quarantined:confirmed', 'defect:quarantined:suspected',
  'defect:needs-oracle:suspected', 'defect:suspected:confirmed', 'defect:confirmed:automated', 'defect:automated:fixed', 'defect:fixed:closed',
  'runner-lifecycle:discovered:reproduced', 'runner-lifecycle:reproduced:automated', 'runner-lifecycle:automated:fixed', 'runner-lifecycle:fixed:closed',
  'automation:planned:implemented', 'automation:implemented:passed', 'automation:implemented:failed', 'automation:implemented:skipped',
  'evidence:collected:immutable', 'coverage-observations:collected:merged', 'coverage-result:inputs-ready:calculated',
  'final-summary:reporting:completed', 'final-summary:reporting:degraded', 'final-summary:reporting:blocked',
];
const transitionKeys = new Set(source.stateTransitions.map(transitionKey));
for (const transition of requiredTransitions) assert(transitionKeys.has(transition), `missing canonical state transition: ${transition}`);

const realSlugs = new Set(slugs);
for (const item of source.defectLifecycle) assert(realSlugs.has(item.accountable), `${item.activity}: accountable owner must be one real agent`);
for (const item of [...source.stateTransitions, ...source.artifacts]) assert(realSlugs.has(item.accountable), `unknown accountable owner: ${item.accountable}`);
for (const route of source.surfaceRoutes) {
  for (const field of ['discover', 'baseline', 'automate', 'validate', 'report']) {
    assert(realSlugs.has(route[field]), `${route.surface}: unknown ${field} owner ${route[field]}`);
  }
  assert(Array.isArray(route.reproduce), `${route.surface}: reproduce must be an ordered list of candidates`);
  unique(route.reproduce, (slug) => slug, `${route.surface} reproduce candidate`);
  for (const slug of route.reproduce) {
    assert(realSlugs.has(slug), `${route.surface}: unknown reproduce candidate ${slug}`);
    assert(slug !== route.discover, `${route.surface}: reproduce candidate ${slug} is the surface discover owner`);
  }
}

// Engagement transitions are exactly the phase edges the orchestration plan can produce:
// consecutive phases of every mode, plus the skip exit (converged or controller-budget) from
// each skippable deep-hunt pass to the first phase after that mode's last deep pass. Validating the plan against this
// RACI also proves every reproduce candidate holds a lane before the first proof phase.
const engagementTransitions = new Set();
for (const mode of MODES) {
  let phases;
  try {
    phases = derivePhasePlan(orchestrationPlan, capability, mode, undefined, source);
  } catch (error) {
    fail(`Mode ${mode}: ${error.message}`);
  }
  for (let index = 1; index < phases.length; index += 1) {
    engagementTransitions.add(`engagement:${phases[index - 1].id}:${phases[index].id}`);
  }
  const lastDeep = phases.findLastIndex(isDeepPhase);
  if (lastDeep === -1) continue;
  const exit = phases[lastDeep + 1];
  assert(exit, `Mode ${mode}: no phase follows the last deep pass`);
  for (const phase of phases) {
    if (phase.kind === 'deep-hunt' && phase.pass >= 2) engagementTransitions.add(`engagement:${phase.id}:${exit.id}`);
  }
}
const transitionsByKey = new Map(source.stateTransitions.map((item) => [transitionKey(item), item]));
for (const key of engagementTransitions) {
  const transition = transitionsByKey.get(key);
  assert(transition, `missing canonical state transition: ${key}`);
  assert(transition.accountable === 'odysseus', `${key}: engagement transitions must be accountable to odysseus`);
}
for (const item of source.stateTransitions) {
  if (item.stateMachine === 'engagement') assert(engagementTransitions.has(transitionKey(item)), `stale engagement transition: ${transitionKey(item)}`);
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

syncGenerated('argus/RACI-CONTRACT.md', renderContract(source));
syncFile('argus/README.md', (content) => updateReadme(content, source));

console.log(`PASS  Argus RACI: ${source.agents.length} agents, ${source.artifacts.length} artifacts, ${source.stateTransitions.length} transitions, ${source.surfaceRoutes.length} surface routes`);

function renderContract(data) {
  const lines = [
    '# Argus RACI Contract', '',
    'This generated document is the human view of `argus/raci.json`. The JSON source is authoritative. `scripts/sync-argus-raci.mjs --check` rejects ownership, roster, or transition drift. Runtime routing uses `argus-assets raci route`; `scripts/sync-argus-role-variants.mjs` renders role descriptions and contract blocks.', '',
    'R = responsible, A = exactly one accountable owner, C = consulted, I = informed.', '',
    '## Defect lifecycle', '',
    '| Activity | A | R | C | Handoff |', '|---|---|---|---|---|',
    ...data.defectLifecycle.map((item) => `| ${item.activity} | ${item.accountable} | ${(item.responsible ?? []).join(', ')} | ${(item.consulted ?? []).join(', ') || '—'} | ${item.handoff ?? '—'} |`), '',
    '## Surface routing', '',
    'Reproduce lists independent reproducers in preference order. Odysseus assigns the first selected, dispatchable candidate that is not the finder, an origin lane, or the collector of the original reproduction evidence; every candidate holds a lane before the first proof phase and never discovers that surface. An empty list names no independent reproducer: the finding uses the route of its manifestation surface when that differs, and otherwise records independent reproduction as unavailable with its reason.', '',
    '| Surface | Discover | Reproduce | Baseline | Automate | Validate | Report | Gate |', '|---|---|---|---|---|---|---|---|',
    ...data.surfaceRoutes.map((item) => `| ${item.surface} | ${item.discover} | ${item.reproduce.join(', ') || '—'} | ${item.baseline} | ${item.automate} | ${item.validate} | ${item.report} | ${item.gate ?? '—'} |`), '',
    '## Canonical artifacts', '', 'The accountable owner is also the sole owner of that artifact\'s `fragment → canonical` merge transition.', '', '| Path | A / merge owner |', '|---|---|',
    ...data.artifacts.map((item) => `| \`${item.path}\` | ${item.accountable} |`), '',
    '## State transitions', '',
    'Engagement transitions are derived, not declared freely: they are exactly the consecutive phases that `derivePhasePlan` produces from `argus/orchestration-plan.json` in Modes A–D, plus the skip exit from each skippable deep-hunt pass to the first phase after that mode\'s last deep pass.', '',
    '| State machine | Transition | A |', '|---|---|---|',
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
  const sourceNote = 'The generated roster comes from `argus/raci.json`; the sole role-variant generator reads descriptions from the same source. Detailed ownership is in [`RACI-CONTRACT.md`](RACI-CONTRACT.md).';
  if (content.includes(start)) {
    content = content.replace(new RegExp(`${start}[\\s\\S]*?${end}`), table);
    content = content.replace(/The generated roster and every prompt description come from `argus\/raci\.json`; detailed ownership is in \[`RACI-CONTRACT\.md`\]\(RACI-CONTRACT\.md\)\./, sourceNote);
    content = content.replace(
      /The RACI sync gate validates all 27 prompt descriptions and generated\ncontract blocks against the same source used for the roster below\./,
      'The sole role-variant generator renders all 27 prompt descriptions and contract blocks from this source. The RACI sync gate validates ownership, roster, and transition consistency.',
    );
    return content;
  }
  const legacy = /\| Agent \| Role \|\n\|---\|---\|[\s\S]*?\n\(In `odysseus\.md`[\s\S]*?view\.\)\n/;
  assert(legacy.test(content), 'README roster region not found');
  return content.replace(legacy, `${table}\n\n${sourceNote}\n`);
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
function transitionKey(item) { return `${item.stateMachine}:${item.from}:${item.to}`; }
function isDeepPhase(phase) { return phase.kind === 'deep-hunt' || (phase.kind === 'proof' && phase.pass >= 1); }
function readJson(path) { return JSON.parse(readFileSync(join(ROOT, path), 'utf8')); }
function byPath(a, b) { return a.path.localeCompare(b.path); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assert(value, message) { if (!value) fail(message); }
function fail(message) { console.error(`FAIL  ${message}`); process.exit(1); }
