import { call, methodNotAllowed, readJsonObject, segmentsAfter, send } from '../http.mjs';

const BASE = '/api/catalog';
const SEARCH = `${BASE}/search`;
const LIMIT = Object.freeze({ min: 1, max: 100, default: 20 });
const MAX_QUERY_LENGTH = 200;
const P95_MS = 300;
const CONCURRENCY = 10;
const ITEM_READ_MS = 60;
const SLOW_SEARCH_MS = 450;
const REPORT_READY_MS = 1500;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 5000 deterministic items (5 colors x 10 styles x 10 materials x 10 products, every name unique),
// built once and shared read-only by every instance. Prices follow a fixed arithmetic pattern.
const COLORS = ['Black', 'Blue', 'Green', 'Grey', 'Red'];
const STYLES = ['Classic', 'Compact', 'Deluxe', 'Folding', 'Heavy', 'Light', 'Modern', 'Rustic', 'Slim', 'Vintage'];
const MATERIALS = ['Bamboo', 'Brass', 'Canvas', 'Ceramic', 'Cotton', 'Glass', 'Leather', 'Oak', 'Steel', 'Wool'];
const PRODUCTS = ['Bag', 'Bottle', 'Chair', 'Clock', 'Desk', 'Lamp', 'Mug', 'Rug', 'Shelf', 'Table'];
const NAME_PARTS = [COLORS, STYLES, MATERIALS, PRODUCTS];
function itemName(index) {
  let rest = index;
  return NAME_PARTS.map(words => {
    const word = words[rest % words.length];
    rest = Math.floor(rest / words.length);
    return word;
  }).join(' ');
}
const CATALOG = Object.freeze(Array.from({ length: NAME_PARTS.reduce((count, words) => count * words.length, 1) }, (_, index) => Object.freeze({
  id: `sku-${String(index + 1).padStart(5, '0')}`,
  name: itemName(index),
  priceCents: 499 + (index * 7919) % 49500,
})));
const SEARCH_TEXT = CATALOG.map(item => item.name.toLowerCase());
const BY_ID = new Map(CATALOG.map(item => [item.id, item]));

// Two-term queries used by the latency probe; each matches catalog items.
const TWO_TERM_QUERIES = ['blue lamp', 'oak chair', 'red mug', 'steel desk', 'wool rug', 'glass bottle', 'brass clock', 'leather bag', 'canvas shelf', 'bamboo table'];

async function search(res, url, ctx) {
  const q = url.searchParams.get('q') ?? '';
  if (q.length > MAX_QUERY_LENGTH) {
    send(res, 422, { error: 'invalid-query', maxLength: MAX_QUERY_LENGTH });
    return;
  }
  const raw = url.searchParams.get('limit');
  const limit = raw === null ? LIMIT.default : /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  // The faulty build validates the lower bound only, so any large limit is served in full.
  const max = ctx.enabled('perf-unbounded-limit') ? Infinity : LIMIT.max;
  if (!(limit >= LIMIT.min && limit <= max)) {
    send(res, 422, { error: 'invalid-limit', min: LIMIT.min, max: LIMIT.max });
    return;
  }
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  // The faulty build sends multi-term queries down an unindexed slow path.
  if (terms.length >= 2 && ctx.enabled('perf-search-latency')) await delay(SLOW_SEARCH_MS);
  const matches = CATALOG.filter((_, index) => terms.every(term => SEARCH_TEXT[index].includes(term)));
  send(res, 200, { q, limit, total: matches.length, items: matches.slice(0, limit) });
}

// A promise chain acting as an instance-wide mutex.
function serialized(state, task) {
  const run = state.readChain.then(task);
  state.readChain = run.catch(() => {});
  return run;
}

async function readItem(res, id, ctx) {
  // Every read costs one simulated 60 ms storage round trip. The faulty build holds a global
  // lock for the whole round trip, so concurrent reads queue behind each other.
  if (ctx.enabled('perf-serialized-item-reads')) await serialized(ctx.state, () => delay(ITEM_READ_MS));
  else await delay(ITEM_READ_MS);
  const item = BY_ID.get(id);
  if (item) send(res, 200, item);
  else send(res, 404, { error: 'not-found' });
}

async function createReport(req, res, ctx) {
  const body = await readJsonObject(req);
  const unknown = Object.keys(body);
  if (unknown.length) {
    send(res, 422, { error: 'unknown-field', fields: unknown });
    return;
  }
  const { reports } = ctx.state;
  const reportId = ctx.deriveId(`report:${reports.size + 1}`);
  reports.set(reportId, { requestedAt: performance.now() });
  send(res, 202, { reportId, status: 'pending' }, { location: `${BASE}/reports/${reportId}` });
}

function readReport(res, reportId, ctx) {
  const report = ctx.state.reports.get(reportId);
  if (!report) send(res, 404, { error: 'not-found' });
  else if (performance.now() - report.requestedAt >= REPORT_READY_MS) send(res, 200, { reportId, status: 'ready', itemCount: CATALOG.length });
  else send(res, 200, { reportId, status: 'pending' }, { 'retry-after': '1' });
}

// Nearest-rank 95th percentile.
function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function timedCall(baseUrl, path) {
  const started = performance.now();
  const response = await call(baseUrl, 'GET', path);
  return { ms: performance.now() - started, response };
}

