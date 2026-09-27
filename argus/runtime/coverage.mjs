const SURFACE_TYPES = new Set(['ui', 'api', 'event', 'data']);
const ACCESS = new Set(['testable', 'inaccessible', 'untestable']);
const RISK = new Set(['critical', 'high', 'medium', 'low']);
const ID = /^SRF-[A-Z0-9][A-Z0-9-]*$/;
const EVIDENCE = /^EVD-[0-9]{4}$/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const CASE_ID = /^[A-Za-z0-9_.:-]+$/;
const DEFECT_REF = /^(?:BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$/;
// Optional recon tags: attack-surface features on an item and the side-effect channels a
// hunter must observe. Neither is a denominator, so coverage arithmetic never reads them.
const SURFACE_FEATURES = new Set(['file-upload', 'url-fetch-redirect', 'protected-download', 'export-generation', 'notification-channel', 'audit-trail', 'scheduled-job', 'background-job']);
const SIDE_EFFECT_KINDS = new Set(['notification-channel', 'audit-trail', 'export-generation', 'scheduled-job', 'background-job']);
const OBSERVABILITY = new Set(['observable', 'unobservable']);
const CHANNEL_ID = /^SFX-[A-Z0-9][A-Z0-9-]*$/;
// The input versions this module reads; contracts.mjs owns the compatibility policy. This
// module imports nothing, so the contract validator and the finding reconciler can use it.
const INPUT_VERSIONS = Object.freeze({ 'surface-inventory': 1, 'coverage-observations': 2 });
const EVIDENCE_SCHEMA = 'argus/evidence-reference@3';
const LEDGER_SCHEMA = 'argus/bug-ledger@2';
const AUTOMATION_SCHEMA = 'argus/automation-status@2';
// Automation-status tests that may vouch for a runner case; planned and skipped tests never do.
const MAPPING_TEST_STATUSES = new Set(['implemented', 'passed', 'failed']);
// coverage-result sourceSchemas, in emission order; inventory and observations always lead.
const SOURCE_SCHEMAS = Object.freeze(['argus/surface-inventory@1', 'argus/coverage-observations@2', EVIDENCE_SCHEMA, LEDGER_SCHEMA]);
// Captures that prove a surface was exercised when their reference names it. A runner result
// proves execution only through one executed case; text evidence never does.
const DIRECT_EXECUTION_KINDS = new Set(['http', 'har', 'trace', 'screenshot', 'video', 'dom-snapshot', 'log', 'metric']);
const RUNNER_CATEGORIES = new Set(['product', 'automation']);
const RUNNER_OUTCOMES = Object.freeze({ pass: 'passed', fail: 'failed' });

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
    if (typeof item.lane !== 'string' || !SLUG.test(item.lane)) errors.push(`${item.id}: invalid lane`);
    if (!RISK.has(item.risk) || !Number.isInteger(item.riskWeight) || item.riskWeight < 1 || item.riskWeight > 5) errors.push(`${item.id}: risk and riskWeight must be explicit`);
    if (typeof item.riskBasis !== 'string' || !item.riskBasis.trim()) errors.push(`${item.id}: riskBasis is required`);
    if (!ACCESS.has(item.accessibility)) errors.push(`${item.id}: invalid accessibility`);
    if (item.accessibility !== 'testable' && (typeof item.scopeReason !== 'string' || !item.scopeReason.trim())) errors.push(`${item.id}: scoped outcomes require scopeReason`);
    if (!Array.isArray(item.denominators) || item.denominators.length === 0 || item.denominators.some((value) => !['route', 'operation', 'schema', 'role', 'state', 'device', 'browser', 'risk-category'].includes(value))) errors.push(`${item.id}: denominators are invalid`);
    if (!validEvidence(item.discoveryEvidenceIds)) errors.push(`${item.id}: discoveryEvidenceIds are invalid`);
    if (item.features !== undefined && !validFeatures(item.features)) errors.push(`${item.id}: features are invalid`);
  }
  errors.push(...validateSideEffectChannels(document.sideEffectChannels, ids));
  return unique(errors);
}

