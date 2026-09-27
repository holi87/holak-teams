import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageEvidenceReferences } from './coverage.mjs';
import { loadRedactionPatterns, validateEvidenceContent } from './evidence.mjs';

const CAPABILITY_MATRIX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'capabilities', 'capability-matrix.json');
let filingPrefixLanes = null;

// Rows whose proof blocks carry confirmed-grade verification.
const PROVEN_STATUSES = new Set(['confirmed', 'quarantined']);
const MISSING_PROOF_STATUSES = new Set(['suspected', 'needs-oracle']);
// A duplicate points at a live row. A quarantined target stays valid because the merge may
// demote a confirmed target after the duplicate was filed against it.
const DUPLICATE_TARGET_STATUSES = new Set(['confirmed', 'suspected', 'needs-oracle', 'quarantined']);

// Every evidence ID a ledger row cites, in any block, sorted and unique.
export function ledgerEvidenceIds(bug) {
  const proof = bug.verification;
  return [...new Set([
    ...bug.evidenceIds,
    ...(proof ? [proof.oracle.evidenceId, ...proof.reproduction.evidenceIds, ...proof.independent.evidenceIds] : []),
    ...(bug.merge?.causalEvidence ?? []).flatMap(item => item.evidenceIds),
    ...(bug.rejection?.evidenceIds ?? []),
  ])].sort();
}

// Reconcile only at the canonical merge boundary, after evidence owners have published.
// readArtifact must enforce the engagement's physical-path boundary and alias policy.
// `errors` abort the merge; `byBug` holds per-row failures, which quarantine that row.
// Intact bytes are re-validated against their reference (options.patterns defaults to the
// packaged redaction policy); options.verifyReference(ref) may add caller-bound checks, such
// as the binary-evidence audit binding, and returns their errors.
export function reconcileFindings(ledger, evidence, readArtifact, options = {}) {
  if (ledger.engagementId !== evidence.engagementId) return { errors: ['evidence engagementId does not match ledger'], byBug: {} };
  const refs = new Map(evidence.references.map(item => [item.id, item]));
  const checkEvidence = evidenceChecker(readArtifact, options);
  const byBug = {};
  for (const bug of ledger.bugs) {
    const errors = [];
    for (const id of ledgerEvidenceIds(bug)) {
      const ref = refs.get(id);
      if (!ref) { errors.push(`${bug.id}: unresolved evidence ${id}`); continue; }
      errors.push(...checkEvidence(ref).map(error => `${bug.id}: ${error}`));
    }
    if (bug.status === 'confirmed') errors.push(...confirmedLinkageErrors(bug, refs));
    if (bug.merge) errors.push(...mergeCollectorErrors(bug, refs));
    if (errors.length) (byBug[bug.id] ??= []).push(...errors);
  }
  return { errors: [], byBug };
}

// Per-reference checks, memoized so a capture cited by several rows is read once per merge.
function evidenceChecker(readArtifact, { patterns, verifyReference } = {}) {
  const results = new Map();
  let loadedPatterns = patterns;
  return (ref) => {
    if (results.has(ref.id)) return results.get(ref.id);
    const errors = [];
    let bytes = null;
    try { bytes = readArtifact(ref.source); }
    catch { errors.push(`missing or unsafe evidence ${ref.id}`); }
    if (bytes !== null) {
      if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) errors.push(`evidence digest drift ${ref.id}`);
      else errors.push(...validateEvidenceContent(ref, bytes, { patterns: loadedPatterns ??= loadRedactionPatterns() }));
      if (!Number.isFinite(Date.parse(ref.capturedAt)) || Date.parse(ref.capturedAt) > Date.now() + 60000) errors.push(`invalid evidence time ${ref.id}`);
    }
    if (verifyReference) {
      try { errors.push(...verifyReference(ref)); }
      catch (error) { errors.push(`evidence ${ref.id} cannot be verified: ${error.message}`); }
    }
    results.set(ref.id, errors);
    return errors;
  };
}

// Demotes every row with a reconciliation failure to quarantined, in place. The row keeps
// every block it was submitted with, so it never counts as confirmed and its owner can see
// what it claimed; the immutable fragment is untouched, so a later merge with intact
// evidence restores the submitted status. Returns the quarantined ids.
export function quarantineFindings(ledger, byBug) {
  const quarantined = new Set();
  for (const bug of ledger.bugs) {
    const errors = byBug[bug.id];
    if (!errors?.length) continue;
    const reasons = errors.map(error => error.startsWith(`${bug.id}: `) ? error.slice(bug.id.length + 2) : error);
    bug.status = 'quarantined';
    bug.quarantine = { reasons: [...new Set([...(bug.quarantine?.reasons ?? []), ...reasons])] };
    quarantined.add(bug.id);
  }
  return [...quarantined].sort();
}

