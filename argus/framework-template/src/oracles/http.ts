import { expect } from '@playwright/test';

// Exact HTTP status oracles. A status is one documented integer, never a class: "any 2xx"
// or [401, 403] hides the defects Argus hunts. Every RED goes through Playwright's expect,
// so the outcome adapter classifies it as a product failure; usage errors throw TypeError.

/** A Playwright APIResponse or browser Response, or a plain {status, body} record. */
export type HttpResult =
  | {
      status(): number;
      url(): string;
      headers(): Record<string, string>;
      text(): Promise<string>;
      request?: () => { method(): string };
    }
  | { status: number; body?: unknown; headers?: Record<string, string>; url?: string; method?: string };

export type HttpSnapshot = {
  status: number;
  method: string;
  url: string;
  /** Lowercase header names. */
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, the raw text otherwise, undefined when empty. */
  body: unknown;
  empty: boolean;
};

export type RestState =
  | 'created'
  | 'deleted'
  | 'missing'
  | 'method-not-allowed'
  | 'unsupported-media-type'
  | 'malformed'
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'ok';

/** The one status code each REST state maps to. */
export const REST_STATUS: Readonly<Record<RestState, number>> = Object.freeze({
  created: 201,
  deleted: 204,
  missing: 404,
  'method-not-allowed': 405,
  'unsupported-media-type': 415,
  malformed: 400,
  unauthenticated: 401,
  forbidden: 403,
  conflict: 409,
  ok: 200,
});

const SECRET_KEY = /authorization|token|password|secret|cookie/i;
const REDACTED = '[REDACTED]';

/** Read status, headers, and body once; the method comes from the result or `method`. */
export async function readResult(res: HttpResult, method?: string): Promise<HttpSnapshot> {
  if (typeof res.status === 'function') {
    const live = res as Extract<HttpResult, { status(): number }>;
    let text = '';
    try {
      text = await live.text();
    } catch {
      text = '';
    }
    let recorded = method;
    try {
      recorded ??= live.request?.().method();
    } catch {
      recorded = method;
    }
    return {
      status: live.status(),
      method: recorded ?? '-',
      url: live.url(),
      headers: lowerCaseKeys(live.headers()),
      body: text === '' ? undefined : parseText(text),
      empty: text === '',
    };
  }
  const record = res as Extract<HttpResult, { status: number }>;
  const { body } = record;
  return {
    status: record.status,
    method: method ?? record.method ?? '-',
    url: record.url ?? '-',
    headers: lowerCaseKeys(record.headers ?? {}),
    body,
    empty: body === undefined || body === null || body === '',
  };
}

/** A body excerpt of at most `limit` characters with secret-looking keys and values masked. */
export function redactedExcerpt(body: unknown, limit = 500): string {
  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return clip(maskText(body), limit);
    }
  }
  if (value === undefined) return '(empty)';
  let text: string;
  try {
    text = JSON.stringify(redact(value, new WeakSet())) ?? String(value);
  } catch {
    text = '(unserializable body)';
  }
  return clip(text, limit);
}

/** Assert the exact status code; the failure names method, URL, and a redacted body excerpt. */
export async function expectStatus(res: HttpResult, exact: number, options: { method?: string } = {}): Promise<void> {
  requireStatusCode(exact, 'expectStatus: exact');
  const status = typeof res.status === 'function' ? res.status() : res.status;
  if (status === exact) {
    expect(status).toBe(exact);
    return;
  }
  const snapshot = await readResult(res, options.method);
  expect(status, `expected HTTP ${exact}, got ${status}: ${describeResult(snapshot)}`).toBe(exact);
}

/**
 * Assert a REST state with its exact code: created=201 with a non-empty Location,
 * deleted=204 with an empty body, method-not-allowed=405 with Allow, missing=404,
 * unsupported-media-type=415, malformed=400, unauthenticated=401, forbidden=403,
 * conflict=409, ok=200. `documentedStatus` replaces the code with the one the API
 * documents (one exact integer, never a class); the Location, empty-body, and Allow
 * requirements belong to the standard code and apply only when it is the expected one.
 */
export async function assertRestStatus(
  res: HttpResult,
  state: RestState,
  options: { documentedStatus?: number; method?: string } = {},
): Promise<void> {
  const standard = Object.prototype.hasOwnProperty.call(REST_STATUS, state) ? REST_STATUS[state] : undefined;
  if (standard === undefined) throw new TypeError(`assertRestStatus: unknown state ${JSON.stringify(state)}`);
  if (options.documentedStatus !== undefined) {
    requireStatusCode(options.documentedStatus, 'assertRestStatus: documentedStatus (one exact code, never a class)');
  }
  const expected = options.documentedStatus ?? standard;
  const snapshot = await readResult(res, options.method);
  expect(snapshot.status, `${state}: expected HTTP ${expected}, got ${snapshot.status}: ${describeResult(snapshot)}`).toBe(expected);
  if (expected !== standard) return;
  if (state === 'created') {
    const location = (snapshot.headers.location ?? '').trim();
    expect(location !== '', `created: HTTP 201 without a non-empty Location header: ${describeResult(snapshot)}`).toBe(true);
  } else if (state === 'deleted') {
    expect(snapshot.empty, `deleted: HTTP 204 with a non-empty body: ${describeResult(snapshot)}`).toBe(true);
  } else if (state === 'method-not-allowed') {
    const allow = (snapshot.headers.allow ?? '').trim();
    expect(allow !== '', `method-not-allowed: HTTP 405 without an Allow header: ${describeResult(snapshot)}`).toBe(true);
  }
}

/** "method=GET url=http://… body: {…}" with secrets masked; used in every oracle message. */
export function describeResult(snapshot: HttpSnapshot, includeBody = true): string {
  const where = `method=${snapshot.method} url=${redactUrl(snapshot.url)}`;
  return includeBody ? `${where}\nbody: ${redactedExcerpt(snapshot.body)}` : where;
}

function requireStatusCode(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new TypeError(`${label} must be one integer HTTP status code (100-599), got ${JSON.stringify(value)}`);
  }
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value;
  return result;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, seen);
  return result;
}

function maskText(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/([A-Za-z0-9_-]*(?:authorization|token|password|secret|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^"'&\s,;}]+/gi, `$1${REDACTED}`);
}

function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return maskText(url);
  }
  parsed.username = '';
  parsed.password = '';
  for (const name of [...new Set(parsed.searchParams.keys())]) {
    if (SECRET_KEY.test(name)) parsed.searchParams.set(name, REDACTED);
  }
  return parsed.toString();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}