// Each channel names how its effect is observed, or why it cannot be; a linked surface must
// exist in the same inventory.
function validateSideEffectChannels(channels, surfaceIds) {
  if (channels === undefined) return [];
  if (!Array.isArray(channels)) return ['sideEffectChannels must be an array'];
  const errors = [];
  const ids = new Set();
  for (const channel of channels) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) { errors.push('side-effect channel must be an object'); continue; }
    const label = channel.id ?? '(missing channel id)';
    if (typeof channel.id !== 'string' || !CHANNEL_ID.test(channel.id)) errors.push(`invalid side-effect channel id: ${label}`);
    if (ids.has(channel.id)) errors.push(`duplicate side-effect channel id: ${label}`);
    ids.add(channel.id);
    const unknown = Object.keys(channel).filter((key) => !['id', 'kind', 'observability', 'observation', 'reason', 'surfaceIds'].includes(key));
    if (unknown.length) errors.push(`${label}: unknown side-effect channel fields: ${unknown.join(', ')}`);
    if (!SIDE_EFFECT_KINDS.has(channel.kind)) errors.push(`${label}: invalid side-effect channel kind`);
    if (!OBSERVABILITY.has(channel.observability)) errors.push(`${label}: observability must be observable or unobservable`);
    if (channel.observation !== undefined && !nonEmpty(channel.observation)) errors.push(`${label}: observation must be a non-empty string`);
    if (channel.reason !== undefined && !nonEmpty(channel.reason)) errors.push(`${label}: reason must be a non-empty string`);
    if (channel.observability === 'observable' && channel.observation === undefined) errors.push(`${label}: an observable channel requires observation`);
    if (channel.observability === 'unobservable' && channel.reason === undefined) errors.push(`${label}: an unobservable channel requires reason`);
    if (channel.surfaceIds !== undefined) {
      const linked = channel.surfaceIds;
      if (!Array.isArray(linked) || linked.length === 0 || new Set(linked).size !== linked.length || linked.some((id) => typeof id !== 'string' || !ID.test(id))) errors.push(`${label}: surfaceIds are invalid`);
      else for (const id of linked.filter((value) => !surfaceIds.has(value))) errors.push(`${label}: unknown surface ${id}`);
    }
  }
  return errors;
}
function validFeatures(values) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => SURFACE_FEATURES.has(value)) && new Set(values).size === values.length;
}

