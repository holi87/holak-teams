#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectOrchestrationPlan, validateOrchestrationPlan } from '../argus/runtime/orchestration-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = readJson('argus/orchestration-plan.json');
const matrix = readJson('argus/capabilities/capability-matrix.json');
const raci = readJson('argus/raci.json');
const fixtures = readJson('scripts/fixtures/argus-orchestration/invalid-mutations.json');
const controllerSkill = readFileSync(join(ROOT, 'argus/shared-skills/orchestration-core/SKILL.md'), 'utf8');
const controllerContract = controllerSkill.replace(/\s+/gu, ' ');
const expectedWaves = {
  W0: ['kalchas', 'metis', 'atlas'],
  W1: ['penelope', 'theseus', 'pistis', 'tiresias'],
  W2: [
    'aegis', 'antigone', 'ariadne', 'asklepios', 'atalanta', 'charon', 'daidalos',
    'hermes', 'lynceus', 'minos', 'mnemosyne', 'nike', 'orion', 'perseus', 'proteus',
    'talos', 'tyche',
  ],
  W3: ['aristarchus'],
  W4: ['kleio'],
};

const canonicalErrors = validateOrchestrationPlan(plan, matrix, raci);
assert(canonicalErrors.length === 0, `canonical plan failed: ${canonicalErrors.join('; ')}`);
const controllerWords = controllerSkill.trim().split(/\s+/u).length;
assert(controllerWords >= 800 && controllerWords <= 1200, `orchestration-core must stay within 800-1200 words, found ${controllerWords}`);
for (const fragment of [
  'qa-core', 'qa-browser', 'qa-framework-runner', 'qa-coverage-reporting',
  'A — Full QA Audit', 'B — Deep Bug Hunt', 'C — Greenfield suite', 'D — Brownfield extension',
  'ARGUS_PREFLIGHT_ERROR: TARGET_REQUIRED', 'ARGUS_PREFLIGHT_ERROR: AGENT_TOOL_UNAVAILABLE',
  'ARGUS_PREFLIGHT_ERROR: ARGUS_AGENTS_UNAVAILABLE', 'ARGUS_PREFLIGHT_ERROR: CAPABILITY_PREFLIGHT_BLOCKED',
  'argus-assets preflight --target <target> --mode <A|B|C|D> --artifact-root <artifact-root>', 'ai_agents_internal/orchestration-plan.json', 'ai_agents_internal/preflight.json',
  '`ready`/`degraded`', '`deferred`, `skipped`, or `blocked`', 'untrusted evidence',
  'argus-assets authorization check', 'argus-assets redact', 'success`, `failure`, or `interrupted',
  'selected-dispatchable-predecessors', 'argus-assets raci route', 'argus-assets template detect',
  'template select', 'template scaffold', '`baseline`, `defect-evidence`, `candidate-regression`, and',
  'argus-assets model route', 'argus/model-escalation-request@1', 'argus-assets model telemetry',
  'product, automation,', 'infrastructure, skip, and policy outcomes', 'Never claim an agent ran',
]) {
  assert(controllerContract.includes(fragment), `orchestration-core lost required controller semantic: ${fragment}`);
}
assert(!controllerSkill.includes('qa-doctrine'), 'orchestration-core references legacy qa-doctrine instead of modular skills');
assert(plan.roles.length === 27, `expected 27 roles, found ${plan.roles.length}`);
assert(plan.roles.find((role) => role.slug === 'odysseus')?.dispatch === false, 'Odysseus is not a non-dispatched controller');
for (const [wave, expected] of Object.entries(expectedWaves)) {
  const actual = plan.roles.filter((role) => role.wave === wave).map((role) => role.slug);
  assert(sameSet(actual, expected), `${wave} membership drifted`);
}

for (const [mode, expectedCount] of Object.entries({ A: 27, B: 16, C: 14, D: 14 })) {
  const activeCount = plan.roles.filter((role) => role.modes.includes(mode)).length;
  assert(activeCount === expectedCount, `mode ${mode} count drifted: ${activeCount}`);
  const projected = projectOrchestrationPlan(plan, matrix, mode, undefined, raci);
  const dispatched = projected.waves.flatMap((wave) => wave.roles);
  assert(dispatched.length === expectedCount - 1, `mode ${mode} projection must exclude only the controller`);
  const dispatchedSlugs = new Set(dispatched.map((role) => role.slug));
  for (const role of dispatched) {
    assert(role.dependsOn.every((dependency) => dispatchedSlugs.has(dependency)), `${mode}/${role.slug}: inactive dependency survived projection`);
    assert(role.task && role.lane && Array.isArray(role.responsibilities), `${mode}/${role.slug}: task contract missing from projection`);
    assert(Array.isArray(role.accountableArtifacts) && Array.isArray(role.artifactPaths), `${mode}/${role.slug}: output contract missing from projection`);
  }
  assert(projected.omitted.length === 0, `mode ${mode}: complete projection unexpectedly omitted roles`);
}

const gatedA = projectOrchestrationPlan(plan, matrix, 'A', ['kalchas', 'metis', 'atlas', 'theseus', 'talos', 'aristarchus', 'kleio'], raci);
const gatedRoles = gatedA.waves.flatMap((wave) => wave.roles);
const aristarchus = gatedRoles.find((role) => role.slug === 'aristarchus');
assert(sameSet(aristarchus.dependsOn, ['atlas', 'talos']), 'projection did not remove non-dispatchable predecessors');
const kleio = gatedRoles.find((role) => role.slug === 'kleio');
assert(sameSet(kleio.dependsOn, ['aristarchus']), 'projection did not remove gated Minos predecessor');
assert(gatedA.omitted.length === 19, `gated projection must report 19 omitted roles, found ${gatedA.omitted.length}`);
assert(gatedA.omitted.every((role) => role.reason === 'not-in-dispatchable-set'), 'gated projection omitted a disposition reason');
assertThrows(() => projectOrchestrationPlan(plan, matrix, 'A', ['unknown-role'], raci), 'unknown dispatchable role');
assertThrows(() => projectOrchestrationPlan(plan, matrix, 'B', ['atlas'], raci), 'not dispatchable in Mode B');

for (const fixture of fixtures) {
  const mutated = structuredClone(plan);
  applyMutation(mutated, fixture);
  const errors = validateOrchestrationPlan(mutated, matrix, raci);
  assert(errors.length > 0, `${fixture.id}: invalid plan unexpectedly passed`);
  assert(errors.some((error) => error.includes(fixture.expects)), `${fixture.id}: expected '${fixture.expects}', got: ${errors.join('; ')}`);
}

const nullRole = structuredClone(plan);
nullRole.roles[0] = null;
assert(validateOrchestrationPlan(nullRole, matrix, raci).length > 0, 'null role crashed or passed semantic validation');

console.log(`PASS  Argus orchestration core: ${controllerWords} words, 27 roles, A/B/C/D=27/16/14/14, W0-W4 DAG, gate parity, projection, ${fixtures.length} corruptions rejected`);

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
