import { actorOf, call, methodNotAllowed, readJsonObject, segmentsAfter, send, sendText } from '../http.mjs';

const INVOICES = '/api/invoices';
const ME = '/api/me';
const ADMIN = '/api/admin';
const TENANTS = ['t-a', 't-b'];
const CUSTOMERS = ['Northwind Traders', 'Contoso Ltd', 'Fabrikam Inc', 'Tailspin Toys'];
const CSV_HEADER = 'id,tenant,number,customer,amountCents';

const csvCell = value => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const toCsv = invoices => [CSV_HEADER, ...invoices.map(item => [item.id, item.tenant, item.number, item.customer, item.amountCents].map(csvCell).join(','))].join('\n') + '\n';
const isName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
const unauthenticated = res => send(res, 401, { error: 'unauthenticated' });

function nextInvoice(state, tenant, customer, amountCents, id) {
  state.numbers[tenant] += 1;
  const invoice = { id, tenant, number: `${tenant.toUpperCase()}-${String(state.numbers[tenant]).padStart(4, '0')}`, customer, amountCents };
  state.invoices.set(id, invoice);
  return invoice;
}

async function handleInvoices(req, res, parts, ctx) {
  const actor = actorOf(req);
  if (!actor) return unauthenticated(res);
  const { state } = ctx;
  const { tenant } = state.users[actor];
  if (parts.length === 0) {
    if (req.method === 'GET') {
      // The faulty build forgets the tenant filter on the collection query.
      const all = [...state.invoices.values()];
      send(res, 200, { invoices: ctx.enabled('authz-tenant-list-leak') ? all : all.filter(item => item.tenant === tenant) });
    } else if (req.method === 'POST') {
      const { customer, amountCents } = await readJsonObject(req);
      if (!isName(customer) || !Number.isInteger(amountCents) || amountCents < 1 || amountCents > 100000000) {
        send(res, 422, { error: 'invalid-invoice' });
        return;
      }
      state.created += 1;
      send(res, 201, nextInvoice(state, tenant, customer, amountCents, ctx.deriveId(`invoice:created:${state.created}`)));
    } else methodNotAllowed(res, ['GET', 'POST']);
    return;
  }
  const invoice = state.invoices.get(parts[0]);
  const own = invoice?.tenant === tenant;
  if (req.method === 'GET') {
    if (own) send(res, 200, invoice);
    else send(res, 404, { error: 'not-found' });
  } else if (req.method === 'DELETE') {
    // The faulty build checks existence but not tenant ownership before deleting.
    if (invoice && (own || ctx.enabled('authz-idor-write'))) {
      state.invoices.delete(invoice.id);
      send(res, 204);
    } else send(res, 404, { error: 'not-found' });
  } else methodNotAllowed(res, ['GET', 'DELETE']);
}

async function handleMe(req, res, ctx) {
  const actor = actorOf(req);
  if (!actor) return unauthenticated(res);
  const user = ctx.state.users[actor];
  if (req.method === 'GET') {
    send(res, 200, { account: actor, ...user });
    return;
  }
  if (req.method !== 'PATCH') {
    methodNotAllowed(res, ['GET', 'PATCH']);
    return;
  }
  const changes = await readJsonObject(req);
  // The faulty build's allow-list mistakenly includes role.
  const writable = ctx.enabled('authz-mass-assignment-role') ? ['displayName', 'role'] : ['displayName'];
  const unknown = Object.keys(changes).filter(field => !writable.includes(field));
  if (unknown.length) {
    send(res, 422, { error: 'unknown-field', fields: unknown });
    return;
  }
  if ('displayName' in changes && !isName(changes.displayName)) {
    send(res, 422, { error: 'invalid-displayName' });
    return;
  }
  if ('role' in changes && !['member', 'admin'].includes(changes.role)) {
    send(res, 422, { error: 'invalid-role' });
    return;
  }
  Object.assign(user, changes);
  send(res, 200, { account: actor, ...user });
}

function handleAdmin(req, res, parts, ctx) {
  if (parts.length !== 1 || parts[0] !== 'export') return false;
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return true;
  }
  const { state } = ctx;
  const all = [...state.invoices.values()];
  const actor = actorOf(req);
  if (!actor) {
    // The faulty build treats a missing actor as a trusted internal caller.
    if (ctx.enabled('authz-unauth-export')) sendText(res, 200, toCsv(all), 'text/csv; charset=utf-8');
    else unauthenticated(res);
    return true;
  }
  const user = state.users[actor];
  if (user.role !== 'admin') send(res, 403, { error: 'forbidden' });
  else sendText(res, 200, toCsv(all.filter(item => item.tenant === user.tenant)), 'text/csv; charset=utf-8');
  return true;
}

const createBobInvoice = async baseUrl => (await call(baseUrl, 'POST', INVOICES, { actor: 'bob', json: { customer: 'Probe Customer', amountCents: 1234 } })).json.id;

