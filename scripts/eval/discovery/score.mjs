// Human/model adjudication must read reports and replay their evidence independently.
// Seed IDs and private acceptance criteria are never provided to the hunter adapter.
export function scoreRun({ truth, findings, verdicts, elapsedMs, tokens, cost }) {
  const ids = new Set(findings.map(item => item.id));
  if (ids.size !== findings.length || findings.some(item => !item.id)) throw new Error('finding IDs must be unique');
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) throw new Error('missing or invalid measured usage');
  const byId = new Map(verdicts.map(item => [item.findingId, item]));
  if (byId.size !== verdicts.length || verdicts.some(item => !ids.has(item.findingId))) throw new Error('unknown or duplicate verdict');
  if (findings.some(item => !byId.has(item.id))) return { status: 'unscored', reason: 'Unadjudicated findings remain' };
  const seedIds = new Set(truth.map(item => item.id));
  const detected = new Set(); let real = 0, independentlyReproduced = 0;
  const confirmations = [];
  for (const finding of findings) {
    const verdict = byId.get(finding.id);
    if (!['real', 'false-positive', 'duplicate'].includes(verdict.outcome) || !verdict.reason || !verdict.evidenceRef || typeof verdict.independentlyReproduced !== 'boolean') throw new Error('verdict requires judgment, evidence, and reproduction outcome');
    if (verdict.seedId && !seedIds.has(verdict.seedId)) throw new Error('verdict credits an unknown seed');
    if (verdict.outcome === 'real') {
      real++;
      if (!Number.isFinite(verdict.confirmedAtMs) || verdict.confirmedAtMs < 0 || verdict.confirmedAtMs > elapsedMs) throw new Error('invalid confirmation timing');
      confirmations.push(verdict.confirmedAtMs);
      if (verdict.independentlyReproduced) independentlyReproduced++;
      if (verdict.seedId) detected.add(verdict.seedId);
    }
  }
  const high = truth.filter(item => ['Critical', 'Blocker'].includes(item.severity));
  return { status: 'scored', seeded: truth.length, detected: detected.size, reported: findings.length, real,
    recall: truth.length ? detected.size / truth.length : null,
    criticalRecall: high.length ? high.filter(item => detected.has(item.id)).length / high.length : null,
    precision: findings.length ? real / findings.length : null,
    independentReproduction: real ? independentlyReproduced / real : null,
    firstConfirmedMs: confirmations.length ? Math.min(...confirmations) : null,
    elapsedMs, tokens, cost, costPerConfirmed: real ? cost / real : null };
}
