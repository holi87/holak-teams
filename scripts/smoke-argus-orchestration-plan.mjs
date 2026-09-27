#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEssentialLanePolicy, derivePhasePlan, projectOrchestrationPlan, validateOrchestrationPlan } from '../argus/runtime/orchestration-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = readJson('argus/orchestration-plan.json');
const matrix = readJson('argus/capabilities/capability-matrix.json');
const raci = readJson('argus/raci.json');
const modelPolicy = readJson('argus/model-policy.json');
const fixtures = readJson('scripts/fixtures/argus-orchestration/invalid-mutations.json');
const controllerSkill = readFileSync(join(ROOT, 'argus/shared-skills/orchestration-core/SKILL.md'), 'utf8');
const controllerContract = controllerSkill.replace(/\s+/gu, ' ');
const expectedWaves = {
  W0: ['kalchas', 'metis', 'tiresias', 'atlas'],
  W1: [
    'antigone', 'ariadne', 'asklepios', 'atalanta', 'charon', 'daidalos', 'hermes', 'lynceus',
    'minos', 'orion', 'penelope', 'perseus', 'pistis', 'proteus', 'talos', 'theseus', 'tyche',
  ],
  W2: [],
  W3: ['aegis', 'aristarchus', 'mnemosyne', 'nike'],
  W4: ['kleio'],
};
const expectedModeCounts = { A: 27, B: 16, C: 15, D: 15 };
const deepHuntRoles = [
  'antigone', 'ariadne', 'atalanta', 'charon', 'hermes', 'lynceus', 'orion', 'perseus', 'proteus', 'tiresias', 'tyche',
];
const deepPhases = ['deep-hunt-1', 'deep-proof-1', 'deep-hunt-2', 'deep-proof-2', 'deep-hunt-3', 'deep-proof-3'];
// Declared essential lanes per mode; Modes A and B also inherit the 11 mandatory hunters.
const declaredEssential = {
  A: ['kalchas', 'metis', 'atlas', 'minos', 'kleio'],
  B: ['kalchas', 'metis', 'minos', 'kleio'],
  C: ['kalchas', 'metis', 'atlas', 'minos', 'kleio'],
  D: ['kalchas', 'metis', 'atlas', 'minos', 'kleio'],
};
const expectedEssential = {
  A: [...declaredEssential.A, ...deepHuntRoles].sort(),
  B: [...declaredEssential.B, ...deepHuntRoles].sort(),
  C: [...declaredEssential.C].sort(),
  D: [...declaredEssential.D].sort(),
};
const expectedPhaseIds = {
  A: ['preflight', 'discovery', 'hunting', 'proof', ...deepPhases, 'automation', 'verification', 'reporting', 'complete'],
  B: ['preflight', 'discovery', 'hunting', 'proof', ...deepPhases, 'verification', 'reporting', 'complete'],
  C: ['preflight', 'discovery', 'hunting', 'proof', 'automation', 'verification', 'reporting', 'complete'],
  D: ['preflight', 'discovery', 'hunting', 'proof', 'automation', 'verification', 'reporting', 'complete'],
};

