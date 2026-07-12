#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  analyzeAssetConsumers,
  findExcludedSourceOverlaps,
} from './sync-argus-runtime-assets.mjs';

const fixture = cleanFixture();
const clean = analyzeAssetConsumers(fixture);
assertClean(clean);
assert.ok(
  clean.assetConsumers
    .find((record) => record.assetId === 'model-policy-benchmark')
    .consumers.some((consumer) => consumer.consumer === 'command:argus-assets model benchmark'),
  'model benchmark must be an explicit semantic consumer',
);
assert.ok(
  clean.assetConsumers
    .find((record) => record.assetId === 'orchestration-plan')
    .consumers.some((consumer) => consumer.consumer === 'command:argus-assets orchestration plan'),
  'orchestration plan must be an explicit semantic consumer',
);
assert.ok(
  clean.assetConsumers
    .find((record) => record.assetId === 'authorization-policies')
    .consumers.some((consumer) => consumer.consumer.includes('schema compatibility')),
  'schema validation must explicitly consume compatibility policy assets',
);

const unknownLiteral = mutate(fixture, (value) => {
  value.cliText += "\nfunction badLiteral() { requireAsset('ghost-asset'); }\n";
});
assert.equal(analyzeAssetConsumers(unknownLiteral).unknownAssetReferences[0].assetId, 'ghost-asset');

const dynamicLookup = mutate(fixture, (value) => {
  value.cliText += '\nfunction badDynamic() { requireAsset(selectedAsset); }\n';
});
assert.ok(
  analyzeAssetConsumers(dynamicLookup).unknownAssetReferences
    .some((record) => record.mechanism === 'dynamic-require-asset'),
);

const multilineLiteral = mutate(fixture, (value) => {
  value.cliText += "\nfunction badMultilineLiteral() { requireAsset(\n  'ghost-multiline'\n); }\n";
});
assert.ok(
  analyzeAssetConsumers(multilineLiteral).unknownAssetReferences
    .some((record) => record.assetId === 'ghost-multiline'),
);

const multilineDynamic = mutate(fixture, (value) => {
  value.cliText += '\nfunction badMultilineDynamic() { requireAsset(\n  selectedAsset\n); }\n';
});
assert.ok(
  analyzeAssetConsumers(multilineDynamic).unknownAssetReferences
    .some((record) => record.mechanism === 'dynamic-require-asset'),
);

const indirectLookup = mutate(fixture, (value) => {
  value.cliText += '\nfunction badAlias() { const lookup = requireAsset; return lookup(selectedAsset); }\n';
});
assert.ok(
  analyzeAssetConsumers(indirectLookup).unknownAssetReferences
    .some((record) => record.mechanism === 'indirect-require-asset-reference'),
);

const unknownProfile = mutate(fixture, (value) => {
  value.capabilityMatrix.agents[0].toolProfiles.push('missing-tool-profile');
});
assert.ok(analyzeAssetConsumers(unknownProfile).unknownProfileReferences.length > 0);

const unreachableProfile = mutate(fixture, (value) => {
  value.capabilityMatrix.doctrineProfiles.extra = { requiredAsset: 'core-skill' };
  value.capabilityMatrix.agents[0].doctrineProfiles.push('extra');
});
assert.ok(
  analyzeAssetConsumers(unreachableProfile).unknownProfileReferences
    .some((record) => record.reason === 'assigned-profile-not-preloaded'),
);

const unknownRequiredAsset = mutate(fixture, (value) => {
  value.capabilityMatrix.doctrineProfiles.core.requiredAsset = 'missing-skill-asset';
});
assert.ok(analyzeAssetConsumers(unknownRequiredAsset).unknownAssetReferences.length > 0);

const unconsumed = mutate(fixture, (value) => {
  value.manifest.assets.push({ id: 'dead-asset', kind: 'reference', destination: 'references/DEAD.md' });
});
assert.deepEqual(analyzeAssetConsumers(unconsumed).unconsumedAssets, ['dead-asset']);

const unownedPluginReference = mutate(fixture, (value) => {
  value.pluginReferences.push({ value: 'references/MISSING.md', consumer: 'agent-one', sourceKind: 'agent' });
});
assert.ok(analyzeAssetConsumers(unownedPluginReference).unownedPluginReferences.length > 0);

const parentAlias = mutate(fixture, (value) => {
  value.manifest.assets.push({ id: 'parent-only', kind: 'reference', destination: 'references/PARENT-ONLY.md' });
  value.pluginReferences.push({ value: 'references', consumer: 'generic-doc', sourceKind: 'skill' });
});
const parentAliasAudit = analyzeAssetConsumers(parentAlias);
assert.ok(parentAliasAudit.unownedPluginReferences.some((record) => record.value === 'references'));
assert.ok(parentAliasAudit.unconsumedAssets.includes('parent-only'));

const unreachableSkill = mutate(fixture, (value) => {
  value.manifest.assets.push({ id: 'hidden-skill', kind: 'skill', destination: 'skills/hidden' });
  value.skills.push({
    name: 'hidden',
    path: 'skills/hidden/SKILL.md',
    text: '---\nname: hidden\nuser-invocable: false\n---\n',
    userInvocable: false,
  });
});
const unreachableSkillAudit = analyzeAssetConsumers(unreachableSkill);
assert.ok(unreachableSkillAudit.unownedSkills.some((record) => record.skill === 'hidden'));