export default Object.freeze({
  id: 'catalog-perf',
  title: 'Product catalog',
  basePaths: [BASE],
  entryPaths: [SEARCH],
  seeds: [
    { id: 'perf-search-latency', surface: 'perf', severity: 'Major', criterion: 'A catalog search whose q has two or more whitespace-separated terms takes about 450 ms, so the p95 latency of ten sequential two-term searches exceeds the published 300 ms budget.' },
    { id: 'perf-unbounded-limit', surface: 'perf', severity: 'Major', criterion: 'GET /api/catalog/search with a limit above 100, such as limit=1000, returns 200 with more than 100 items instead of 422.' },
    { id: 'perf-serialized-item-reads', surface: 'perf', severity: 'Major', criterion: 'Concurrent item reads are serialized behind a global lock held about 60 ms per read: a single read stays within budget, but 10 concurrent reads exceed the 300 ms p95 budget and 20 concurrent reads reach a p95 of 1000 ms or more.' },
  ],
  controls: [
    { id: 'perf-report-async', description: 'POST /api/catalog/reports returns 202 at once and the report stays pending until it becomes ready about 1500 ms later; documented asynchronous processing, not a latency defect.' },
  ],
  publicContract: () => ({
    itemCount: CATALOG.length,
    searchLimit: { ...LIMIT },
    latencyBudget: { p95Ms: P95_MS, concurrency: CONCURRENCY, endpoints: ['GET /api/catalog/search', 'GET /api/catalog/items/{id}'] },
    reportReadyAfterMs: REPORT_READY_MS,
    rules: [
      `GET /api/catalog/search?q=<terms>&limit=<n> returns {q, limit, total, items: [{id, name, priceCents}]}. items holds, in id order, the first limit catalog items whose name contains every whitespace-separated term of q, ignoring case; an empty or missing q matches all ${CATALOG.length} items. total counts every match.`,
      `limit is an integer from ${LIMIT.min} through ${LIMIT.max} (default ${LIMIT.default}); any other limit returns 422 and no items. q is at most ${MAX_QUERY_LENGTH} characters, otherwise 422.`,
      'GET /api/catalog/items/{id} returns one item {id, name, priceCents}, or 404 for an unknown id.',
      `Latency budget: GET /api/catalog/search (for any valid q and limit) and GET /api/catalog/items/{id} each keep a p95 latency of at most ${P95_MS} ms with up to ${CONCURRENCY} concurrent requests.`,
      `POST /api/catalog/reports with an empty body or {} starts an asynchronous full-catalog report and returns 202 {reportId, status: 'pending'} with a Location header. GET /api/catalog/reports/{reportId} returns {reportId, status}: status stays pending until the report is ready about ${REPORT_READY_MS} ms after the request, then ready with itemCount. Report generation is asynchronous by design and outside the latency budget. An unknown reportId returns 404.`,
    ],
  }),
  createState: () => ({ readChain: Promise.resolve(), reports: new Map() }),
  async handle(req, res, url, ctx) {
    const parts = segmentsAfter(url.pathname, BASE);
    if (parts === null || parts.length === 0 || parts.length > 2) return false;
    const [resource, id] = parts;
    if (resource === 'search' && parts.length === 1) {
      if (req.method === 'GET') await search(res, url, ctx);
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    if (resource === 'items' && parts.length === 2) {
      if (req.method === 'GET') await readItem(res, id, ctx);
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    if (resource === 'reports') {
      if (parts.length === 1) {
        if (req.method === 'POST') await createReport(req, res, ctx);
        else methodNotAllowed(res, ['POST']);
      } else if (req.method === 'GET') readReport(res, id, ctx);
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    return false;
  },
  probes: {
    // Ten sequential two-term searches: the faulty build answers each after at least 450 ms,
    // the correct build well under 50 ms.
    'perf-search-latency': async (baseUrl, section) => {
      const samples = [];
      for (const q of TWO_TERM_QUERIES) {
        const { ms, response } = await timedCall(baseUrl, `${SEARCH}?q=${encodeURIComponent(q)}&limit=10`);
        if (response.status !== 200) return false;
        samples.push(ms);
      }
      return p95(samples) > section.latencyBudget.p95Ms;
    },
    'perf-unbounded-limit': async (baseUrl, section) => {
      const response = await call(baseUrl, 'GET', `${SEARCH}?q=&limit=1000`);
      return response.status === 200 && response.json.items.length > section.searchLimit.max;
    },
    // Twenty concurrent reads over separate connections: serialized reads finish 60 ms apart
    // (p95 about 1140 ms); unserialized reads all finish after about 60 ms.
    'perf-serialized-item-reads': async (baseUrl, section) => {
      const listed = await call(baseUrl, 'GET', `${SEARCH}?q=&limit=20`);
      if (listed.status !== 200 || listed.json.items.length !== 20) return false;
      const reads = await Promise.all(listed.json.items.map(item => timedCall(baseUrl, `${BASE}/items/${item.id}`)));
      if (reads.some(({ response }) => response.status !== 200)) return false;
      return p95(reads.map(read => read.ms)) > section.latencyBudget.p95Ms;
    },
    // Polls without asserting a lower bound on readiness, which would be fragile under load.
    'perf-report-async': async (baseUrl, section) => {
      const created = await call(baseUrl, 'POST', `${BASE}/reports`, { json: {} });
      const reportId = created.json?.reportId;
      if (created.status !== 202 || typeof reportId !== 'string' || created.headers.get('location') !== `${BASE}/reports/${reportId}`) return false;
      const path = `${BASE}/reports/${encodeURIComponent(reportId)}`;
      const first = await call(baseUrl, 'GET', path);
      if (first.status !== 200 || first.json.status !== 'pending') return false;
      const deadline = performance.now() + section.reportReadyAfterMs * 2 + 1000;
      while (performance.now() < deadline) {
        await delay(100);
        const polled = await call(baseUrl, 'GET', path);
        if (polled.status !== 200 || !['pending', 'ready'].includes(polled.json.status)) return false;
        if (polled.json.status === 'ready') return polled.json.itemCount === section.itemCount;
      }
      return false;
    },
  },
});
