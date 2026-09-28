import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { APIRequestContext, test, expect } from '@playwright/test';
import { StubHandler, StubServer } from '../../src/argus/stub-server';
import {
  assertCollectionConservation,
  boundary3,
  caseVariants,
  credentialConsistency,
  Credentials,
  expectStatus,
  I18N_VECTORS,
  i18nCharset,
  IDENTITY_VECTORS,
  invalidEmails,
  invalidObjectPartitions,
  invalidPartitions,
  moneyReconciles,
  PageRequest,
  PageResult,
  paginateAll,
  Partition,
  percentagesSumTo100,
  validEmail,
} from '../../src/oracles';

// Self-tests for the data oracles: every helper passes on a correct in-memory or stub
// implementation and fails on a faulty one. Nothing contacts a real target; each stub binds
// 127.0.0.1 on an ephemeral port and lives for one test. Negative cases assert the
// rejection itself, so a healthy run reports `product pass` for every case.

type Item = { id: number };

// The reference validator for the partition cases: JSON Schema 2020-12 with full formats.
// multipleOfPrecision keeps decimal multiples such as 19.99 of 0.01 valid.
const ajv = new Ajv2020({ allErrors: true, strict: false, multipleOfPrecision: 9 });
addFormats(ajv, { mode: 'full' });

const ORDER_SCHEMA = {
  type: 'object',
  required: ['sku', 'qty'],
  properties: {
    id: { type: 'integer', readOnly: true },
    sku: { type: 'string', minLength: 3, maxLength: 12, pattern: '^[A-Za-z0-9-]+$' },
    qty: { type: 'integer', minimum: 1, maximum: 99 },
    note: { type: ['string', 'null'], maxLength: 20 },
  },
  additionalProperties: false,
};
const VALID_ORDER = { sku: 'SKU-1', qty: 2, note: null };
const PROFILE_MAX_LENGTH = 20;

async function withStub(handler: StubHandler, body: (stub: StubServer) => Promise<void>): Promise<void> {
  const stub = await StubServer.start({ handler });
  try {
    await body(stub);
  } finally {
    await stub.stop();
  }
}

function labels(partitions: Partition[]): string[] {
  return partitions.map((partition) => partition.label);
}

function codePoints(value: string): number[] {
  return [...value].map((char) => char.codePointAt(0) ?? 0);
}

/** POST /orders answers 201 when `schema` accepts the body and 400 otherwise. */
function orderEndpoint(schema: object): StubHandler {
  const validate = ajv.compile(schema);
  return (request) => {
    if (request.method !== 'POST' || request.path !== '/orders') return undefined;
    return validate(request.body) ? { status: 201, body: { id: 1 } } : { status: 400, body: { error: 'invalid order' } };
  };
}

function postJson(request: APIRequestContext, url: string, value: unknown) {
  return request.post(url, { headers: { 'content-type': 'application/json' }, data: JSON.stringify(value) });
}

/**
 * GET /items?page=&pageSize= over `count` items with 1-based pages. Faults: `overlap` starts
 * every page after the first one item early (the last item of a page repeats), `totalDrift`
 * reports a wrong total, `ignorePage` serves the first page for every page number.
 */
function pageStub(count: number, faults: { overlap?: boolean; totalDrift?: number; ignorePage?: boolean } = {}): StubHandler {
  const items: Item[] = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
  return (request) => {
    if (request.method !== 'GET' || request.path !== '/items') return undefined;
    const page = faults.ignorePage ? 1 : Number(request.query.page);
    const size = Number(request.query.pageSize);
    const start = (page - 1) * size - (faults.overlap && page > 1 ? 1 : 0);
    return { status: 200, body: { items: items.slice(start, start + size), total: count + (faults.totalDrift ?? 0) } };
  };
}

/**
 * GET /feed?cursor=&pageSize= over `count` items; the cursor is an offset. Faults:
 * `unstable` drops item 7 from the second walk, `cycle` points back to offset 5 once the
 * offset reaches 10.
 */
function cursorStub(count: number, fault?: 'unstable' | 'cycle'): StubHandler {
  const items: Item[] = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
  let walks = 0;
  return (request) => {
    if (request.method !== 'GET' || request.path !== '/feed') return undefined;
    const offset = typeof request.query.cursor === 'string' ? Number(request.query.cursor) : 0;
    const size = Number(request.query.pageSize);
    if (offset === 0) walks += 1;
    const source = fault === 'unstable' && walks === 2 ? items.filter((item) => item.id !== 7) : items;
    let nextCursor: string | null = offset + size < source.length ? String(offset + size) : null;
    if (fault === 'cycle' && offset >= 10) nextCursor = '5';
    return { status: 200, body: { items: source.slice(offset, offset + size), nextCursor } };
  };
}

