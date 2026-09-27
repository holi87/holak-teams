import { expect } from '@playwright/test';

// Boundary value and exact-sum oracles. The step is the domain's smallest unit (money
// 0.01, a count 1), never a blind integer +-1, and every sum is compared in scaled
// integers: floating-point money drifts by a penny exactly where these oracles look.

export type BoundaryPoint = { value: number; expected: 'accepted' | 'rejected'; actual: 'accepted' | 'rejected' };

/**
 * Three-point boundary value analysis: probe B - step, B, and B + step, in that order, and
 * require each documented outcome. `probe(value)` returns true when the product accepted
 * the value. The probe values are computed at the decimal precision of `boundary` and
 * `step`, so boundary 0.07 with step 0.01 probes exactly 0.06, 0.07, and 0.08. Call it once
 * per edge of a range.
 */
export async function boundary3(options: {
  boundary: number;
  step: number;
  probe: (value: number) => boolean | Promise<boolean>;
  acceptBelow: boolean;
  acceptAt: boolean;
  acceptAbove: boolean;
}): Promise<{ below: BoundaryPoint; at: BoundaryPoint; above: BoundaryPoint }> {
  const { boundary, step, probe } = options;
  if (!Number.isFinite(boundary)) throw new TypeError(`boundary3: boundary must be a finite number, got ${JSON.stringify(boundary)}`);
  if (!Number.isFinite(step) || step <= 0) throw new TypeError(`boundary3: step must be a finite number > 0 (the domain's smallest unit), got ${JSON.stringify(step)}`);
  if (typeof probe !== 'function') throw new TypeError('boundary3: probe must be a function');
  for (const name of ['acceptBelow', 'acceptAt', 'acceptAbove'] as const) {
    if (typeof options[name] !== 'boolean') throw new TypeError(`boundary3: ${name} must be a boolean`);
  }
  const plan: Array<['below' | 'at' | 'above', number, boolean]> = [
    ['below', addDecimal(boundary, -step), options.acceptBelow],
    ['at', boundary, options.acceptAt],
    ['above', addDecimal(boundary, step), options.acceptAbove],
  ];
  const points = {} as Record<'below' | 'at' | 'above', BoundaryPoint>;
  for (const [name, value, expected] of plan) {
    const result = await probe(value);
    if (typeof result !== 'boolean') throw new TypeError('boundary3: probe must return true (accepted) or false (rejected)');
    points[name] = { value, expected: verdict(expected), actual: verdict(result) };
  }
  const wrong = Object.values(points).filter((point) => point.expected !== point.actual);
  expect(
    wrong.length === 0,
    `boundary3 at ${boundary} (step ${step}): ${wrong.map((point) => `value ${point.value} expected ${point.expected}, got ${point.actual}`).join('; ')}`,
  ).toBe(true);
  return points;
}

/**
 * Money reconciles to the minor unit: the parts, parsed as decimal strings into integer
 * minor units (numbers are read through their shortest decimal form), must sum exactly to
 * the total. An amount with more fractional digits than `minorUnits` (default 2) is RED,
 * which is how floating-point money such as 0.30000000000000004 surfaces.
 */
export function moneyReconciles(parts: ReadonlyArray<string | number>, total: string | number, options: { minorUnits?: number } = {}): { sum: string; total: string } {
  const minorUnits = options.minorUnits ?? 2;
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 18) throw new TypeError(`moneyReconciles: minorUnits must be an integer from 0 to 18, got ${JSON.stringify(minorUnits)}`);
  if (!Array.isArray(parts)) throw new TypeError('moneyReconciles: parts must be an array of amounts');
  const problems: string[] = [];
  const minor = parts.map((part, index) => toScaled(part, minorUnits, `part ${index}`, problems));
  const expected = toScaled(total, minorUnits, 'total', problems);
  expect(problems.length === 0, `moneyReconciles: unusable amounts: ${problems.join('; ')}`).toBe(true);
  const sum = minor.reduce<bigint>((acc, value) => acc + (value ?? 0n), 0n);
  const target = expected ?? 0n;
  expect(
    sum === target,
    `moneyReconciles: the parts sum to ${formatScaled(sum, minorUnits)}, the total is ${formatScaled(target, minorUnits)} (difference ${formatScaled(sum - target, minorUnits)})`,
  ).toBe(true);
  return { sum: formatScaled(sum, minorUnits), total: formatScaled(target, minorUnits) };
}

/**
 * A percentage breakdown sums to exactly 100: each value is scaled to an integer at
 * `decimals` places (default 0) and the sum must equal 100 * 10^decimals. A value with more
 * fractional digits than `decimals` is RED.
 */
export function percentagesSumTo100(values: ReadonlyArray<string | number>, options: { decimals?: number } = {}): { sum: string } {
  const decimals = options.decimals ?? 0;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new TypeError(`percentagesSumTo100: decimals must be an integer from 0 to 18, got ${JSON.stringify(decimals)}`);
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('percentagesSumTo100: values must be a non-empty array');
  const problems: string[] = [];
  const scaled = values.map((value, index) => toScaled(value, decimals, `value ${index}`, problems));
  expect(problems.length === 0, `percentagesSumTo100: unusable values: ${problems.join('; ')}`).toBe(true);
  const sum = scaled.reduce<bigint>((acc, value) => acc + (value ?? 0n), 0n);
  const hundred = 100n * 10n ** BigInt(decimals);
  expect(sum === hundred, `percentagesSumTo100: the values sum to ${formatScaled(sum, decimals)}, not exactly 100`).toBe(true);
  return { sum: formatScaled(sum, decimals) };
}

/** a + b, rounded to the larger decimal precision of the two operands. */
export function addDecimal(a: number, b: number): number {
  const places = Math.min(20, Math.max(decimalPlaces(a), decimalPlaces(b)));
  return Number((a + b).toFixed(places));
}

/** Fractional digits in the shortest round-trip form of a finite number (1e-7 has 7). */
export function decimalPlaces(value: number): number {
  const match = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(value));
  if (!match) return 0;
  return Math.max(0, (match[1]?.length ?? 0) - (match[2] ? Number(match[2]) : 0));
}

/** Parse a decimal amount into an integer at `places`; a problem is recorded instead of thrown. */
function toScaled(value: string | number, places: number, label: string, problems: string[]): bigint | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${label} must be a decimal string or a number, got ${typeof value}`);
  const text = typeof value === 'number' ? String(value) : value;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    problems.push(`${label} ${JSON.stringify(text)} is not a plain decimal`);
    return undefined;
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > places && /[^0]/.test(fraction.slice(places))) {
    problems.push(`${label} ${text} has more than ${places} decimal places`);
    return undefined;
  }
  const scaled = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.slice(0, places).padEnd(places, '0') || '0');
  return sign === '-' ? -scaled : scaled;
}

function formatScaled(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = places > 0 ? `.${digits.slice(digits.length - places)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

function verdict(value: boolean): 'accepted' | 'rejected' {
  return value ? 'accepted' : 'rejected';
}
