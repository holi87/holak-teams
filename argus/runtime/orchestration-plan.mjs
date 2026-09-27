import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileJsonSchema } from './json-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'orchestration-plan.schema.json'), 'utf8'));
const validateSchema = compileJsonSchema(schema);
const MODES = Object.freeze(['A', 'B', 'C', 'D']);
const WAVE_ORDER = Object.freeze(['W0', 'W1', 'W2', 'W3', 'W4']);
const PASS_KINDS = Object.freeze(['proof', 'deep-hunt']);
const CONTROL_PHASES = Object.freeze(['preflight', 'complete']);
const CONTROLLER = 'odysseus';
const DEFAULT_VALIDATOR = 'minos';
// Lanes whose output reaches the ledger only through Minos: their candidates can bounce, so
// they must stay reachable (standby) while the first proof phase runs.
const PROOF_CANDIDATE_PERSISTENCE = Object.freeze(['candidate-file', 'fragment-only']);
const ROUTED_STATUSES = Object.freeze(['bounced', 'needs-oracle', 'quarantined', 'suspected', 'confirmed']);
// Kalchas recon feeds every lane and Minos's ledger merge gates every proof phase, so no mode
// may treat either as optional.
const ALWAYS_ESSENTIAL = Object.freeze(['kalchas', 'minos']);

