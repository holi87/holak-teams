import { expect } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { describeResult, HttpResult, readResult, redactedExcerpt } from './http';

// Idempotency oracles. A replayed idempotent request (PUT, DELETE, or a POST carrying an
// idempotency key) must not change the intended effect a second time (RFC 9110 §9.2.2).

export type ReplayResult = { status: number; body: unknown; state?: unknown };

/**
 * Send the same request twice and require equal state from the independent `read` oracle.
 * Responses may differ; use `requireSameResponse` only when the API contract requires
 * equal statuses and bodies. `volatileFields` removes named keys at any depth in both checks.
 */
export async function idempotentReplay(options: {
  send: () => Promise<HttpResult>;
  read?: () => unknown | Promise<unknown>;
  volatileFields?: string[];
  requireSameResponse?: boolean;
}): Promise<ReplayResult> {
  const { send, read } = options;
  if (typeof read !== 'function') throw new TypeError('idempotentReplay: read() is required to verify the intended effect');
  const volatile = new Set(options.volatileFields ?? []);
  const first = await readResult(await send());
  const stateAfterFirst = await read();
  const second = await readResult(await send());
  const stateAfterSecond = await read();
  if (options.requireSameResponse) {
    expect(second.status, `idempotent replay changed the status from ${first.status} to ${second.status}: ${describeResult(second)}`).toBe(first.status);
    const firstBody = withoutVolatile(first.body, volatile);
    const secondBody = withoutVolatile(second.body, volatile);
    expect(
      isDeepStrictEqual(firstBody, secondBody),
      `idempotent replay changed the body: ${describeResult(second, false)}\nfirst:  ${redactedExcerpt(firstBody)}\nreplay: ${redactedExcerpt(secondBody)}`,
    ).toBe(true);
  }
  const before = withoutVolatile(stateAfterFirst, volatile);
  const after = withoutVolatile(stateAfterSecond, volatile);
  expect(
    isDeepStrictEqual(before, after),
    `idempotent replay changed the state read back\nafter first:  ${redactedExcerpt(before)}\nafter replay: ${redactedExcerpt(after)}`,
  ).toBe(true);
  return { status: first.status, body: first.body, state: stateAfterSecond };
}

let sequence = 0;

/**
 * The next deterministic idempotency key, 'argus-idem-<seq>'. The sequence is per worker
 * process; against an environment that keeps keys across runs, reset it first.
 */
export function nextIdempotencyKey(): string {
  sequence += 1;
  return `argus-idem-${sequence}`;
}

/**
 * Send one create twice with the same idempotency key. Exactly one effect must exist
 * (count after == count before + 1) and both responses must name the same id.
 */
export async function replayWithIdempotencyKey<R>(options: {
  send: (key: string) => Promise<R>;
  count: () => number | Promise<number>;
  idOf: (response: R) => unknown | Promise<unknown>;
}): Promise<{ key: string; id: unknown }> {
  const { send, count, idOf } = options;
  const key = nextIdempotencyKey();
  const before = await count();
  const first = await send(key);
  const second = await send(key);
  const after = await count();
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    throw new TypeError('replayWithIdempotencyKey: count() must return a finite number');
  }
  const firstId = await idOf(first);
  const secondId = await idOf(second);
  expect(after, `idempotency key ${key}: expected exactly one effect (count ${before} -> ${before + 1}), observed ${after}`).toBe(before + 1);
  expect(firstId !== undefined && firstId !== null && firstId !== '', `idempotency key ${key}: the first response carries no id`).toBe(true);
  expect(
    isDeepStrictEqual(firstId, secondId),
    `idempotency key ${key}: the replay returned a different id (${redactedExcerpt(firstId, 80)} then ${redactedExcerpt(secondId, 80)})`,
  ).toBe(true);
  return { key, id: firstId };
}

function withoutVolatile(value: unknown, volatile: Set<string>): unknown {
  if (volatile.size === 0 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withoutVolatile(item, volatile));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!volatile.has(key)) result[key] = withoutVolatile(item, volatile);
  }
  return result;
}
