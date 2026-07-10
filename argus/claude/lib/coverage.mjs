const SURFACE_TYPES = new Set(['ui', 'api', 'event', 'data']);
const ACCESS = new Set(['testable', 'inaccessible', 'untestable']);
const RISK = new Set(['critical', 'high', 'medium', 'low']);
const ID = /^SRF-[A-Z0-9][A-Z0-9-]*$/;
const EVIDENCE = /^EVD-[0-9]{4}$/;

export function validateSurfaceInventory(document) {
  const errors = base(document, 'surface-inventory');
  if (!document || typeof document !== 'object') return errors;
  if (!Number.isInteger(document.discovery?.candidates) || document.discovery.candidates < 1) errors.push('discovery.candidates must be a positive integer');
  if (!Number.isInteger(document.discovery?.characterized) || document.discovery.characterized < 0 || document.discovery.characterized > document.discovery.candidates) errors.push('discovery.characterized must be between zero and discovery.candidates');
  if (!Array.isArray(document.items) || document.items.length === 0) errors.push('items must be a non-empty array');
  const ids = new Set();
  for (const item of document.items ?? []) {
    if (!ID.test(item.id ?? '')) errors.push(`invalid surface id: ${item.id ?? '(missing)'}`);
    if (ids.has(item.id)) errors.push(`duplicate surface id: ${item.id}`);
    ids.add(item.id);
    if (!SURFACE_TYPES.has(item.surfaceType)) errors.push(`${item.id}: invalid surfaceType`);
    if (typeof item.lane !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.lane)) errors.push(`${item.id}: invalid lane`);
    if (!RISK.has(item.risk) || !Number.isInteger(item.riskWeight) || item.riskWeight < 1 || item.riskWeight > 5) errors.push(`${item.id}: risk and riskWeight must be explicit`);
    if (typeof item.riskBasis !== 'string' || !item.riskBasis.trim()) errors.push(`${item.id}: riskBasis is required`);
    if (!ACCESS.has(item.accessibility)) errors.push(`${item.id}: invalid accessibility`);
    if (item.accessibility !== 'testable' && (typeof item.scopeReason !== 'string' || !item.scopeReason.trim())) errors.push(`${item.id}: scoped outcomes require scopeReason`);
    if (!Array.isArray(item.denominators) || item.denominators.length === 0 || item.denominators.some((value) => !['route', 'operation', 'schema', 'role', 'state', 'device', 'browser', 'risk-category'].includes(value))) errors.push(`${item.id}: denominators are invalid`);
    if (!validEvidence(item.discoveryEvidenceIds)) errors.push(`${item.id}: discoveryEvidenceIds are invalid`);
  }
  return unique(errors);
}

export function validateCoverageObservations(document, inventory) {
  const errors = base(document, 'coverage-observations');
  if (!document || typeof document !== 'object') return errors;
  if (inventory && document.engagementId !== inventory.engagementId) errors.push('engagementId must match the surface inventory');
  if (!Array.isArray(document.observations)) errors.push('observations must be an array');
  const inventoryIds = new Set((inventory?.items ?? []).map((item) => item.id));
  const ids = new Set();
  for (const observation of document.observations ?? []) {
    if (!ID.test(observation.surfaceId ?? '')) errors.push(`invalid observed surface id: ${observation.surfaceId ?? '(missing)'}`);
    if (ids.has(observation.surfaceId)) errors.push(`duplicate observation: ${observation.surfaceId}`);
    ids.add(observation.surfaceId);
    if (inventory && !inventoryIds.has(observation.surfaceId)) errors.push(`unknown observed surface: ${observation.surfaceId}`);
    if (typeof observation.executed !== 'boolean') errors.push(`${observation.surfaceId}: executed must be boolean`);
    if (!Array.isArray(observation.assertions)) errors.push(`${observation.surfaceId}: assertions must be an array`);
    for (const assertion of observation.assertions ?? []) {
      if (typeof assertion.id !== 'string' || !assertion.id.trim() || typeof assertion.oracleId !== 'string' || !assertion.oracleId.trim() || typeof assertion.meaningful !== 'boolean') errors.push(`${observation.surfaceId}: assertions require id, oracleId, and meaningful`);
    }
    if (!validEvidence(observation.evidenceIds)) errors.push(`${observation.surfaceId}: evidenceIds are invalid`);
    if (!Array.isArray(observation.defects)) errors.push(`${observation.surfaceId}: defects must be an array`);
    for (const defect of observation.defects ?? []) {
      if (typeof defect.id !== 'string' || !defect.id.trim() || !['confirmed', 'duplicate', 'unsupported'].includes(defect.status)) errors.push(`${observation.surfaceId}: defect outcomes are invalid`);
    }
  }
  return unique(errors);
}

