import { setTimeout as delay } from 'node:timers/promises';
import { APIRequestContext, APIResponse, Locator, test, expect } from '@playwright/test';
import { StubHandler, StubServer } from '../../src/argus/stub-server';
import {
  analyzeScaling,
  BoundsMeasurement,
  concurrentRace,
  doubleSubmit,
  evaluateBounds,
  n1Scaling,
  ScalingSample,
  softDeleteSweep,
  validEmail,
  visualBounds,
} from '../../src/oracles';

// Self-tests for the behaviour oracles: every helper passes on a correct implementation and
// fails on a faulty one. evaluateBounds and analyzeScaling are pure and get plain values;
// the others run against a 127.0.0.1 StubServer on an ephemeral port that lives for one
// test, and visualBounds against a recording stand-in for a Locator, so no browser starts
// and no real target is contacted. Negative cases assert the rejection itself, so a
// healthy run reports `product pass` for every case.

type SweepFault = 'listed' | 'readable' | 'login' | 'delete-200';
type SeatFault = 'overbook' | 'crash-when-sold-out';

const USER_EMAIL = validEmail(7);
const SIZES = [10, 100, 1000];
const PAGE_SIZE = 10;
// A 375 px phone viewport and a button that fits inside it.
const FITS: BoundsMeasurement = {
  rect: { x: 16, y: 120, width: 343, height: 48 },
  viewport: { width: 375, height: 812 },
  scrollWidth: 343,
  clientWidth: 343,
  topElementIsSelf: true,
};

async function withStub(handler: StubHandler, body: (stub: StubServer) => Promise<void>): Promise<void> {
  const stub = await StubServer.start({ handler });
  try {
    await body(stub);
  } finally {
    await stub.stop();
  }
}

/**
 * Users 7 and 8 behind DELETE and GET /users/:id, GET /users, GET /users/export, and
 * POST /login. A correct service removes a deleted user from every read path and refuses
 * its login. Faults: `listed` keeps the deleted user in the export, `readable` still serves
 * it by id, `login` still accepts its credentials, `delete-200` answers the delete with 200
 * and a body.
 */
function userStub(fault?: SweepFault): StubHandler {
  const users = new Map([7, 8].map((id) => [id, { id, email: validEmail(id), deleted: false }]));
  const visible = (includeDeleted: boolean) => ({
    status: 200,
    body: { items: [...users.values()].filter((user) => includeDeleted || !user.deleted).map(({ id, email }) => ({ id, email })) },
  });
  return (request) => {
    const byId = /^\/users\/(\d+)$/.exec(request.path);
    if (byId) {
      const user = users.get(Number(byId[1]));
      if (request.method === 'DELETE') {
        if (!user || user.deleted) return { status: 404, body: { error: 'not found' } };
        user.deleted = true;
        return fault === 'delete-200' ? { status: 200, body: { deleted: true } } : { status: 204 };
      }
      if (request.method === 'GET') {
        return user && (!user.deleted || fault === 'readable') ? { status: 200, body: { id: user.id, email: user.email } } : { status: 404, body: { error: 'not found' } };
      }
    }
    if (request.method === 'GET' && request.path === '/users') return visible(false);
    if (request.method === 'GET' && request.path === '/users/export') return visible(fault === 'listed');
    if (request.method === 'POST' && request.path === '/login') {
      const user = [...users.values()].find((candidate) => candidate.email === (request.body as { email?: string }).email);
      return user && (!user.deleted || fault === 'login') ? { status: 200, body: {} } : { status: 401, body: { error: 'invalid credentials' } };
    }
    return undefined;
  };
}

/** Sweep user 7 through its detail read, both lists, and a login; the id arrives as a string. */
function sweepUser(request: APIRequestContext, stub: StubServer) {
  const ids = (path: string) => async () => ((await (await request.get(`${stub.url}${path}`)).json()) as { items: Array<{ id: number }> }).items.map((item) => item.id);
  return softDeleteSweep({
    id: '7',
    deleteResource: () => request.delete(`${stub.url}/users/7`),
    getById: () => request.get(`${stub.url}/users/7`),
    listIds: [ids('/users'), ids('/users/export')],
    loginAttempt: () => request.post(`${stub.url}/login`, { data: { email: USER_EMAIL, password: 'argus-correct-password' } }),
  });
}

