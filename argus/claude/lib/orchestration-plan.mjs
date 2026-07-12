import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileJsonSchema } from './json-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'orchestration-plan.schema.json'), 'utf8'));
const validateSchema = compileJsonSchema(schema);
const MODES = Object.freeze(['A', 'B', 'C', 'D']);
const WAVE_ORDER = Object.freeze(['W0', 'W1', 'W2', 'W3', 'W4']);

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
  if (raci !== undefined) {
    if (!isObject(raci) || !Array.isArray(raci.agents)) errors.push('RACI must contain an agents array');
    else compareSets(planBySlug.keys(), uniqueMap(raci.agents, 'RACI', errors).keys(), 'RACI roster', errors);
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

  validateDependencies(planBySlug, errors);
  return [...new Set(errors)];
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
    omitted: active
      .filter((role) => !selectedSlugs.has(role.slug))
      .map((role) => ({ slug: role.slug, reason: 'not-in-dispatchable-set' })),
  };
}

function validateDependencies(planBySlug, errors) {
  const waveIndex = new Map(WAVE_ORDER.map((wave, index) => [wave, index]));
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

function formatSchemaError(error) {
  return `${error.instancePath || '/'} ${error.message} [${error.keyword}]`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