// Observations are a collection keyed by <lane>:<surfaceId>. A record cites evidence; it
// never declares execution or assertion quality, which resolveCoverage derives.
export function validateCoverageObservations(document, inventory) {
  const errors = base(document, 'coverage-observations');
  if (!document || typeof document !== 'object') return errors;
  if (inventory && document.engagementId !== inventory.engagementId) errors.push('engagementId must match the surface inventory');
  if (!Array.isArray(document.observations)) errors.push('observations must be an array');
  const inventoryIds = new Set((inventory?.items ?? []).map((item) => item.id));
  const ids = new Set();
  const obligations = new Set();
  for (const observation of arrayOf(document.observations)) {
    const label = observation?.observationId ?? '(missing observationId)';
    if (!SLUG.test(observation?.lane ?? '')) errors.push(`${label}: invalid lane`);
    if (!ID.test(observation?.surfaceId ?? '')) errors.push(`invalid observed surface id: ${observation?.surfaceId ?? '(missing)'}`);
    if (observation?.observationId !== `${observation?.lane}:${observation?.surfaceId}`) errors.push(`${label}: observationId must equal <lane>:<surfaceId>`);
    if (ids.has(observation?.observationId)) errors.push(`duplicate observation: ${observation.observationId}`);
    ids.add(observation?.observationId);
    if (inventory && !inventoryIds.has(observation?.surfaceId)) errors.push(`unknown observed surface: ${observation?.surfaceId}`);
    if (!Array.isArray(observation?.executions) || !observation.executions.every(validExecution)) errors.push(`${label}: executions are invalid`);
    else if (new Set(observation.executions.map(executionKey)).size !== observation.executions.length) errors.push(`${label}: executions must be unique`);
    if (!Array.isArray(observation?.assertions)) errors.push(`${label}: assertions must be an array`);
    for (const assertion of arrayOf(observation?.assertions)) {
      if (!nonEmpty(assertion?.id) || !nonEmpty(assertion?.oracleId) || !validEvidence(assertion?.evidenceIds) || assertion.evidenceIds.length === 0 || !validEvidence(assertion?.controlEvidenceIds)) {
        errors.push(`${label}: assertions require id, oracleId, evidenceIds, and controlEvidenceIds`);
      } else if (assertion.controlEvidenceIds.some((id) => assertion.evidenceIds.includes(id))) {
        errors.push(`${label}: assertion ${assertion.id} control evidence must be distinct from its evidence`);
      }
    }
    if (!validEvidence(observation?.evidenceIds)) errors.push(`${label}: evidenceIds are invalid`);
    if (!Array.isArray(observation?.defectRefs) || !observation.defectRefs.every((ref) => DEFECT_REF.test(ref ?? '')) || new Set(observation.defectRefs).size !== observation.defectRefs.length) errors.push(`${label}: defectRefs are invalid`);
    if (observation?.cases !== undefined && !Array.isArray(observation.cases)) errors.push(`${label}: cases must be an array`);
    for (const item of arrayOf(observation?.cases)) {
      if (obligations.has(item?.obligationId)) errors.push(`duplicate case observation: ${item.obligationId}`);
      obligations.add(item?.obligationId);
      if (item?.execution !== undefined && !validExecution(item.execution)) errors.push(`${item?.obligationId}: case execution is invalid`);
    }
  }
  return unique(errors);
}

// Every evidence ID the coverage inputs cite, each with the place that cites it. The engagement
// merge and the evidence reconciler use it to decide what must resolve and pass integrity checks.
export function coverageEvidenceReferences(inventory, observations) {
  const references = [];
  const add = (label, ids) => { for (const id of arrayOf(ids)) references.push({ label, id }); };
  for (const surface of arrayOf(inventory?.items)) add(`${surface.id}: discovery evidence`, surface.discoveryEvidenceIds);
  for (const row of arrayOf(observations?.observations)) {
    add(`${row.observationId}: execution`, arrayOf(row.executions).map((item) => item?.evidenceId));
    for (const assertion of arrayOf(row.assertions)) {
      add(`${row.observationId}: assertion ${assertion.id} evidence`, assertion.evidenceIds);
      add(`${row.observationId}: assertion ${assertion.id} control evidence`, assertion.controlEvidenceIds);
    }
    add(`${row.observationId}: outcome evidence`, row.evidenceIds);
    for (const item of arrayOf(row.cases)) {
      add(`${row.observationId}: case ${item.obligationId} evidence`, item.evidenceIds);
      add(`${row.observationId}: case ${item.obligationId} control evidence`, item.controlEvidenceIds);
      if (item.execution) add(`${row.observationId}: case ${item.obligationId} execution`, [item.execution.evidenceId]);
    }
  }
  return references;
}

