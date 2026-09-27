import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { StubExchange, StubHandler, StubResponse, StubServer } from '../../src/argus/stub-server';
import {
  assertRestStatus,
  assertSchema,
  assertSchemaRef,
  assertSchemaStrict,
  expectMatchesSchema,
  expectStatus,
  idempotentReplay,
  loadOpenApi,
  normalize,
  replayWithIdempotencyKey,
  REST_STATUS,
  RestState,
} from '../../src/oracles';

// Self-tests for the contract oracles: every helper passes on a correct stub and fails on a
// faulty one. Nothing contacts a real target; each stub binds 127.0.0.1 on an ephemeral
// port and lives for one test. Negative cases assert the rejection itself, so a healthy run
// reports `product pass` for every case.

const OPENAPI_FIXTURE = join(__dirname, 'fixtures', 'openapi.selftest.json');
const SCHEMAS = '#/components/schemas';
const BASE = `${SCHEMAS}/Base`;
const WIDGET = `${SCHEMAS}/Widget`;
const WIDGET_LIST = `${SCHEMAS}/WidgetList`;
const PET = `${SCHEMAS}/Pet`;
const SHAPE = `${SCHEMAS}/Shape`;
const LABELS = `${SCHEMAS}/Labels`;
const USER = `${SCHEMAS}/User`;
const COUNTERS = `${SCHEMAS}/Counters`;
const ORDER = `${SCHEMAS}/Order`;
const SECRET = 'argus-never-print-me';
const WIDGET_BODY = { id: 1, name: 'widget', color: 'red', weight: 2.5 };

async function withStub(
  setup: { exchanges?: StubExchange[]; handler?: StubHandler },
  body: (stub: StubServer) => Promise<void>,
): Promise<void> {
  const stub = await StubServer.start({ handler: setup.handler });
  try {
    if (setup.exchanges) stub.load(setup.exchanges);
    await body(stub);
  } finally {
    await stub.stop();
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: Error) => error,
  );
}

const CONFORMING: Record<RestState, { method: string; response: StubResponse }> = {
  created: { method: 'POST', response: { status: 201, headers: { location: '/widgets/9' }, body: { id: 9 } } },
  deleted: { method: 'DELETE', response: { status: 204 } },
  missing: { method: 'GET', response: { status: 404, body: { error: 'missing' } } },
  'method-not-allowed': { method: 'PATCH', response: { status: 405, headers: { allow: 'GET, DELETE' } } },
  'unsupported-media-type': { method: 'PUT', response: { status: 415 } },
  malformed: { method: 'POST', response: { status: 400, body: { error: 'malformed' } } },
  unauthenticated: { method: 'GET', response: { status: 401 } },
  forbidden: { method: 'GET', response: { status: 403 } },
  conflict: { method: 'PUT', response: { status: 409 } },
  ok: { method: 'GET', response: { status: 200, body: { id: 1 } } },
};

function orderStub(honourKeys: boolean): StubHandler {
  const orders: number[] = [];
  const byKey = new Map<string, number>();
  return (request) => {
    if (request.method === 'POST' && request.path === '/orders') {
      const key = request.headers['idempotency-key'];
      if (honourKeys && key && byKey.has(key)) return { status: 200, body: { id: byKey.get(key) } };
      const id = orders.length + 1;
      orders.push(id);
      if (key) byKey.set(key, id);
      return { status: 201, headers: { location: `/orders/${id}` }, body: { id } };
    }
    if (request.method === 'GET' && request.path === '/orders/count') return { status: 200, body: { count: orders.length } };
    return undefined;
  };
}