function pages(request: APIRequestContext, stub: StubServer) {
  return async ({ page, pageSize }: PageRequest) =>
    (await (await request.get(`${stub.url}/items`, { params: { page: page ?? 1, pageSize } })).json()) as PageResult<Item>;
}

function feed(request: APIRequestContext, stub: StubServer) {
  return async ({ cursor, pageSize }: PageRequest) =>
    (await (await request.get(`${stub.url}/feed`, { params: cursor === undefined ? { pageSize } : { cursor, pageSize } })).json()) as PageResult<Item>;
}

type AuthFault = 'trim-register' | 'trim-login' | 'trim-both' | 'case-insensitive-password' | 'case-sensitive-email';

/** POST /register and POST /login; a correct service keys email case-insensitively and compares passwords byte for byte. */
function authStub(fault?: AuthFault): StubHandler {
  const accounts = new Map<string, string>();
  const emailKey = (email: string) => (fault === 'case-sensitive-email' ? email : email.toLowerCase());
  const password = (value: string, side: 'register' | 'login') => (fault === `trim-${side}` || fault === 'trim-both' ? value.trim() : value);
  return (request) => {
    const body = request.body as Credentials;
    if (request.method === 'POST' && request.path === '/register') {
      if (accounts.has(emailKey(body.email))) return { status: 409, body: { error: 'exists' } };
      accounts.set(emailKey(body.email), password(body.password, 'register'));
      return { status: 201, body: {} };
    }
    if (request.method === 'POST' && request.path === '/login') {
      const stored = accounts.get(emailKey(body.email));
      const given = password(body.password, 'login');
      const matches = fault === 'case-insensitive-password' ? stored?.toLowerCase() === given.toLowerCase() : stored === given;
      return { status: stored !== undefined && matches ? 200 : 401, body: {} };
    }
    return undefined;
  };
}

function accounts(request: APIRequestContext, stub: StubServer) {
  return {
    register: async (credentials: Credentials) => (await request.post(`${stub.url}/register`, { data: credentials })).status() === 201,
    login: async (credentials: Credentials) => (await request.post(`${stub.url}/login`, { data: credentials })).status() === 200,
  };
}

/** PUT /profile stores `store(name)` (null refuses with 400); GET /profile reads it back. */
function profileStub(store: (name: string) => string | null): StubHandler {
  let name = '';
  return (request) => {
    if (request.path !== '/profile') return undefined;
    if (request.method === 'GET') return { status: 200, body: { name } };
    if (request.method !== 'PUT') return undefined;
    const stored = store((request.body as { name: string }).name);
    if (stored === null) return { status: 400, body: { error: 'invalid name' } };
    name = stored;
    return { status: 200, body: {} };
  };
}

function profile(request: APIRequestContext, stub: StubServer) {
  return {
    submit: async (value: string) => (await request.put(`${stub.url}/profile`, { data: { name: value } })).status() === 200,
    readBack: async () => ((await (await request.get(`${stub.url}/profile`)).json()) as { name: string }).name,
  };
}

const withinLimit = (value: string) => [...value].length <= PROFILE_MAX_LENGTH;