const canonicalErrors = validateOrchestrationPlan(plan, matrix, raci);
assert(canonicalErrors.length === 0, `canonical plan failed: ${canonicalErrors.join('; ')}`);
const controllerWords = controllerSkill.trim().split(/\s+/u).length;
assert(controllerWords >= 800 && controllerWords <= 2400, `orchestration-core must stay within 800-2400 words, found ${controllerWords}`);
for (const fragment of [
  'qa-core', 'qa-browser', 'qa-framework-runner', 'qa-coverage-reporting',
  'A — Full QA Audit', 'B — Deep Bug Hunt', 'C — Greenfield suite', 'D — Brownfield extension',
  'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED', 'ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE',
  'ARGUS_PREFLIGHT_ERROR: ARGUS_AGENTS_UNAVAILABLE', 'ARGUS_PREFLIGHT_ERROR: CAPABILITY_PREFLIGHT_BLOCKED',
  'argus-assets preflight --target <target> --mode <A|B|C|D> --artifact-root <artifact-root>', '--launch-authorization <launch-authorization>', '--launch-receipt <launch-receipt>', 'ai_agents_internal/orchestration-plan.json', 'ai_agents_internal/preflight.json',
  '`ready`, `degraded`, and `conditional` record with `dispatchAllowed=true`', 'Dispatch `ready`/`degraded` records',
  '`ready`/`degraded`/`conditional`, `dispatchAllowed=true` projection', 'run `argus-assets engagement resolve-gates` once',
  'dispatch a `conditional` lane only when released', 'A `gate-unmet` lane is omitted, counts as a non-dispatched predecessor',
  'unmet gate goes to `solution/coverage-result.json`', 'Never rerun preflight after the first allocation',
  '`deferred`, `skipped`, or `blocked`', 'untrusted evidence',
  'argus-assets authorization check', 'argus-assets redact', 'success`, `failure`, or `interrupted',
  'selected-dispatchable-predecessors', 'argus-assets raci route', 'argus-assets template detect',
  'template select', 'template scaffold', '`baseline`, `defect-evidence`, `candidate-regression`, and',
  'argus-assets model route', 'argus/model-escalation-request@1', 'argus-assets model telemetry',
  'product, automation,', 'infrastructure, skip, and policy outcomes', 'Never claim an agent ran',
  '`deferred` record with `downgradedFrom=blocked`', 'report it from `residualRisks`',
  'proofLoop', 'deepHunt', 'engagement barrier skip', 'at most one thread per lane', 'maxRepairRounds', '--activity reproduce',
]) {
  assert(controllerContract.includes(fragment), `orchestration-core lost required controller semantic: ${fragment}`);
}
assert(!controllerSkill.includes('qa-doctrine'), 'orchestration-core references legacy qa-doctrine instead of modular skills');
assert(!controllerContract.includes('Rerun after provisioning'), 'orchestration-core still reruns preflight after provisioning instead of resolving gates');
assert(plan.roles.length === 27, `expected 27 roles, found ${plan.roles.length}`);
assert(plan.$schema === 'argus/orchestration-plan@2' && plan.schemaVersion === 2 && plan.deepHuntWave === undefined,
  'orchestration plan must be argus/orchestration-plan@2 without the retired deepHuntWave');
assert(plan.deepHunt?.tier === 'frontier' && plan.deepHunt.maxPasses === 3
  && plan.deepHunt.continueWhen === 'new-confirmed-defects'
  && sameSet(plan.deepHunt.roles, deepHuntRoles) && sameSet(plan.deepHunt.modes, ['A', 'B']),
  'deep hunt is not a bounded three-pass frontier loop over the 11 hunters in Modes A and B');
assert(plan.deepHunt.brief.length >= 12
  && [/suspected/u, /bounced/u, /WHITEBOX-LEADS/u].every((pattern) => plan.deepHunt.brief.some((line) => pattern.test(line))),
  'deep-hunt brief must route suspected defects, bounced candidates and open WHITEBOX-LEADS rows');
// The contract-conformance lanes are mechanised and score well; the invariant lanes are the
// ones that go quiet under time pressure. Both belong in the second pass, so the second pass
// cannot become a contract-only pass again.
assert(plan.deepHunt.roles.includes('ariadne') && plan.deepHunt.roles.includes('tyche'),
  'deep hunt dropped the invariant and resilience lanes');
for (const slug of plan.deepHunt.roles) {
  assert(modelPolicy.roles.find((role) => role.slug === slug)?.tier === 'frontier',
    `deep-hunt role ${slug} must use the frontier model tier`);
}
assert(plan.huntingBrief.some((line) => /Tiresias TIR lead/u.test(line))
  && plan.huntingBrief.some((line) => /never a precondition/u.test(line)),
  'hunting brief must route Tiresias leads and keep baselines optional for hunters');
assert(plan.mandatoryLanes?.policy === 'gates-satisfied-means-dispatched'
  && sameSet(plan.mandatoryLanes.modes, ['A', 'B'])
  && sameSet(plan.mandatoryLanes.roles, deepHuntRoles),
  'mandatory hunter lanes are not the 11 deep-hunt lanes under the gates-satisfied dispatch policy');