export function validateOrchestrationPlan(plan, capabilityMatrix, raci) {
  const errors = validateSchema(plan).map(formatSchemaError);
  if (!isObject(plan) || !Array.isArray(plan.roles) || !isObject(capabilityMatrix) || !Array.isArray(capabilityMatrix.agents)) {
    return errors;
  }

  const matrixBySlug = uniqueMap(capabilityMatrix.agents, 'capability matrix', errors);
  const planBySlug = uniqueMap(plan.roles, 'orchestration plan', errors);
  const roles = [...planBySlug.values()];
  const knownGates = new Set(Object.keys(capabilityMatrix.capabilities ?? {}));
  compareSets(planBySlug.keys(), matrixBySlug.keys(), 'role roster', errors);
  let proofCandidates = null;
  if (raci !== undefined) {
    if (!isObject(raci) || !Array.isArray(raci.agents)) errors.push('RACI must contain an agents array');
    else {
      const raciBySlug = uniqueMap(raci.agents, 'RACI', errors);
      compareSets(planBySlug.keys(), raciBySlug.keys(), 'RACI roster', errors);
      proofCandidates = [...raciBySlug.values()]
        .filter((agent) => PROOF_CANDIDATE_PERSISTENCE.includes(agent.persistence))
        .map((agent) => agent.slug)
        .sort();
    }
  }

  for (const [slug, role] of planBySlug) {
    const contract = matrixBySlug.get(slug);
    if (!contract) continue;
    if (!sameList(role.modes, contract.modes)) errors.push(`${slug}: modes differ from capability matrix`);
    if (!sameList(role.gates, contract.requiredCapabilities ?? [])) errors.push(`${slug}: gates differ from capability matrix requiredCapabilities`);
    for (const gate of Array.isArray(role.gates) ? role.gates : []) {
      if (!knownGates.has(gate)) errors.push(`${slug}: unknown capability gate ${gate}`);
    }
  }

  const controller = planBySlug.get('odysseus');
  if (!controller || controller.kind !== 'controller' || controller.dispatch !== false || controller.wave !== 'controller') {
    errors.push('odysseus: must be the non-dispatched controller');
  }
  for (const [slug, role] of planBySlug) {
    if (slug === 'odysseus') continue;
    if (role.kind !== 'specialist' || role.dispatch !== true || !WAVE_ORDER.includes(role.wave)) {
      errors.push(`${slug}: must be a dispatched specialist assigned to W0-W4`);
    }
  }

  const declaredWaves = Array.isArray(plan.waves) ? plan.waves : [];
  if (!sameList(declaredWaves.map((wave) => wave?.id), WAVE_ORDER, true)) errors.push('waves: must declare W0-W4 exactly once in order');
  for (const wave of declaredWaves) {
    if (wave?.barrierAfter !== true) errors.push(`${wave?.id ?? 'unknown wave'}: barrierAfter must be true`);
  }

  const computedCounts = Object.fromEntries(MODES.map((mode) => [
    mode,
    roles.filter((role) => Array.isArray(role.modes) && role.modes.includes(mode)).length,
  ]));
  for (const mode of MODES) {
    if (plan.modeCounts?.[mode] !== computedCounts[mode]) {
      errors.push(`modeCounts.${mode}: declared ${String(plan.modeCounts?.[mode])}, computed ${computedCounts[mode]}`);
    }
  }

  const deepHunt = plan.deepHunt;
  if (deepHunt !== undefined) {
    if (!isObject(deepHunt)) errors.push('deepHunt: must be an object');
    else {
      for (const mode of Array.isArray(deepHunt.modes) ? deepHunt.modes : []) {
        if (!MODES.includes(mode)) errors.push(`deepHunt.modes: unknown mode ${String(mode)}`);
      }
      for (const slug of Array.isArray(deepHunt.roles) ? deepHunt.roles : []) {
        const role = planBySlug.get(slug);
        if (!role) errors.push(`deepHunt.roles: unknown role ${String(slug)}`);
        else if (!role.dispatch) errors.push(`deepHunt.roles: ${slug} is not dispatched`);
        else {
          for (const mode of Array.isArray(deepHunt.modes) ? deepHunt.modes : []) {
            if (!stringList(role.modes).includes(mode)) errors.push(`deepHunt.roles: ${slug} is inactive in Mode ${mode}`);
          }
        }
      }
    }
  }

  // A lane that is silently dropped costs more than a lane that fails loudly. Three of the
  // four hunters listed here produced nothing at all on one past engagement while the plan
  // stayed formally valid, so membership is checked rather than assumed.
  const mandatory = plan.mandatoryLanes;
  if (mandatory !== undefined) {
    if (!isObject(mandatory)) errors.push('mandatoryLanes: must be an object');
    else {
      if (mandatory.policy !== 'gates-satisfied-means-dispatched') {
        errors.push('mandatoryLanes.policy: must be gates-satisfied-means-dispatched');
      }
      if (!Array.isArray(mandatory.rule) || mandatory.rule.length < 3) {
        errors.push('mandatoryLanes.rule: must state the dispatch, omission and additive-brief rules');
      }
      for (const mode of Array.isArray(mandatory.modes) ? mandatory.modes : []) {
        if (!MODES.includes(mode)) errors.push(`mandatoryLanes.modes: unknown mode ${String(mode)}`);
      }
      const listed = Array.isArray(mandatory.roles) ? mandatory.roles : [];
      if (listed.length === 0) errors.push('mandatoryLanes.roles: must not be empty');
      for (const slug of listed) {
        const role = planBySlug.get(slug);
        if (!role) errors.push(`mandatoryLanes.roles: unknown role ${String(slug)}`);
        else if (!role.dispatch) errors.push(`mandatoryLanes.roles: ${slug} is not dispatched`);
        else {
          for (const mode of Array.isArray(mandatory.modes) ? mandatory.modes : []) {
            if (!role.modes.includes(mode)) errors.push(`mandatoryLanes.roles: ${slug} is inactive in Mode ${mode}`);
          }
        }
      }
      for (const slug of Array.isArray(deepHunt?.roles) ? deepHunt.roles : []) {
        if (!listed.includes(slug)) errors.push(`mandatoryLanes.roles: deep-hunt role ${slug} must also be mandatory`);
      }
    }
  }

  // A blocked essential lane stops the engagement, while any other blocked lane is only
  // downgraded. A stale or inactive slug would silently shrink that set, so each is checked.
  const essential = plan.essentialLanes;
  if (essential !== undefined) {
    if (!isObject(essential)) errors.push('essentialLanes: must be an object');
    else {
      const byMode = isObject(essential.modes) ? essential.modes : {};
      for (const mode of MODES) {
        const listed = stringList(byMode[mode]);
        for (const slug of listed) {
          const role = planBySlug.get(slug);
          if (!role) errors.push(`essentialLanes.modes.${mode}: unknown role ${slug}`);
          else if (role.dispatch !== true) errors.push(`essentialLanes.modes.${mode}: ${slug} is not dispatched`);
          else if (!stringList(role.modes).includes(mode)) errors.push(`essentialLanes.modes.${mode}: ${slug} is inactive in Mode ${mode}`);
        }
        for (const slug of ALWAYS_ESSENTIAL) {
          if (!listed.includes(slug)) errors.push(`essentialLanes.modes.${mode}: must list ${slug}`);
        }
      }
    }
  }

  const phases = phaseList(plan);
  validatePhases(plan, phases, planBySlug, proofCandidates, errors);
  validateProofLoop(plan.proofLoop, planBySlug, proofCandidates, errors);
  validateDependencies(planBySlug, phases, errors);
  return [...new Set(errors)];
}