test.describe('contract oracles', { tag: '@contract-smoke' }, () => {
  test.beforeEach(() => {
    // The schema oracle reads OPENAPI_PATH at call time.
    process.env.OPENAPI_PATH = OPENAPI_FIXTURE;
  });

  test('strict schema: an undocumented field is RED', async () => {
    await assertSchemaRef({ id: 1, name: 'widget' }, BASE);
    await expect(assertSchemaRef({ id: 1, name: 'widget', surprise: true }, BASE)).rejects.toThrow(/surprise/);
  });

  test('strict schema: a valid allOf body is GREEN', async () => {
    await assertSchemaRef(WIDGET_BODY, WIDGET);
    await assertSchemaRef({ id: 2, name: 'plain' }, WIDGET);
  });

  test('strict schema: an allOf body with an extra field is RED', async () => {
    await expect(assertSchemaRef({ ...WIDGET_BODY, surprise: 1 }, WIDGET)).rejects.toThrow(/surprise/);
  });

  test('strict schema: a oneOf body is GREEN and an extra field in it is RED', async () => {
    await assertSchemaRef({ kind: 'cat', meows: true }, PET);
    await assertSchemaRef({ kind: 'dog', barks: false }, PET);
    // Members are closed too, so a body of loose members matches exactly one of them.
    await assertSchemaRef({ radius: 2 }, SHAPE);
    await expect(assertSchemaRef({ kind: 'cat', meows: true, barks: true }, PET)).rejects.toThrow();
  });

  test('strict schema: a use site that declares patternProperties stays open', async () => {
    await assertSchemaRef({ name: 'labels', 'x-trace': 'abc', other: 1 }, LABELS);
    await expect(assertSchemaRef({ 'x-trace': 5 }, LABELS)).rejects.toThrow(/x-trace/);
  });

  test('OpenAPI 3.0 nullable: null is GREEN where documented', async () => {
    await assertSchemaRef({ id: 7, email: 'qa@example.com', nickname: null, manager: null }, USER);
    await assertSchemaRef({ id: 7, email: 'qa@example.com', manager: { id: 1, name: 'lead' } }, USER);
    await assertSchemaRef({ id: 1, name: 'widget', color: null }, WIDGET);
    await expect(assertSchemaRef({ id: 1, name: null }, BASE)).rejects.toThrow();
  });

  test('OpenAPI 3.0 boolean exclusiveMinimum is enforced', async () => {
    await assertSchemaRef({ id: 1, name: 'widget', weight: 0.5 }, WIDGET);
    await expect(assertSchemaRef({ id: 1, name: 'widget', weight: 0 }, WIDGET)).rejects.toThrow(/weight/);
  });

  test('response direction: a writeOnly field in a response is RED and redacted', async () => {
    const leaked = { id: 7, email: 'qa@example.com', password: SECRET };
    await expect(assertSchemaRef(leaked, USER)).rejects.toThrow(/password/);
    const error = await rejection(assertSchemaRef(leaked, USER));
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(SECRET);
    // The response direction drops the writeOnly property from `required` as well.
    await assertSchemaRef({ id: 7, email: 'qa@example.com' }, USER);
  });

  test('request direction: readOnly fields are removed', async () => {
    await assertSchemaRef({ email: 'qa@example.com', password: 'correct-horse' }, USER, { direction: 'request' });
    await expect(
      assertSchemaRef({ id: 7, email: 'qa@example.com', password: 'correct-horse' }, USER, { direction: 'request' }),
    ).rejects.toThrow(/"unevaluatedProperty":"id"/);
  });

  test('documented additionalProperties map: extra keys are GREEN', async () => {
    await assertSchemaRef({ widgets: 3, orders: 0, 'any key': 12 }, COUNTERS);
    await expect(assertSchemaRef({ widgets: 'three' }, COUNTERS)).rejects.toThrow(/widgets/);
  });

  test('array of objects: an item with an extra field is RED', async () => {
    await assertSchemaRef([{ id: 1, name: 'a' }, { id: 2, name: 'b' }], WIDGET_LIST);
    await expect(assertSchemaRef([{ id: 1, name: 'a' }, { id: 2, name: 'b', surprise: true }], WIDGET_LIST)).rejects.toThrow(/surprise/);
  });

  test('nested inline object: an extra field is RED', async () => {
    await assertSchemaRef({ id: 1, shipping: { city: 'Gdansk', zip: '80-001' } }, ORDER);
    await expect(assertSchemaRef({ id: 1, shipping: { city: 'Gdansk', surprise: true } }, ORDER)).rejects.toThrow(/shipping/);
  });

  test('operation lookup: an undocumented status is RED', async ({ request }) => {
    const exchanges: StubExchange[] = [
      { id: 'widget-ok', request: { method: 'GET', path: '/widgets/1' }, response: { status: 200, body: WIDGET_BODY } },
      { id: 'widget-created', request: { method: 'GET', path: '/widgets/2' }, response: { status: 201, body: WIDGET_BODY } },
    ];
    await withStub({ exchanges }, async (stub) => {
      await assertSchema(await request.get(`${stub.url}/widgets/1`), 'getWidget');
      await expect(assertSchema(await request.get(`${stub.url}/widgets/2`), 'getWidget')).rejects.toThrow(/HTTP 201 is not documented/);
    });
    await expect(assertSchema({ status: 500, body: { error: 'boom' } }, 'getWidget')).rejects.toThrow(/HTTP 500 is not documented/);
  });

  test('operation lookup: referenced and bodiless responses', async () => {
    await assertSchema({ status: 404, body: { error: 'no such user' } }, 'getUser');
    await expect(assertSchema({ status: 404, body: { error: 'no such user', trace: 'x' } }, 'getUser')).rejects.toThrow(/trace/);
    await assertSchema({ status: 204 }, 'deleteWidget');
    await expect(assertSchema({ status: 204, body: { deleted: true } }, 'deleteWidget')).rejects.toThrow(/documents no content/);
    await expect(assertSchema({ status: 200, body: {} }, 'noSuchOperation')).rejects.toThrow(/not defined/);
  });

  test('operation lookup: the exact code, then its range, then default', async () => {
    // 404 has its own key, so the 4XX schema's extra field is RED there.
    await assertSchema({ status: 404, body: { error: 'no such gadget' } }, 'getGadget');
    await expect(assertSchema({ status: 404, body: { error: 'no such gadget', fields: [] } }, 'getGadget')).rejects.toThrow(/fields/);
    // 422 falls under 4XX, which requires fields: the default Error body alone is RED.
    await assertSchema({ status: 422, body: { error: 'invalid', fields: ['name'] } }, 'getGadget');
    await expect(assertSchema({ status: 422, body: { error: 'invalid' } }, 'getGadget')).rejects.toThrow(/HTTP 422 via 4XX/);
    // 500 falls under default.
    await assertSchema({ status: 500, body: { error: 'boom' } }, 'getGadget');
    await expect(assertSchema({ status: 500, body: { error: 'boom', trace: 'x' } }, 'getGadget')).rejects.toThrow(/HTTP 500 via default/);
  });

  test('strict:false with a reason is GREEN; without a reason it throws', async () => {
    const drifted = { status: 200, body: { id: 1, name: 'widget', legacyField: true } };
    await assertSchema(drifted, 'getWidget', { strict: false, reason: 'legacyField is a recorded, accepted drift' });
    await expect(assertSchema(drifted, 'getWidget', { strict: false })).rejects.toThrow(/reason/);
    await expect(assertSchema(drifted, 'getWidget', { strict: false, reason: '  ' })).rejects.toThrow(/reason/);
    await expect(assertSchema(drifted, 'getWidget')).rejects.toThrow(/legacyField/);
  });

  test('assertSchemaStrict and expectMatchesSchema are strict', async () => {
    await expect(assertSchemaStrict({ id: 1, name: 'widget', surprise: 1 }, BASE)).rejects.toThrow(/surprise/);
    await expect(expectMatchesSchema({ id: 1, name: 'widget', surprise: 1 }, BASE)).rejects.toThrow(/surprise/);
    await expectMatchesSchema({ id: 1, name: 'widget' }, BASE);
  });

  test('normalize: component roots and allOf members stay open, use sites close', async () => {
    type Schemas = Record<string, Record<string, any>>;
    const source = loadOpenApi(OPENAPI_FIXTURE);
    const normalized = normalize(source, { direction: 'response' });
    const response = (normalized.components as { schemas: Schemas }).schemas;
    const bodySchema = (path: string) => (normalized.paths as Schemas)[path].get.responses['200'].content['application/json'].schema;
    expect(bodySchema('/widgets/{id}')).toEqual({ allOf: [{ $ref: `${SCHEMAS}/Widget` }], unevaluatedProperties: false });
    // A use site whose target declares additionalProperties is left as the author wrote it.
    expect(bodySchema('/counters')).toEqual({ $ref: `${SCHEMAS}/Counters` });
    expect(response.Base).not.toHaveProperty('unevaluatedProperties');
    expect(response.Widget).toEqual({ allOf: [{ $ref: `${SCHEMAS}/Base` }, { $ref: `${SCHEMAS}/Ext` }] });
    expect(response.Base.properties.name).toEqual({ allOf: [{ type: 'string' }], unevaluatedProperties: false });
    expect(response.Order.properties.shipping).toMatchObject({ unevaluatedProperties: false });
    expect(response.Counters).toEqual({ type: 'object', additionalProperties: { allOf: [{ type: 'integer' }], unevaluatedProperties: false } });
    expect(response.Ext.properties.weight.allOf[0]).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect(response.Ext.properties.color.allOf[0]).toEqual({ type: ['string', 'null'], enum: ['red', 'blue', null] });
    expect(response.User.properties).not.toHaveProperty('password');
    expect(response.User.required).toEqual(['id', 'email']);
    expect(response.User.properties.nickname.allOf[0]).toEqual({ type: ['string', 'null'] });
    expect(JSON.stringify(response.User.properties.manager)).toContain('"anyOf"');
    const request = (normalize(source, { direction: 'request', strict: false }).components as { schemas: Schemas }).schemas;
    expect(request.User.required).toEqual(['email', 'password']);
    expect(request.User.properties).not.toHaveProperty('id');
    expect(request.Base.properties.name).toEqual({ type: 'string' });
    expect((source.components as { schemas: Schemas }).schemas.User.required).toEqual(['id', 'email', 'password']);
  });

  test('expectStatus compares one exact status code', async ({ request }) => {
    const exchanges: StubExchange[] = [
      { id: 'create', request: { method: 'POST', path: '/widgets' }, response: { status: 201, headers: { location: '/widgets/9' }, body: { id: 9, token: SECRET } } },
    ];
    await withStub({ exchanges }, async (stub) => {
      const res = await request.post(`${stub.url}/widgets`, { data: { name: 'widget' } });
      await expectStatus(res, 201);
      await expect(expectStatus(res, 200, { method: 'POST' })).rejects.toThrow(/expected HTTP 200, got 201: method=POST url=http:\/\/127\.0\.0\.1:\d+\/widgets/);
      const error = await rejection(expectStatus(res, 200));
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain(SECRET);
      await expect(expectStatus(res, 2)).rejects.toThrow(TypeError);
    });
  });

  test('assertRestStatus: every state is GREEN on a conforming stub', async ({ request }) => {
    const states = Object.keys(REST_STATUS) as RestState[];
    expect(states).toHaveLength(10);
    const exchanges = states.map((state) => ({
      id: state,
      request: { method: CONFORMING[state].method, path: `/rest/${state}` },
      response: CONFORMING[state].response,
    }));
    await withStub({ exchanges }, async (stub) => {
      for (const state of states) {
        const res = await request.fetch(`${stub.url}/rest/${state}`, { method: CONFORMING[state].method });
        await assertRestStatus(res, state);
      }
      expect(stub.unmatched()).toEqual([]);
    });
  });

  test('assertRestStatus: a wrong code or a missing Location, Allow, or empty body is RED', async ({ request }) => {
    const exchanges: StubExchange[] = [
      { id: 'no-location', request: { method: 'POST', path: '/no-location' }, response: { status: 201, body: { id: 1 } } },
      { id: 'no-allow', request: { method: 'PATCH', path: '/no-allow' }, response: { status: 405 } },
      { id: 'gone', request: { method: 'GET', path: '/gone' }, response: { status: 410 } },
      { id: 'no-content', request: { method: 'GET', path: '/no-content' }, response: { status: 204 } },
    ];
    await withStub({ exchanges }, async (stub) => {
      await expect(assertRestStatus(await request.post(`${stub.url}/no-location`), 'created')).rejects.toThrow(/Location/);
      await expect(assertRestStatus(await request.patch(`${stub.url}/no-allow`), 'method-not-allowed')).rejects.toThrow(/Allow/);
      await expect(assertRestStatus(await request.get(`${stub.url}/gone`), 'missing')).rejects.toThrow(/expected HTTP 404, got 410/);
      await expect(assertRestStatus(await request.get(`${stub.url}/no-content`), 'ok')).rejects.toThrow(/expected HTTP 200, got 204/);
    });
    // HTTP drops content on a 204, so a body can only be shown through the record form.
    await expect(assertRestStatus({ status: 204, body: { deleted: true } }, 'deleted')).rejects.toThrow(/non-empty body/);
    await expect(assertRestStatus({ status: 201, headers: { Location: ' ' } }, 'created')).rejects.toThrow(/Location/);
    await expect(assertRestStatus({ status: 200 }, 'fine' as RestState)).rejects.toThrow(TypeError);
  });

  test('assertRestStatus: documentedStatus overrides the code, never a class', async () => {
    await assertRestStatus({ status: 200, body: { id: 9 } }, 'created', { documentedStatus: 200 });
    await expect(assertRestStatus({ status: 201, headers: { location: '/x/9' } }, 'created', { documentedStatus: 200 })).rejects.toThrow(/expected HTTP 200, got 201/);
    await assertRestStatus({ status: 422 }, 'malformed', { documentedStatus: 422 });
    await expect(assertRestStatus({ status: 422 }, 'malformed', { documentedStatus: '4XX' as unknown as number })).rejects.toThrow(/never a class/);
    await expect(assertRestStatus({ status: 400 }, 'malformed', { documentedStatus: 4 })).rejects.toThrow(/never a class/);
  });

  test('idempotentReplay is GREEN on a deterministic stub', async ({ request }) => {
    let requestId = 0;
    const handler: StubHandler = (req) => {
      if (req.method === 'PUT' && req.path === '/widgets/1') return { status: 200, body: { id: 1, name: 'widget', meta: { requestId: ++requestId } } };
      if (req.method === 'GET' && req.path === '/widgets/1') return { status: 200, body: { id: 1, name: 'widget' } };
      return undefined;
    };
    await withStub({ handler }, async (stub) => {
      const result = await idempotentReplay({
        send: () => request.put(`${stub.url}/widgets/1`, { data: { name: 'widget' } }),
        read: async () => (await request.get(`${stub.url}/widgets/1`)).json(),
        volatileFields: ['requestId'],
      });
      expect(result.status).toBe(200);
      expect(requestId).toBe(2);
    });
  });

  test('idempotentReplay is RED on a counter stub', async ({ request }) => {
    let version = 0;
    let visits = 0;
    const handler: StubHandler = (req) => {
      if (req.method === 'PUT' && req.path === '/widgets/1') return { status: 200, body: { id: 1, version: ++version } };
      if (req.method === 'POST' && req.path === '/visits') {
        visits += 1;
        return { status: 204 };
      }
      if (req.method === 'GET' && req.path === '/visits') return { status: 200, body: { total: visits } };
      return undefined;
    };
    await withStub({ handler }, async (stub) => {
      await expect(idempotentReplay({ send: () => request.put(`${stub.url}/widgets/1`) })).rejects.toThrow(/changed the body/);
      // Identical responses, but the state keeps counting.
      await expect(
        idempotentReplay({
          send: () => request.post(`${stub.url}/visits`),
          read: async () => (await request.get(`${stub.url}/visits`)).json(),
        }),
      ).rejects.toThrow(/changed the state/);
    });
  });

  test('replayWithIdempotencyKey is GREEN when the key deduplicates the create', async ({ request }) => {
    await withStub({ handler: orderStub(true) }, async (stub) => {
      const result = await replayWithIdempotencyKey({
        send: (key) => request.post(`${stub.url}/orders`, { headers: { 'Idempotency-Key': key }, data: { sku: 'A-1' } }),
        count: async () => (await (await request.get(`${stub.url}/orders/count`)).json()).count,
        idOf: async (res) => (await res.json()).id,
      });
      expect(result.key).toMatch(/^argus-idem-[1-9][0-9]*$/);
      expect(result.id).toBe(1);
      const keys = stub.requests().filter((record) => record.method === 'POST').map((record) => record.headers['idempotency-key']);
      expect(keys).toEqual([result.key, result.key]);
    });
  });

  test('replayWithIdempotencyKey is RED when the key is ignored', async ({ request }) => {
    await withStub({ handler: orderStub(false) }, async (stub) => {
      await expect(
        replayWithIdempotencyKey({
          send: (key) => request.post(`${stub.url}/orders`, { headers: { 'Idempotency-Key': key }, data: { sku: 'A-1' } }),
          count: async () => (await (await request.get(`${stub.url}/orders/count`)).json()).count,
          idOf: async (res) => (await res.json()).id,
        }),
      ).rejects.toThrow(/exactly one effect/);
    });
  });

  test('stub: an unmatched request gets 501 and is recorded', async ({ request }) => {
    const exchanges: StubExchange[] = [
      { id: 'widget', request: { method: 'GET', path: '/widgets/1' }, response: { status: 200, body: { id: 1, name: 'widget' } } },
      { id: 'page-two', request: { method: 'GET', path: '/widgets', query: { page: '2' } }, response: { status: 200, body: [] } },
    ];
    await withStub({ exchanges }, async (stub) => {
      const hit = await request.get(`${stub.url}/widgets/1`);
      await expectStatus(hit, 200);
      expect(hit.headers()['content-type']).toBe('application/json');
      expect(await hit.json()).toEqual({ id: 1, name: 'widget' });
      await expectStatus(await request.get(`${stub.url}/widgets?page=2&sort=name`), 200);
      const miss = await request.get(`${stub.url}/widgets?page=3`);
      await expectStatus(miss, 501);
      expect(await miss.json()).toEqual({ argusStub: 'unmatched' });
      await expectStatus(await request.post(`${stub.url}/widgets/1`), 501);
      expect(stub.unmatched().map((record) => `${record.method} ${record.path}`)).toEqual(['GET /widgets', 'POST /widgets/1']);
      expect(stub.requests().map((record) => record.matched)).toEqual(['widget', 'page-two', null, null]);
      stub.load([]);
      expect(stub.requests()).toEqual([]);
    });
  });

  test('stub: resolve serves exchanges without the network; a failing handler answers 500', async ({ request }) => {
    const exchanges: StubExchange[] = [
      { id: 'widget', request: { method: 'GET', path: '/widgets/1' }, response: { status: 200, body: { id: 1 } } },
      { id: 'page-two', request: { method: 'GET', path: '/widgets', query: { page: '2' } }, response: { status: 200, body: [] } },
    ];
    const handler: StubHandler = (req) => {
      if (req.path === '/explode') throw new Error('handler failure on purpose');
      return undefined;
    };
    await withStub({ exchanges, handler }, async (stub) => {
      expect(stub.resolve({ method: 'GET', path: '/widgets/1' })).toEqual({ status: 200, body: { id: 1 } });
      expect(stub.resolve({ method: 'get', path: '/widgets?page=2' })).toEqual({ status: 200, body: [] });
      expect(stub.resolve({ method: 'GET', path: '/widgets', query: { page: '3' } })).toBeNull();
      expect(stub.unmatched().map((record) => record.path)).toEqual(['/widgets']);
      const exploded = await request.get(`${stub.url}/explode`);
      await expectStatus(exploded, 500);
      expect(await exploded.json()).toEqual({ argusStub: 'handler-error' });
      expect(stub.requests().at(-1)?.matched).toBe('handler-error');
    });
  });

  test('stub: invalid exchanges are refused', async () => {
    const valid: StubExchange = { id: 'ok', request: { method: 'GET', path: '/ok' }, response: { status: 200 } };
    await withStub({}, async (stub) => {
      expect(() => stub.load([{ ...valid, id: 'Not Valid' }])).toThrow(TypeError);
      expect(() => stub.load([valid, valid])).toThrow(/duplicate/);
      expect(() => stub.load([{ ...valid, request: { method: 'get', path: '/ok' } }])).toThrow(/uppercase/);
      expect(() => stub.load([{ ...valid, request: { method: 'GET', path: 'ok' } }])).toThrow(/start with/);
      expect(() => stub.load([{ ...valid, response: { status: 200, headers: { 'Content-Type': 'text/plain' } } }])).toThrow(/lowercase/);
      expect(() => stub.load([{ ...valid, response: { status: 42 } }])).toThrow(/status/);
    });
  });
});