export default Object.freeze({
  id: 'tenant-authz',
  title: 'Multi-tenant invoices',
  basePaths: [INVOICES, ME, ADMIN],
  seeds: [
    { id: 'authz-tenant-list-leak', surface: 'authz', severity: 'Critical', criterion: "Alice's invoice list includes invoices that belong to tenant t-b." },
    { id: 'authz-idor-write', surface: 'authz', severity: 'Critical', criterion: "Alice deletes an invoice of tenant t-b and receives 204; the invoice no longer exists for bob." },
    { id: 'authz-mass-assignment-role', surface: 'authz', severity: 'Critical', criterion: "PATCH /api/me with role 'admin' is accepted and the elevated role is persisted." },
    { id: 'authz-unauth-export', surface: 'authz', severity: 'Critical', criterion: 'GET /api/admin/export without an actor returns 200 with invoice CSV instead of 401.' },
  ],
  controls: [
    { id: 'authz-foreign-404', description: 'Reading an invoice of another tenant returns the documented 404, not 403.' },
    { id: 'authz-admin-export', description: "Carol, the admin of tenant t-a, exports a CSV containing only t-a invoices." },
  ],
  publicContract: () => ({
    tenants: { 't-a': { members: ['alice'], admins: ['carol'] }, 't-b': { members: ['bob'], admins: [] } },
    rules: [
      'Accounts belong to tenants: alice (member) and carol (admin) belong to tenant t-a; bob (member) belongs to tenant t-b. Identify the actor with the x-actor header; every endpoint in this module returns 401 without a known x-actor.',
      'GET /api/invoices lists only the invoices of the actor\'s own tenant as {invoices}. POST /api/invoices with {customer, amountCents} creates an invoice in the actor\'s tenant and returns 201; customer must be a non-empty string of at most 100 characters and amountCents an integer from 1 through 100000000, otherwise 422.',
      'GET /api/invoices/{id} returns an invoice of the actor\'s own tenant. DELETE /api/invoices/{id} deletes an invoice of the actor\'s own tenant and returns 204. Reading or deleting an invoice of another tenant returns 404, exactly like an unknown id, so that the existence of foreign invoices is not disclosed.',
      'GET /api/me returns {account, tenant, role, displayName}. PATCH /api/me accepts only displayName (a non-empty string of at most 100 characters); a request containing any other field returns 422 and changes nothing.',
      'GET /api/admin/export returns 401 without an actor, 403 for a member, and 200 text/csv for a tenant admin. The CSV header is id,tenant,number,customer,amountCents and the rows contain only the admin\'s own tenant.',
    ],
  }),
  createState: ctx => {
    const state = {
      users: {
        alice: { tenant: 't-a', role: 'member', displayName: 'Alice' },
        bob: { tenant: 't-b', role: 'member', displayName: 'Bob' },
        carol: { tenant: 't-a', role: 'admin', displayName: 'Carol' },
      },
      invoices: new Map(),
      numbers: { 't-a': 0, 't-b': 0 },
      created: 0,
    };
    TENANTS.forEach((tenant, tenantIndex) => {
      for (const n of [1, 2]) {
        const name = `invoice:${tenant}:${n}`;
        nextInvoice(state, tenant, CUSTOMERS[tenantIndex * 2 + n - 1], ctx.deriveInt(`${name}:amount`, 1000, 500000), ctx.deriveId(name));
      }
    });
    return state;
  },
  async handle(req, res, url, ctx) {
    const invoiceParts = segmentsAfter(url.pathname, INVOICES);
    if (invoiceParts !== null) {
      if (invoiceParts.length > 1) return false;
      await handleInvoices(req, res, invoiceParts, ctx);
      return true;
    }
    const meParts = segmentsAfter(url.pathname, ME);
    if (meParts !== null) {
      if (meParts.length) return false;
      await handleMe(req, res, ctx);
      return true;
    }
    const adminParts = segmentsAfter(url.pathname, ADMIN);
    return adminParts !== null && handleAdmin(req, res, adminParts, ctx);
  },
  probes: {
    'authz-tenant-list-leak': async baseUrl => {
      const foreignId = await createBobInvoice(baseUrl);
      const list = await call(baseUrl, 'GET', INVOICES, { actor: 'alice' });
      return list.status === 200 && list.json.invoices.some(item => item.id === foreignId || item.tenant !== 't-a');
    },
    'authz-idor-write': async baseUrl => {
      const foreignId = await createBobInvoice(baseUrl);
      const deleted = await call(baseUrl, 'DELETE', `${INVOICES}/${foreignId}`, { actor: 'alice' });
      const afterwards = await call(baseUrl, 'GET', `${INVOICES}/${foreignId}`, { actor: 'bob' });
      return deleted.status === 204 && afterwards.status === 404;
    },
    // Restores bob's role after proving the defect so later probes see the published roles.
    'authz-mass-assignment-role': async baseUrl => {
      await call(baseUrl, 'PATCH', ME, { actor: 'bob', json: { role: 'admin' } });
      const escalated = (await call(baseUrl, 'GET', ME, { actor: 'bob' })).json.role === 'admin';
      if (escalated) await call(baseUrl, 'PATCH', ME, { actor: 'bob', json: { role: 'member' } });
      return escalated;
    },
    'authz-unauth-export': async baseUrl => (await call(baseUrl, 'GET', `${ADMIN}/export`)).status === 200,
    'authz-foreign-404': async baseUrl => {
      const foreignId = await createBobInvoice(baseUrl);
      const foreign = await call(baseUrl, 'GET', `${INVOICES}/${foreignId}`, { actor: 'alice' });
      const owner = await call(baseUrl, 'GET', `${INVOICES}/${foreignId}`, { actor: 'bob' });
      return foreign.status === 404 && owner.status === 200;
    },
    'authz-admin-export': async baseUrl => {
      const ownId = (await call(baseUrl, 'POST', INVOICES, { actor: 'carol', json: { customer: 'Probe Customer', amountCents: 4321 } })).json.id;
      await createBobInvoice(baseUrl);
      const exported = await call(baseUrl, 'GET', `${ADMIN}/export`, { actor: 'carol' });
      const [header, ...rows] = exported.text.trimEnd().split('\n');
      const cells = rows.map(row => row.split(','));
      return exported.status === 200 && (exported.headers.get('content-type') ?? '').startsWith('text/csv')
        && header === CSV_HEADER && cells.some(([id]) => id === ownId) && cells.every(([, tenant]) => tenant === 't-a');
    },
  },
});