// Derives the ordered engagement phases for one mode: the controller-owned preflight and
// complete bracket every plan phase active in that mode. Participants and standby lanes are
// narrowed to the selected roles, so the result is exactly the manifest phasePlan.
export function derivePhasePlan(plan, capabilityMatrix, mode, selectedAgents, raci) {
  const errors = validateOrchestrationPlan(plan, capabilityMatrix, raci);
  if (errors.length > 0) throw new Error(`invalid orchestration plan: ${errors.join('; ')}`);
  if (!MODES.includes(mode)) throw new Error(`unknown Argus mode: ${mode}`);
  if (selectedAgents !== undefined && !Array.isArray(selectedAgents)) throw new Error('selected agents must be an array of role slugs');

  const planBySlug = new Map(plan.roles.map((role) => [role.slug, role]));
  const selected = new Set(selectedAgents ?? plan.roles.filter((role) => role.modes.includes(mode)).map((role) => role.slug));
  for (const slug of selected) {
    const role = planBySlug.get(slug);
    if (!role) throw new Error(`unknown selected role: ${slug}`);
    if (!role.modes.includes(mode)) throw new Error(`role is not active in Mode ${mode}: ${slug}`);
  }
  return buildPhasePlan(plan, mode, selected);
}

export function projectOrchestrationPlan(plan, capabilityMatrix, mode, dispatchableSlugs, raci) {
  const errors = validateOrchestrationPlan(plan, capabilityMatrix, raci);
  if (errors.length > 0) throw new Error(`invalid orchestration plan: ${errors.join('; ')}`);
  if (!MODES.includes(mode)) throw new Error(`unknown Argus mode: ${mode}`);

  const allowed = dispatchableSlugs === undefined ? null : new Set(dispatchableSlugs);
  const planBySlug = new Map(plan.roles.map((role) => [role.slug, role]));
  if (allowed !== null) {
    for (const slug of allowed) {
      const role = planBySlug.get(slug);
      if (!role) throw new Error(`unknown dispatchable role: ${slug}`);
      if (!role.dispatch || !role.modes.includes(mode)) throw new Error(`role is not dispatchable in Mode ${mode}: ${slug}`);
    }
  }
  const active = plan.roles.filter((role) => role.dispatch && role.modes.includes(mode));
  const selected = active.filter((role) => allowed === null || allowed.has(role.slug));
  const selectedSlugs = new Set(selected.map((role) => role.slug));
  const capabilityBySlug = new Map(capabilityMatrix.agents.map((agent) => [agent.slug, agent]));
  const raciBySlug = new Map(raci.agents.map((agent) => [agent.slug, agent]));
  return {
    mode,
    controller: 'odysseus',
    dependencyPolicy: plan.dependencyPolicy,
    waves: WAVE_ORDER.map((wave) => ({
      id: wave,
      roles: selected
        .filter((role) => role.wave === wave)
        .map((role) => ({
          slug: role.slug,
          lane: raciBySlug.get(role.slug).lane,
          task: raciBySlug.get(role.slug).description,
          responsibilities: [...raciBySlug.get(role.slug).responsible],
          persistence: raciBySlug.get(role.slug).persistence,
          accountableArtifacts: [...raciBySlug.get(role.slug).accountableArtifacts],
          artifactPaths: [...capabilityBySlug.get(role.slug).artifactPaths],
          gates: [...role.gates],
          dependsOn: role.dependsOn.filter((slug) => selectedSlugs.has(slug)),
          omittedDependencies: role.dependsOn.filter((slug) => !selectedSlugs.has(slug)),
        })),
    })),
    phases: buildPhasePlan(plan, mode, new Set([...selectedSlugs, CONTROLLER])),
    deepHunt: projectDeepHunt(plan.deepHunt, mode, selectedSlugs),
    proofLoop: projectProofLoop(plan.proofLoop, selectedSlugs),
    huntingBrief: [...plan.huntingBrief],
    essentialLanes: essentialLaneSet(plan, mode),
    omitted: active
      .filter((role) => !selectedSlugs.has(role.slug))
      .map((role) => ({ slug: role.slug, reason: 'not-in-dispatchable-set' })),
  };
}

