import { call, methodNotAllowed, readJsonObject, segmentsAfter, send } from '../http.mjs';

const BASE = '/api/workflow';
const TARGETS = ['cancelled', 'committed'];

async function createItem(req, res, ctx) {
  await readJsonObject(req);
  const { items } = ctx.state;
  const item = { id: ctx.deriveId(`workflow:${items.size + 1}`), status: 'draft' };
  items.set(item.id, item);
  send(res, 201, item);
}

async function transition(req, res, item, ctx) {
  const { to } = await readJsonObject(req);
  if (!TARGETS.includes(to)) {
    send(res, 422, { error: 'invalid-target', allowed: TARGETS });
    return;
  }
  // The faulty build only treats committed as terminal, so cancelled items can still move.
  const blocked = ctx.enabled('terminal-transition')
    ? item.status === 'committed' || item.status === to
    : item.status !== 'draft';
  if (blocked) {
    send(res, 409, { error: 'invalid-transition', status: item.status });
    return;
  }
  item.status = to;
  send(res, 200, item);
}

const createProbeItem = async baseUrl => (await call(baseUrl, 'POST', BASE)).json.id;

export default Object.freeze({
  id: 'workflow',
  title: 'Workflow items',
  basePaths: [BASE],
  seeds: [
    { id: 'terminal-transition', surface: 'api', severity: 'Major', criterion: 'A cancelled workflow item transitions to committed with 200 instead of 409.' },
  ],
  controls: [
    { id: 'workflow-draft-commit', description: 'A draft item transitions to committed with 200.' },
  ],
  publicContract: () => ({
    statuses: ['draft', 'cancelled', 'committed'],
    rules: [
      'POST /api/workflow creates an item in status draft and returns 201 {id, status}. GET /api/workflow lists items as {items}; GET /api/workflow/{id} returns one item or 404.',
      "POST /api/workflow/{id}/transition with {to: 'cancelled' | 'committed'} applies a transition. The allowed transitions are draft -> cancelled and draft -> committed; each returns 200 with the updated item.",
      'cancelled and committed are terminal: any transition out of them returns 409 and leaves the status unchanged. A to value other than cancelled or committed returns 422.',
    ],
  }),
  createState: () => ({ items: new Map() }),
  async handle(req, res, url, ctx) {
    const parts = segmentsAfter(url.pathname, BASE);
    if (parts === null) return false;
    const { items } = ctx.state;
    if (parts.length === 0) {
      if (req.method === 'GET') send(res, 200, { items: [...items.values()] });
      else if (req.method === 'POST') await createItem(req, res, ctx);
      else methodNotAllowed(res, ['GET', 'POST']);
      return true;
    }
    if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'transition')) return false;
    const item = items.get(parts[0]);
    if (!item) {
      send(res, 404, { error: 'not-found' });
      return true;
    }
    if (parts.length === 1) {
      if (req.method === 'GET') send(res, 200, item);
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    if (req.method === 'POST') await transition(req, res, item, ctx);
    else methodNotAllowed(res, ['POST']);
    return true;
  },
  probes: {
    'terminal-transition': async baseUrl => {
      const id = await createProbeItem(baseUrl);
      const cancelled = await call(baseUrl, 'POST', `${BASE}/${id}/transition`, { json: { to: 'cancelled' } });
      const committed = await call(baseUrl, 'POST', `${BASE}/${id}/transition`, { json: { to: 'committed' } });
      const item = await call(baseUrl, 'GET', `${BASE}/${id}`);
      return cancelled.status === 200 && committed.status === 200 && item.json.status === 'committed';
    },
    'workflow-draft-commit': async baseUrl => {
      const id = await createProbeItem(baseUrl);
      const committed = await call(baseUrl, 'POST', `${BASE}/${id}/transition`, { json: { to: 'committed' } });
      const item = await call(baseUrl, 'GET', `${BASE}/${id}`);
      return committed.status === 200 && committed.json.status === 'committed' && item.json.status === 'committed';
    },
  },
});
