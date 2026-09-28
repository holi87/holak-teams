// Scoring v2 of the discovery evaluator. scoreRun() turns one private run
// (argus-eval/private-runs@2), its final verdicts (argus-eval/final-verdicts@1) and its replay
// summary (summarizeReplay() in lib/replay.mjs) into per-run metrics; aggregateRuns() pools the
// per-run results of one variant and mode. Seed IDs and acceptance criteria never reach the
// hunter: the verdicts come from an independent reading of reports and evidence. Only IDs and
// counts leave this module, never report text, verdict reasons, or evidence paths.
import { isDeepStrictEqual } from 'node:util';

export const CRITICAL_SEVERITIES = Object.freeze(['Critical', 'Blocker']);
const OUTCOMES = Object.freeze(['real', 'false-positive', 'duplicate']);
const LANE_FINDING_COUNTS = Object.freeze(['reported', 'real', 'falsePositive', 'duplicate', 'seedsDetected']);
const LANE_OUTCOME_COSTS = Object.freeze(['turnLimit', 'totalTokens']);

const total = values => values.reduce((sum, value) => sum + value, 0);
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
// The mean of the non-null values, or null when there are none.
const mean = values => {
  const present = values.filter(value => value !== null);
  return present.length ? total(present) / present.length : null;
};
const measured = value => (Number.isFinite(value) ? value : null);
const byId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// Lane names come from the hunter's ledger, so every keyed tally is a Map (a lane named
// `constructor` must not reach Object.prototype) and becomes an object, sorted by key, at the end.
const sortedObject = map => Object.fromEntries([...map].sort(([left], [right]) => byId(left, right)));
const tally = (map, key, create) => {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
};

// Checks every verdict against the run's extracted ledger rows and truth, and returns them by
// finding ID. A verdict must name an extracted row with the same status, at most once; it may
// credit only one of the run's seeds, and only with outcome real; a duplicate must cite another
// extracted row.
function indexVerdicts(run, verdicts) {
  const rows = new Map();
  for (const row of [...run.extraction.findings, ...run.extraction.suspected]) {
    if (rows.has(row.id)) throw new Error(`${run.runId}: ledger row ${row.id} was extracted twice`);
    rows.set(row.id, row);
  }
  const seeds = new Set(run.truth.map(seed => seed.id));
  const byFinding = new Map();
  for (const verdict of verdicts) {
    const label = `${run.runId} ${verdict.findingId}`;
    const row = rows.get(verdict.findingId);
    if (!row) throw new Error(`${label}: the verdict names no extracted ledger row of the run`);
    if (byFinding.has(verdict.findingId)) throw new Error(`${label}: the finding has more than one verdict`);
    if (verdict.status !== row.status) throw new Error(`${label}: the verdict records status ${verdict.status}, but the ledger row is ${row.status}`);
    if (!OUTCOMES.includes(verdict.outcome)) throw new Error(`${label}: outcome must be one of ${OUTCOMES.join(', ')}`);
    const seedId = verdict.seedId ?? null;
    if (seedId !== null && verdict.outcome !== 'real') throw new Error(`${label}: only a real outcome may credit a seed`);
    if (seedId !== null && !seeds.has(seedId)) throw new Error(`${label}: the verdict credits an unknown seed ${seedId}`);
    if (verdict.outcome === 'duplicate' && (verdict.duplicateOf === verdict.findingId || !rows.has(verdict.duplicateOf))) {
      throw new Error(`${label}: duplicateOf must name another extracted ledger row of the run`);
    }
    byFinding.set(verdict.findingId, { ...verdict, seedId });
  }
  return byFinding;
}