assert(plan.proofLoop?.validator === 'minos' && plan.proofLoop.oracleDesk === 'metis' && plan.proofLoop.maxRepairRounds === 2
  && plan.proofLoop.validatorPasses.order === 'clusters-then-consolidator'
  && sameSet(plan.proofLoop.justifiedInvariantClasses, ['server-error', 'crash', 'data-loss', 'authz-breach', 'layer-disagreement'])
  && /never dropped/u.test(plan.proofLoop.exhaustion),
  'proof loop lost its validator, oracle desk, repair bound, invariant classes or exhaustion rule');
assert(plan.roles.find((role) => role.slug === 'minos')?.modes.join('') === 'ABCD'
  && matrix.agents.find((agent) => agent.slug === 'minos')?.modes.join('') === 'ABCD',
  'Minos must validate findings in every mode');
assert(plan.mandatoryLanes.rule.some((rule) => /additive/i.test(rule)),
  'mandatoryLanes must state that a brief is additive and cannot remove a catalog obligation');
assert(plan.mandatoryLanes.rule.some((rule) => /time pressure is not a disposition/i.test(rule)),
  'mandatoryLanes must forbid holding a satisfied lane for time');
assert(plan.roles.find((role) => role.slug === 'odysseus')?.dispatch === false, 'Odysseus is not a non-dispatched controller');
assert(plan.essentialLanes?.policy === 'blocked-essential-lane-stops-engagement'
  && plan.essentialLanes.includeMandatoryLanes === true
  && Object.entries(declaredEssential).every(([mode, lanes]) => sameSet(plan.essentialLanes.modes[mode], lanes))
  && plan.essentialLanes.rule.length >= 2,
  'essential lanes are not the declared per-mode set under the blocked-essential-lane policy');
for (const [wave, expected] of Object.entries(expectedWaves)) {
  const actual = plan.roles.filter((role) => role.wave === wave).map((role) => role.slug);
  assert(sameSet(actual, expected), `${wave} membership drifted`);
}