// Applies the essential-lane policy to evaluated preflight records without mutating them. A
// blocked controller, essential lane, or mandatory lane of the mode stops the engagement; any
// other blocked lane becomes a never-dispatched deferred record that names its residual risk.
export function applyEssentialLanePolicy(agents, plan, mode) {
  if (!Array.isArray(agents)) throw new Error('preflight agent records must be an array');
  if (!MODES.includes(mode)) throw new Error(`unknown Argus mode: ${mode}`);
  if (!isObject(plan) || !isObject(plan.essentialLanes) || !isObject(plan.essentialLanes.modes) || !Array.isArray(plan.essentialLanes.modes[mode])) {
    throw new Error(`orchestration plan declares no essential lanes for Mode ${mode}`);
  }
  const essential = new Set(essentialLaneSet(plan, mode));
  return agents.map((agent) => {
    if (!isObject(agent)) throw new Error('preflight agent record must be an object');
    if (agent.selected !== true || agent.status !== 'blocked') return { ...agent, stopsEngagement: false };
    if (agent.slug === CONTROLLER || essential.has(agent.slug)) return { ...agent, stopsEngagement: true };
    const missing = [...stringList(agent.missingTools), ...stringList(agent.missingCapabilities)];
    const cause = missing.length > 0 ? missing.join(', ') : 'model routing unavailable';
    return {
      ...agent,
      status: 'deferred',
      downgradedFrom: 'blocked',
      dispatchAllowed: false,
      stopsEngagement: false,
      actions: [
        ...stringList(agent.actions),
        `Residual risk: ${agent.slug} is blocked (${cause}); it is not dispatched and its surfaces are reported uncovered.`,
      ],
    };
  });
}

// The essential set for one mode: the declared lanes plus, when the plan opts in, every
// mandatory lane active in a mode where the mandatory-lane policy applies.
function essentialLaneSet(plan, mode) {
  const lanes = new Set(stringList(plan.essentialLanes.modes[mode]));
  const mandatory = isObject(plan.mandatoryLanes) ? plan.mandatoryLanes : {};
  if (plan.essentialLanes.includeMandatoryLanes === true && stringList(mandatory.modes).includes(mode)) {
    const roles = Array.isArray(plan.roles) ? plan.roles.filter(isObject) : [];
    const active = new Set(roles.filter((role) => stringList(role.modes).includes(mode)).map((role) => role.slug));
    for (const slug of stringList(mandatory.roles)) {
      if (active.has(slug)) lanes.add(slug);
    }
  }
  return [...lanes].sort();
}

function buildPhasePlan(plan, mode, selected) {
  const control = (id) => ({
    id,
    wave: 'controller',
    kind: 'control',
    skippable: false,
    participants: selected.has(CONTROLLER) ? [CONTROLLER] : [],
    standby: [],
  });
  const phases = plan.phases
    .filter((phase) => phase.modes.includes(mode))
    .map((phase) => {
      const participants = phase.participants.filter((slug) => selected.has(slug)).sort();
      const standby = phase.standby.filter((slug) => selected.has(slug) && !participants.includes(slug)).sort();
      return {
        id: phase.id,
        wave: phase.wave,
        kind: phase.kind,
        ...(PASS_KINDS.includes(phase.kind) ? { pass: phase.pass } : {}),
        skippable: phase.skippable,
        participants,
        standby,
      };
    });
  return [control('preflight'), ...phases, control('complete')];
}