// Resolves every citation against the evidence registry and the ledger and derives each
// surface's flags from evidence alone. Returns every violation instead of throwing, so a
// validator can report them all; calculateCoverage fails closed on any. readArtifact(source)
// returns the bytes of a registered capture and must enforce the caller's path boundary.
// With an automation status, a runner case is credited to a surface only when an
// implemented, passed, or failed test maps that case to that surface.
export function resolveCoverage(inventory, observations, { evidence = null, ledger = null, automationStatus = null, readArtifact = null } = {}) {
  const errors = [];
  if (evidence && evidence.$schema !== EVIDENCE_SCHEMA) errors.push(`coverage evidence registry must be ${EVIDENCE_SCHEMA}`);
  if (evidence && evidence.engagementId !== inventory.engagementId) errors.push('coverage evidence engagementId does not match the surface inventory');
  if (ledger && ledger.$schema !== LEDGER_SCHEMA) errors.push(`coverage bug ledger must be ${LEDGER_SCHEMA}`);
  if (ledger && ledger.engagementId !== inventory.engagementId) errors.push('coverage bug ledger engagementId does not match the surface inventory');
  if (automationStatus && automationStatus.$schema !== AUTOMATION_SCHEMA) errors.push(`coverage automation status must be ${AUTOMATION_SCHEMA}`);
  if (automationStatus && automationStatus.engagementId !== inventory.engagementId) errors.push('coverage automation status engagementId does not match the surface inventory');
  const refs = evidence ? new Map(arrayOf(evidence.references).map((ref) => [ref.id, ref])) : null;
  if (!refs && coverageEvidenceReferences(inventory, observations).length) errors.push('coverage evidence registry required');
  const defects = ledger ? ledgerIndex(ledger) : null;
  const mappedCases = automationStatus ? runnerCaseIndex(automationStatus) : null;
  let runnerExecutions = 0;
  const runnerResults = new Map();
  const loadRunnerResult = (ref) => {
    if (!runnerResults.has(ref.id)) runnerResults.set(ref.id, parseRunnerResult(ref, readArtifact));
    return runnerResults.get(ref.id);
  };
  const resolved = (at, ids) => arrayOf(ids).filter((id) => {
    if (!refs) return false;
    if (!refs.has(id)) errors.push(`${at} ${id} is not in the evidence registry`);
    return refs.has(id);
  });
  // One execution citation; returns the resolved runner document (or null) and event, or
  // undefined when the citation does not prove execution of this surface.
  const resolveExecution = (surface, execution, at) => {
    if (!refs) return undefined;
    const ref = refs.get(execution.evidenceId);
    const cited = `${at} ${execution.evidenceId}`;
    if (!ref) { errors.push(`${cited} is not in the evidence registry`); return undefined; }
    if (ref.kind === 'runner-result') {
      if (execution.caseId === undefined) { errors.push(`${cited} is a runner result and requires a caseId`); return undefined; }
      const loaded = loadRunnerResult(ref);
      if (loaded.error) { errors.push(`${cited}: ${loaded.error}`); return undefined; }
      const event = loaded.document.events.find((item) => item?.caseId === execution.caseId && RUNNER_CATEGORIES.has(item.category) && Object.hasOwn(RUNNER_OUTCOMES, item.status));
      if (!event) { errors.push(`${cited} has no executed product or automation case ${execution.caseId}`); return undefined; }
      runnerExecutions += 1;
      if (mappedCases && !mappedCases.get(surface.id)?.has(execution.caseId)) {
        errors.push(`${cited}: runner case ${execution.caseId} is not mapped to ${surface.id} by automation-status`);
        return undefined;
      }
      return { runner: loaded.document, event };
    }
    if (execution.caseId !== undefined) { errors.push(`${cited} is ${ref.kind} evidence and must not carry a caseId`); return undefined; }
    if (!DIRECT_EXECUTION_KINDS.has(ref.kind)) { errors.push(`${cited} is ${ref.kind} evidence, which never proves execution`); return undefined; }
    if (!arrayOf(ref.relatedSurfaceIds).includes(surface.id)) { errors.push(`${cited} does not name ${surface.id} in relatedSurfaceIds`); return undefined; }
    if (arrayOf(surface.discoveryEvidenceIds).includes(ref.id)) { errors.push(`${cited} is discovery evidence for ${surface.id}`); return undefined; }
    return { runner: null, event: null };
  };

  const rowsBySurface = new Map();
  for (const row of arrayOf(observations?.observations)) {
    if (!rowsBySurface.has(row.surfaceId)) rowsBySurface.set(row.surfaceId, []);
    rowsBySurface.get(row.surfaceId).push(row);
  }
  const perSurface = {};
  for (const surface of arrayOf(inventory?.items)) {
    const rows = rowsBySurface.get(surface.id) ?? [];
    resolved(`${surface.id}: discovery evidence`, surface.discoveryEvidenceIds);
    let executed = false;
    let automated = false;
    for (const row of rows) {
      for (const execution of arrayOf(row.executions)) {
        const result = resolveExecution(surface, execution, `${row.observationId}: execution`);
        if (!result) continue;
        executed = true;
        if (result.runner?.deliveryGate === true) automated = true;
      }
    }
    let assertedByEvidence = false;
    let outcomeEvidence = 0;
    const defectIds = new Set();
    for (const row of rows) {
      for (const assertion of arrayOf(row.assertions)) {
        const evidenceIds = arrayOf(assertion.evidenceIds);
        const controlIds = arrayOf(assertion.controlEvidenceIds);
        const evidenceResolved = resolved(`${row.observationId}: assertion ${assertion.id} evidence`, evidenceIds).length === evidenceIds.length;
        const controlResolved = resolved(`${row.observationId}: assertion ${assertion.id} control evidence`, controlIds).length === controlIds.length;
        const disjoint = !controlIds.some((id) => evidenceIds.includes(id));
        if (nonEmpty(assertion.oracleId) && evidenceIds.length > 0 && evidenceResolved && controlIds.length > 0 && controlResolved && disjoint) assertedByEvidence = true;
      }
      outcomeEvidence += resolved(`${row.observationId}: outcome evidence`, row.evidenceIds).length;
      for (const ref of arrayOf(row.defectRefs)) {
        if (!defects) errors.push(`${row.observationId}: defect reference ${ref} requires the canonical bug ledger`);
        else if (!defects.has(ref)) errors.push(`${row.observationId}: unknown defect reference ${ref}`);
        else defectIds.add(defects.get(ref));
      }
    }
    const cases = [];
    for (const row of rows) {
      for (const item of arrayOf(row.cases)) {
        const at = `${row.observationId}: case ${item.obligationId}`;
        resolved(`${at} evidence`, item.evidenceIds);
        resolved(`${at} control evidence`, item.controlEvidenceIds);
        const reported = ['passed', 'failed'].includes(item.outcome);
        if (reported && !executed) errors.push(`${item.obligationId}: executed case on an unexecuted surface`);
        let proven = true;
        if (item.execution) {
          const result = resolveExecution(surface, item.execution, `${at} execution`);
          if (!result) proven = false;
          else if (result.event && RUNNER_OUTCOMES[result.event.status] !== item.outcome) {
            errors.push(`${at} execution ${item.execution.evidenceId} runner outcome ${result.event.status} does not match case outcome ${item.outcome}`);
            proven = false;
          }
        }
        cases.push({ obligationId: item.obligationId, ran: reported && executed && proven, controlled: arrayOf(item.evidenceIds).length > 0 && arrayOf(item.controlEvidenceIds).length > 0, reason: item.reason });
      }
    }
    perSurface[surface.id] = {
      surfaceId: surface.id, lane: surface.lane, risk: surface.risk, riskWeight: surface.riskWeight, accessibility: surface.accessibility,
      executed, asserted: executed && assertedByEvidence, evidenced: executed && outcomeEvidence > 0, automated: executed && automated,
      defectIds: [...defectIds].sort(compareAscii), cases,
    };
  }
  // A mapping is verified only when runner cases were credited and an automation status vouched
  // for every one of them; without runner-result executions there is nothing to map.
  const runnerCaseMapping = runnerExecutions === 0 ? 'not-applicable' : mappedCases ? 'verified' : 'unverified';
  return { errors: unique(errors), perSurface, runnerCaseMapping };
}