/**
 * POST /checkout {cartId} and GET /orders. A correct checkout checks and inserts in one
 * step, so a second submit of the same cart gets 409. The faulty one awaits between the
 * check and the insert, the classic check-then-act race: both submits pass the check.
 */
function checkoutStub(faulty: boolean): StubHandler {
  const orders: Array<{ id: number; cartId: string }> = [];
  return async (request) => {
    if (request.method === 'GET' && request.path === '/orders') return { status: 200, body: { items: orders } };
    if (request.method !== 'POST' || request.path !== '/checkout') return undefined;
    const { cartId } = request.body as { cartId: string };
    if (orders.some((order) => order.cartId === cartId)) return { status: 409, body: { error: 'already ordered' } };
    if (faulty) await delay(50);
    orders.push({ id: orders.length + 1, cartId });
    return { status: 201, headers: { location: `/orders/${orders.length}` }, body: { id: orders.length } };
  };
}

function checkout(request: APIRequestContext, stub: StubServer) {
  return {
    action: () => request.post(`${stub.url}/checkout`, { data: { cartId: 'cart-1' } }),
    countEffects: async () => ((await (await request.get(`${stub.url}/orders`)).json()) as { items: unknown[] }).items.length,
  };
}

/**
 * POST /seats/claim for the last seat and GET /seats. A correct booking decrements
 * atomically and answers 409 once sold out. Faults: `overbook` awaits between the check and
 * the decrement, so every contender passes the check; `crash-when-sold-out` answers 500
 * instead of 409.
 */
function seatStub(fault?: SeatFault): StubHandler {
  const seats = { remaining: 1, bookings: 0 };
  return async (request) => {
    if (request.method === 'GET' && request.path === '/seats') return { status: 200, body: seats };
    if (request.method !== 'POST' || request.path !== '/seats/claim') return undefined;
    if (seats.remaining <= 0) return fault === 'crash-when-sold-out' ? { status: 500, body: { error: 'internal' } } : { status: 409, body: { error: 'sold out' } };
    if (fault === 'overbook') await delay(50);
    seats.remaining -= 1;
    seats.bookings += 1;
    return { status: 201, body: { seat: seats.bookings } };
  };
}

function lastSeatRace(request: APIRequestContext, stub: StubServer) {
  return concurrentRace({
    n: 5,
    capacity: 1,
    action: (index) => request.post(`${stub.url}/seats/claim`, { data: { account: `contender-${index}` } }),
    invariant: async () => {
      const seats = (await (await request.get(`${stub.url}/seats`)).json()) as { remaining: number; bookings: number };
      return seats.remaining >= 0 && seats.bookings <= 1;
    },
  });
}

/**
 * PUT /seed/:size sets the collection size; GET /items?pageSize= reads the first page. The
 * server-timing header reports a deterministic cost of 0.2 ms per row the request touches,
 * so the scaling cases never depend on wall-clock noise. The first read after a new size
 * fills a cache over every row. A correct read then touches one page. Faults: `fan-out`
 * runs one query per row of the collection (N+1), `over-fetch` serves every row.
 */
function collectionStub(fault?: 'fan-out' | 'over-fetch'): StubHandler {
  let size = 0;
  let cold = false;
  return (request) => {
    const seed = /^\/seed\/(\d+)$/.exec(request.path);
    if (request.method === 'PUT' && seed) {
      if (Number(seed[1]) !== size) cold = true;
      size = Number(seed[1]);
      return { status: 204 };
    }
    if (request.method !== 'GET' || request.path !== '/items') return undefined;
    const pageSize = Number(request.query.pageSize);
    const served = fault === 'over-fetch' ? size : Math.min(pageSize, size);
    const touched = cold || fault === 'fan-out' ? size : served;
    cold = false;
    const items = Array.from({ length: served }, (_, index) => ({ id: index + 1, name: 'item' }));
    return { status: 200, headers: { 'server-timing': `db;dur=${touched * 0.2}` }, body: { items, total: size } };
  };
}

function readFirstPage(request: APIRequestContext, stub: StubServer) {
  return async (size: number) => {
    await request.put(`${stub.url}/seed/${size}`);
    const res = await request.get(`${stub.url}/items`, { params: { pageSize: PAGE_SIZE } });
    return { ms: serverTimingMs(res), bytes: (await res.body()).length };
  };
}

function serverTimingMs(res: APIResponse): number {
  const match = /dur=([\d.]+)/.exec(res.headers()['server-timing'] ?? '');
  if (!match) throw new TypeError('the collection stub did not send a server-timing duration');
  return Number(match[1]);
}