function confirmedLinkageErrors(bug, refs) {
  const proof = bug.verification;
  if (!proof) return [`${bug.id}: verification is required`];
  const errors = [];
  if (!bug.evidenceIds.some(id => proof.reproduction.evidenceIds.includes(id))) errors.push(`${bug.id}: reproduction is not linked to finding evidence`);
  if (proof.independent.status === 'reproduced') {
    for (const id of proof.independent.evidenceIds) {
      if (refs.get(id)?.collectedBy !== proof.independent.executor) errors.push(`${bug.id}: independent evidence owner mismatch`);
      if (proof.reproduction.evidenceIds.includes(id)) errors.push(`${bug.id}: independent reproduction reuses original evidence`);
    }
    if (proof.reproduction.evidenceIds.some(id => refs.get(id)?.collectedBy === proof.independent.executor)) errors.push(`${bug.id}: independent executor collected the original reproduction evidence`);
    if (originLanes(bug, refs).has(proof.independent.executor)) errors.push(`${bug.id}: independent executor ${proof.independent.executor} is an origin lane`);
  }
  return errors;
}

// The lanes that found a row: the lane each origin prefix files under (bugs/<PREFIX>-* in the
// capability matrix) and the collectors of the causal evidence cited for each origin.
function originLanes(bug, refs) {
  const lanes = new Set(bug.origin.map(origin => filingLane(origin)).filter(Boolean));
  for (const item of bug.merge?.causalEvidence ?? []) {
    if (item.ref.startsWith('BUG-')) continue;
    for (const id of item.evidenceIds) if (refs.get(id)?.collectedBy) lanes.add(refs.get(id).collectedBy);
  }
  return lanes;
}

function filingLane(origin) {
  if (!filingPrefixLanes) {
    let matrix;
    try { matrix = JSON.parse(readFileSync(CAPABILITY_MATRIX_PATH, 'utf8')); }
    catch (error) { throw new Error(`cannot load capability matrix ${CAPABILITY_MATRIX_PATH}: ${error.message}`); }
    filingPrefixLanes = new Map();
    for (const agent of matrix.agents ?? []) {
      for (const path of agent.artifactPaths ?? []) {
        const prefix = /^bugs\/([A-Z]{3})-\*$/.exec(path)?.[1];
        if (prefix) filingPrefixLanes.set(prefix, agent.slug);
      }
    }
  }
  return filingPrefixLanes.get(origin.slice(0, 3)) ?? null;
}

// A merge across lanes (distinct origin prefixes; BUG refs name ledger rows, not lanes) must
// cite evidence from at least as many distinct collectors as it merges lanes.
function mergeCollectorErrors(bug, refs) {
  const lanes = new Set(bug.merge.causalEvidence.map(item => item.ref).filter(ref => !ref.startsWith('BUG-')).map(ref => ref.slice(0, 3)));
  if (lanes.size < 2) return [];
  const collectors = new Set(bug.merge.causalEvidence.flatMap(item => item.evidenceIds).map(id => refs.get(id)?.collectedBy).filter(Boolean));
  return collectors.size >= lanes.size ? [] : [`${bug.id}: merge must cite evidence collected by each merged lane`];
}

// Semantic rules the schema subset cannot express. A quarantined row is a row frozen by an
// integrity failure: it keeps the blocks of its submitted status, so the status-exclusive
// rules skip it, while its proof blocks are still checked.
export function validateFindingQuality(bugs) {
  const errors = [];
  const rows = new Map(bugs.map(bug => [bug.id, bug]));
  const origins = new Map();
  for (const bug of bugs) {
    for (const origin of bug.origin) {
      const owner = origins.get(origin);
      if (owner === undefined) origins.set(origin, bug.id);
      else if (owner !== bug.id) errors.push(`${bug.id}: origin ${origin} is already assigned to ${owner}`);
    }
    errors.push(...statusBlockErrors(bug, rows), ...mergeErrors(bug), ...proofErrors(bug));
  }
  return errors;
}

