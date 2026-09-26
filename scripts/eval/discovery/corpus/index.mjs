import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveId, deriveInt } from './derive.mjs';
import { escapeHtml, page } from './html.mjs';
import { ACCOUNTS, RequestError, methodNotAllowed, send, sendHtml } from './http.mjs';
import orders from './modules/orders.mjs';
import accounts from './modules/accounts.mjs';
import workflow from './modules/workflow.mjs';
import tenantAuthz from './modules/tenant-authz.mjs';
import orderEvents from './modules/order-events.mjs';
import storefrontUi from './modules/storefront-ui.mjs';
import a11yForms from './modules/a11y-forms.mjs';
import catalogPerf from './modules/catalog-perf.mjs';

// Evaluator-only corpus: one loopback application composed of modules. Each module carries
// seeded defects, correct-lookalike controls and deterministic probes. Seed IDs, criteria,
// the corpus version and enabled flags never reach a hunter-visible endpoint.
export const corpusVersion = 'argus-eval-corpus@2';
export const corpusDir = fileURLToPath(new URL('.', import.meta.url));

const SURFACES = ['api', 'authz', 'events', 'ui', 'a11y', 'perf'];
const SEVERITIES = ['Critical', 'Major', 'Minor'];
const ID = /^[a-z][a-z0-9-]*$/;

// Module contract (the default export must be frozen): {id, title, basePaths, entryPaths?,
// seeds: [{id, surface, severity, criterion}], controls: [{id, description}], publicContract(ctx)
// -> {rules, ...publicFields}, createState(ctx), async handle(req, res, url, ctx) -> boolean
// (false means not handled, answered 404), probes: {[seedOrControlId]: async (baseUrl, section)
// -> boolean}}. `section` is the module's own entry of the public contract. `entryPaths`
// optionally replaces basePaths[0] as the index links. ctx = {seed, enabled(seedId), deriveId(name),
// deriveInt(name, min, max), state}: the derive helpers are pre-bound to the seed, and enabled()
// throws for a seed the module does not own.
function register(list) {
  const moduleIds = new Set();
  const itemIds = new Set();
  const basePaths = new Set();
  for (const module of list) {
    const where = `corpus module ${module?.id}`;
    if (!Object.isFrozen(module)) throw new Error(`${where}: default export must be frozen`);
    if (!ID.test(module.id ?? '') || moduleIds.has(module.id)) throw new Error(`${where}: id must be unique kebab-case`);
    moduleIds.add(module.id);
    if (typeof module.title !== 'string' || !module.title) throw new Error(`${where}: title required`);
    for (const name of ['publicContract', 'createState', 'handle']) if (typeof module[name] !== 'function') throw new Error(`${where}: ${name} must be a function`);
    for (const field of ['basePaths', 'entryPaths']) {
      const paths = module[field];
      if (paths === undefined && field === 'entryPaths') continue;
      if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !/^\/[a-z0-9/-]*[a-z0-9]$/.test(path))) throw new Error(`${where}: ${field} must be non-empty absolute paths`);
    }
    for (const path of module.basePaths) {
      if (basePaths.has(path)) throw new Error(`${where}: base path ${path} is already registered`);
      basePaths.add(path);
    }
    if (!Array.isArray(module.seeds) || !Array.isArray(module.controls) || !module.probes || typeof module.probes !== 'object') throw new Error(`${where}: seeds, controls and probes required`);
    const items = [...module.seeds, ...module.controls];
    for (const item of items) {
      if (!ID.test(item.id ?? '') || itemIds.has(item.id)) throw new Error(`${where}: seed and control ids must be unique kebab-case (${item.id})`);
      itemIds.add(item.id);
      if (typeof module.probes[item.id] !== 'function') throw new Error(`${where}: missing probe for ${item.id}`);
    }
    for (const seed of module.seeds) {
      if (!SURFACES.includes(seed.surface) || !SEVERITIES.includes(seed.severity) || typeof seed.criterion !== 'string' || !seed.criterion) throw new Error(`${where}: seed ${seed.id} needs a surface, severity and criterion`);
    }
    for (const control of module.controls) if (typeof control.description !== 'string' || !control.description) throw new Error(`${where}: control ${control.id} needs a description`);
    const known = new Set(items.map(item => item.id));
    for (const id of Object.keys(module.probes)) if (!known.has(id)) throw new Error(`${where}: probe ${id} matches no seed or control`);
    for (const value of [module.basePaths, module.entryPaths, module.seeds, module.controls, module.probes, ...items]) if (value) Object.freeze(value);
  }
  return Object.freeze([...list]);
}

export const modules = register([orders, accounts, workflow, tenantAuthz, orderEvents, storefrontUi, a11yForms, catalogPerf]);
export const seeds = Object.freeze(modules.flatMap(module => module.seeds.map(seed => Object.freeze({
  id: seed.id, module: module.id, surface: seed.surface, severity: seed.severity, criterion: seed.criterion }))));
export const seedIds = Object.freeze(seeds.map(seed => seed.id));
export const controls = Object.freeze(modules.flatMap(module => module.controls.map(control => Object.freeze({
  id: control.id, module: module.id, description: control.description }))));

function enabledSet(enabledSeeds) {
  if (!Array.isArray(enabledSeeds)) throw new Error('enabledSeeds must be an array of seed ids');
  for (const id of enabledSeeds) if (!seedIds.includes(id)) throw new Error(`unknown corpus seed: ${id}`);
  return new Set(enabledSeeds);
}