// Per run. `verdicts` are the run's final verdicts and `replaySummary` is summarizeReplay(run.replay)
// (null when the run was not replayed). Returns {status: 'unscored', reason: 'missing-verdict',
// missingVerdicts} when a confirmed finding has no verdict, otherwise {status: 'scored', metrics}.
// Throws when a verdict contradicts the run.
export function scoreRun(run, verdicts, replaySummary = null) {
  const verdictOf = indexVerdicts(run, verdicts);
  const confirmed = run.extraction.findings;
  const missingVerdicts = confirmed.filter(row => !verdictOf.has(row.id)).map(row => row.id);
  if (missingVerdicts.length) return { status: 'unscored', reason: 'missing-verdict', missingVerdicts };

  const outcomeOf = row => verdictOf.get(row.id).outcome;
  const seedOf = row => verdictOf.get(row.id).seedId;
  const real = confirmed.filter(row => outcomeOf(row) === 'real');
  const detected = new Set(real.map(seedOf).filter(id => id !== null));
  // Seeds credited only through judged suspected rows. They are reported, never counted as recall.
  const suspectedSeeds = new Set(run.extraction.suspected
    .map(row => verdictOf.get(row.id))
    .filter(verdict => verdict?.outcome === 'real' && verdict.seedId !== null && !detected.has(verdict.seedId))
    .map(verdict => verdict.seedId));
  const critical = run.truth.filter(seed => CRITICAL_SEVERITIES.includes(seed.severity));

  const perSurface = new Map();
  for (const seed of run.truth) {
    const entry = tally(perSurface, seed.surface, () => ({ seeded: 0, detected: 0 }));
    entry.seeded += 1;
    if (detected.has(seed.id)) entry.detected += 1;
  }

  const lanes = new Map();
  for (const row of confirmed) {
    const entry = tally(lanes, row.lane, () => ({ reported: 0, real: 0, falsePositive: 0, duplicate: 0, seeds: new Set() }));
    entry.reported += 1;
    const outcome = outcomeOf(row);
    if (outcome === 'real') {
      entry.real += 1;
      if (seedOf(row) !== null) entry.seeds.add(seedOf(row));
    } else if (outcome === 'false-positive') entry.falsePositive += 1;
    else entry.duplicate += 1;
  }
  // A lane's turn-limit decisions and telemetry tokens come from the controller's lane-outcomes
  // report when the run produced a valid one, and are null otherwise: a missing report cannot
  // honestly claim zero. Lookups go through a Map because lane names are run output.
  const laneOutcomes = run.extraction.laneOutcomes?.state === 'present'
    ? new Map(run.extraction.laneOutcomes.document.lanes.map(outcome => [outcome.agent, outcome]))
    : new Map();
  const perLane = sortedObject([...lanes].map(([lane, { seeds, ...counts }]) => {
    const outcome = laneOutcomes.get(lane);
    return [lane, {
      ...counts,
      seedsDetected: seeds.size,
      turnLimit: outcome ? outcome.decisions.turnLimit : null,
      totalTokens: outcome ? outcome.telemetry.totalTokens : null,
    }];
  }));

  // A bug's regression is fail-to-pass when it failed on every faulty repeat, passed on every
  // corrected repeat, and never changed outcome between repeats of one case.
  const factsOf = id => replaySummary?.bugs?.[id] ?? null;
  const failsToPass = id => {
    const facts = factsOf(id);
    return Boolean(facts && facts.failsOnFaulty && facts.passesOnFix && !facts.flaky);
  };
  const byFinding = Object.fromEntries(real.map(row => [row.id,
    verdictOf.get(row.id).humanReproduced === true ? 'human' : failsToPass(row.id) ? 'replay' : 'none']));
  const reproductions = Object.values(byFinding);
  const reproduction = {
    human: reproductions.filter(value => value === 'human').length,
    replay: reproductions.filter(value => value === 'replay').length,
    none: reproductions.filter(value => value === 'none').length,
    byFinding,
  };

  let regression = null;
  if (replaySummary && run.build === 'faulty') {
    const seeds = {};
    for (const seed of run.truth.filter(entry => detected.has(entry.id))) {
      const credited = real.filter(row => seedOf(row) === seed.id);
      seeds[seed.id] = {
        bugs: credited.map(row => row.id),
        hasWiredRegression: credited.some(row => row.wired),
        failToPass: credited.some(row => failsToPass(row.id)),
        specific: credited.some(row => failsToPass(row.id) && isDeepStrictEqual(factsOf(row.id).specificTo, [seed.id])),
        flaky: credited.some(row => factsOf(row.id)?.flaky === true),
      };
    }
    regression = {
      replayStatus: replaySummary.status,
      seeds,
      falseAlarms: real.filter(row => factsOf(row.id)?.falseAlarm === true).length,
      baselineGreenOnFix: replaySummary.baselineGreenOnFix,
    };
  }

  const usage = run.adapter.result?.usage ?? null;
  const reported = confirmed.length;
  return {
    status: 'scored',
    metrics: {
      seeded: run.truth.length,
      detectedSeeds: detected.size,
      detectedSeedIds: run.truth.filter(seed => detected.has(seed.id)).map(seed => seed.id),
      recall: ratio(detected.size, run.truth.length),
      criticalSeeded: critical.length,
      criticalRecall: ratio(critical.filter(seed => detected.has(seed.id)).length, critical.length),
      perSurface: sortedObject(perSurface),
      reported,
      real: real.length,
      realUnseeded: real.filter(row => seedOf(row) === null).length,
      falsePositive: confirmed.filter(row => outcomeOf(row) === 'false-positive').length,
      duplicate: confirmed.filter(row => outcomeOf(row) === 'duplicate').length,
      precision: ratio(real.length, reported),
      suspected: run.extraction.suspected.length,
      suspectedSeedHits: suspectedSeeds.size,
      perLane,
      reproduction,
      independentReproduction: ratio(reproduction.human + reproduction.replay, real.length),
      deliveryDefects: { ledger: run.extraction.ledger, unledgeredReports: run.extraction.unledgeredReports.length },
      usage: {
        tokens: measured(usage?.totalTokens),
        cost: measured(usage?.costUsd),
        numTurns: measured(usage?.numTurns),
        controllerTurnCapHit: typeof usage?.controllerTurnCapHit === 'boolean' ? usage.controllerTurnCapHit : null,
        elapsedMs: run.elapsedMs,
        timedOut: run.timedOut,
        overBudget: run.overBudget,
      },
      regression,
    },
  };
}

const measure = values => {
  const present = values.filter(value => value !== null);
  return { runs: present.length, total: present.length ? total(present) : null, mean: mean(present) };
};

