#!/usr/bin/env node
// Probe-matrix smoke for the evaluation corpus v2: every seed is observable exactly when it is
// enabled, every control holds in every build, seeds are independent, and nothing private
// reaches a hunter-visible endpoint. Scripted harness validation only; no Argus score.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveId, deriveInt } from './corpus/derive.mjs';
import { attr, elementById, escapeHtml, hasClass, page, submitForm, tagsByName, textOf } from './corpus/html.mjs';
import { controls, corpusDigest, corpusDir, corpusFiles, corpusVersion, modules, probe, seedIds, seeds, startApplication, truthFor } from './corpus/index.mjs';

const CORPUS_SEEDS = [1, 19, 734];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_KEY = /corpus|enabled|seed|truth|faulty|criterion/i;
const smokeStarted = performance.now();
let executions = 0;

// Static acceptance: node: builtins and corpus-relative imports only; no nondeterminism sources.
const files = corpusFiles();
assert(files.includes('index.mjs') && files.some(file => file.startsWith('modules/')), 'corpus file listing is incomplete');
for (const file of files) {
  const source = readFileSync(join(corpusDir, file), 'utf8');
  for (const token of ['Math.random', 'randomUUID', 'require(', 'createRequire']) assert(!source.includes(token), `${file} must not use ${token}`);
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`]+)\1/g)].map(match => match[2]);
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:')) {
      assert(builtinModules.includes(specifier.slice(5)), `${file} imports unknown builtin ${specifier}`);
      continue;
    }
    assert(/^\.\.?\//.test(specifier), `${file} imports non-relative ${specifier}`);
    const inside = relative(corpusDir, resolve(dirname(join(corpusDir, file)), specifier));
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), `${file} imports outside corpus/: ${specifier}`);
  }
}
const indexSource = readFileSync(join(corpusDir, 'index.mjs'), 'utf8');
assert(/\.listen\(port, '127\.0\.0\.1'/.test(indexSource), 'the application must listen on 127.0.0.1 only');

// Deterministic derivation.
assert.match(deriveId(1, 'objectId'), UUID);
assert.equal(deriveId(1, 'objectId'), deriveId(1, 'objectId'));
assert.notEqual(deriveId(1, 'objectId'), deriveId(2, 'objectId'));
assert.notEqual(deriveId(1, 'objectId'), deriveId(1, 'objectId2'));
const sampled = Array.from({ length: 200 }, (_, index) => deriveInt(7, `sample:${index}`, 3, 10));
assert(sampled.every(value => Number.isInteger(value) && value >= 3 && value <= 10), 'deriveInt must stay inside its inclusive range');
assert(sampled.includes(3) && sampled.includes(10), 'deriveInt must reach both inclusive bounds');
assert.equal(deriveInt(5, 'fixed', 4, 4), 4);
assert.throws(() => deriveInt(1, 'bad', 5, 4));
assert.throws(() => deriveId(-1, 'objectId'));

// HTML helpers: the page shell and the regex-based probe extraction.
assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
const shell = page({ title: 'A & B', lang: 'pl', body: '<p>x</p>' });
assert(shell.startsWith('<!doctype html>\n<html lang="pl">') && shell.includes('<meta charset="utf-8">') && shell.includes('<title>A &amp; B</title>'), 'page() must emit lang, charset and title');
assert.match(page({ title: 't', body: '' }), /<html lang="en">/);
const fragment = '<p id="a" class="x y">One &amp; <b>two</b></p><input type="checkbox" checked name=\'n\' aria-label="Pick &quot;me&quot;"><p>Three</p>';
assert.deepEqual(tagsByName(fragment, 'p').map(element => textOf(element)), ['One & two', 'Three']);
const [checkbox] = tagsByName(fragment, 'input');
assert.equal(attr(checkbox, 'checked'), '');
assert.equal(attr(checkbox, 'name'), 'n');
assert.equal(attr(checkbox, 'aria-label'), 'Pick "me"');
assert.equal(attr(checkbox, 'label'), null);
assert.equal(textOf(elementById(fragment, 'a')), 'One & two');
assert(hasClass(tagsByName(fragment, 'p')[0], 'y') && !hasClass(tagsByName(fragment, 'p')[1], 'y'));

// Corpus structure.
assert.equal(corpusVersion, 'argus-eval-corpus@2');
assert.deepEqual(modules.map(module => module.id), ['orders', 'accounts', 'workflow', 'tenant-authz', 'order-events', 'storefront-ui', 'a11y-forms', 'catalog-perf']);
assert.equal(seeds.length, 22, `expected exactly 22 seeds, found ${seeds.length}`);
const surfaceCounts = Object.fromEntries(['api', 'authz', 'events', 'ui', 'a11y', 'perf'].map(surface => [surface, seeds.filter(seed => seed.surface === surface).length]));
assert.deepEqual(surfaceCounts, { api: 3, authz: 5, events: 4, ui: 3, a11y: 4, perf: 3 }, 'seed counts per surface');
assert(controls.length >= 12, `expected at least 12 controls, found ${controls.length}`);
const allIds = [...seedIds, ...controls.map(control => control.id)];
assert.equal(new Set(allIds).size, allIds.length, 'seed and control ids must be unique');
assert.deepEqual(seedIds, seeds.map(seed => seed.id));
for (const module of modules) for (const item of [...module.seeds, ...module.controls]) assert.equal(typeof module.probes[item.id], 'function', `missing probe ${item.id}`);
assert.deepEqual(truthFor(seedIds), seeds.map(({ id, module, surface, severity, criterion }) => ({ id, module, surface, severity, criterion })));
assert.deepEqual(truthFor([]), []);
assert.match(corpusDigest(), /^[0-9a-f]{64}$/);
assert.equal(corpusDigest(), corpusDigest());

// Host junk never moves the corpus identity: a copy of corpus/ with Finder metadata, AppleDouble,
// editor swap and backup files, and node_modules/ keeps the digest; a real content change moves it.
{
  const copyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'argus-eval-corpus-copy-')));
  try {
    const copy = join(copyRoot, 'corpus');
    cpSync(corpusDir, copy, { recursive: true });
    const copied = await import(pathToFileURL(join(copy, 'index.mjs')).href);
    assert.equal(copied.corpusDigest(), corpusDigest(), 'an identical copy has the same digest');
    for (const junk of ['.DS_Store', 'modules/.DS_Store', 'modules/._orders.mjs', 'modules/.orders.mjs.swp', 'modules/orders.mjs~', 'node_modules/x/index.js']) {
      mkdirSync(dirname(join(copy, junk)), { recursive: true });
      writeFileSync(join(copy, junk), 'host junk\n');
    }
    assert.equal(copied.corpusDigest(), corpusDigest(), 'host and editor junk must not change the corpus digest');
    assert.deepEqual(copied.corpusFiles(), files, 'host and editor junk is not a corpus file');
    writeFileSync(join(copy, 'modules', 'orders.mjs'), `${readFileSync(join(copy, 'modules', 'orders.mjs'), 'utf8')}\n`);
    assert.notEqual(copied.corpusDigest(), corpusDigest(), 'a content change must change the corpus digest');
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
}

// (f) Unknown ids are rejected everywhere.
await assert.rejects(startApplication({ seed: 1, enabledSeeds: ['no-such-seed'] }), /unknown corpus seed/);
await assert.rejects(startApplication({ seed: 1.5, enabledSeeds: [] }));
assert.throws(() => truthFor(['no-such-seed']), /unknown corpus seed/);
await assert.rejects(probe('no-such-seed', 'http://127.0.0.1:9'), /unknown corpus probe/);

// A same-port restart retries briefly while the previous listener releases the port.
async function listenWithRetry(options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startApplication(options);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || !options.port || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function withApp(seed, enabledSeeds, run, port = 0) {
  const app = await listenWithRetry({ seed, enabledSeeds, port });
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

// Probes run sequentially on one instance: every seed probe, then every control probe.
async function assertMatrix(seed, enabledSeeds, label) {
  const enabled = new Set(enabledSeeds);
  await withApp(seed, enabledSeeds, async app => {
    for (const item of seeds) {
      executions++;
      assert.equal(await probe(item.id, app.url, app.contract), enabled.has(item.id), `seed ${seed}, ${label}: probe ${item.id} must be ${enabled.has(item.id)}`);
    }
    for (const control of controls) {
      executions++;
      assert.equal(await probe(control.id, app.url, app.contract), true, `seed ${seed}, ${label}: control ${control.id} must hold`);
    }
  });
}

function forbiddenKeys(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [...(FORBIDDEN_KEY.test(key) ? [`${path}.${key}`] : []), ...forbiddenKeys(item, `${path}.${key}`)]);
}

const privateStrings = [corpusVersion, ...allIds, ...seeds.map(seed => seed.criterion)];
const leaks = text => privateStrings.filter(value => text.includes(value));

// Hunter-visible HTML pages of the UI modules, including states that render extra markup.
const HTML_PAGES = ['/shop', '/shop/cart', '/shop/checkout', '/shop/orders', '/shop/wishlist', '/account/signup', '/account/settings'];
const ENTRY_LINKS = ['/shop', '/account/signup', '/account/settings', '/docs'];

async function publicSurface(app) {
  const contractResponse = await fetch(`${app.url}/contract`);
  const contractText = await contractResponse.text();
  const index = await (await fetch(`${app.url}/`)).text();
  const docs = await (await fetch(`${app.url}/docs`)).text();
  const pages = {};
  for (const path of HTML_PAGES) pages[`GET ${path}`] = await (await fetch(new URL(path, app.url))).text();
  const product = app.contract.modules['storefront-ui'].products.find(item => !item.soldOut);
  assert.equal((await submitForm(app.url, '/shop/cart/add', { productId: product.id, qty: '2' })).status, 303);
  for (const path of ['/shop/cart', '/shop/checkout']) pages[`GET ${path} with a cart line`] = await (await fetch(new URL(path, app.url))).text();
  pages['POST /account/signup with invalid fields'] = (await submitForm(app.url, '/account/signup', { email: 'invalid', password: 'short' })).text;
  return { status: contractResponse.status, contractText, index, docs, pages };
}

// A reachable non-loopback address must refuse the connection when the app binds 127.0.0.1 only.
function externalAddress() {
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return null;
}
const connects = (host, port) => new Promise(done => {
  const socket = connect({ host, port });
  const finish = result => { socket.destroy(); done(result); };
  socket.setTimeout(1000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

const contractsBySeed = new Map();
for (const seed of CORPUS_SEEDS) {
  // (d) and (e): the public surface carries no private data and depends only on the seed.
  const surfaces = [];
  for (const enabledSeeds of [seedIds, [], seedIds]) {
    await withApp(seed, enabledSeeds, async app => {
      assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const surface = await publicSurface(app);
      assert.equal(surface.status, 200);
      const contract = JSON.parse(surface.contractText);
      assert.deepEqual(app.contract, contract, 'startApplication must return the served contract');
      assert.equal(contract.application, 'argus-eval-suite');
      assert.deepEqual(contract.accounts, ['alice', 'bob', 'carol']);
      assert.deepEqual(Object.keys(contract.modules), modules.map(module => module.id));
      assert.deepEqual(forbiddenKeys(contract), [], 'public contract must not carry private keys');
      for (const [name, text] of Object.entries({ contract: surface.contractText, index: surface.index, docs: surface.docs })) assert.deepEqual(leaks(text), [], `${name} leaks private corpus data`);
      for (const [name, html] of Object.entries(surface.pages)) {
        assert.deepEqual(leaks(html), [], `${name} leaks private corpus data`);
        assert(!/data-testid/i.test(html), `${name} must not carry test hooks`);
        assert(html.startsWith('<!doctype html>\n<html lang="en">') && html.includes('<meta charset="utf-8">') && /<title>[^<]+<\/title>/.test(html), `${name} must be a complete HTML5 document`);
      }
      for (const path of ENTRY_LINKS) assert(surface.index.includes(`href="${path}"`), `index must link ${path}`);
      for (const href of [...surface.index.matchAll(/href="([^"]+)"/g)].map(match => match[1])) {
        const linked = await fetch(new URL(href, app.url));
        await linked.arrayBuffer();
        assert(linked.status !== 404 && linked.status < 500, `index link ${href} returned ${linked.status}`);
      }
      const external = externalAddress();
      if (external) assert.equal(await connects(external, app.port), false, `application is reachable on ${external}`);
      surfaces.push(surface.contractText);
    });
  }
  assert.equal(new Set(surfaces).size, 1, `seed ${seed}: /contract must be identical across restarts and builds`);
  contractsBySeed.set(seed, surfaces[0]);

  // Created IDs are derived, so a restart on the same port replays the same URL and identifiers.
  const created = [];
  let replayPort = 0;
  for (let restart = 0; restart < 2; restart++) {
    await withApp(seed, [], async app => {
      if (replayPort) assert.equal(app.port, replayPort, 'startApplication must honor an explicit port');
      replayPort = app.port;
      const response = await fetch(`${app.url}/api/workflow`, { method: 'POST' });
      created.push((await response.json()).id);
    }, replayPort);
  }
  assert.equal(created[0], created[1], `seed ${seed}: created IDs must survive a restart`);
  assert.match(created[0], UUID);

  // (a) all enabled, (b) none enabled, (c) exactly one enabled.
  await assertMatrix(seed, seedIds, 'all seeds enabled');
  await assertMatrix(seed, [], 'no seed enabled');
  for (const id of seedIds) await assertMatrix(seed, [id], `only ${id} enabled`);
}
assert.equal(new Set(contractsBySeed.values()).size, CORPUS_SEEDS.length, 'different seeds must derive different contracts');

// Dispatcher behavior shared by every module.
await withApp(1, [], async app => {
  const unknown = await fetch(`${app.url}/api/unknown`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'not-found' });
  const lookalike = await fetch(`${app.url}/api/ordersX`);
  assert.equal(lookalike.status, 404, 'base paths match whole segments only');
  await lookalike.arrayBuffer();
  const malformed = await fetch(`${app.url}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"quantity":' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid-json' });
  const oversized = await fetch(`${app.url}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity: 1, padding: 'x'.repeat(70000) }) });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  const notAllowed = await fetch(`${app.url}/contract`, { method: 'DELETE' });
  assert.equal(notAllowed.status, 405);
  await notAllowed.arrayBuffer();
});

const surfaceCount = new Set(seeds.map(seed => seed.surface)).size;
console.log(`PASS  corpus v2: ${seeds.length} seeds, ${surfaceCount} surfaces, ${controls.length} controls, ${executions} probe executions (${((performance.now() - smokeStarted) / 1000).toFixed(1)} s)`);