function projectDeepHunt(deepHunt, mode, selectedSlugs) {
  if (!deepHunt.modes.includes(mode)) return null;
  return {
    tier: deepHunt.tier,
    maxPasses: deepHunt.maxPasses,
    continueWhen: deepHunt.continueWhen,
    brief: [...deepHunt.brief],
    roles: deepHunt.roles.filter((slug) => selectedSlugs.has(slug)),
    omitted: deepHunt.roles
      .filter((slug) => !selectedSlugs.has(slug))
      .map((slug) => ({ slug, reason: 'not-in-dispatchable-set' })),
  };
}

function projectProofLoop(proofLoop, selectedSlugs) {
  const validatorSelected = selectedSlugs.has(proofLoop.validator);
  // Clusters partition the validator's passes. Without a selected validator no pass runs,
  // so no cluster is projected even when some of its lanes are selected.
  const clusters = validatorSelected
    ? proofLoop.validatorPasses.clusters
      .map((cluster) => ({ id: cluster.id, lanes: cluster.lanes.filter((slug) => selectedSlugs.has(slug)) }))
      .filter((cluster) => cluster.lanes.length > 0)
    : [];
  return {
    validator: proofLoop.validator,
    validatorSelected,
    oracleDesk: proofLoop.oracleDesk,
    oracleDeskSelected: selectedSlugs.has(proofLoop.oracleDesk),
    maxRepairRounds: proofLoop.maxRepairRounds,
    clusters,
    routes: proofLoop.routes.map((route) => ({ ...route })),
    independentReproduction: { ...proofLoop.independentReproduction },
    acceptedOracleKinds: [...proofLoop.acceptedOracleKinds],
    justifiedInvariantClasses: [...proofLoop.justifiedInvariantClasses],
    exhaustion: proofLoop.exhaustion,
  };
}