for (const [mode, expectedCount] of Object.entries(expectedModeCounts)) {
  const activeCount = plan.roles.filter((role) => role.modes.includes(mode)).length;
  assert(activeCount === expectedCount, `mode ${mode} count drifted: ${activeCount}`);
  const projected = projectOrchestrationPlan(plan, matrix, mode, undefined, raci);
  const dispatched = projected.waves.flatMap((wave) => wave.roles);
  assert(dispatched.length === expectedCount - 1, `mode ${mode} projection must exclude only the controller`);
  assert(projected.waves.find((wave) => wave.id === 'W2').roles.length === 0, `mode ${mode}: W2 must hold no first-dispatch roles`);
  const dispatchedSlugs = new Set(dispatched.map((role) => role.slug));
  for (const role of dispatched) {
    assert(role.dependsOn.every((dependency) => dispatchedSlugs.has(dependency)), `${mode}/${role.slug}: inactive dependency survived projection`);
    assert(role.task && role.lane && Array.isArray(role.responsibilities), `${mode}/${role.slug}: task contract missing from projection`);
    assert(Array.isArray(role.accountableArtifacts) && Array.isArray(role.artifactPaths), `${mode}/${role.slug}: output contract missing from projection`);
  }
  assert(projected.omitted.length === 0, `mode ${mode}: complete projection unexpectedly omitted roles`);
  if (plan.deepHunt.modes.includes(mode)) {
    assert(projected.deepHunt
      && projected.deepHunt.tier === plan.deepHunt.tier
      && projected.deepHunt.maxPasses === plan.deepHunt.maxPasses
      && projected.deepHunt.continueWhen === plan.deepHunt.continueWhen
      && sameSet(projected.deepHunt.roles, plan.deepHunt.roles)
      && projected.deepHunt.omitted.length === 0
      && projected.deepHunt.brief.length === plan.deepHunt.brief.length,
      `mode ${mode}: projection lost the declared deep hunt`);
  } else {
    assert(projected.deepHunt === null, `mode ${mode}: deep hunt must not project outside its declared modes`);
  }
  assert(projected.huntingBrief.length === plan.huntingBrief.length, `mode ${mode}: projection lost the hunting brief`);
  assert(JSON.stringify(projected.essentialLanes) === JSON.stringify(expectedEssential[mode]),
    `mode ${mode}: projected essential lanes drifted: ${projected.essentialLanes.join(', ')}`);

  const phasePlan = derivePhasePlan(plan, matrix, mode, undefined, raci);
  assert(JSON.stringify(phasePlan.map((phase) => phase.id)) === JSON.stringify(expectedPhaseIds[mode]),
    `mode ${mode}: derived phase order drifted: ${phasePlan.map((phase) => phase.id).join(', ')}`);
  assert(JSON.stringify(projected.phases) === JSON.stringify(derivePhasePlan(plan, matrix, mode, [...dispatchedSlugs, 'odysseus'], raci)),
    `mode ${mode}: projection phases differ from derivePhasePlan over the selected lanes`);
  assert(JSON.stringify(phasePlan) === JSON.stringify(projected.phases), `mode ${mode}: default selection differs from the complete projection`);
  assertPhasePlanShape(mode, phasePlan);
  const proof = phasePlan.find((phase) => phase.id === 'proof');
  assert(sameSet(proof.participants, ['minos']) && proof.standby.includes('metis'), `mode ${mode}: proof must run Minos with Metis on standby`);

  const loop = projected.proofLoop;
  assert(loop.validator === 'minos' && loop.validatorSelected && loop.oracleDesk === 'metis' && loop.oracleDeskSelected
    && loop.maxRepairRounds === plan.proofLoop.maxRepairRounds && loop.routes.length === plan.proofLoop.routes.length
    && loop.independentReproduction.candidates === 'raci.surfaceRoutes[].reproduce'
    && loop.acceptedOracleKinds.length === 3 && loop.justifiedInvariantClasses.length === 5 && loop.exhaustion === plan.proofLoop.exhaustion,
    `mode ${mode}: projection lost proof-loop data`);
  assert(loop.clusters.length > 0 && loop.clusters.every((cluster) => cluster.lanes.length > 0
    && cluster.lanes.every((slug) => dispatchedSlugs.has(slug))),
    `mode ${mode}: proof clusters must list only selected lanes and drop empty clusters`);
}
const clusterIds = (mode) => projectOrchestrationPlan(plan, matrix, mode, undefined, raci).proofLoop.clusters.map((cluster) => cluster.id);
assert(clusterIds('A').length === 4 && JSON.stringify(clusterIds('C')) === JSON.stringify(['api-data', 'ui-journey']),
  'proof clusters are not narrowed to the lanes active in each mode');

const gatedA = projectOrchestrationPlan(plan, matrix, 'A', ['kalchas', 'metis', 'atlas', 'theseus', 'talos', 'aristarchus', 'kleio'], raci);
const gatedRoles = gatedA.waves.flatMap((wave) => wave.roles);
const aristarchus = gatedRoles.find((role) => role.slug === 'aristarchus');
assert(sameSet(aristarchus.dependsOn, ['atlas', 'talos']), 'projection did not remove non-dispatchable predecessors');
const kleio = gatedRoles.find((role) => role.slug === 'kleio');
assert(sameSet(kleio.dependsOn, ['aristarchus']), 'projection did not remove gated Minos predecessor');
assert(gatedA.omitted.length === 19, `gated projection must report 19 omitted roles, found ${gatedA.omitted.length}`);
assert(gatedA.omitted.every((role) => role.reason === 'not-in-dispatchable-set'), 'gated projection omitted a disposition reason');
assert(gatedA.deepHunt.roles.length === 0
  && sameSet(gatedA.deepHunt.omitted.map((role) => role.slug), deepHuntRoles)
  && gatedA.deepHunt.omitted.every((role) => role.reason === 'not-in-dispatchable-set'),
  'gated projection did not report the deep-hunt hunters as named residuals');
assert(gatedA.proofLoop.validatorSelected === false && gatedA.proofLoop.oracleDeskSelected === true && gatedA.proofLoop.clusters.length === 0,
  'gated projection must report an unselected validator and project no validator clusters');
const gatedProof = gatedA.phases.find((phase) => phase.id === 'proof');
assert(gatedProof.participants.length === 0 && sameSet(gatedProof.standby, ['metis']),
  'gated projection kept an unselected validator or standby lane in the proof phase');
