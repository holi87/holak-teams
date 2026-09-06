import { createHash } from 'node:crypto';

// Reconcile only at the canonical merge boundary, after evidence owners have published.
// readArtifact must enforce the engagement's physical-path boundary and alias policy.
export function reconcileFindings(ledger, evidence, readArtifact) {
  const errors = [];
  if (ledger.engagementId !== evidence.engagementId) return ['evidence engagementId does not match ledger'];
  const refs = new Map(evidence.references.map(item => [item.id, item]));
  for (const bug of ledger.bugs.filter(item => item.status === 'confirmed')) {
    const proof = bug.verification;
    if (!proof) { errors.push(`${bug.id}: verification is required`); continue; }
    const ids = new Set([...bug.evidenceIds, proof.oracle.evidenceId, ...proof.reproduction.evidenceIds, ...proof.independent.evidenceIds]);
    for (const id of ids) {
      const ref = refs.get(id);
      if (!ref) { errors.push(`${bug.id}: unresolved evidence ${id}`); continue; }
      try {
        const bytes = readArtifact(ref.source);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== ref.sha256) errors.push(`${bug.id}: evidence digest drift ${id}`);
        if (!Number.isFinite(Date.parse(ref.capturedAt)) || Date.parse(ref.capturedAt) > Date.now() + 60000) errors.push(`${bug.id}: invalid evidence time ${id}`);
      } catch { errors.push(`${bug.id}: missing or unsafe evidence ${id}`); }
    }
    if (!bug.evidenceIds.some(id => proof.reproduction.evidenceIds.includes(id))) errors.push(`${bug.id}: reproduction is not linked to finding evidence`);
    if (proof.independent.status === 'reproduced') {
      for (const id of proof.independent.evidenceIds) {
        if (refs.get(id)?.collectedBy !== proof.independent.executor) errors.push(`${bug.id}: independent evidence owner mismatch`);
        if (proof.reproduction.evidenceIds.includes(id)) errors.push(`${bug.id}: independent reproduction reuses original evidence`);
      }
    }
  }
  return errors;
}

export function validateFindingQuality(bugs) {
  const errors = [];
  for (const bug of bugs) {
    if (bug.status !== 'confirmed') continue;
    const proof = bug.verification;
    if (!proof) { errors.push(`${bug.id}: confirmed findings require verification`); continue; }
    if (proof.reproduction.occurrences > proof.reproduction.attempts) errors.push(`${bug.id}: occurrences exceed attempts`);
    if (proof.independent.status === 'reproduced' && proof.independent.executor === bug.lane) errors.push(`${bug.id}: independent executor must differ from finder`);
    if ((['Critical', 'Blocker'].includes(bug.severity) || proof.disputedOracle) && proof.independent.status === 'not-required') errors.push(`${bug.id}: independent reproduction or an explicit unavailable reason is required`);
    if (bug.origin.length > 1 && !proof.mergeRationale) errors.push(`${bug.id}: multiple origins require a causal merge rationale`);
  }
  return errors;
}

export function reconcileCaseEvidence(inventory, observations, evidence, readArtifact) {
  const errors = [];
  if (inventory.engagementId !== observations.engagementId || inventory.engagementId !== evidence.engagementId) return ['coverage evidence engagement mismatch'];
  const refs = new Map(evidence.references.map(item => [item.id, item]));
  for (const observation of observations.observations) {
    for (const item of observation.cases ?? []) {
      for (const id of [...item.evidenceIds, ...item.controlEvidenceIds]) {
        const ref = refs.get(id);
        if (!ref) { errors.push(`${item.obligationId}: unresolved evidence ${id}`); continue; }
        try {
          if (createHash('sha256').update(readArtifact(ref.source)).digest('hex') !== ref.sha256) errors.push(`${item.obligationId}: stale evidence ${id}`);
        } catch { errors.push(`${item.obligationId}: missing or unsafe evidence ${id}`); }
      }
    }
  }
  return errors;
}