// Phases are the execution order; role waves and dependencies must agree with it. Every
// check tolerates malformed input because schema errors are reported alongside these.
function validatePhases(plan, phases, planBySlug, proofCandidates, errors) {
  const deepHunt = isObject(plan.deepHunt) ? plan.deepHunt : {};
  const deepHuntRoles = stringList(deepHunt.roles);
  const proofLoop = isObject(plan.proofLoop) ? plan.proofLoop : {};
  const validator = typeof proofLoop.validator === 'string' ? proofLoop.validator : DEFAULT_VALIDATOR;

  const ids = phases.map((phase) => phase.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => CONTROL_PHASES.includes(id))) {
    errors.push('phases: ids must be unique and must not be preflight or complete');
  }

  let highestWave = -1;
  for (const phase of phases) {
    const id = String(phase.id);
    const waveIndex = WAVE_ORDER.indexOf(phase.wave);
    if (waveIndex !== -1 && waveIndex < highestWave) errors.push(`${id}: phase order regresses wave ${phase.wave}`);
    highestWave = Math.max(highestWave, waveIndex);

    const phaseModes = stringList(phase.modes);
    const participants = stringList(phase.participants);
    const standby = stringList(phase.standby);
    for (const slug of new Set([...participants, ...standby])) {
      const role = planBySlug.get(slug);
      if (!role) errors.push(`${id}: unknown role ${slug}`);
      else if (role.dispatch !== true) errors.push(`${id}: ${slug} is not dispatched`);
      else if (!stringList(role.modes).some((mode) => phaseModes.includes(mode))) errors.push(`${id}: ${slug} is inactive in every phase mode`);
    }
    for (const slug of participants) {
      if (standby.includes(slug)) errors.push(`${id}: ${slug} is both participant and standby`);
    }

    validatePhaseIdentity(phase, id, errors);
    const isPass = PASS_KINDS.includes(phase.kind) && Number.isInteger(phase.pass);
    if (isPass && phase.pass <= 1 && phase.skippable === true) errors.push(`${id}: the first pass must not be skippable`);
    else if (isPass && phase.pass >= 2 && phase.skippable !== true) errors.push(`${id}: passes after the first must be skippable`);
    else if (!isPass && phase.skippable === true) errors.push(`${id}: only deep-hunt and proof passes after the first may be skippable`);

    if (phase.kind === 'deep-hunt' && !sameList(participants, deepHuntRoles)) {
      errors.push(`${id}: participants differ from deepHunt.roles`);
    }
    if (phase.kind === 'proof') {
      if (participants.length !== 1 || participants[0] !== validator) {
        errors.push(`${id}: proof phase must have exactly the validator ${validator} as participant`);
      }
      const required = typeof proofLoop.oracleDesk === 'string' ? [proofLoop.oracleDesk] : [];
      if (phase.pass === 0 && proofCandidates !== null) required.push(...proofCandidates);
      if (Number.isInteger(phase.pass) && phase.pass >= 1) required.push(...deepHuntRoles);
      for (const slug of new Set(required)) {
        if (!standby.includes(slug) && !participants.includes(slug)) errors.push(`${id}: standby must include ${slug}`);
      }
    }
  }

  const maxPasses = Number.isInteger(deepHunt.maxPasses) ? deepHunt.maxPasses : 0;
  const deepModes = stringList(deepHunt.modes);
  const automation = phases.find((phase) => phase.id === 'automation');
  for (const mode of MODES) {
    const expected = ['discovery', 'hunting', 'proof'];
    if (deepModes.includes(mode)) {
      for (let pass = 1; pass <= maxPasses; pass += 1) expected.push(`deep-hunt-${pass}`, `deep-proof-${pass}`);
    }
    if (automation && stringList(automation.participants).some((slug) => stringList(planBySlug.get(slug)?.modes).includes(mode))) {
      expected.push('automation');
    }
    expected.push('verification', 'reporting');
    const actual = phases.filter((phase) => stringList(phase.modes).includes(mode)).map((phase) => String(phase.id));
    if (!sameList(actual, expected, true)) errors.push(`Mode ${mode}: phase sequence is invalid: ${actual.join('->')}`);
  }

  const firstPhase = firstPhaseIndexes(phases);
  for (const [slug, role] of planBySlug) {
    if (role.dispatch !== true) continue;
    for (const mode of stringList(role.modes)) {
      const participates = phases.some((phase) => stringList(phase.modes).includes(mode) && stringList(phase.participants).includes(slug));
      if (!participates) errors.push(`${slug}: participates in no phase in Mode ${mode}`);
    }
    const first = phases[firstPhase.get(slug)];
    if (first && WAVE_ORDER.includes(first.wave) && role.wave !== first.wave) {
      errors.push(`${slug}: wave ${String(role.wave)} differs from its first phase ${first.id} (${first.wave})`);
    }
  }
}

// Phase ids name their kind and pass, so a phase cannot keep a familiar id while changing
// what the runtime does with it.
function validatePhaseIdentity(phase, id, errors) {
  const deep = /^deep-(hunt|proof)-([1-9][0-9]*)$/u.exec(id);
  let kind = 'work';
  let pass;
  if (id === 'proof') [kind, pass] = ['proof', 0];
  else if (deep) [kind, pass] = [deep[1] === 'hunt' ? 'deep-hunt' : 'proof', Number(deep[2])];
  if (phase.kind !== kind) errors.push(`${id}: kind must be ${kind}`);
  if (pass !== undefined && phase.pass !== pass) errors.push(`${id}: pass must be ${pass}`);
  if (!PASS_KINDS.includes(phase.kind) && phase.pass !== undefined) errors.push(`${id}: pass is only allowed on proof and deep-hunt phases`);
}