assert(gatedA.phases.filter((phase) => phase.kind === 'deep-hunt').every((phase) => phase.participants.length === 0),
  'gated projection kept unselected deep-hunt participants');
assertThrows(() => projectOrchestrationPlan(plan, matrix, 'A', ['unknown-role'], raci), 'unknown dispatchable role');
assertThrows(() => projectOrchestrationPlan(plan, matrix, 'B', ['atlas'], raci), 'not dispatchable in Mode B');
assertThrows(() => derivePhasePlan(plan, matrix, 'E', undefined, raci), 'unknown Argus mode: E');
assertThrows(() => derivePhasePlan(plan, matrix, 'A', ['unknown-role'], raci), 'unknown selected role: unknown-role');
assertThrows(() => derivePhasePlan(plan, matrix, 'B', ['odysseus', 'atlas'], raci), 'role is not active in Mode B: atlas');
assertThrows(() => derivePhasePlan(plan, matrix, 'A', 'kalchas', raci), 'selected agents must be an array');
const brokenPlan = structuredClone(plan);
brokenPlan.phases.find((phase) => phase.id === 'proof').participants = ['metis'];
assertThrows(() => derivePhasePlan(brokenPlan, matrix, 'A', undefined, raci), 'invalid orchestration plan');
const controllerless = derivePhasePlan(plan, matrix, 'C', ['kalchas', 'minos'], raci);
assert(controllerless[0].participants.length === 0 && controllerless.at(-1).participants.length === 0,
  'control phases listed an unselected controller');
assert(validateOrchestrationPlan(plan, matrix).length === 0 && derivePhasePlan(plan, matrix, 'A').length === expectedPhaseIds.A.length,
  'phase derivation must not require a RACI contract');

// Without a RACI contract only the plan-internal standby rules apply; the candidate-lane
// standby and cluster-coverage rules come from RACI persistence.
const thinStandby = structuredClone(plan);
thinStandby.phases.find((phase) => phase.id === 'proof').standby = ['metis'];
assert(validateOrchestrationPlan(thinStandby, matrix).length === 0, 'RACI-derived standby rule ran without a RACI contract');
assert(validateOrchestrationPlan(thinStandby, matrix, raci).includes('proof: standby must include antigone'),
  'proof standby did not require RACI candidate lanes');

// RACI reproduce routes: independent reproduction runs in the proof phases, so a reproducer
// must hold a lane before the first proof phase and can never discover the same surface.
const reproduceErrors = (surface, candidates) => {
  const routed = structuredClone(raci);
  routed.surfaceRoutes.find((route) => route.surface === surface).reproduce = candidates;
  return validateOrchestrationPlan(plan, matrix, routed);
};
assert(raci.surfaceRoutes.every((route) => Array.isArray(route.reproduce)), 'every RACI surface route must declare reproduce candidates');
assert(reproduceErrors('api-rest', ['atalanta']).includes('raci reproduce candidate atalanta for api-rest is the surface discover owner'),
  'a surface discover owner was accepted as its independent reproducer');
assert(reproduceErrors('api-rest', ['aegis']).includes('raci reproduce candidate aegis for api-rest is not dispatched before the first proof phase'),
  'a reproducer first dispatched after the first proof phase was accepted');
for (const late of ['kleio', 'odysseus', 'hydra']) {
  assert(reproduceErrors('journey-ui', ['orion', late]).includes(`raci reproduce candidate ${late} for journey-ui is not dispatched before the first proof phase`),
    `reproducer ${late} (late, controller or unknown) was accepted`);
}
assert(reproduceErrors('resilience', ['kalchas']).length === 0, 'a discovery-phase reproducer was rejected');
const routelessRaci = structuredClone(raci);
delete routelessRaci.surfaceRoutes;
assert(validateOrchestrationPlan(plan, matrix, routelessRaci).length === 0, 'a RACI contract without surface routes must add no reproduce errors');
const lateReproducer = structuredClone(raci);
lateReproducer.surfaceRoutes.find((route) => route.surface === 'security').reproduce = ['atalanta', 'mnemosyne'];
assertThrows(() => derivePhasePlan(plan, matrix, 'A', undefined, lateReproducer), 'raci reproduce candidate mnemosyne for security is not dispatched before the first proof phase');