// Fails closed: schema-subset, case-plan, and resolution errors all throw.
export function calculateCoverage(inventory, observations, context = {}) {
  const errors = [...validateSurfaceInventory(inventory), ...validateCoverageObservations(observations, inventory), ...validateCasePlan(inventory, observations)];
  if (errors.length) throw new Error(errors.join('; '));
  const { evidence = null, ledger = null } = context;
  const { errors: resolutionErrors, perSurface, runnerCaseMapping } = resolveCoverage(inventory, observations, context);
  if (resolutionErrors.length) throw new Error(resolutionErrors.join('; '));
  const lanes = [...new Set(inventory.items.map((item) => item.lane))].sort();
  const calculations = Object.fromEntries(lanes.map((lane) => [lane, summarize(inventory.items.filter((item) => item.lane === lane), perSurface)]));
  const surfaces = inventory.items.map((item) => perSurface[item.id]).sort((left, right) => compareAscii(left.surfaceId, right.surfaceId));
  return {
    $schema: 'argus/coverage-result@2', schemaVersion: 2, engagementId: inventory.engagementId,
    sourceSchemas: [inventory.$schema, observations.$schema, ...(evidence ? [evidence.$schema] : []), ...(ledger ? [ledger.$schema] : [])],
    discovery: { candidates: inventory.discovery.candidates, characterized: inventory.discovery.characterized, completeness: ratio(inventory.discovery.characterized, inventory.discovery.candidates) },
    overall: summarize(inventory.items, perSurface), lanes: calculations,
    surfaces: surfaces.map(({ cases, ...surface }) => surface),
    criticalUnexecuted: surfaces.filter(isCriticalUnexecuted).map((surface) => surface.surfaceId),
    runnerCaseMapping,
    scopedOutcomes: inventory.items.filter((item) => item.accessibility !== 'testable').map((item) => ({ surfaceId: item.id, accessibility: item.accessibility, reason: item.scopeReason, evidenceIds: item.discoveryEvidenceIds })),
    defectOutcomes: defectOutcomes(ledger, new Set(surfaces.flatMap((surface) => surface.defectIds))),
    generatedAt: new Date().toISOString(),
  };
}