// Pools the per-run results ({status, scoring, metrics}; see adjudicate.mjs) of one variant and
// mode. Only runs with scoring 'scored' contribute metrics; invalid and contaminated runs are
// counted. Recall means are over faulty runs; precision is pooled over every scored run.
export function aggregateRuns(results, { mode, judgeReliability }) {
  const scored = results.filter(result => result.scoring === 'scored');
  const metrics = scored.map(result => result.metrics);
  const faulty = scored.filter(result => result.build === 'faulty').map(result => result.metrics);
  const corrected = scored.filter(result => result.build === 'corrected').map(result => result.metrics);

  const surfaces = new Map();
  for (const run of faulty) {
    for (const [surface, counts] of Object.entries(run.perSurface)) {
      const entry = tally(surfaces, surface, () => ({ seeded: 0, detected: 0 }));
      entry.seeded += counts.seeded;
      entry.detected += counts.detected;
    }
  }
  const perSurfaceRecall = sortedObject([...surfaces].map(([surface, counts]) => [surface, { ...counts, recall: ratio(counts.detected, counts.seeded) }]));

  // Finding counts always sum; the lane-outcomes costs sum over the runs that measured them and
  // stay null when none did.
  const lanes = new Map();
  for (const run of metrics) {
    for (const [lane, counts] of Object.entries(run.perLane)) {
      const entry = tally(lanes, lane, () => ({ reported: 0, real: 0, falsePositive: 0, duplicate: 0, seedsDetected: 0, turnLimit: null, totalTokens: null }));
      for (const key of LANE_FINDING_COUNTS) entry[key] += counts[key];
      for (const key of LANE_OUTCOME_COSTS) {
        const value = counts[key] ?? null;
        if (value !== null) entry[key] = (entry[key] ?? 0) + value;
      }
    }
  }
  const perLane = sortedObject([...lanes].map(([lane, counts]) => [lane, { ...counts, precision: ratio(counts.real, counts.reported) }]));

  let regression = null;
  if (mode === 'A') {
    const replayed = faulty.filter(run => run.regression !== null).map(run => run.regression);
    const seeds = replayed.flatMap(run => Object.values(run.seeds));
    const count = key => seeds.filter(seed => seed[key]).length;
    regression = {
      faultyRuns: faulty.length,
      replayedRuns: replayed.length,
      detectedSeeds: seeds.length,
      withWiredRegression: count('hasWiredRegression'),
      failToPass: count('failToPass'),
      specific: count('specific'),
      flaky: count('flaky'),
      failToPassRate: ratio(count('failToPass'), seeds.length),
      specificRate: ratio(count('specific'), seeds.length),
      flakyRate: ratio(count('flaky'), seeds.length),
      falseAlarms: total(replayed.map(run => run.falseAlarms)),
      baselineGreenOnFixRate: ratio(replayed.filter(run => run.baselineGreenOnFix).length, replayed.length),
    };
  }

  const reported = total(metrics.map(run => run.reported));
  const real = total(metrics.map(run => run.real));
  const reproduced = total(metrics.map(run => run.reproduction.human + run.reproduction.replay));
  return {
    runs: scored.length,
    faultyRuns: faulty.length,
    correctedRuns: corrected.length,
    seedsPerFaultyRun: mean(faulty.map(run => run.seeded)),
    meanDetectedSeeds: mean(faulty.map(run => run.detectedSeeds)),
    meanRecall: mean(faulty.map(run => run.recall)),
    meanCriticalRecall: mean(faulty.map(run => run.criticalRecall)),
    perSurfaceRecall,
    reported,
    real,
    pooledPrecision: ratio(real, reported),
    falsePositivesOnCorrected: total(corrected.map(run => run.falsePositive)),
    meanRealUnseeded: mean(metrics.map(run => run.realUnseeded)),
    suspectedSeedHits: total(metrics.map(run => run.suspectedSeedHits)),
    independentReproduction: ratio(reproduced, real),
    regression,
    perLane,
    deliveryDefects: {
      ledgerMissing: metrics.filter(run => run.deliveryDefects.ledger === 'missing').length,
      ledgerInvalid: metrics.filter(run => run.deliveryDefects.ledger === 'invalid').length,
      unledgeredReports: total(metrics.map(run => run.deliveryDefects.unledgeredReports)),
    },
    usage: {
      tokens: measure(metrics.map(run => run.usage.tokens)),
      cost: measure(metrics.map(run => run.usage.cost)),
      numTurns: measure(metrics.map(run => run.usage.numTurns)),
      elapsedMs: measure(metrics.map(run => run.usage.elapsedMs)),
    },
    timedOutRuns: metrics.filter(run => run.usage.timedOut).length,
    overBudgetRuns: metrics.filter(run => run.usage.overBudget).length,
    controllerTurnCapHits: metrics.filter(run => run.usage.controllerTurnCapHit === true).length,
    invalidRuns: results.filter(result => result.status === 'invalid-run').length,
    contaminatedRuns: results.filter(result => result.status === 'contaminated').length,
    judgeReliability,
  };
}