for (const fixture of fixtures) {
  const mutated = structuredClone(plan);
  applyMutation(mutated, fixture);
  const errors = validateOrchestrationPlan(mutated, matrix, raci);
  assert(errors.length > 0, `${fixture.id}: invalid plan unexpectedly passed`);
  assert(errors.some((error) => error.includes(fixture.expects)), `${fixture.id}: expected '${fixture.expects}', got: ${errors.join('; ')}`);
}

// Essential-lane negatives: every listed slug must be a dispatched role active in that mode,
// and Kalchas and Minos are essential in every mode.
for (const [id, mutate, expects] of [
  ['essential-unknown-slug', (document) => document.essentialLanes.modes.A.push('unknown-role'), 'essentialLanes.modes.A: unknown role unknown-role'],
  ['essential-kalchas-missing', (document) => { document.essentialLanes.modes.D = ['metis', 'atlas', 'minos', 'kleio']; }, 'essentialLanes.modes.D: must list kalchas'],
  ['essential-minos-missing-b', (document) => { document.essentialLanes.modes.B = ['kalchas', 'metis', 'kleio']; }, 'essentialLanes.modes.B: must list minos'],
  ['essential-minos-missing-c', (document) => { document.essentialLanes.modes.C = ['kalchas', 'metis', 'atlas', 'kleio']; }, 'essentialLanes.modes.C: must list minos'],
  ['essential-inactive-lane', (document) => document.essentialLanes.modes.B.push('atlas'), 'essentialLanes.modes.B: atlas is inactive in Mode B'],
  ['essential-controller', (document) => document.essentialLanes.modes.C.push('odysseus'), 'essentialLanes.modes.C: odysseus is not dispatched'],
  ['essential-missing', (document) => { delete document.essentialLanes; }, 'essentialLanes'],
  ['essential-policy', (document) => { document.essentialLanes.policy = 'blocked-lane-stops-engagement'; }, '/essentialLanes/policy must be equal to constant'],
  ['essential-empty-mode', (document) => { document.essentialLanes.modes.C = []; }, '/essentialLanes/modes/C must NOT have fewer than 1 items'],
  ['essential-single-rule', (document) => { document.essentialLanes.rule = [document.essentialLanes.rule[0]]; }, '/essentialLanes/rule must NOT have fewer than 2 items'],
]) {
  const mutated = structuredClone(plan);
  mutate(mutated);
  const errors = validateOrchestrationPlan(mutated, matrix, raci);
  assert(errors.some((error) => error.includes(expects)), `${id}: expected '${expects}', got: ${errors.join('; ') || 'no errors'}`);
}

// Essential-lane policy over evaluated preflight records. Blocked non-essential lanes become
// never-dispatched deferred residuals; the controller, essential and mandatory lanes stop it.
const lane = (slug, status, extra = {}) => ({
  slug,
  lane: slug,
  selected: status !== 'not-selected',
  status,
  dispatchAllowed: status === 'ready' || status === 'degraded' || status === 'conditional',
  missingTools: [],
  missingCapabilities: [],
  actions: [],
  ...extra,
});
const policyCase = (mode, record) => {
  const input = [lane('odysseus', 'ready'), record];
  const snapshot = JSON.stringify(input);
  const output = applyEssentialLanePolicy(input, plan, mode);
  assert(JSON.stringify(input) === snapshot, `${mode}/${record.slug}: applyEssentialLanePolicy mutated its input`);
  assert(output.length === input.length && output[0].stopsEngagement === false, `${mode}/${record.slug}: a ready controller must not stop the engagement`);
  return output[1];
};
const pistis = policyCase('A', lane('pistis', 'blocked', { missingTools: ['Write'], actions: ['Mandatory tools unavailable: Write. Stop before dispatch.'] }));
assert(pistis.status === 'deferred' && pistis.downgradedFrom === 'blocked' && pistis.dispatchAllowed === false && pistis.stopsEngagement === false,
  'A blocked pistis must be downgraded to a never-dispatched deferred lane');