/** A stand-in for a Locator: evaluate() returns `measurement`, and viewport changes are recorded. */
function recordingLocator(measurement: BoundsMeasurement) {
  const resized: Array<{ width: number; height: number }> = [];
  let viewport = { width: 1280, height: 720 };
  const page = {
    viewportSize: () => viewport,
    setViewportSize: async (size: { width: number; height: number }) => {
      resized.push(size);
      viewport = size;
    },
  };
  const locator = {
    page: () => page,
    evaluate: async () => measurement,
    toString: () => "getByRole('button', { name: 'Pay' })",
  };
  return { locator: locator as unknown as Locator, resized };
}

function samples(points: Array<[size: number, ms: number[], bytes: number]>): ScalingSample[] {
  return points.flatMap(([size, times, bytes]) => times.map((ms) => ({ size, ms, bytes })));
}

test.describe('behaviour oracles', { tag: '@contract-smoke' }, () => {
  test('softDeleteSweep: a resource gone from every read path is GREEN', async ({ request }) => {
    await withStub(userStub(), async (stub) => {
      expect(await sweepUser(request, stub)).toEqual({ deleteStatus: 204, getStatus: 404, lists: 2, loginStatus: 401 });
      // User 8 is untouched: the sweep deleted exactly one resource.
      expect((await request.get(`${stub.url}/users/8`)).status()).toBe(200);
    });
  });

  test('softDeleteSweep: a list that still serves the deleted id is RED', async ({ request }) => {
    await withStub(userStub('listed'), async (stub) => {
      // The export serves the number 7; the id is the string '7'. The type never hides it.
      await expect(sweepUser(request, stub)).rejects.toThrow(/resource "7" is not gone after the delete\nlistIds\[1\] still serves the deleted id "7"/);
    });
  });

  test('softDeleteSweep: a readable detail, an accepted login, and a wrong delete status are RED', async ({ request }) => {
    const cases: Array<[SweepFault, RegExp]> = [
      ['readable', /getById: expected HTTP 404 after the delete, got 200: method=\S+ url=http:\/\/127\.0\.0\.1:\d+\/users\/7/],
      ['login', /loginAttempt: expected HTTP 401 for the deleted account, got 200/],
      ['delete-200', /deleted: expected HTTP 204, got 200/],
    ];
    for (const [fault, message] of cases) {
      await withStub(userStub(fault), async (stub) => {
        await expect(sweepUser(request, stub), fault).rejects.toThrow(message);
      });
    }
    // A delete documented as 200 passes with expectedDeleteState 'ok'.
    await withStub(userStub('delete-200'), async (stub) => {
      const result = await softDeleteSweep({
        id: 7,
        deleteResource: () => request.delete(`${stub.url}/users/7`),
        getById: () => request.get(`${stub.url}/users/7`),
        listIds: [async () => [8]],
        expectedDeleteState: 'ok',
      });
      expect(result).toEqual({ deleteStatus: 200, getStatus: 404, lists: 1 });
    });
  });

  test('softDeleteSweep: usage errors throw TypeError', async () => {
    const gone = { deleteResource: async () => ({ status: 204 }), getById: async () => ({ status: 404 }), listIds: [async () => [8]], id: 7 };
    await expect(softDeleteSweep({ ...gone, listIds: [] })).rejects.toThrow(/listIds must be a non-empty array/);
    await expect(softDeleteSweep({ ...gone, id: '' })).rejects.toThrow(TypeError);
    await expect(softDeleteSweep({ ...gone, expectedDeleteState: 'gone' as never })).rejects.toThrow(/unknown expectedDeleteState/);
    await expect(softDeleteSweep({ ...gone, deleteResource: undefined as never })).rejects.toThrow(TypeError);
    await expect(softDeleteSweep({ ...gone, listIds: [() => 'id-7' as never] })).rejects.toThrow(/listIds\[0\] must return an array/);
    await expect(softDeleteSweep(gone)).resolves.toEqual({ deleteStatus: 204, getStatus: 404, lists: 1 });
  });

  test('doubleSubmit: a checkout that refuses the second submit is GREEN', async ({ request }) => {
    await withStub(checkoutStub(false), async (stub) => {
      expect(await doubleSubmit(checkout(request, stub))).toEqual({ before: 0, after: 1, delta: 1 });
      expect(stub.requests().filter((record) => record.path === '/checkout')).toHaveLength(2);
    });
  });

  test('doubleSubmit: a checkout that creates two orders is RED', async ({ request }) => {
    await withStub(checkoutStub(true), async (stub) => {
      await expect(doubleSubmit(checkout(request, stub))).rejects.toThrow(/two simultaneous submits changed the effect count by 2 \(0 -> 2\), expected exactly 1/);
    });
  });

  test('doubleSubmit: usage errors throw TypeError', async () => {
    const action = async () => ({ status: 201 });
    await expect(doubleSubmit({ action, countEffects: () => 0, expectedDelta: -1 })).rejects.toThrow(/expectedDelta/);
    await expect(doubleSubmit({ action, countEffects: () => 0, expectedDelta: 1.5 })).rejects.toThrow(TypeError);
    await expect(doubleSubmit({ action, countEffects: () => Number.NaN })).rejects.toThrow(/countEffects must return a finite number/);
    await expect(doubleSubmit({ action: undefined as never, countEffects: () => 0 })).rejects.toThrow(TypeError);
  });

  test('concurrentRace: a last seat that admits one contender is GREEN', async ({ request }) => {
    await withStub(seatStub(), async (stub) => {
      const result = await lastSeatRace(request, stub);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(4);
      expect([...result.statuses].sort()).toEqual([201, 409, 409, 409, 409]);
    });
  });

  test('concurrentRace: an overbooking check-then-act is RED', async ({ request }) => {
    await withStub(seatStub('overbook'), async (stub) => {
      await expect(lastSeatRace(request, stub)).rejects.toThrow(/5 call\(s\) succeeded for a capacity of 1; the invariant does not hold after the race/);
    });
  });

  test('concurrentRace: a 5xx under contention is RED; a rejected call rethrows its own error', async ({ request }) => {
    await withStub(seatStub('crash-when-sold-out'), async (stub) => {
      await expect(lastSeatRace(request, stub)).rejects.toThrow(/concurrentRace \(n=5\): 4 call\(s\) answered 5xx: call \d HTTP 500/);
    });
    let settled = 0;
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const action = async (index: number) => {
      await delay(index * 10);
      settled += 1;
      if (index === 0) throw refused;
      return { status: 201 };
    };
    await expect(concurrentRace({ n: 3, action, invariant: () => true })).rejects.toBe(refused);
    // Every call settled before the rejection surfaced: nothing is left in flight.
    expect(settled).toBe(3);
  });

  test('concurrentRace: usage errors throw TypeError', async () => {
    const action = async () => ({ status: 201 });
    await expect(concurrentRace({ n: 1, action, invariant: () => true })).rejects.toThrow(/n must be an integer >= 2/);
    await expect(concurrentRace({ n: 2, action, capacity: -1, invariant: () => true })).rejects.toThrow(/capacity/);
    await expect(concurrentRace({ n: 2, action, invariant: () => 'yes' as never })).rejects.toThrow(/invariant must return true/);
    await expect(concurrentRace({ n: 2, action: async () => ({ code: 201 }) as never, invariant: () => true })).rejects.toThrow(/action\(0\) must resolve to an HTTP response/);
    await expect(concurrentRace({ n: 2, action: async () => { throw new TypeError('bad arrange'); }, invariant: () => true })).rejects.toThrow(TypeError);
    await expect(concurrentRace({ n: 2, action, invariant: () => true })).resolves.toEqual({ succeeded: 2, failed: 0, statuses: [201, 201] });
  });

  test('evaluateBounds: an element inside the viewport is ok; each rule fails on its own', () => {
    expect(evaluateBounds(FITS)).toEqual({ ok: true, violations: [] });
    const cases: Array<[Partial<BoundsMeasurement>, string]> = [
      [{ rect: { ...FITS.rect, x: -4 } }, 'renders past the left edge (x -4)'],
      [{ rect: { ...FITS.rect, y: -0.5 } }, 'renders above the top edge (y -0.5)'],
      [{ rect: { ...FITS.rect, width: 360 } }, 'renders past the right edge (right 376 > viewport width 375)'],
      [{ scrollWidth: 412 }, 'content overflows the box (scrollWidth 412 > clientWidth 343)'],
      [{ topElementIsSelf: false }, 'another element covers its center (occluded)'],
    ];
    for (const [change, violation] of cases) expect(evaluateBounds({ ...FITS, ...change })).toEqual({ ok: false, violations: [violation] });
    // Exactly at the right edge is inside.
    expect(evaluateBounds({ ...FITS, rect: { ...FITS.rect, x: 0, width: 375 } }).ok).toBe(true);
    // Several violations are all reported, in rule order.
    expect(evaluateBounds({ ...FITS, rect: { x: -10, y: -10, width: 400, height: 48 }, topElementIsSelf: false }).violations).toEqual([
      'renders past the left edge (x -10)',
      'renders above the top edge (y -10)',
      'renders past the right edge (right 390 > viewport width 375)',
      'another element covers its center (occluded)',
    ]);
  });

  test('evaluateBounds: usage errors throw TypeError', () => {
    expect(() => evaluateBounds(undefined as never)).toThrow(TypeError);
    expect(() => evaluateBounds({ ...FITS, rect: { ...FITS.rect, x: Number.NaN } })).toThrow(/rect\.x must be a finite number/);
    expect(() => evaluateBounds({ ...FITS, viewport: { width: 0, height: 812 } })).toThrow(/viewport non-empty/);
    expect(() => evaluateBounds({ ...FITS, topElementIsSelf: 'yes' as never })).toThrow(/topElementIsSelf/);
    expect(() => evaluateBounds({ ...FITS, scrollWidth: undefined as never })).toThrow(/scrollWidth/);
  });

  test('visualBounds: measures at the phone width, restores the viewport, and asserts the rules', async () => {
    const fits = recordingLocator(FITS);
    await expect(visualBounds(fits.locator)).resolves.toEqual(FITS);
    expect(fits.resized).toEqual([{ width: 375, height: 720 }, { width: 1280, height: 720 }]);
    const covered = recordingLocator({ ...FITS, topElementIsSelf: false });
    await expect(visualBounds(covered.locator, { viewportWidth: 320 })).rejects.toThrow(
      /visualBounds at 320px: getByRole\('button', \{ name: 'Pay' \}\) another element covers its center \(occluded\)/,
    );
    expect(covered.resized).toEqual([{ width: 320, height: 720 }, { width: 1280, height: 720 }]);
    await expect(visualBounds(fits.locator, { viewportWidth: 0 })).rejects.toThrow(/viewportWidth/);
    await expect(visualBounds({} as Locator)).rejects.toThrow(/pass a Playwright Locator/);
  });

  test('analyzeScaling: flat growth is ok and the median ignores an outlier', () => {
    const analysis = analyzeScaling(samples([[10, [5, 5, 90, 5, 5], 2048], [100, [5, 6, 5, 5, 4], 2048], [1000, [5, 5, 5, 70, 5], 2048]]));
    expect(analysis).toEqual({
      points: [
        { size: 10, ms: 5, bytes: 2048, runs: 5 },
        { size: 100, ms: 5, bytes: 2048, runs: 5 },
        { size: 1000, ms: 5, bytes: 2048, runs: 5 },
      ],
      timeExponent: 0,
      bytesExponent: 0,
      ok: true,
      violations: [],
    });
    // Sub-linear growth passes: 4 ms -> 16 ms over 100x the size is exponent 0.301.
    const sublinear = analyzeScaling(samples([[1000, [16], 100], [10, [4], 100], [100, [8], 100]]));
    expect(sublinear.points.map((point) => point.size)).toEqual([10, 100, 1000]);
    expect(sublinear.timeExponent).toBeCloseTo(0.301, 3);
    expect(sublinear.ok).toBe(true);
    // An even count takes the mean of the two middle values.
    expect(analyzeScaling(samples([[1, [2, 4], 10], [2, [3, 3], 10]])).points[0].ms).toBe(3);
  });

  test('analyzeScaling: linear time and a growing payload are violations', () => {
    const linear = analyzeScaling(samples([[10, [2, 2, 2], 1000], [100, [20, 20, 20], 10000], [1000, [200, 200, 200], 100000]]));
    expect(linear.timeExponent).toBe(1);
    expect(linear.bytesExponent).toBe(1);
    expect(linear.ok).toBe(false);
    expect(linear.violations).toEqual([
      'time exponent 1 > 0.5 (median 2 ms at size 10 -> 200 ms at size 1000)',
      'bytes exponent 1 > 0.1 (median 1000 bytes at size 10 -> 100000 bytes at size 1000)',
    ]);
    // The thresholds are the caller's: a documented linear read passes with explicit limits.
    expect(analyzeScaling(samples([[10, [2], 1000], [1000, [200], 100000]]), { maxTimeExponent: 1, maxBytesExponent: 1 }).ok).toBe(true);
    // A payload that grows from nothing is infinite growth; an always-empty one is flat.
    expect(analyzeScaling(samples([[10, [1], 0], [100, [1], 64]])).bytesExponent).toBe(Infinity);
    expect(analyzeScaling(samples([[10, [1], 0], [100, [1], 0]])).bytesExponent).toBe(0);
  });

  test('analyzeScaling: usage errors throw TypeError', () => {
    expect(() => analyzeScaling([])).toThrow(/non-empty array/);
    expect(() => analyzeScaling(samples([[10, [1, 2], 5]]))).toThrow(/at least two distinct sizes/);
    expect(() => analyzeScaling(samples([[0, [1], 5], [10, [1], 5]]))).toThrow(/size must be a finite number > 0/);
    expect(() => analyzeScaling(samples([[1, [-1], 5], [10, [1], 5]]))).toThrow(/ms must be a finite number >= 0/);
    expect(() => analyzeScaling(samples([[1, [1], Number.NaN], [10, [1], 5]]))).toThrow(/bytes/);
    expect(() => analyzeScaling(samples([[1, [1], 5], [10, [1], 5]]), { maxTimeExponent: Number.POSITIVE_INFINITY })).toThrow(/maxTimeExponent/);
  });

  test('n1Scaling: a one-page read is GREEN once the cold read is discarded', async ({ request }) => {
    await withStub(collectionStub(), async (stub) => {
      let calls = 0;
      const measure = readFirstPage(request, stub);
      const analysis = await n1Scaling({ sizes: SIZES, measure: (size) => { calls += 1; return measure(size); } });
      expect(calls).toBe(SIZES.length * 6);
      expect(analysis.points.map((point) => [point.size, point.ms, point.runs])).toEqual([[10, 2, 5], [100, 2, 5], [1000, 2, 5]]);
      expect(analysis.timeExponent).toBe(0);
      expect(analysis.bytesExponent).toBeLessThanOrEqual(0.1);
    });
    // Without the warm-up discard the cache fill over every row is measured as the read.
    await withStub(collectionStub(), async (stub) => {
      await expect(n1Scaling({ sizes: SIZES, measure: readFirstPage(request, stub), warmup: 0, runs: 1 })).rejects.toThrow(/time exponent 1 > 0\.5/);
    });
  });

  test('n1Scaling: a per-row query fan-out and an over-fetching read are RED', async ({ request }) => {
    await withStub(collectionStub('fan-out'), async (stub) => {
      await expect(n1Scaling({ sizes: SIZES, measure: readFirstPage(request, stub), runs: 3 })).rejects.toThrow(
        /n1Scaling: the read does not scale sub-linearly: time exponent 1 > 0\.5 \(median 2 ms at size 10 -> 200 ms at size 1000\)\nmedians: size 10: 2 ms/,
      );
    });
    await withStub(collectionStub('over-fetch'), async (stub) => {
      await expect(n1Scaling({ sizes: SIZES, measure: readFirstPage(request, stub), runs: 3 })).rejects.toThrow(/time exponent 1 > 0\.5 .*; bytes exponent 0\.9\d* > 0\.1/);
    });
  });

  test('n1Scaling: usage errors throw TypeError', async () => {
    const measure = () => ({ ms: 1, bytes: 1 });
    await expect(n1Scaling({ measure, sizes: [10, 100] })).rejects.toThrow(/at least three collection sizes/);
    await expect(n1Scaling({ measure, sizes: [10, 1000, 100] })).rejects.toThrow(/strictly ascending/);
    await expect(n1Scaling({ measure, sizes: SIZES, runs: 0 })).rejects.toThrow(/runs must be a positive integer/);
    await expect(n1Scaling({ measure, sizes: SIZES, warmup: -1 })).rejects.toThrow(/warmup/);
    await expect(n1Scaling({ measure: () => null as never, sizes: SIZES })).rejects.toThrow(/measure\(10\) must return \{ms, bytes\}/);
    await expect(n1Scaling({ measure, sizes: SIZES, maxBytesExponent: Number.NaN })).rejects.toThrow(/maxBytesExponent/);
    await expect(n1Scaling({ measure, sizes: SIZES })).resolves.toMatchObject({ timeExponent: 0, bytesExponent: 0, ok: true });
  });
});
