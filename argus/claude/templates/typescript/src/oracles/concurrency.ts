import { expect } from '@playwright/test';
import { HttpResult } from './http';

// Concurrency oracles. Two submits of one commit-style action and N contenders for a
// scarce resource are fired together, not one after another: a check-then-act race only
// shows when the requests overlap. Every call starts in the same tick, and each oracle
// judges the outcome only after every call has settled.

export type DoubleSubmitResult = { before: number; after: number; delta: number };

export type RaceResult = {
  /** Calls answered 2xx. */
  succeeded: number;
  /** Calls answered with any other status. */
  failed: number;
  /** Every call's status, in call order. */
  statuses: number[];
};

/**
 * Fire `action` twice at once (Promise.all) and require the effect count to grow by
 * exactly `expectedDelta` (default 1): a second order, payment, or enrollment from one
 * double-clicked submit is RED. `countEffects()` reads the effect count (for example the
 * length of the orders list) before and after; pass the delta the action contract names,
 * 2 when two submits are two legitimate effects.
 */
export async function doubleSubmit(options: {
  action: () => Promise<unknown>;
  countEffects: () => number | Promise<number>;
  expectedDelta?: number;
}): Promise<DoubleSubmitResult> {
  const { action, countEffects } = options;
  const expectedDelta = options.expectedDelta ?? 1;
  if (typeof action !== 'function' || typeof countEffects !== 'function') throw new TypeError('doubleSubmit: action and countEffects must be functions');
  if (!Number.isSafeInteger(expectedDelta) || expectedDelta < 0) throw new TypeError(`doubleSubmit: expectedDelta must be a non-negative integer, got ${JSON.stringify(expectedDelta)}`);
  const before = await readCount(countEffects);
  await Promise.all([action(), action()]);
  const after = await readCount(countEffects);
  const delta = after - before;
  expect(delta, `doubleSubmit: two simultaneous submits changed the effect count by ${delta} (${before} -> ${after}), expected exactly ${expectedDelta}`).toBe(expectedDelta);
  return { before, after, delta };
}

/**
 * Start `n` calls of `action(index)` at once (Promise.allSettled) against one scarce
 * resource and judge them after all have settled: no call may answer 5xx, at most
 * `capacity` calls may succeed (2xx) when a capacity is given, and `invariant(result)`
 * must return true (for example: the stock read back afterwards is not negative and the
 * bookings do not exceed the seats). `index` lets each contender use its own account. A
 * call that rejects has no HTTP answer to judge: once every call has settled, the first
 * rejection is rethrown as it is, so a usage error stays an automation failure and a
 * refused connection stays an infrastructure one.
 */
export async function concurrentRace(options: {
  n: number;
  action: (index: number) => Promise<HttpResult>;
  capacity?: number;
  invariant: (result: RaceResult) => boolean | Promise<boolean>;
}): Promise<RaceResult> {
  const { n, action, capacity, invariant } = options;
  if (!Number.isSafeInteger(n) || n < 2) throw new TypeError(`concurrentRace: n must be an integer >= 2, got ${JSON.stringify(n)}`);
  if (typeof action !== 'function' || typeof invariant !== 'function') throw new TypeError('concurrentRace: action and invariant must be functions');
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0)) {
    throw new TypeError(`concurrentRace: capacity must be a non-negative integer, got ${JSON.stringify(capacity)}`);
  }
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, index) => action(index)));
  const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
  const statuses = settled.map((outcome, index) => statusOf((outcome as PromiseFulfilledResult<HttpResult>).value, index));
  const succeeded = statuses.filter((status) => status >= 200 && status < 300).length;
  const result: RaceResult = { succeeded, failed: n - succeeded, statuses };
  const holds = await invariant({ ...result, statuses: [...statuses] });
  if (typeof holds !== 'boolean') throw new TypeError('concurrentRace: invariant must return true (holds) or false (violated)');
  const problems: string[] = [];
  const serverErrors = statuses.map((status, index) => ({ status, index })).filter(({ status }) => status >= 500);
  if (serverErrors.length > 0) problems.push(`${serverErrors.length} call(s) answered 5xx: ${serverErrors.map(({ status, index }) => `call ${index} HTTP ${status}`).join(', ')}`);
  if (capacity !== undefined && succeeded > capacity) problems.push(`${succeeded} call(s) succeeded for a capacity of ${capacity}`);
  if (!holds) problems.push('the invariant does not hold after the race');
  expect(problems.length === 0, `concurrentRace (n=${n}): ${problems.join('; ')}\nstatuses: ${statuses.join(', ')}`).toBe(true);
  return result;
}

async function readCount(countEffects: () => number | Promise<number>): Promise<number> {
  const count = await countEffects();
  if (typeof count !== 'number' || !Number.isFinite(count)) throw new TypeError('doubleSubmit: countEffects must return a finite number');
  return count;
}

function statusOf(res: HttpResult, index: number): number {
  const status = res !== null && typeof res === 'object' ? (typeof res.status === 'function' ? res.status() : res.status) : undefined;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError(`concurrentRace: action(${index}) must resolve to an HTTP response or a {status} record`);
  }
  return status;
}