export function calculateCoverage(inventory, observations) {
  const errors = [...validateSurfaceInventory(inventory), ...validateCoverageObservations(observations, inventory)];
  if (errors.length) throw new Error(errors.join('; '));
  const byId = new Map(observations.observations.map((item) => [item.surfaceId, item]));
  const lanes = [...new Set(inventory.items.map((item) => item.lane))].sort();
  const calculations = Object.fromEntries(lanes.map((lane) => [lane, summarize(inventory.items.filter((item) => item.lane === lane), byId)]));
  const all = summarize(inventory.items, byId);
  const defects = observations.observations.flatMap((item) => item.defects);
  const confirmed = [...new Set(defects.filter((item) => item.status === 'confirmed').map((item) => item.id))];
  return {
    $schema: 'argus/coverage-result@1', schemaVersion: 1, engagementId: inventory.engagementId,
    sourceSchemas: [inventory.$schema, observations.$schema],
    discovery: { candidates: inventory.discovery.candidates, characterized: inventory.discovery.characterized, completeness: ratio(inventory.discovery.characterized, inventory.discovery.candidates) },
    overall: all, lanes: calculations,
    scopedOutcomes: inventory.items.filter((item) => item.accessibility !== 'testable').map((item) => ({ surfaceId: item.id, accessibility: item.accessibility, reason: item.scopeReason, evidenceIds: item.discoveryEvidenceIds })),
    defectOutcomes: { uniqueConfirmed: confirmed.length, duplicate: defects.filter((item) => item.status === 'duplicate').length, unsupported: defects.filter((item) => item.status === 'unsupported').length, scoreContribution: 0 },
    generatedAt: new Date().toISOString(),
  };
}

function summarize(items, byId) {
  const testable = items.filter((item) => item.accessibility === 'testable');
  const denominator = sum(testable.map((item) => item.riskWeight));
  const executed = testable.filter((item) => byId.get(item.id)?.executed);
  const executedWeight = sum(executed.map((item) => item.riskWeight));
  const assertedWeight = sum(executed.filter((item) => byId.get(item.id).assertions.some((assertion) => assertion.meaningful && assertion.oracleId)).map((item) => item.riskWeight));
  const evidencedWeight = sum(executed.filter((item) => byId.get(item.id).evidenceIds.length > 0).map((item) => item.riskWeight));
  return {
    discoveredItems: items.length, testableItems: testable.length, scopedItems: items.length - testable.length,
    riskWeight: { denominator, executed: executedWeight, asserted: assertedWeight, evidenced: evidencedWeight },
    executionCoverage: ratio(executedWeight, denominator), assertionQuality: ratio(assertedWeight, executedWeight), evidenceQuality: ratio(evidencedWeight, executedWeight),
  };
}

function base(document, kind) {
  const errors = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be an object'];
  if (document.$schema !== `argus/${kind}@1`) errors.push(`$schema must be argus/${kind}@1`);
  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof document.engagementId !== 'string' || !document.engagementId.trim()) errors.push('engagementId is required');
  return errors;
}
function validEvidence(values) { return Array.isArray(values) && values.every((value) => EVIDENCE.test(value)) && new Set(values).size === values.length; }
function ratio(numerator, denominator) { return denominator === 0 ? null : Number((numerator / denominator).toFixed(4)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function unique(values) { return [...new Set(values)]; }