function validateProofLoop(proofLoop, planBySlug, proofCandidates, errors) {
  if (!isObject(proofLoop)) return;
  for (const field of ['validator', 'oracleDesk']) {
    const role = planBySlug.get(proofLoop[field]);
    if (!role || role.dispatch !== true) errors.push(`proofLoop.${field}: ${String(proofLoop[field])} is not a dispatched role`);
  }

  const clusters = Array.isArray(proofLoop.validatorPasses?.clusters) ? proofLoop.validatorPasses.clusters.filter(isObject) : [];
  const clusterIds = new Set();
  const listed = new Map();
  for (const cluster of clusters) {
    if (clusterIds.has(cluster.id)) errors.push(`proofLoop clusters repeat id ${String(cluster.id)}`);
    clusterIds.add(cluster.id);
    for (const slug of stringList(cluster.lanes)) {
      if (!planBySlug.has(slug)) errors.push(`proofLoop clusters name unknown role ${slug}`);
      listed.set(slug, (listed.get(slug) ?? 0) + 1);
    }
  }
  for (const [slug, count] of listed) {
    if (count > 1) errors.push(`proofLoop clusters list ${slug} more than once`);
  }
  for (const slug of proofCandidates ?? []) {
    if (!listed.has(slug)) errors.push(`proofLoop clusters must cover ${slug}`);
  }

  const routes = Array.isArray(proofLoop.routes) ? proofLoop.routes.filter(isObject) : [];
  for (const status of ROUTED_STATUSES) {
    if (routes.filter((route) => route.status === status).length !== 1) errors.push(`proofLoop routes: ${status} must be routed exactly once`);
  }
  if (stringList(proofLoop.justifiedInvariantClasses).length > 0 && !stringList(proofLoop.acceptedOracleKinds).includes('justified-invariant')) {
    errors.push('proofLoop.justifiedInvariantClasses: requires the justified-invariant oracle kind');
  }
}

function validateDependencies(planBySlug, phases, errors) {
  const waveIndex = new Map(WAVE_ORDER.map((wave, index) => [wave, index]));
  const firstPhase = firstPhaseIndexes(phases);
  const edges = new Map();
  for (const [slug, role] of planBySlug) {
    const dependencies = Array.isArray(role.dependsOn) ? role.dependsOn : [];
    edges.set(slug, dependencies);
    for (const dependency of dependencies) {
      const predecessor = planBySlug.get(dependency);
      if (!predecessor) {
        errors.push(`${slug}: unknown dependency ${dependency}`);
        continue;
      }
      if (dependency === slug) errors.push(`${slug}: self dependency is forbidden`);
      if (predecessor.dispatch !== true) errors.push(`${slug}: dependency ${dependency} is not dispatchable`);
      const roleWave = waveIndex.get(role.wave);
      const predecessorWave = waveIndex.get(predecessor.wave);
      if (roleWave !== undefined && predecessorWave !== undefined && predecessorWave > roleWave) {
        errors.push(`${slug}: dependency ${dependency} is assigned to a future wave`);
      }
      const rolePhase = firstPhase.get(slug);
      const predecessorPhase = firstPhase.get(dependency);
      if (rolePhase !== undefined && predecessorPhase !== undefined && predecessorPhase > rolePhase) {
        errors.push(`${slug}: dependency ${dependency} starts in a later phase`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  for (const slug of planBySlug.keys()) visit(slug);

  function visit(slug) {
    if (visited.has(slug)) return;
    if (visiting.has(slug)) {
      const start = stack.indexOf(slug);
      errors.push(`dependency cycle: ${[...stack.slice(start), slug].join(' -> ')}`);
      return;
    }
    visiting.add(slug);
    stack.push(slug);
    for (const dependency of edges.get(slug) ?? []) {
      if (planBySlug.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(slug);
    visited.add(slug);
  }
}

function uniqueMap(records, label, errors) {
  const result = new Map();
  for (const record of records) {
    if (!isObject(record) || typeof record.slug !== 'string') continue;
    if (result.has(record.slug)) errors.push(`${label}: duplicate role slug ${record.slug}`);
    else result.set(record.slug, record);
  }
  return result;
}

function compareSets(actualValues, expectedValues, label, errors) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  for (const value of expected) if (!actual.has(value)) errors.push(`${label}: missing ${value}`);
  for (const value of actual) if (!expected.has(value)) errors.push(`${label}: unknown ${value}`);
}

function sameList(left, right, ordered = false) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  if (ordered) return left.every((value, index) => value === right[index]);
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function phaseList(plan) {
  return Array.isArray(plan.phases) ? plan.phases.filter(isObject) : [];
}

function firstPhaseIndexes(phases) {
  const result = new Map();
  phases.forEach((phase, index) => {
    for (const slug of stringList(phase.participants)) {
      if (!result.has(slug)) result.set(slug, index);
    }
  });
  return result;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function formatSchemaError(error) {
  return `${error.instancePath || '/'} ${error.message} [${error.keyword}]`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