function statusBlockErrors(bug, rows) {
  const errors = [];
  if (bug.quarantine && bug.status !== 'quarantined') errors.push(`${bug.id}: quarantine is only valid for quarantined status`);
  if (bug.repair && bug.status === 'confirmed') errors.push(`${bug.id}: repair is not valid on a confirmed entry`);
  if (bug.verification?.oracle.invariantClass && bug.verification.oracle.kind !== 'justified-invariant') errors.push(`${bug.id}: invariantClass requires a justified-invariant oracle`);
  if (bug.status === 'quarantined') return errors;
  if (bug.missingProof && !MISSING_PROOF_STATUSES.has(bug.status)) errors.push(`${bug.id}: missingProof is only valid for suspected or needs-oracle status`);
  if (bug.rejection && bug.status !== 'rejected') errors.push(`${bug.id}: rejection is only valid for rejected status`);
  if (bug.duplicateOf !== undefined && bug.status !== 'duplicate') errors.push(`${bug.id}: duplicateOf is only valid for duplicate status`);
  if (bug.status === 'duplicate') {
    const target = rows.get(bug.duplicateOf);
    if (bug.duplicateOf === bug.id) errors.push(`${bug.id}: duplicateOf must name another entry`);
    else if (!target) errors.push(`${bug.id}: duplicateOf names unknown entry ${bug.duplicateOf}`);
    else if (!DUPLICATE_TARGET_STATUSES.has(target.status)) errors.push(`${bug.id}: duplicateOf target ${target.id} is ${target.status}; it must be confirmed, suspected, needs-oracle, or quarantined`);
  }
  if (bug.status === 'needs-oracle' && !bug.missingProof?.elements.includes('oracle')) errors.push(`${bug.id}: needs-oracle requires an oracle gap in missingProof`);
  if (bug.status === 'suspected' && bug.evidenceIds.length === 0 && !bug.missingProof?.elements.includes('evidence')) errors.push(`${bug.id}: a suspected entry without evidence requires an evidence gap in missingProof`);
  if (bug.status !== 'confirmed' && (bug.wired || bug.testId !== null)) errors.push(`${bug.id}: only a confirmed entry can be wired to a regression test`);
  if (bug.status === 'rejected' && bug.rejection.reason !== 'out-of-scope' && bug.rejection.evidenceIds.length === 0) errors.push(`${bug.id}: rejection requires evidence unless the reason is out-of-scope`);
  return errors;
}

// Multiple origins and every duplicate need a causal merge whose entries cite each merged
// reference exactly once, each with its own evidence.
function mergeErrors(bug) {
  if (bug.status === 'quarantined') return [];
  const required = bug.origin.length > 1 || bug.status === 'duplicate';
  if (!bug.merge) return required ? [`${bug.id}: multiple origins or a duplicate require a causal merge`] : [];
  if (!required) return [`${bug.id}: merge is only valid for a multi-origin or duplicate entry`];
  const errors = [];
  const refs = bug.merge.causalEvidence.map(item => item.ref);
  const expected = new Set(bug.status === 'duplicate' ? [...bug.origin, bug.duplicateOf] : bug.origin);
  if (new Set(refs).size !== refs.length || refs.length !== expected.size || !refs.every(ref => expected.has(ref))) {
    errors.push(`${bug.id}: merge causalEvidence must cite each ${bug.status === 'duplicate' ? 'origin and the duplicate target' : 'origin'} exactly once`);
  }
  const cited = new Set();
  for (const id of bug.merge.causalEvidence.flatMap(item => item.evidenceIds)) {
    if (cited.has(id)) { errors.push(`${bug.id}: merge causalEvidence entries must cite disjoint evidence, ${id} is shared`); break; }
    cited.add(id);
  }
  return errors;
}

function proofErrors(bug) {
  if (!PROVEN_STATUSES.has(bug.status)) return [];
  const proof = bug.verification;
  if (!proof) return bug.status === 'confirmed' ? [`${bug.id}: confirmed findings require verification`] : [];
  const errors = [];
  if (proof.reproduction.occurrences > proof.reproduction.attempts) errors.push(`${bug.id}: occurrences exceed attempts`);
  if ((proof.reproduction.occurrences < proof.reproduction.attempts || proof.reproduction.attempts === 1) && proof.independent.status === 'not-required') errors.push(`${bug.id}: intermittent or single-attempt confirmation requires independent reproduction or an explicit unavailable reason`);
  if (proof.independent.status === 'reproduced' && proof.independent.executor === bug.lane) errors.push(`${bug.id}: independent executor must differ from finder`);
  if ((['Critical', 'Blocker'].includes(bug.severity) || proof.disputedOracle) && proof.independent.status === 'not-required') errors.push(`${bug.id}: independent reproduction or an explicit unavailable reason is required`);
  return errors;
}

// Every evidence ID the coverage inputs cite (execution, assertion and control, outcome,
// case evidence, control and execution, and inventory discovery) must resolve in the registry
// and pass the digest, capture-time, and content checks; options match reconcileFindings.
export function reconcileCoverageEvidence(inventory, observations, evidence, readArtifact, options = {}) {
  if (inventory.engagementId !== observations.engagementId || inventory.engagementId !== evidence.engagementId) return ['coverage evidence engagement mismatch'];
  const refs = new Map(evidence.references.map(item => [item.id, item]));
  const checkEvidence = evidenceChecker(readArtifact, options);
  const errors = [];
  for (const { label, id } of coverageEvidenceReferences(inventory, observations)) {
    const ref = refs.get(id);
    if (!ref) { errors.push(`${label}: unresolved evidence ${id}`); continue; }
    errors.push(...checkEvidence(ref).map(error => `${label}: ${error}`));
  }
  return [...new Set(errors)];
}