const unknownComposition = mutate(fixture, (value) => {
  value.manifest.templateCompositions.typescript.runtimeAsset = 'missing-template';
});
assert.ok(analyzeAssetConsumers(unknownComposition).unknownAssetReferences.length > 0);

const overlaps = findExcludedSourceOverlaps({
  buildOnly: [{ source: 'argus/runtime/private', reason: 'test' }],
  maintainerOnly: [{ source: 'argus/runtime', reason: 'test' }],
});
assert.equal(overlaps.length, 1, 'nested build-only and maintainer-only sources must be rejected');

console.log('PASS  Argus runtime asset consumer audit: clean graph plus 14 negative mutations');

function cleanFixture() {
  const assets = [
    ['core-skill', 'skill', 'skills/core'],
    ['payload', 'reference', 'references/PAYLOAD.md'],
    ['model-policy-benchmark', 'capabilities', 'capabilities/model-policy.benchmark.json'],
    ['runtime-schemas', 'schemas', 'schemas'],
    ['orchestration-plan', 'capabilities', 'capabilities/orchestration-plan.json'],
    ['capability-matrix', 'capabilities', 'capabilities/capability-matrix.json'],
    ['technique-bundle', 'capabilities', 'capabilities/technique-catalogs.bundle.b64'],
    ['raci-matrix', 'capabilities', 'references/raci.json'],
    ['runtime-library', 'runtime', 'lib'],
    ['authorization-policies', 'policies', 'policies'],
    ['template-policy', 'capabilities', 'capabilities/template-contract.json'],
    ['common-template', 'template', 'templates/common'],
    ['typescript-template', 'template', 'templates/typescript'],
  ].map(([id, kind, destination]) => ({ id, kind, destination }));
  return {
    manifest: {
      assets,
      templateCompositions: {
        typescript: {
          source: 'argus/framework-template',
          commonAsset: 'common-template',
          runtimeAsset: 'typescript-template',
        },
      },
    },
    capabilityMatrix: {
      toolProfiles: { standard: { tools: [] } },
      doctrineProfiles: { core: { requiredAsset: 'core-skill' } },
      techniqueCatalogs: { catalog: { requiredAsset: 'technique-bundle' } },
      orchestration: { requiredAssets: ['payload'] },
      agents: [{
        slug: 'agent-one',
        toolProfiles: ['standard'],
        doctrineProfiles: ['core'],
        techniqueCatalogs: ['catalog'],
      }],
    },
    orchestrationPlan: {
      capabilityMatrix: 'capabilities/capability-matrix.json',
      raci: 'references/raci.json',
    },
    pluginReferences: [{
      value: 'references/PAYLOAD.md',
      consumer: 'agent-one',
      sourceKind: 'agent',
    }],
    commandAssetReferences: [],
    preloadedAssignments: [{ agent: 'agent-one', skill: 'core' }],
    skills: [
      {
        name: 'core',
        path: 'skills/core/SKILL.md',
        text: '---\nname: core\nuser-invocable: false\n---\n',
        userInvocable: false,
      },
      {
        name: 'run',
        path: 'skills/run/SKILL.md',
        text: '---\nname: run\ndisable-model-invocation: true\n---\n',
        userInvocable: true,
      },
    ],
    cliText: `
import { validateCanonicalDocument } from '../lib/contracts.mjs';
const MODEL_BENCHMARK_PATH = true;
const MODEL_BENCHMARK_SCHEMA_PATH = true;
const ORCHESTRATION_PLAN_PATH = true;
const RACI_PATH = true;
const TEMPLATE_CONTRACT_PATH = true;
function modelCommand() { if (operation === 'benchmark') return; }
function orchestrationCommand() { projectOrchestrationPlan(); }
function schemaCommand() { validateCanonicalDocument(); }
function templateCommand() { validateTemplateContract(); }
function copyTemplate() {
  requireAsset(composition.commonAsset);
  requireAsset(composition.runtimeAsset);
}
function printPath(id) { requireAsset(id); }
function usePayload() { requireAsset('payload'); }
function techniqueCommand() { requireAsset('technique-bundle'); }
function requireAsset(id) { return id; }
`,
    runtimeFiles: [{
      path: 'lib/contracts.mjs',
      text: "const policy = 'schema-compatibility.json'; const schema = 'schema-compatibility.schema.json';",
    }],
    hooksDocument: {
      hooks: {
        PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/argus-assets" guard' }] }],
      },
    },
  };
}

function mutate(value, update) {
  const copy = structuredClone(value);
  update(copy);
  return copy;
}

function assertClean(audit) {
  for (const field of [
    'unconsumedAssets',
    'unknownAssetReferences',
    'unknownProfileReferences',
    'unownedPluginReferences',
    'unownedRuntimeReferences',
    'unownedSkills',
  ]) {
    assert.deepEqual(audit[field], [], `clean fixture produced ${field}`);
  }
}