function indexHtml(contract) {
  const links = modules.map(module => (module.entryPaths ?? [module.basePaths[0]])
    .map(path => `<li><a href="${escapeHtml(path)}">${escapeHtml(contract.modules[module.id].title)}: ${escapeHtml(path)}</a></li>`).join('\n')).join('\n');
  return page({ title: 'Evaluation suite', body: `<h1>Evaluation suite</h1>
<p>Test accounts: ${contract.accounts.map(escapeHtml).join(', ')}. Send the account name in the x-actor request header.</p>
<h2>Areas</h2>
<ul>
${links}
</ul>
<h2>Documentation</h2>
<ul>
<li><a href="/docs">Published rules</a></li>
<li><a href="/contract">Machine-readable contract (JSON)</a></li>
</ul>` });
}

function docsHtml(contract) {
  const sections = Object.values(contract.modules).map(({ title, basePaths, rules, ...fields }) => {
    const values = Object.entries(fields).map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(JSON.stringify(value))}</code></dd>`).join('\n');
    return `<section>
<h2>${escapeHtml(title)}</h2>
<p>Base paths: ${basePaths.map(path => `<code>${escapeHtml(path)}</code>`).join(', ')}</p>
<ul>
${rules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('\n')}
</ul>${values ? `\n<dl>\n${values}\n</dl>` : ''}
</section>`;
  }).join('\n');
  return page({ title: 'Published rules', body: `<h1>Published rules</h1>\n${sections}` });
}

const matchesBase = (pathname, base) => pathname === base || pathname.startsWith(`${base}/`);

// Starts the composite application on 127.0.0.1. `enabledSeeds` selects the faulty behaviors;
// every other seed behaves correctly. The same seed always yields the same public contract and IDs.
export async function startApplication({ seed, enabledSeeds = [], port = 0 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('corpus seed must be a non-negative safe integer');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 through 65535');
  const enabled = enabledSet(enabledSeeds);
  const contexts = new Map(modules.map(module => {
    const own = new Set(module.seeds.map(item => item.id));
    const ctx = {
      seed,
      enabled(seedId) {
        if (!own.has(seedId)) throw new Error(`corpus module ${module.id} has no seed ${seedId}`);
        return enabled.has(seedId);
      },
      deriveId: name => deriveId(seed, name),
      deriveInt: (name, min, max) => deriveInt(seed, name, min, max),
      state: undefined,
    };
    ctx.state = module.createState(ctx);
    return [module, ctx];
  }));
  const contract = {
    application: 'argus-eval-suite',
    accounts: [...ACCOUNTS],
    modules: Object.fromEntries(modules.map(module => {
      const fields = module.publicContract(contexts.get(module));
      if (!Array.isArray(fields?.rules) || !fields.rules.length || fields.rules.some(rule => typeof rule !== 'string' || !rule)) throw new Error(`corpus module ${module.id}: publicContract must return non-empty rules`);
      if ('title' in fields || 'basePaths' in fields) throw new Error(`corpus module ${module.id}: publicContract must not redefine title or basePaths`);
      return [module.id, { title: module.title, basePaths: [...module.basePaths], ...fields }];
    })),
  };
  const contractJson = JSON.stringify(contract);
  const pages = { '/': indexHtml(contract), '/docs': docsHtml(contract) };

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/contract' || Object.hasOwn(pages, url.pathname)) {
      if (req.method !== 'GET') methodNotAllowed(res, ['GET']);
      else if (url.pathname === '/contract') send(res, 200, contractJson, { 'content-type': 'application/json; charset=utf-8' });
      else sendHtml(res, 200, pages[url.pathname]);
      return;
    }
    const module = modules.find(item => item.basePaths.some(base => matchesBase(url.pathname, base)));
    if (!module || !await module.handle(req, res, url, contexts.get(module))) send(res, 404, { error: 'not-found' });
  }

  const server = createServer(async (req, res) => {
    try {
      await dispatch(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof RequestError) send(res, error.status, error.body, error.headers);
      else send(res, 400, { error: 'invalid-json' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address().port;
  let closing;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    contract: JSON.parse(contractJson),
    close: () => {
      closing ??= new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// Private answer key for a set of enabled seeds, in corpus order.
export function truthFor(enabledSeeds) {
  const enabled = enabledSet(enabledSeeds);
  return seeds.filter(seed => enabled.has(seed.id))
    .map(({ id, module, surface, severity, criterion }) => ({ id, module, surface, severity, criterion }));
}

// Runs the deterministic probe of a seed (true = defect observable) or a control
// (true = intended behavior holds) against a running instance. `contract` is the full
// public contract; it is fetched from the instance when omitted.
export async function probe(id, url, contract) {
  const module = modules.find(item => Object.hasOwn(item.probes, id));
  if (!module) throw new Error(`unknown corpus probe: ${id}`);
  const publicContract = contract ?? await (await fetch(new URL('/contract', url))).json();
  const section = publicContract.modules?.[module.id];
  if (!section) throw new Error(`public contract has no module ${module.id}`);
  return Boolean(await module.probes[id](url, section));
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

// Every regular file under corpus/, as sorted forward-slash relative paths.
export function corpusFiles() {
  return listFiles(corpusDir).map(file => relative(corpusDir, file).split(sep).join('/')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const sha256 = content => createHash('sha256').update(content).digest('hex');

// sha256 over `relPath\0sha256(content)\n` for every corpus file, sorted by relPath.
export function corpusDigest() {
  return sha256(corpusFiles().map(path => `${path}\0${sha256(readFileSync(join(corpusDir, path)))}\n`).join(''));
}