// Invariants of a calculated result that the schema subset cannot express.
export function validateCoverageResult(document) {
  const errors = [];
  const sources = arrayOf(document?.sourceSchemas);
  const positions = sources.map((source) => SOURCE_SCHEMAS.indexOf(source));
  if (sources[0] !== SOURCE_SCHEMAS[0] || sources[1] !== SOURCE_SCHEMAS[1] || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    errors.push('sourceSchemas must list the inventory, the observations, then the evidence registry and the bug ledger when present, in that order');
  }
  for (const [label, metric] of [['overall', document?.overall], ...Object.entries(document?.lanes ?? {}).map(([lane, value]) => [`lane ${lane}`, value])]) {
    const weight = metric?.riskWeight;
    if (!weight) continue;
    if (weight.executed > weight.denominator || weight.asserted > weight.executed || weight.evidenced > weight.executed || weight.automated > weight.executed) {
      errors.push(`${label} risk weights must satisfy asserted, evidenced, automated <= executed <= denominator`);
    }
  }
  const surfaces = arrayOf(document?.surfaces);
  if (!sortedUnique(surfaces.map((surface) => surface.surfaceId))) errors.push('surfaces must be sorted by unique surfaceId');
  for (const surface of surfaces) {
    if (!surface.executed && (surface.asserted || surface.evidenced || surface.automated)) errors.push(`${surface.surfaceId}: asserted, evidenced, and automated require executed`);
    if (!sortedUnique(arrayOf(surface.defectIds))) errors.push(`${surface.surfaceId}: defectIds must be sorted and unique`);
  }
  const critical = surfaces.filter(isCriticalUnexecuted).map((surface) => surface.surfaceId);
  if (JSON.stringify(arrayOf(document?.criticalUnexecuted)) !== JSON.stringify(critical)) errors.push('criticalUnexecuted must list exactly the unexecuted testable critical surfaces, sorted');
  // Automated execution is only ever credited through a runner case, so there was one to map.
  if (document?.runnerCaseMapping === 'not-applicable' && surfaces.some((surface) => surface.automated)) errors.push('runnerCaseMapping cannot be not-applicable when a surface has automated execution');
  const outcomes = document?.defectOutcomes;
  if (outcomes) {
    if (outcomes.headline !== outcomes.confirmed + outcomes.suspected) errors.push('defectOutcomes.headline must equal confirmed + suspected');
    if (outcomes.linked + arrayOf(outcomes.unlinked).length !== outcomes.headline) errors.push('defectOutcomes linked and unlinked must partition the headline defects');
    if (!sortedUnique(arrayOf(outcomes.unlinked))) errors.push('defectOutcomes.unlinked must be sorted and unique');
  }
  return errors;
}

