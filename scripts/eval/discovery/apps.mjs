import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Evaluator-only source; never copied into the hunter workspace or installed plugin.
export async function startApplication({ family, faulty = true, seed = 1 }) {
  if (!['orders', 'accounts', 'workflow'].includes(family)) throw new Error('unknown application family');
  const limit = 3 + seed % 8;
  const id = randomUUID();
  const state = { count: 0, claims: 0, status: 'draft' };
  const truth = {
    orders: [{ id: 'quantity-boundary', severity: 'Critical', criterion: 'An order quantity above the published maximum is persisted.' }, { id: 'capacity-race', severity: 'Critical', criterion: 'Two concurrent claims acquire the one available unit.' }],
    accounts: [{ id: 'cross-owner-read', severity: 'Critical', criterion: 'Bob retrieves the private object owned by Alice.' }],
    workflow: [{ id: 'terminal-transition', severity: 'Major', criterion: 'A cancelled entity transitions to committed.' }],
  }[family];
  const contract = {
    family, accounts: ['alice', 'bob'], objectId: id, quantityLimit: limit,
    rules: family === 'orders'
      ? ['POST /orders accepts integer quantity from 1 through quantityLimit inclusive. Invalid input returns 422 and creates no order.', 'Requests without an idempotency key represent separate intentional orders. GET /state returns count and claims.', 'POST /claim reserves one available unit. Across concurrent requests exactly one may succeed; subsequent claims return 409.']
      : family === 'accounts'
        ? ['GET /objects/{objectId} requires x-actor: alice, its owner; bob must receive 403.', 'GET /profile?email=... preserves email case. Case sensitivity is intentional.']
        : ['POST /transition accepts {to: cancelled|committed}. Allowed: draft->cancelled, draft->committed. Terminal states cannot change.', 'GET /state returns status. An invalid transition returns 409 without mutation.'],
  };
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/contract') return send(200, contract);
      if (url.pathname === '/state') return send(200, state);
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return send(413, {}); }
      const body = raw ? JSON.parse(raw) : {};
      if (family === 'orders' && req.method === 'POST' && url.pathname === '/orders') {
        if (!Number.isInteger(body.quantity) || body.quantity < 1 || (!faulty && body.quantity > limit)) return send(422, { error: 'quantity' });
        state.count++; return send(201, { quantity: body.quantity, count: state.count });
      }
      if (family === 'orders' && req.method === 'POST' && url.pathname === '/claim') {
        if (state.claims >= 1) return send(409, {});
        if (faulty) await new Promise(resolve => setTimeout(resolve, 10));
        state.claims++; return send(201, { claims: state.claims });
      }
      if (family === 'accounts' && url.pathname === `/objects/${id}`) {
        if (!['alice', 'bob'].includes(req.headers['x-actor'])) return send(401, {});
        if (!faulty && req.headers['x-actor'] !== 'alice') return send(403, {});
        return send(200, { owner: 'alice', privateNote: 'synthetic private note' });
      }
      if (family === 'accounts' && url.pathname === '/profile') return send(200, { email: url.searchParams.get('email') });
      if (family === 'workflow' && req.method === 'POST' && url.pathname === '/transition') {
        if (!['cancelled', 'committed'].includes(body.to) || (!faulty && state.status !== 'draft')) return send(409, { status: state.status });
        state.status = body.to; return send(200, state);
      }
      send(404, {});
    } catch { send(400, { error: 'invalid-json' }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, truth: faulty ? truth : [],
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