assert(pistis.actions.length === 2 && pistis.actions[0].startsWith('Mandatory tools unavailable')
  && pistis.actions[1] === 'Residual risk: pistis is blocked (Write); it is not dispatched and its surfaces are reported uncovered.',
  `A blocked pistis must keep its evidence and name its residual risk: ${JSON.stringify(pistis.actions)}`);
const theseus = policyCase('C', lane('theseus', 'blocked', { missingCapabilities: ['model:maxTurns'] }));
assert(theseus.status === 'deferred' && theseus.downgradedFrom === 'blocked' && theseus.stopsEngagement === false
  && theseus.actions.at(-1) === 'Residual risk: theseus is blocked (model:maxTurns); it is not dispatched and its surfaces are reported uncovered.',
  'C blocked theseus must be downgraded with its missing model capability named');
const unexplained = policyCase('D', lane('nike', 'blocked'));
assert(unexplained.status === 'deferred' && unexplained.actions.at(-1).includes('(model routing unavailable)'),
  'a blocked lane without missing tools or capabilities must name model routing as its residual cause');
for (const [mode, slug, reason] of [
  ['B', 'tiresias', 'mandatory hunter'],
  ['B', 'orion', 'mandatory hunter'],
  ['B', 'minos', 'essential validator'],
  ['A', 'atlas', 'essential lane'],
  ['A', 'charon', 'mandatory hunter'],
  ['C', 'kleio', 'essential reporter'],
  ['D', 'minos', 'essential validator in every mode'],
  ['D', 'kalchas', 'essential recon in every mode'],
]) {
  const record = policyCase(mode, lane(slug, 'blocked', { missingTools: ['Edit'] }));
  assert(record.status === 'blocked' && record.stopsEngagement === true && record.downgradedFrom === undefined && record.actions.length === 0,
    `${mode} blocked ${slug} (${reason}) must stay blocked and stop the engagement`);
}
const blockedController = applyEssentialLanePolicy([lane('odysseus', 'blocked'), lane('pistis', 'ready')], plan, 'A');
assert(blockedController[0].status === 'blocked' && blockedController[0].stopsEngagement === true && blockedController[1].stopsEngagement === false,
  'a blocked controller must stop the engagement');
for (const status of ['ready', 'degraded', 'deferred', 'skipped', 'conditional', 'not-selected']) {
  const record = policyCase('A', lane('pistis', status));
  assert(record.status === status && record.stopsEngagement === false && record.downgradedFrom === undefined,
    `A ${status} pistis must keep its disposition and never stop the engagement`);
}
// A conditional mandatory hunter is not blocked: it keeps its pending gates and stays
// dispatchable until resolve-gates releases or omits it.
const conditionalOrion = policyCase('B', lane('orion', 'conditional', { pendingGates: ['browser-runtime'], missingCapabilities: ['browser-runtime'] }));
assert(conditionalOrion.status === 'conditional' && conditionalOrion.dispatchAllowed === true && conditionalOrion.stopsEngagement === false
  && JSON.stringify(conditionalOrion.pendingGates) === '["browser-runtime"]' && conditionalOrion.downgradedFrom === undefined,
  'B conditional orion must keep its pending gates without stopping the engagement');
const unselectedBlocked = policyCase('A', { ...lane('pistis', 'blocked'), selected: false });
assert(unselectedBlocked.status === 'blocked' && unselectedBlocked.stopsEngagement === false && unselectedBlocked.downgradedFrom === undefined,
  'an unselected record is outside the engagement and must neither stop it nor be downgraded');
assertThrows(() => applyEssentialLanePolicy([], plan, 'E'), 'unknown Argus mode: E');
assertThrows(() => applyEssentialLanePolicy({}, plan, 'A'), 'preflight agent records must be an array');
const noEssential = structuredClone(plan);
delete noEssential.essentialLanes;
assertThrows(() => applyEssentialLanePolicy([], noEssential, 'A'), 'declares no essential lanes');
const noMandatory = structuredClone(plan);
noMandatory.essentialLanes.includeMandatoryLanes = false;
const unprotectedOrion = applyEssentialLanePolicy([lane('orion', 'blocked')], noMandatory, 'B')[0];
assert(unprotectedOrion.status === 'deferred' && unprotectedOrion.downgradedFrom === 'blocked',
  'includeMandatoryLanes=false must leave only the declared essential lanes protected');