function summarize(items, perSurface) {
  const testable = items.filter((item) => item.accessibility === 'testable');
  const weight = (flag) => sum(testable.filter((item) => perSurface[item.id][flag]).map((item) => item.riskWeight));
  const denominator = sum(testable.map((item) => item.riskWeight));
  const executed = weight('executed');
  const asserted = weight('asserted');
  const evidenced = weight('evidenced');
  const automated = weight('automated');
  return {
    caseDepth: caseDepth(items, perSurface),
    discoveredItems: items.length, testableItems: testable.length, scopedItems: items.length - testable.length,
    riskWeight: { denominator, executed, asserted, evidenced, automated },
    executionCoverage: ratio(executed, denominator), assertionQuality: ratio(asserted, executed), evidenceQuality: ratio(evidenced, executed), automatedExecution: ratio(automated, executed),
  };
}

// Defect outcomes come from the canonical ledger, never from observations, and never score.
function defectOutcomes(ledger, linkedIds) {
  const bugs = arrayOf(ledger?.bugs);
  const count = (status) => bugs.filter((bug) => bug.status === status).length;
  const headline = bugs.filter((bug) => bug.status === 'confirmed' || bug.status === 'suspected').map((bug) => bug.id).sort(compareAscii);
  const linked = headline.filter((id) => linkedIds.has(id));
  return {
    confirmed: count('confirmed'), suspected: count('suspected'), needsOracle: count('needs-oracle'), duplicate: count('duplicate'), rejected: count('rejected'),
    headline: headline.length, linked: linked.length, unlinked: headline.filter((id) => !linkedIds.has(id)), scoreContribution: 0,
  };
}

// A defect reference resolves through a ledger ID or any origin alias to the ledger ID.
function ledgerIndex(ledger) {
  const index = new Map();
  for (const bug of arrayOf(ledger.bugs)) {
    index.set(bug.id, bug.id);
    for (const origin of arrayOf(bug.origin)) index.set(origin, bug.id);
  }
  return index;
}

// Surface ID -> runner case IDs that an implemented, passed, or failed automation test maps to
// it. A test maps the cross product of its caseIds and surfaceIds.
function runnerCaseIndex(automationStatus) {
  const index = new Map();
  for (const test of arrayOf(automationStatus.tests)) {
    if (!MAPPING_TEST_STATUSES.has(test?.status)) continue;
    for (const surfaceId of arrayOf(test.surfaceIds)) {
      if (!index.has(surfaceId)) index.set(surfaceId, new Set());
      for (const caseId of arrayOf(test.caseIds)) index.get(surfaceId).add(caseId);
    }
  }
  return index;
}

function parseRunnerResult(ref, readArtifact) {
  if (typeof readArtifact !== 'function') return { error: 'runner-result evidence requires an artifact reader' };
  let document;
  try { document = JSON.parse(Buffer.from(readArtifact(ref.source)).toString('utf8')); }
  catch (error) { return { error: `runner result ${ref.source} cannot be read: ${error.message}` }; }
  if (!document || typeof document !== 'object' || document.$schema !== 'argus/runner-result@1' || !Array.isArray(document.events) || typeof document.deliveryGate !== 'boolean') {
    return { error: `runner result ${ref.source} is not an argus/runner-result@1 document` };
  }
  return { document };
}

function isCriticalUnexecuted(surface) {
  return surface.accessibility === 'testable' && surface.risk === 'critical' && !surface.executed;
}

