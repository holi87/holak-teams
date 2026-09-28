import { expect } from '@playwright/test';

// Growth-rate oracle for N+1 and over-fetch defects. It needs no latency budget: it compares
// the product with itself at several collection sizes and requires the cost of one read to
// grow sub-linearly. The size is how many records the collection (or the parent's child
// collection) holds, never the page size: a read of one fixed-size page, or of an
// aggregate, should stay nearly flat in payload and grow slowly in time. A per-item query
// fan-out shows up as a time exponent near 1, a server that returns everything as a bytes
// exponent near 1.

export type ScalingSample = { size: number; ms: number; bytes: number };

export type ScalingPoint = ScalingSample & { runs: number };

export type ScalingThresholds = { maxTimeExponent?: number; maxBytesExponent?: number };

export type ScalingAnalysis = {
  /** The median ms and bytes per size, in ascending size order. */
  points: ScalingPoint[];
  timeExponent: number;
  bytesExponent: number;
  ok: boolean;
  violations: string[];
};

/**
 * Take the median ms and bytes per size (the mean of the two middle values for an even
 * count) and compute each growth exponent from the smallest and the largest size:
 * log(m_last / m_first) / log(s_last / s_first). 1 is linear growth, 0 is flat. Equal
 * medians give 0, and a median that grows from 0 gives Infinity. The analysis is ok when
 * timeExponent <= maxTimeExponent (default 0.5) and bytesExponent <= maxBytesExponent
 * (default 0.1). Pure: it returns every violation and never asserts.
 */
export function analyzeScaling(samples: ReadonlyArray<ScalingSample>, thresholds: ScalingThresholds = {}): ScalingAnalysis {
  const { maxTimeExponent, maxBytesExponent } = readThresholds(thresholds, 'analyzeScaling');
  if (!Array.isArray(samples) || samples.length === 0) throw new TypeError('analyzeScaling: samples must be a non-empty array of {size, ms, bytes}');
  const bySize = new Map<number, ScalingSample[]>();
  samples.forEach((sample, index) => {
    if (sample === null || typeof sample !== 'object') throw new TypeError(`analyzeScaling: sample ${index} must be {size, ms, bytes}`);
    const { size, ms, bytes } = sample;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) throw new TypeError(`analyzeScaling: sample ${index} size must be a finite number > 0, got ${JSON.stringify(size)}`);
    for (const [label, value] of [['ms', ms], ['bytes', bytes]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`analyzeScaling: sample ${index} ${label} must be a finite number >= 0, got ${JSON.stringify(value)}`);
    }
    const group = bySize.get(size) ?? [];
    group.push({ size, ms, bytes });
    bySize.set(size, group);
  });
  if (bySize.size < 2) throw new TypeError('analyzeScaling: samples must cover at least two distinct sizes');
  const points = [...bySize.entries()]
    .sort(([a], [b]) => a - b)
    .map(([size, group]) => ({ size, ms: median(group.map((sample) => sample.ms)), bytes: median(group.map((sample) => sample.bytes)), runs: group.length }));
  const first = points[0];
  const last = points[points.length - 1];
  const timeExponent = exponent(first.ms, last.ms, first.size, last.size);
  const bytesExponent = exponent(first.bytes, last.bytes, first.size, last.size);
  const violations: string[] = [];
  if (timeExponent > maxTimeExponent) {
    violations.push(`time exponent ${format(timeExponent)} > ${maxTimeExponent} (median ${format(first.ms)} ms at size ${first.size} -> ${format(last.ms)} ms at size ${last.size})`);
  }
  if (bytesExponent > maxBytesExponent) {
    violations.push(`bytes exponent ${format(bytesExponent)} > ${maxBytesExponent} (median ${format(first.bytes)} bytes at size ${first.size} -> ${format(last.bytes)} bytes at size ${last.size})`);
  }
  return { points, timeExponent, bytesExponent, ok: violations.length === 0, violations };
}

/**
 * Measure one read at every size and require sub-linear growth. `measure(size)` arranges a
 * collection of `size` records (idempotently: it is called several times per size) and
 * returns {ms, bytes} for one read. `sizes` holds at least three ascending sizes; for a
 * paged read the smallest one fills the page, so a correct payload stays flat. Per size,
 * the first `warmup` measurements (default 1) are discarded and the next `runs` (default 5)
 * are kept; analyzeScaling judges the kept samples against the thresholds.
 */
export async function n1Scaling(options: {
  measure: (size: number) => { ms: number; bytes: number } | Promise<{ ms: number; bytes: number }>;
  sizes: ReadonlyArray<number>;
  runs?: number;
  warmup?: number;
} & ScalingThresholds): Promise<ScalingAnalysis> {
  const { measure, sizes } = options;
  const runs = options.runs ?? 5;
  const warmup = options.warmup ?? 1;
  if (typeof measure !== 'function') throw new TypeError('n1Scaling: measure must be a function');
  if (!Array.isArray(sizes) || sizes.length < 3) throw new TypeError('n1Scaling: sizes must list at least three collection sizes');
  sizes.forEach((size, index) => {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) throw new TypeError(`n1Scaling: sizes[${index}] must be a finite number > 0, got ${JSON.stringify(size)}`);
    if (index > 0 && size <= sizes[index - 1]) throw new TypeError('n1Scaling: sizes must be strictly ascending');
  });
  if (!Number.isSafeInteger(runs) || runs < 1) throw new TypeError(`n1Scaling: runs must be a positive integer, got ${JSON.stringify(runs)}`);
  if (!Number.isSafeInteger(warmup) || warmup < 0) throw new TypeError(`n1Scaling: warmup must be a non-negative integer, got ${JSON.stringify(warmup)}`);
  const thresholds = readThresholds(options, 'n1Scaling');
  const samples: ScalingSample[] = [];
  for (const size of sizes) {
    for (let call = 0; call < warmup + runs; call += 1) {
      const measured = await measure(size);
      if (measured === null || typeof measured !== 'object') throw new TypeError(`n1Scaling: measure(${size}) must return {ms, bytes}`);
      if (call >= warmup) samples.push({ size, ms: measured.ms, bytes: measured.bytes });
    }
  }
  const analysis = analyzeScaling(samples, thresholds);
  const table = analysis.points.map((point) => `size ${point.size}: ${format(point.ms)} ms, ${format(point.bytes)} bytes`).join('; ');
  expect(analysis.ok, `n1Scaling: the read does not scale sub-linearly: ${analysis.violations.join('; ')}\nmedians: ${table}`).toBe(true);
  return analysis;
}

function readThresholds(thresholds: ScalingThresholds, label: string): Required<ScalingThresholds> {
  const maxTimeExponent = thresholds.maxTimeExponent ?? 0.5;
  const maxBytesExponent = thresholds.maxBytesExponent ?? 0.1;
  for (const [name, value] of [['maxTimeExponent', maxTimeExponent], ['maxBytesExponent', maxBytesExponent]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}: ${name} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return { maxTimeExponent, maxBytesExponent };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function exponent(firstValue: number, lastValue: number, firstSize: number, lastSize: number): number {
  if (firstValue === lastValue) return 0;
  if (firstValue === 0) return Infinity;
  if (lastValue === 0) return -Infinity;
  return Math.log(lastValue / firstValue) / Math.log(lastSize / firstSize);
}

function format(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : String(value);
}