const nullRole = structuredClone(plan);
nullRole.roles[0] = null;
assert(validateOrchestrationPlan(nullRole, matrix, raci).length > 0, 'null role crashed or passed semantic validation');
const nullPhase = structuredClone(plan);
nullPhase.phases[0] = null;
nullPhase.phases[1].participants = 'kalchas';
assert(validateOrchestrationPlan(nullPhase, matrix, raci).length > 0, 'malformed phases crashed or passed semantic validation');

console.log(`PASS  Argus orchestration core: ${controllerWords} words, 27 roles, A/B/C/D=${Object.values(expectedModeCounts).join('/')}, W0-W4 DAG, derived phases, proof loop, ${plan.deepHunt.maxPasses} deep-hunt passes, gate parity, projection, essential lanes A/B/C/D=${Object.values(expectedEssential).map((lanes) => lanes.length).join('/')}, ${fixtures.length} corruptions rejected`);

function assertPhasePlanShape(mode, phasePlan) {
  for (const control of [phasePlan[0], phasePlan.at(-1)]) {
    assert(control.wave === 'controller' && control.kind === 'control' && control.skippable === false
      && sameSet(control.participants, ['odysseus']) && control.standby.length === 0,
      `mode ${mode}: ${control.id} must be a controller-only control phase`);
  }
  for (const phase of phasePlan.slice(1, -1)) {
    const keys = ['id', 'wave', 'kind', ...(['proof', 'deep-hunt'].includes(phase.kind) ? ['pass'] : []), 'skippable', 'participants', 'standby'];
    assert(JSON.stringify(Object.keys(phase)) === JSON.stringify(keys), `mode ${mode}/${phase.id}: phase entry keys drifted`);
    assert(phase.skippable === (['proof', 'deep-hunt'].includes(phase.kind) && phase.pass >= 2),
      `mode ${mode}/${phase.id}: only passes after the first may be skippable`);
    assert(JSON.stringify(phase.participants) === JSON.stringify([...phase.participants].sort())
      && JSON.stringify(phase.standby) === JSON.stringify([...phase.standby].sort()),
      `mode ${mode}/${phase.id}: participants and standby must be sorted`);
    assert(phase.standby.every((slug) => !phase.participants.includes(slug)), `mode ${mode}/${phase.id}: standby overlaps participants`);
    if (phase.kind === 'proof') assert(phase.participants.every((slug) => slug === 'minos'), `mode ${mode}/${phase.id}: proof participants must be Minos`);
  }
}

function applyMutation(document, fixture) {
  if (fixture.operation === 'set-plan-field') {
    document[fixture.field] = fixture.value;
    return;
  }
  if (fixture.operation === 'set-role-field') {
    const role = document.roles.find((candidate) => candidate.slug === fixture.slug);
    assert(role, `${fixture.id}: mutation role not found: ${fixture.slug}`);
    role[fixture.field] = fixture.value;
    return;
  }
  if (fixture.operation === 'set-phase-field') {
    const phase = document.phases.find((candidate) => candidate.id === fixture.phase);
    assert(phase, `${fixture.id}: mutation phase not found: ${fixture.phase}`);
    phase[fixture.field] = fixture.value;
    return;
  }
  if (fixture.operation === 'set-plan-path') {
    assert(Array.isArray(fixture.path) && fixture.path.length > 0, `${fixture.id}: set-plan-path requires a non-empty path`);
    let parent = document;
    for (const key of fixture.path.slice(0, -1)) {
      parent = parent?.[key];
      assert(parent !== null && typeof parent === 'object', `${fixture.id}: mutation path not found: ${fixture.path.join('.')}`);
    }
    parent[fixture.path.at(-1)] = fixture.value;
    return;
  }
  throw new Error(`${fixture.id}: unknown mutation operation ${fixture.operation}`);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function assert(value, message) {
  if (!value) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}

function assertThrows(action, marker) {
  try { action(); }
  catch (error) {
    assert(error.message.includes(marker), `expected error containing ${JSON.stringify(marker)}, got ${error.message}`);
    return;
  }
  assert(false, `expected error containing ${JSON.stringify(marker)}`);
}