function base(document, kind) {
  const errors = [];
  const version = INPUT_VERSIONS[kind];
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be an object'];
  if (document.$schema !== `argus/${kind}@${version}`) errors.push(`$schema must be argus/${kind}@${version}`);
  if (document.schemaVersion !== version) errors.push(`schemaVersion must be ${version}`);
  if (typeof document.engagementId !== 'string' || !document.engagementId.trim()) errors.push('engagementId is required');
  return errors;
}
function validEvidence(values) { return Array.isArray(values) && values.every((value) => EVIDENCE.test(value)) && new Set(values).size === values.length; }
function validExecution(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && EVIDENCE.test(value.evidenceId ?? '')
    && (value.caseId === undefined || CASE_ID.test(value.caseId)) && Object.keys(value).every((key) => key === 'evidenceId' || key === 'caseId');
}
function executionKey(value) { return `${value.evidenceId}\u0000${value.caseId ?? ''}`; }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function arrayOf(value) { return Array.isArray(value) ? value : []; }
function sortedUnique(values) { return values.every((value, index) => index === 0 || compareAscii(values[index - 1], value) < 0); }
function compareAscii(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function ratio(numerator, denominator) { return denominator === 0 ? null : Number((numerator / denominator).toFixed(4)); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function unique(values) { return [...new Set(values)]; }

export function validateCasePlan(inventory, observations) {
  const errors = [];
  const planned = new Map();
  for (const surface of inventory.items ?? []) {
    for (const item of surface.obligations ?? []) {
      if (planned.has(item.id)) errors.push(`duplicate case obligation: ${item.id}`);
      planned.set(item.id, { ...item, surfaceId: surface.id });
      const dimensions = Object.keys(item.dimensions ?? {});
      if (!dimensions.length || dimensions.some(key => !['operation', 'role', 'state', 'boundary', 'browser', 'device', 'risk-category'].includes(key))) errors.push(`${item.id}: invalid case dimensions`);
      if (!item.oracleId || !item.applicability || !Number.isInteger(item.weight) || item.weight < 1 || item.weight > 5) errors.push(`${item.id}: incomplete case obligation`);
    }
  }
  for (const observation of observations.observations ?? []) {
    for (const item of observation.cases ?? []) {
      const obligation = planned.get(item.obligationId);
      if (!obligation || obligation.surfaceId !== observation.surfaceId) errors.push(`unknown or wrong-surface obligation: ${item.obligationId}`);
      if (obligation && item.oracleId !== obligation.oracleId) errors.push(`${item.obligationId}: oracle mismatch`);
      if (!['passed', 'failed', 'blocked'].includes(item.outcome)) errors.push(`${item.obligationId}: invalid outcome`);
      if (!validEvidence(item.evidenceIds) || !validEvidence(item.controlEvidenceIds)) errors.push(`${item.obligationId}: invalid evidence`);
      if (item.outcome === 'blocked' && !item.reason) errors.push(`${item.obligationId}: blocked case requires reason`);
      if (item.controlEvidenceIds?.some(id => item.evidenceIds?.includes(id))) errors.push(`${item.obligationId}: assertion control must have distinct evidence`);
    }
  }
  return errors;
}

// A case counts as run only when its surface is executed and any cited case execution
// resolves; the executed-case check itself lives in resolveCoverage.
function caseDepth(items, perSurface) {
  let planned = 0, executed = 0, verified = 0;
  const gaps = [], unplannedSurfaces = [];
  for (const surface of items.filter(item => item.accessibility === 'testable')) {
    if (!surface.obligations?.length) unplannedSurfaces.push(surface.id);
    const observed = new Map((perSurface[surface.id]?.cases ?? []).map(item => [item.obligationId, item]));
    for (const obligation of surface.obligations ?? []) {
      planned += obligation.weight;
      const result = observed.get(obligation.id);
      const ran = Boolean(result?.ran);
      if (ran) executed += obligation.weight;
      const supported = ran && result.controlled;
      if (supported) verified += obligation.weight;
      else gaps.push({ obligationId: obligation.id, reason: result?.reason || (ran ? 'Missing execution or assertion-control evidence' : 'Not executed') });
    }
  }
  return { plannedWeight: planned, executedWeight: executed, verifiedWeight: verified,
    coverage: unplannedSurfaces.length ? null : ratio(verified, planned), unplannedSurfaces, gaps };
}