test.describe('data oracles', { tag: '@contract-smoke' }, () => {
  test('partitions: an email field yields the email labels, then the string labels', () => {
    expect(invalidPartitions({ type: 'string', format: 'email', maxLength: 64 })).toEqual([
      { label: 'email.missing-at', value: 'argus.qa.example.com' },
      { label: 'email.missing-domain', value: 'argus.qa@' },
      { label: 'email.missing-local-part', value: '@example.com' },
      { label: 'email.double-at', value: 'argus.qa@@example.com' },
      { label: 'email.embedded-whitespace', value: 'argus qa@example.com' },
      { label: 'string.above-max-length', value: 'a'.repeat(65) },
      { label: 'type.number-for-string', value: 1 },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(invalidEmails.map((entry) => entry.label)).toEqual(labels(invalidPartitions({ type: 'string', format: 'email' })).slice(0, 5));
  });

  test('partitions: string length and pattern constraints in order', () => {
    expect(invalidPartitions({ type: 'string', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' })).toEqual([
      { label: 'string.below-min-length', value: 'a' },
      { label: 'string.above-max-length', value: 'aaaaaa' },
      { label: 'string.pattern-mismatch', value: '' },
      { label: 'string.empty', value: '' },
      { label: 'type.number-for-string', value: 1 },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    // The first candidate the pattern rejects wins; a pattern that accepts all of them has no mismatch.
    const mismatch = (pattern: string) => invalidPartitions({ type: 'string', pattern }).find((partition) => partition.label === 'string.pattern-mismatch')?.value;
    expect(mismatch('^[a-z]*$')).toBe(' ');
    expect(mismatch('^[^0-9]*$')).toBe('0');
    expect(mismatch('.*')).toBeUndefined();
    expect(invalidPartitions({ type: 'string', minLength: 1 }).slice(0, 2)).toEqual([
      { label: 'string.below-min-length', value: '' },
      { label: 'string.empty', value: '' },
    ]);
    expect(labels(invalidPartitions({ type: 'string', minLength: 0 }))).toEqual(['type.number-for-string', 'type.null-for-non-nullable']);
  });

  test('partitions: integer bounds, fractional, unsafe, and multipleOf values', () => {
    expect(invalidPartitions({ type: 'integer', minimum: 1, maximum: 10 })).toEqual([
      { label: 'number.below-minimum', value: 0 },
      { label: 'number.above-maximum', value: 11 },
      { label: 'number.fractional-for-integer', value: 1.5 },
      { label: 'type.string-for-number', value: '1' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(invalidPartitions({ type: 'integer', minimum: 0 })).toEqual([
      { label: 'number.below-minimum', value: -1 },
      { label: 'number.fractional-for-integer', value: 0.5 },
      { label: 'number.unsafe-integer', value: 2 ** 53 },
      { label: 'type.string-for-number', value: '0' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    // An integer multipleOf is the step, so every value breaks exactly one constraint.
    expect(invalidPartitions({ type: 'integer', minimum: 10, maximum: 50, multipleOf: 5 })).toEqual([
      { label: 'number.below-minimum', value: 5 },
      { label: 'number.above-maximum', value: 55 },
      { label: 'number.fractional-for-integer', value: 10.5 },
      { label: 'number.multiple-of-violation', value: 11 },
      { label: 'type.string-for-number', value: '10' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(labels(invalidPartitions({ type: 'integer', enum: [1, 2, 3] }))).toEqual([
      'number.fractional-for-integer',
      'number.unsafe-integer',
      'type.string-for-number',
      'enum.out-of-enum',
      'type.null-for-non-nullable',
    ]);
    expect(invalidPartitions({ type: 'integer', enum: [1, 2, 3] }).find((partition) => partition.label === 'enum.out-of-enum')?.value).toBe(4);
  });

  test('partitions: number steps come from multipleOf or numberStep, never a blind +-1', () => {
    expect(invalidPartitions({ type: 'number', minimum: 0, maximum: 100, multipleOf: 0.01 })).toEqual([
      { label: 'number.below-minimum', value: -0.01 },
      { label: 'number.above-maximum', value: 100.01 },
      { label: 'number.multiple-of-violation', value: 0.005 },
      { label: 'type.string-for-number', value: '0' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(invalidPartitions({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }, { numberStep: 0.1 })).toEqual([
      { label: 'number.exclusive-minimum-equal', value: 0 },
      { label: 'number.exclusive-maximum-equal', value: 1 },
      { label: 'type.string-for-number', value: '0.1' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    // Exact cents where floating point drifts: 0.07 - 0.01 is 0.060000000000000005.
    expect(invalidPartitions({ type: 'number', minimum: 0.07, maximum: 0.7 }, { numberStep: 0.01 }).slice(0, 2)).toEqual([
      { label: 'number.below-minimum', value: 0.06 },
      { label: 'number.above-maximum', value: 0.71 },
    ]);
    // OpenAPI 3.0: a boolean exclusiveMinimum and nullable read the same as the 3.1 forms.
    expect(invalidPartitions({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 5, nullable: true }, { numberStep: 0.5 })).toEqual([
      { label: 'number.above-maximum', value: 5.5 },
      { label: 'number.exclusive-minimum-equal', value: 0 },
      { label: 'type.string-for-number', value: '0.5' },
    ]);
    expect(() => invalidPartitions({ type: 'number', minimum: 0 })).toThrow(TypeError);
    expect(() => invalidPartitions({ type: 'number', minimum: 0 })).toThrow(/numberStep/);
    expect(() => invalidPartitions({ type: 'number', maximum: 1 }, { numberStep: 0 })).toThrow(/numberStep/);
    // An unbounded number needs no step.
    expect(invalidPartitions({ type: 'number' })).toEqual([
      { label: 'type.string-for-number', value: '0' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
  });

  test('partitions: enum, boolean, nullable, and usage errors', () => {
    expect(invalidPartitions({ type: 'string', enum: ['red', 'blue'] })).toEqual([
      { label: 'type.number-for-string', value: 1 },
      { label: 'enum.out-of-enum', value: 'argus-out-of-enum' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(invalidPartitions({ type: 'boolean' })).toEqual([
      { label: 'type.string-for-boolean', value: 'true' },
      { label: 'type.null-for-non-nullable', value: null },
    ]);
    expect(invalidPartitions({ type: 'boolean', enum: [true] }).find((partition) => partition.label === 'enum.out-of-enum')?.value).toBe(false);
    expect(labels(invalidPartitions({ type: ['string', 'null'], maxLength: 2 }))).toEqual(['string.above-max-length', 'type.number-for-string']);
    expect(labels(invalidPartitions({ enum: ['a', null] }))).toEqual(['enum.out-of-enum']);
    expect(invalidPartitions({})).toEqual([]);
    expect(() => invalidPartitions({ $ref: '#/components/schemas/Order' })).toThrow(/resolve \$ref/);
    expect(() => invalidPartitions({ type: ['string', 'integer'] })).toThrow(TypeError);
    expect(() => invalidPartitions({ type: 'string', pattern: '(' })).toThrow(/not a valid regular expression/);
    expect(() => invalidPartitions({ type: 'string', minLength: -1 })).toThrow(TypeError);
    expect(() => invalidPartitions({ type: 'file' })).toThrow(/unsupported type/);
  });

  test('partitions: every value violates its schema and a valid value does not', () => {
    const cases: Array<{ schema: Record<string, unknown>; valid: unknown; numberStep?: number }> = [
      { schema: { type: 'string', format: 'email', minLength: 6, maxLength: 64 }, valid: validEmail(1) },
      { schema: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' }, valid: 'abc' },
      { schema: { type: 'integer', minimum: 1, maximum: 10 }, valid: 5 },
      { schema: { type: 'integer', minimum: 10, maximum: 50, multipleOf: 5 }, valid: 25 },
      { schema: { type: 'integer', minimum: 0 }, valid: 3 },
      { schema: { type: 'number', minimum: 0, maximum: 100, multipleOf: 0.01 }, valid: 19.99 },
      { schema: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }, valid: 0.5, numberStep: 0.1 },
      { schema: { type: 'number', minimum: 0.07, maximum: 0.7 }, valid: 0.5, numberStep: 0.01 },
      { schema: { type: 'string', enum: ['red', 'blue'] }, valid: 'red' },
      { schema: { type: 'boolean' }, valid: true },
    ];
    for (const { schema, valid, numberStep } of cases) {
      const validate = ajv.compile(schema);
      expect(validate(valid), `the valid example of ${JSON.stringify(schema)}`).toBe(true);
      const partitions = invalidPartitions(schema, { numberStep });
      expect(partitions.length).toBeGreaterThan(0);
      for (const partition of partitions) {
        // 2^53 is a valid JSON Schema integer: number.unsafe-integer probes precision loss, not the schema.
        if (partition.label === 'number.unsafe-integer') continue;
        expect(validate(partition.value), `${partition.label} must violate ${JSON.stringify(schema)}`).toBe(false);
      }
    }
  });

  test('object partitions: labels in schema order, each a fresh copy', () => {
    const partitions = invalidObjectPartitions(ORDER_SCHEMA, VALID_ORDER);
    expect(labels(partitions)).toEqual([
      'object.missing-required.sku',
      'object.missing-required.qty',
      'object.extra-field',
      'object.null-body',
      'object.wrong-type-body',
      'field.sku.string.below-min-length',
      'field.sku.string.above-max-length',
      'field.sku.string.pattern-mismatch',
      'field.sku.string.empty',
      'field.sku.type.number-for-string',
      'field.sku.type.null-for-non-nullable',
      'field.qty.number.below-minimum',
      'field.qty.number.above-maximum',
      'field.qty.number.fractional-for-integer',
      'field.qty.type.string-for-number',
      'field.qty.type.null-for-non-nullable',
      'field.note.string.above-max-length',
      'field.note.type.number-for-string',
    ]);
    const value = (label: string) => partitions.find((partition) => partition.label === label)?.value;
    expect(value('object.missing-required.sku')).toEqual({ qty: 2, note: null });
    expect(value('object.extra-field')).toEqual({ ...VALID_ORDER, argusUndocumentedField: 'argus' });
    expect(value('object.null-body')).toBeNull();
    expect(value('object.wrong-type-body')).toEqual([VALID_ORDER]);
    expect(value('field.qty.number.above-maximum')).toEqual({ sku: 'SKU-1', qty: 100, note: null });
    expect(value('field.sku.type.null-for-non-nullable')).toEqual({ sku: null, qty: 2, note: null });
    expect(VALID_ORDER).toEqual({ sku: 'SKU-1', qty: 2, note: null });
    expect(new Set(partitions.map((partition) => partition.value)).size).toBe(partitions.length);
    // A schema that allows extra fields has no extra-field partition.
    expect(labels(invalidObjectPartitions({ ...ORDER_SCHEMA, additionalProperties: true }, VALID_ORDER))).not.toContain('object.extra-field');
    const priced = { type: 'object', properties: { price: { type: 'number', minimum: 0 } } };
    expect(() => invalidObjectPartitions(priced, { price: 1 })).toThrow(/property price: .*numberStep/);
    expect(labels(invalidObjectPartitions(priced, { price: 1 }, { numberSteps: { price: 0.01 } }))).toContain('field.price.number.below-minimum');
    expect(() => invalidObjectPartitions(ORDER_SCHEMA, { qty: 2 })).toThrow(/lacks the required field sku/);
    expect(() => invalidObjectPartitions({ type: 'object', properties: { owner: { $ref: '#/components/schemas/User' } } }, {})).toThrow(/property owner: resolve \$ref/);
    expect(() => invalidObjectPartitions({ type: 'string' }, {})).toThrow(TypeError);
  });

  test('object partitions: a correct endpoint rejects all of them, a faulty one is RED', async ({ request }) => {
    const partitions = invalidObjectPartitions(ORDER_SCHEMA, VALID_ORDER);
    await withStub(orderEndpoint(ORDER_SCHEMA), async (stub) => {
      await expectStatus(await postJson(request, `${stub.url}/orders`, VALID_ORDER), 201);
      for (const partition of partitions) await expectStatus(await postJson(request, `${stub.url}/orders`, partition.value), 400);
    });
    // The faulty endpoint forgot the sku maxLength and the qty maximum.
    const lenient = structuredClone(ORDER_SCHEMA) as { properties: Record<string, Record<string, unknown>> };
    delete lenient.properties.sku.maxLength;
    delete lenient.properties.qty.maximum;
    await withStub(orderEndpoint(lenient), async (stub) => {
      const accepted: string[] = [];
      for (const partition of partitions) {
        if ((await postJson(request, `${stub.url}/orders`, partition.value)).status() !== 400) accepted.push(partition.label);
      }
      expect(accepted).toEqual(['field.sku.string.above-max-length', 'field.qty.number.above-maximum']);
      const overLimit = partitions.find((partition) => partition.label === 'field.qty.number.above-maximum');
      await expect(expectStatus(await postJson(request, `${stub.url}/orders`, overLimit?.value), 400)).rejects.toThrow(/expected HTTP 400, got 201/);
    });
  });

  test('pagination: a conserving page walk is GREEN', async ({ request }) => {
    await withStub(pageStub(24), async (stub) => {
      const result = await paginateAll({ fetchPage: pages(request, stub), mode: 'page', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result).toEqual({
        ids: Array.from({ length: 24 }, (_, index) => index + 1),
        total: 24,
        duplicates: [],
        missing: [],
        pages: 5,
        consistent: true,
        anomalies: [],
      });
      assertCollectionConservation(result);
      expect(stub.requests()).toHaveLength(10);
    });
    // An exact multiple of the page size ends on an empty page.
    await withStub(pageStub(20), async (stub) => {
      const result = await paginateAll({ fetchPage: pages(request, stub), mode: 'page', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.pages).toBe(5);
      assertCollectionConservation(result);
    });
  });

  test('pagination: a page boundary that repeats an item is RED', async ({ request }) => {
    await withStub(pageStub(23, { overlap: true }), async (stub) => {
      const result = await paginateAll({ fetchPage: pages(request, stub), mode: 'page', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.duplicates).toEqual([5]);
      expect(() => assertCollectionConservation(result)).toThrow(/1 id\(s\) served more than once: 5/);
    });
  });

  test('pagination: a total that drifts from the items is RED', async ({ request }) => {
    await withStub(pageStub(23, { totalDrift: 1 }), async (stub) => {
      const result = await paginateAll({ fetchPage: pages(request, stub), mode: 'page', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.duplicates).toEqual([]);
      expect(() => assertCollectionConservation(result)).toThrow(/total 24 reported, 23 distinct ids served/);
    });
  });

  test('pagination: an ignored page parameter stops at maxPages and is RED', async ({ request }) => {
    await withStub(pageStub(23, { ignorePage: true }), async (stub) => {
      const result = await paginateAll({ fetchPage: pages(request, stub), mode: 'page', pageSize: 5, idOf: (item: Item) => item.id, maxPages: 4 });
      expect(result.pages).toBe(4);
      expect(result.consistent).toBe(false);
      expect(() => assertCollectionConservation(result)).toThrow(/did not end within maxPages=4/);
    });
  });

  test('pagination: a stable cursor walk is GREEN', async ({ request }) => {
    await withStub(cursorStub(12), async (stub) => {
      const result = await paginateAll({ fetchPage: feed(request, stub), mode: 'cursor', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.ids).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(result.total).toBeUndefined();
      expect(result.pages).toBe(3);
      assertCollectionConservation(result);
    });
  });

  test('pagination: an unstable or looping cursor walk is RED', async ({ request }) => {
    await withStub(cursorStub(12, 'unstable'), async (stub) => {
      const result = await paginateAll({ fetchPage: feed(request, stub), mode: 'cursor', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.missing).toEqual([7]);
      expect(() => assertCollectionConservation(result)).toThrow(/served in one walk only: 7/);
    });
    await withStub(cursorStub(20, 'cycle'), async (stub) => {
      const result = await paginateAll({ fetchPage: feed(request, stub), mode: 'cursor', pageSize: 5, idOf: (item: Item) => item.id });
      expect(result.pages).toBe(3);
      expect(() => assertCollectionConservation(result)).toThrow(/repeated an earlier cursor/);
    });
  });

  test('pagination: usage errors throw TypeError', async () => {
    const fetchPage = () => ({ items: [{ id: 1 }] });
    await expect(paginateAll({ fetchPage, mode: 'offset' as 'page', pageSize: 5, idOf: (item: Item) => item.id })).rejects.toThrow(TypeError);
    await expect(paginateAll({ fetchPage, mode: 'page', pageSize: 0, idOf: (item: Item) => item.id })).rejects.toThrow(/pageSize/);
    await expect(paginateAll({ fetchPage, mode: 'page', pageSize: 5, idOf: (item: Item) => ({ id: item.id }) })).rejects.toThrow(/idOf/);
    await expect(paginateAll({ fetchPage: () => ({ rows: [] }) as unknown as PageResult<Item>, mode: 'page', pageSize: 5, idOf: (item: Item) => item.id })).rejects.toThrow(/fetchPage/);
    expect(() => assertCollectionConservation({} as never)).toThrow(TypeError);
  });

  test('boundary3: an exact validator is GREEN at both edges of a range', async () => {
    const accepts = (value: number) => value >= 1 && value <= 10;
    const upper = await boundary3({ boundary: 10, step: 1, probe: accepts, acceptBelow: true, acceptAt: true, acceptAbove: false });
    expect([upper.below.value, upper.at.value, upper.above.value]).toEqual([9, 10, 11]);
    expect(upper.above).toEqual({ value: 11, expected: 'rejected', actual: 'rejected' });
    await boundary3({ boundary: 1, step: 1, probe: accepts, acceptBelow: false, acceptAt: true, acceptAbove: true });
  });

  test('boundary3: an off-by-one validator is RED', async () => {
    const offByOne = (value: number) => value >= 1 && value < 10;
    await expect(boundary3({ boundary: 10, step: 1, probe: offByOne, acceptBelow: true, acceptAt: true, acceptAbove: false })).rejects.toThrow(
      /value 10 expected accepted, got rejected/,
    );
    const lenient = async (value: number) => value >= 1;
    await expect(boundary3({ boundary: 10, step: 1, probe: lenient, acceptBelow: true, acceptAt: true, acceptAbove: false })).rejects.toThrow(
      /value 11 expected rejected, got accepted/,
    );
  });

  test('boundary3: a money step probes exact cents; a bad step throws', async () => {
    const probed: number[] = [];
    const probe = (value: number) => {
      probed.push(value);
      return value <= 0.07;
    };
    await boundary3({ boundary: 0.07, step: 0.01, probe, acceptBelow: true, acceptAt: true, acceptAbove: false });
    expect(probed).toEqual([0.06, 0.07, 0.08]);
    // The floating-point path this avoids.
    expect(0.07 - 0.01).not.toBe(0.06);
    for (const step of [0, -0.01, Number.NaN]) {
      await expect(boundary3({ boundary: 1, step, probe, acceptBelow: true, acceptAt: true, acceptAbove: false })).rejects.toThrow(TypeError);
    }
    await expect(boundary3({ boundary: 1, step: 1, probe: () => 'yes' as unknown as boolean, acceptBelow: true, acceptAt: true, acceptAbove: false })).rejects.toThrow(/probe must return/);
    await expect(boundary3({ boundary: 1, step: 1, probe, acceptBelow: true, acceptAbove: false } as never)).rejects.toThrow(/acceptAt/);
  });

  test('moneyReconciles: exact minor units are GREEN, penny drift is RED', () => {
    expect(moneyReconciles(['0.07', '0.01'], '0.08')).toEqual({ sum: '0.08', total: '0.08' });
    expect(moneyReconciles([19.99, 0.01, '-5.00'], '15')).toEqual({ sum: '15.00', total: '15.00' });
    expect(moneyReconciles(['100', '250'], '350', { minorUnits: 0 })).toEqual({ sum: '350', total: '350' });
    expect(moneyReconciles(['1.500'], '1.50')).toEqual({ sum: '1.50', total: '1.50' });
    expect(() => moneyReconciles(['33.33', '33.33', '33.33'], '100.00')).toThrow(/the parts sum to 99\.99, the total is 100\.00 \(difference -0\.01\)/);
    // Floating-point money surfaces as sub-cent precision.
    expect(() => moneyReconciles([0.1 + 0.2], '0.30')).toThrow(/more than 2 decimal places/);
    expect(() => moneyReconciles(['12,50'], '12.50')).toThrow(/not a plain decimal/);
    expect(() => moneyReconciles(['1'], '1', { minorUnits: -1 })).toThrow(TypeError);
    expect(() => moneyReconciles('1' as never, '1')).toThrow(TypeError);
    expect(() => moneyReconciles([{ amount: 1 } as never], '1')).toThrow(TypeError);
  });

  test('percentagesSumTo100: an exact breakdown is GREEN, a rounded one is RED', () => {
    expect(percentagesSumTo100([33.33, 33.33, 33.34], { decimals: 2 })).toEqual({ sum: '100.00' });
    expect(percentagesSumTo100(['50', '50'])).toEqual({ sum: '100' });
    expect(() => percentagesSumTo100([33.33, 33.33, 33.33], { decimals: 2 })).toThrow(/sum to 99\.99, not exactly 100/);
    expect(() => percentagesSumTo100([33.3, 33.3, 33.4])).toThrow(/more than 0 decimal places/);
    expect(() => percentagesSumTo100([])).toThrow(TypeError);
  });

  test('identity: the vectors carry the exact code points', () => {
    expect(codePoints(IDENTITY_VECTORS.diacritics[0])).toEqual([0x17b, 0xf3, 0x142, 0x107, 0x20, 0x104, 0x107, 0x119, 0x142, 0x144]);
    expect(codePoints(IDENTITY_VECTORS.diacritics[1])).toEqual([0x5a, 0x6f, 0xeb, 0x20, 0x53, 0x61, 0x6c, 0x64, 0x61, 0xf1, 0x61]);
    const edge = IDENTITY_VECTORS.unicodeEdge;
    expect(codePoints(edge.nfc)).toEqual([0xe9]);
    expect(codePoints(edge.nfd)).toEqual([0x65, 0x301]);
    expect(edge.combining).toBe(edge.nfd);
    expect(edge.nfd.normalize('NFC')).toBe(edge.nfc);
    expect(codePoints(edge.rtl)).toEqual([0x202e, 0x61, 0x62, 0x63]);
    expect(codePoints(edge.zeroWidth)).toEqual([0x61, 0x200b, 0x62]);
    expect(codePoints(edge.emoji).every((point) => point > 0xffff)).toBe(true);
    expect(edge.overlong).toHaveLength(1025);
    expect(IDENTITY_VECTORS.whitespace).toEqual({ leading: ' Argus', trailing: 'Argus ', internal: 'Argus QA', tab: 'Argus\tQA', spaceOnly: '   ' });
    expect(IDENTITY_VECTORS.special).toBe('!@#$%^&*()"\'<>');
    expect(Object.isFrozen(IDENTITY_VECTORS) && Object.isFrozen(edge) && Object.isFrozen(IDENTITY_VECTORS.diacritics)).toBe(true);
    expect(invalidEmails).toHaveLength(5);
    expect(validEmail(7)).toBe('argus.qa+7@example.com');
    expect(validEmail('run-42')).toBe('argus.qa+run-42@example.com');
    expect(() => validEmail(-1)).toThrow(TypeError);
    expect(() => validEmail('Run 1')).toThrow(TypeError);
    expect(caseVariants('Argus QA+1@Example.com')).toEqual(['argus qa+1@example.com', 'ARGUS QA+1@EXAMPLE.COM', 'ArGuS qA+1@eXaMpLe.CoM']);
  });

  test('credentialConsistency: a byte-exact account service is GREEN', async ({ request }) => {
    await withStub(authStub(), async (stub) => {
      const report = await credentialConsistency(accounts(request, stub));
      expect(report.email).toMatch(/^argus\.qa\+[1-9][0-9]*@example\.com$/);
      expect(report.checks).toEqual([
        { name: 'byte-identical', expected: 'accepted', actual: 'accepted' },
        { name: 'case-variant-email', expected: 'accepted', actual: 'accepted' },
        { name: 'case-variant-password', expected: 'rejected', actual: 'rejected' },
        { name: 'trailing-space-password', expected: 'rejected', actual: 'rejected' },
      ]);
      const registered = stub.requests()[0].body as Credentials;
      expect(registered.password.endsWith(' ')).toBe(true);
      expect(codePoints(registered.password)).toEqual(expect.arrayContaining([0x17b, 0xf3, 0x142, 0x107]));
    });
  });

  test('credentialConsistency: trimming on one side only is RED', async ({ request }) => {
    for (const fault of ['trim-register', 'trim-login'] as const) {
      await withStub(authStub(fault), async (stub) => {
        const error = await credentialConsistency(accounts(request, stub)).then(
          () => new Error(`${fault}: expected a rejection`),
          (rejection: Error) => rejection,
        );
        expect(error.message).toMatch(/byte-identical login expected accepted, got rejected/);
        expect(error.message).not.toContain('Qa7');
      });
    }
  });

  test('credentialConsistency: silent trimming, case-folded passwords, and case-sensitive emails are RED', async ({ request }) => {
    const cases: Array<[AuthFault, RegExp]> = [
      ['trim-both', /trailing-space-password login expected rejected, got accepted/],
      ['case-insensitive-password', /case-variant-password login expected rejected, got accepted/],
      ['case-sensitive-email', /case-variant-email login expected accepted, got rejected/],
    ];
    for (const [fault, message] of cases) {
      await withStub(authStub(fault), async (stub) => {
        await expect(credentialConsistency(accounts(request, stub))).rejects.toThrow(message);
      });
    }
    // A documented case-sensitive email contract turns the same service GREEN.
    await withStub(authStub('case-sensitive-email'), async (stub) => {
      await credentialConsistency({ ...accounts(request, stub), emailCaseInsensitive: false });
    });
  });

  test('credentialConsistency: usage errors throw TypeError', async () => {
    const ok = () => true;
    await expect(credentialConsistency({ register: ok, login: ok, password: '12345678' })).rejects.toThrow(/no cased letter/);
    await expect(credentialConsistency({ register: () => 201 as unknown as boolean, login: ok })).rejects.toThrow(/register must return/);
    await expect(credentialConsistency({ register: ok, login: ok, emailCaseInsensitive: 'yes' as unknown as boolean })).rejects.toThrow(TypeError);
  });

  test('i18nCharset: a character-exact store is GREEN', async ({ request }) => {
    expect(I18N_VECTORS.map((vector) => vector.label)).toEqual(['diacritics.0', 'diacritics.1', 'emoji', 'nfd']);
    await withStub(profileStub((value) => (withinLimit(value) ? value : null)), async (stub) => {
      const result = await i18nCharset({ ...profile(request, stub), maxLength: PROFILE_MAX_LENGTH });
      expect(result.checked).toEqual(['diacritics.0', 'diacritics.1', 'emoji', 'nfd', 'max-length.20', 'max-length.21']);
      await i18nCharset(profile(request, stub));
    });
  });

  test('i18nCharset: a byte-truncating store is RED', async ({ request }) => {
    // A column sized in bytes: the value keeps its first PROFILE_MAX_LENGTH UTF-8 bytes.
    const truncate = (value: string) => (withinLimit(value) ? Buffer.from(value, 'utf8').subarray(0, PROFILE_MAX_LENGTH).toString('utf8') : null);
    await withStub(profileStub(truncate), async (stub) => {
      await expect(i18nCharset({ ...profile(request, stub), maxLength: PROFILE_MAX_LENGTH })).rejects.toThrow(
        /max-length\.20: sent 20 code points \(40 UTF-8 bytes\): U\+017C .*read back 10 code points/,
      );
    });
  });

  test('i18nCharset: normalization, stripped emoji, and byte-counted limits are RED', async ({ request }) => {
    const faults: Array<[(value: string) => string | null, RegExp]> = [
      [(value) => (withinLimit(value) ? value.normalize('NFC') : null), /nfd: sent 2 code points \(3 UTF-8 bytes\): U\+0065 U\+0301, read back 1 code points/],
      [(value) => (withinLimit(value) ? value.replace(/[\u{10000}-\u{10FFFF}]/gu, '') : null), /emoji: sent 3 code points/],
      [(value) => (Buffer.byteLength(value, 'utf8') <= PROFILE_MAX_LENGTH ? value : null), /max-length\.20: refused 20 code points \(40 UTF-8 bytes\)/],
      [(value) => value, /accepted maxLength \+ 1 = 21 characters/],
    ];
    for (const [store, message] of faults) {
      await withStub(profileStub(store), async (stub) => {
        await expect(i18nCharset({ ...profile(request, stub), maxLength: PROFILE_MAX_LENGTH })).rejects.toThrow(message);
      });
    }
  });

  test('i18nCharset: usage errors throw TypeError', async () => {
    const submit = () => true;
    const readBack = () => '';
    await expect(i18nCharset({ submit, readBack, maxLength: 0 })).rejects.toThrow(/maxLength/);
    await expect(i18nCharset({ submit: () => 200 as unknown as boolean, readBack })).rejects.toThrow(/submit must return/);
    await expect(i18nCharset({ submit, readBack: () => 42 as unknown as string })).rejects.toThrow(/readBack must return/);
  });
});
