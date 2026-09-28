import { call, methodNotAllowed, readJsonObject, segmentsAfter, send } from '../http.mjs';

const BASE = '/api/orders';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const orderCount = async baseUrl => (await call(baseUrl, 'GET', `${BASE}/state`)).json.count;

async function createOrder(req, res, ctx) {
  const { state } = ctx;
  const body = await readJsonObject(req);
  const { quantity } = body;
  const withinLimit = ctx.enabled('quantity-boundary') || quantity <= state.quantityLimit;
  if (!Number.isInteger(quantity) || quantity < 1 || !withinLimit) {
    send(res, 422, { error: 'invalid-quantity', quantityLimit: state.quantityLimit });
    return;
  }
  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && key) {
    const previous = state.idempotency.get(key);
    if (previous && previous.quantity !== quantity) {
      send(res, 409, { error: 'idempotency-key-reused' });
      return;
    }
    if (previous) {
      send(res, 200, { ...previous, count: state.orders.length });
      return;
    }
  }
  const order = { id: ctx.deriveId(`order:${state.orders.length + 1}`), quantity };
  state.orders.push(order);
  if (typeof key === 'string' && key) state.idempotency.set(key, order);
  send(res, 201, { ...order, count: state.orders.length });
}

async function claimUnit(res, ctx) {
  const { state } = ctx;
  if (state.claims >= 1) {
    send(res, 409, { error: 'sold-out', claims: state.claims });
    return;
  }
  // The faulty build yields between the availability check and the reservation.
  if (ctx.enabled('capacity-race')) await delay(10);
  state.claims += 1;
  send(res, 201, { claims: state.claims });
}

export default Object.freeze({
  id: 'orders',
  title: 'Orders and capacity',
  basePaths: ['/api/orders'],
  seeds: [
    { id: 'quantity-boundary', surface: 'api', severity: 'Critical', criterion: 'An order whose quantity exceeds the published quantityLimit is accepted with 201 and increments the order count.' },
    { id: 'capacity-race', surface: 'api', severity: 'Critical', criterion: 'Concurrent claims acquire the single available unit more than once: two or more claims return 201 and claims exceeds 1.' },
  ],
  controls: [
    { id: 'orders-separate-creates', description: 'Two identical creates without an Idempotency-Key header are separate intentional orders; both return 201.' },
    { id: 'orders-invalid-422', description: 'Quantity 0 is rejected with 422 and creates no order.' },
    { id: 'orders-limit-inclusive', description: 'A quantity equal to quantityLimit is valid and returns 201.' },
  ],
  publicContract: ctx => ({
    quantityLimit: ctx.state.quantityLimit,
    rules: [
      'POST /api/orders with a JSON body {quantity} creates an order. quantity must be an integer from 1 through quantityLimit inclusive; the response is 201 {id, quantity, count}. Any other quantity returns 422 and creates no order.',
      'Requests without an Idempotency-Key header are separate intentional orders: two identical requests create two orders. Repeating a request with the same Idempotency-Key and quantity returns 200 with the original order and creates nothing; the same key with a different quantity returns 409.',
      'GET /api/orders lists created orders. GET /api/orders/state returns {count, claims}.',
      'POST /api/orders/claim reserves the single available unit. Across concurrent requests exactly one claim succeeds with 201; every other claim returns 409, and claims never exceeds 1.',
    ],
  }),
  createState: ctx => ({ quantityLimit: ctx.deriveInt('quantityLimit', 3, 10), orders: [], claims: 0, idempotency: new Map() }),
  async handle(req, res, url, ctx) {
    const parts = segmentsAfter(url.pathname, BASE);
    if (parts === null) return false;
    const { state } = ctx;
    if (parts.length === 0) {
      if (req.method === 'GET') send(res, 200, { orders: state.orders });
      else if (req.method === 'POST') await createOrder(req, res, ctx);
      else methodNotAllowed(res, ['GET', 'POST']);
      return true;
    }
    if (parts.length !== 1) return false;
    if (parts[0] === 'state') {
      if (req.method === 'GET') send(res, 200, { count: state.orders.length, claims: state.claims });
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    if (parts[0] === 'claim') {
      if (req.method === 'POST') await claimUnit(res, ctx);
      else methodNotAllowed(res, ['POST']);
      return true;
    }
    return false;
  },
  probes: {
    'quantity-boundary': async (baseUrl, contract) => {
      const before = await orderCount(baseUrl);
      const created = await call(baseUrl, 'POST', BASE, { json: { quantity: contract.quantityLimit + 1 } });
      return created.status === 201 && await orderCount(baseUrl) === before + 1;
    },
    // Concurrent claims over pre-opened keep-alive connections: the faulty build lets every claim
    // in flight pass the check. Claims above 1 also prove the defect when an earlier exchange raced.
    'capacity-race': async baseUrl => {
      const parallel = fn => Promise.all(Array.from({ length: 6 }, fn));
      await parallel(() => call(baseUrl, 'GET', `${BASE}/state`));
      const claims = await parallel(() => call(baseUrl, 'POST', `${BASE}/claim`));
      const state = (await call(baseUrl, 'GET', `${BASE}/state`)).json;
      return claims.filter(response => response.status === 201).length > 1 || state.claims > 1;
    },
    'orders-separate-creates': async baseUrl => {
      const before = await orderCount(baseUrl);
      const first = await call(baseUrl, 'POST', BASE, { json: { quantity: 1 } });
      const second = await call(baseUrl, 'POST', BASE, { json: { quantity: 1 } });
      return first.status === 201 && second.status === 201 && first.json.id !== second.json.id
        && await orderCount(baseUrl) === before + 2;
    },
    'orders-invalid-422': async baseUrl => {
      const before = await orderCount(baseUrl);
      const rejected = await call(baseUrl, 'POST', BASE, { json: { quantity: 0 } });
      return rejected.status === 422 && await orderCount(baseUrl) === before;
    },
    'orders-limit-inclusive': async (baseUrl, contract) => {
      const before = await orderCount(baseUrl);
      const created = await call(baseUrl, 'POST', BASE, { json: { quantity: contract.quantityLimit } });
      return created.status === 201 && created.json.quantity === contract.quantityLimit && await orderCount(baseUrl) === before + 1;
    },
  },
});
