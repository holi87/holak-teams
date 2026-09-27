#!/usr/bin/env node
// Live browser smoke for hunt-driver v2. The framework template's pinned dependencies are
// installed into a temporary directory next to a copy of the driver, Chromium is installed for
// that exact Playwright version, and each driver feature is exercised against a loopback
// node:http fixture: response-body capture with path-segment auth-endpoint omission and
// redaction of bodies over the size caps and of JSON state in text pages, client-side faults
// (fail, abort, delay, offline), a second actor with its own profile, concurrent race clicks,
// clock advance and timezone emulation, uncaught page errors, and the aria snapshot.
//
// Every driver run passes the real authorization gate (argus-assets authorization check) and
// prints through the real redactor. The smoke is mandatory in the release gate: it needs
// network access (npm registry and the Playwright browser CDN) plus a launchable Chromium,
// and there is no skip switch. Only the 127.0.0.1 fixture is ever driven.

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'argus/framework-template');
const PLAYWRIGHT_VERSION = JSON.parse(readFileSync(join(TEMPLATE, 'package-lock.json'), 'utf8')).packages['node_modules/playwright'].version;
const WORK = mkdtempSync(join(tmpdir(), 'argus-hunt-driver-live-'));
const DRIVER_ROOT = join(WORK, 'driver');
const DRIVER = join(DRIVER_ROOT, 'scripts', 'hunt-driver.mjs');
const AUTHORIZATION_DIR = join(WORK, 'authorization');
const AUTHORIZATION_MANIFEST = join(AUTHORIZATION_DIR, 'authorization.json');
const SETUP_TIMEOUT_MS = 600_000;
const DRIVER_TIMEOUT_MS = 60_000;
const OMITTED_AUTH_BODY = '[OMITTED:AUTH-ENDPOINT]';

// Accounts match the manifest's allowedAliases ['argus-*']. The evaluator requires an
// allowlisted account for every browser-state-change check, so each run with an interactive
// verb (eval, click, a fault, --offline, --advance, --race-fire) drives the primary role; an
// anonymous state change is denied by design and covered by smoke-argus-authorization.sh.
const PRIMARY = 'argus-orion';
const SECONDARY = 'argus-orion-b';
const STATUS = "document.querySelector('#status').textContent";
const WHO = "document.querySelector('#who').textContent";

const ITEMS_BODY = JSON.stringify({ items: [{ id: 1, name: 'a', internalNote: 'visible-only-in-payload' }] });
// Capture-redaction fixtures. Each secret value is unique, so one leaked byte sequence names
// the path that leaked it. The large body keeps its sensitive keys inside the first 64 KiB, so
// only redaction before the size cap (not the cap itself) can hide them; the request body does
// the same against the 16 KiB request-body cap, and the text/html page embeds JSON state.
const CAPTURE_SECRETS = {
  bigRefresh: 'opaque-big-refresh-SECRET', bigApiKey: 'big-api-key-SECRET', bigPassword: 'big-password-SECRET',
  stateRefresh: 'ssr-refresh-SECRET', statePassword: 'ssr password SECRET with spaces',
  requestPassword: 'request-password-SECRET', requestApiKey: 'request-api-key-SECRET',
};
const BIG_BODY = JSON.stringify({
  refresh_token: CAPTURE_SECRETS.bigRefresh, api_key: CAPTURE_SECRETS.bigApiKey, password: CAPTURE_SECRETS.bigPassword,
  rows: Array.from({ length: 1500 }, (_, index) => ({ id: index, label: `row-${index}`, note: 'x'.repeat(40) })),
});
const STATE_PAGE = `<!doctype html><html><body><p>state</p><script>window.__STATE__={"user":{"name":"visible-state-name","refresh_token":"${CAPTURE_SECRETS.stateRefresh}","password":"${CAPTURE_SECRETS.statePassword}"}};</script></body></html>`;
const ECHO_REQUEST = JSON.stringify({ password: CAPTURE_SECRETS.requestPassword, api_key: CAPTURE_SECRETS.requestApiKey, pad: 'p'.repeat(20_000) });
const MESSAGES_BODY = JSON.stringify({ messages: [{ id: 1, text: 'sibling-of-me-payload-visible' }] });
const ME_SETTINGS_BODY = JSON.stringify({ theme: 'auth-sub-path-payload' });
// Each buy is counted on arrival and held long enough that two race clicks overlap at the
// server even on a loaded runner; the hold stays below the case's --wait-ms 500.
const BUY_HOLD_MS = 400;
const fixture = { buys: 0, buysInFlight: 0, maxConcurrentBuys: 0 };

// The page reports every state the cases read: #status from /api/items (OK, ERROR <status>, or
// OFFLINE when fetch rejects), #who from /api/me with the injected token, and #ready only once
// both initial loads have settled, so the driver's post-auth marker wait is a deterministic
// readiness signal. Every response body is read: Chromium reports a fetch whose body is never
// consumed as unfinished, so the driver would list it as PENDING and never capture its body.
// ?boom=1 throws from its own script element, which leaves the rest of the page working.
const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Argus hunt-driver live fixture</title></head>
<body>
<main>
  <h1>Hunt-driver fixture</h1>
  <p id="status">loading</p>
  <p id="who">anonymous</p>
  <button id="reload" type="button">Reload</button>
  <button id="buy" type="button">Buy</button>
  <p id="bought"></p>
  <p id="ready" hidden>ready</p>
</main>
<script>
if (new URLSearchParams(location.search).get('boom') === '1') throw new Error('fixture boom: uncaught page error');
</script>
<script>
const status = document.querySelector('#status');
const who = document.querySelector('#who');
async function loadItems() {
  try {
    const response = await fetch('/api/items', { cache: 'no-store' });
    await response.text();
    status.textContent = response.ok ? 'OK' : 'ERROR ' + response.status;
  } catch {
    status.textContent = 'OFFLINE';
  }
}
async function loadWho() {
  const token = localStorage.getItem('fixture-token');
  if (!token) return;
  try {
    const response = await fetch('/api/me', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
    who.textContent = response.ok ? (await response.json()).name : 'ERROR ' + response.status;
  } catch {
    who.textContent = 'OFFLINE';
  }
}
document.querySelector('#reload').addEventListener('click', () => { loadItems(); });
document.querySelector('#buy').addEventListener('click', async () => {
  const response = await fetch('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1 }) });
  document.querySelector('#bought').textContent = 'count ' + (await response.json()).count;
});
Promise.allSettled([loadItems(), loadWho()]).then(() => { document.querySelector('#ready').hidden = false; });
</script>
</body>
</html>
`;

// /capture fetches the capture-redaction fixtures plus two auth-boundary neighbours of
// api.me=/api/me: /api/messages shares its string prefix and must be captured, /api/me/settings
// sits below it and must stay omitted. #ready appears once every body has been read.
const CAPTURE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Argus hunt-driver capture fixture</title></head>
<body>
<p id="ready" hidden>ready</p>
<script>
const read = (path, init) => fetch(path, { cache: 'no-store', ...init }).then((response) => response.text());
Promise.allSettled([
  read('/api/big'),
  read('/api/state'),
  read('/api/messages'),
  read('/api/me/settings'),
  read('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(ECHO_REQUEST)} }),
]).then(() => { document.querySelector('#ready').hidden = false; });
</script>
</body>
</html>
`;

// The driver's own environment: argus-assets on PATH for the authorization gate and the
// redactor, the live manifest, and no caller value that would select a managed engagement,
// another config, or different capture and authorization inputs.
const DRIVER_ENV = {
  ...process.env,
  PATH: `${join(ROOT, 'argus/claude/bin')}${delimiter}${process.env.PATH ?? ''}`,
  ARGUS_AUTHORIZATION_MANIFEST: AUTHORIZATION_MANIFEST,
};
for (const key of [
  'ARGUS_ENGAGEMENT_MANIFEST', 'ARGUS_BROWSER_PROFILE', 'ARGUS_BROWSER_ARTIFACTS',
  'ARGUS_AUTHORIZATION_MUTATION', 'ARGUS_AUTHORIZATION_SOURCE_TRUST', 'ARGUS_BINARY_EVIDENCE_REVIEWED',
  'ARGUS_CAPTURE_TRACE', 'ARGUS_CAPTURE_VIDEO', 'QCA_BASE_URL', 'QCA_GOTO_WAIT_UNTIL', 'DRIVER_CONFIG',
]) delete DRIVER_ENV[key];

let server = null;
try {
  prepareDriver();
  const baseUrl = await startFixture();
  writeDriverConfig(baseUrl);
  writeAuthorizationManifest();

  // (a) Body capture: the payload is visible and matches the served bytes, its network line
  // references the capture, auth endpoints are omitted, and the token never prints.
  const a = await driveCase('a', ['--agent', 'live-a', '--role', PRIMARY, '--capture-bodies', '**/api/**', '--goto', '/', '--net', '--bodies']);
  assert(a.stdout.includes('visible-only-in-payload'), `(a) the /api/items payload was not printed:\n${a.output}`);
  const bodies = capturedBodies(a.stdout);
  const login = bodies.find((entry) => entry.url.endsWith('/api/login'));
  assert(login, `(a) the driver-issued /api/login response was not captured:\n${a.output}`);
  assert.equal(login.body, OMITTED_AUTH_BODY, '(a) the /api/login body was not omitted');
  assert.equal(login.requestBody, null, '(a) the /api/login request body was recorded');
  const me = bodies.find((entry) => entry.url.endsWith('/api/me'));
  assert.equal(me?.body, OMITTED_AUTH_BODY, `(a) the page's /api/me body was not omitted:\n${a.output}`);
  const items = bodies.find((entry) => entry.url.endsWith('/api/items'));
  assert(items, `(a) the /api/items response was not captured:\n${a.output}`);
  assert.equal(items.status, 200);
  assert.equal(items.bytes, Buffer.byteLength(ITEMS_BODY), '(a) the captured byte count differs from the served body');
  assert.equal(items.sha256, createHash('sha256').update(ITEMS_BODY).digest('hex'), '(a) the captured sha256 differs from the served body');
  assert.equal(items.truncated, false);
  assert(items.body.includes('visible-only-in-payload'), '(a) the captured /api/items body lost its payload');
  assert.deepEqual(netEntries(a.stdout, '/api/items').map(({ status, captured }) => [status, captured]), [['200', items.n]],
    `(a) the /api/items network line does not reference its capture:\n${a.output}`);
  assert(!a.output.includes(`tok-${PRIMARY}`), `(a) the access token leaked into the driver output:\n${a.output}`);

  // (k) Capture redaction and the auth-endpoint boundary. A JSON body over the 64 KiB cap and
  // a JSON request body over the 16 KiB cap are redacted whole before they are cut, so their
  // sensitive keys stay blank; JSON state embedded in a text/html body is redacted by key too.
  // /api/messages only shares a string prefix with api.me and is captured, while /api/me/settings
  // is below it and stays omitted.
  const k = await driveCase('k', ['--agent', 'live-k', '--capture-bodies', '**/api/**', '--goto', '/capture', '--bodies']);
  for (const [name, secret] of Object.entries(CAPTURE_SECRETS)) {
    assert(!k.output.includes(secret), `(k) the ${name} secret leaked into the driver output:\n${k.output.slice(0, 4000)}`);
  }
  const captured = capturedBodies(k.stdout);
  const big = captured.find((entry) => entry.url.endsWith('/api/big'));
  assert(big, `(k) the /api/big response was not captured:\n${k.output.slice(0, 4000)}`);
  assert.equal(big.truncated, true, '(k) the /api/big body was not reported as truncated');
  assert.equal(big.bytes, Buffer.byteLength(BIG_BODY), '(k) the /api/big byte count differs from the served body');
  assert.equal(big.sha256, createHash('sha256').update(BIG_BODY).digest('hex'), '(k) the /api/big sha256 differs from the served body');
  assert(Buffer.byteLength(big.body) <= 65536, `(k) the /api/big body exceeds the 64 KiB cap (${Buffer.byteLength(big.body)} bytes)`);
  assert.match(big.body, /"refresh_token":"\[REDACTED\]","api_key":"\[REDACTED\]","password":"\[REDACTED\]","rows":\[\{"id":0,"label":"row-0"/,
    '(k) the truncated /api/big body lost its redacted keys or its payload');
  const state = captured.find((entry) => entry.url.endsWith('/api/state'));
  assert(state?.body.includes('visible-state-name'), `(k) the /api/state page lost its payload:\n${state?.body}`);
  assert(state.body.includes('"refresh_token":"[REDACTED]"') && state.body.includes('"password":"[REDACTED]"'),
    `(k) the /api/state embedded JSON state was not redacted by key:\n${state.body}`);
  const echo = captured.find((entry) => entry.url.endsWith('/api/echo'));
  assert.equal(echo?.status, 200, `(k) the /api/echo request body did not reach the fixture intact:\n${k.output.slice(0, 4000)}`);
  assert(Buffer.byteLength(echo.requestBody) <= 16384, '(k) the /api/echo request body exceeds the 16 KiB cap');
  assert.match(echo.requestBody, /^\{"password":"\[REDACTED\]","api_key":"\[REDACTED\]","pad":"p/, `(k) the truncated /api/echo request body was not redacted by key:\n${echo.requestBody.slice(0, 200)}`);
  const messages = captured.find((entry) => entry.url.endsWith('/api/messages'));
  assert(messages?.body.includes('sibling-of-me-payload-visible'), `(k) /api/messages was omitted as if it were api.me:\n${messages?.body}`);
  const settings = captured.find((entry) => entry.url.endsWith('/api/me/settings'));
  assert.equal(settings?.body, OMITTED_AUTH_BODY, '(k) /api/me/settings, below api.me, was not omitted');
  assert.equal(settings.requestBody, null, '(k) the /api/me/settings request body was recorded');

  // (b) --fail-next answers the first matching request with the chosen status.
  const b = await driveCase('b', ['--agent', 'live-b', '--role', PRIMARY, '--fail-next', '**/api/items::503', '--goto', '/', '--eval', STATUS, '--net']);
  assert.deepEqual(evalValues(b.stdout).map(({ value }) => value), ['ERROR 503'], `(b) the page did not render the injected 503:\n${b.output}`);
  assert(b.stdout.includes(' 503 '), `(b) the network log does not show the 503:\n${b.output}`);
  assert(netEntries(b.stdout, '/api/items').some((entry) => entry.status === '503'), `(b) no 503 network entry for /api/items:\n${b.output}`);
  assert.match(b.stdout, /\] fault fail-next 503 \S*\/api\/items$/m, '(b) the applied fault was not logged');

  // (c) --abort-next fails the request at the network level.
  const c = await driveCase('c', ['--agent', 'live-c', '--role', PRIMARY, '--abort-next', '**/api/items', '--goto', '/', '--net']);
  assert(c.stdout.includes('FAILED('), `(c) the aborted request is not listed as FAILED(...):\n${c.output}`);
  assert(netEntries(c.stdout, '/api/items').some((entry) => entry.status.startsWith('FAILED(')), `(c) no FAILED entry for /api/items:\n${c.output}`);

  // (d) --delay-next holds the request before it continues.
  const d = await driveCase('d', ['--agent', 'live-d', '--role', PRIMARY, '--delay-next', '**/api/items::1500', '--goto', '/', '--net']);
  const delayed = netEntries(d.stdout, '/api/items');
  assert.equal(delayed.length, 1, `(d) expected one /api/items network entry:\n${d.output}`);
  assert.equal(delayed[0].status, '200', `(d) the delayed request did not complete:\n${d.output}`);
  assert(delayed[0].durationMs >= 1500, `(d) /api/items took ${delayed[0].durationMs} ms, expected at least 1500 ms`);

  // (e) --offline makes the page's next fetch reject.
  const e = await driveCase('e', ['--agent', 'live-e', '--role', PRIMARY, '--goto', '/', '--offline', '--click', '#reload', '--wait-ms', '300', '--eval', STATUS]);
  assert.deepEqual(evalValues(e.stdout).map(({ value }) => value), ['OFFLINE'], `(e) the page did not go offline:\n${e.output}`);

  // (f) A second actor has its own identity and its own profile under the lane's artifacts.
  const artifacts = join(WORK, 'lanes', 'live-f', 'browser-artifacts');
  const f = await driveCase('f', [
    '--agent', 'live-f', '--role', PRIMARY, '--actor', `b=${SECONDARY}`,
    '--goto', '/', '--eval', WHO, '--as', 'b', '--goto', '/', '--eval', WHO,
  ], { ARGUS_BROWSER_ARTIFACTS: artifacts });
  assert.deepEqual(evalValues(f.stdout), [
    { label: 'primary/main', value: `user:${PRIMARY}` },
    { label: 'b/main', value: `user:${SECONDARY}` },
  ], `(f) the actors did not keep separate identities:\n${f.output}`);
  const actorProfile = join(artifacts, 'actor-profiles', 'b');
  assert(existsSync(actorProfile) && statSync(actorProfile).isDirectory(), `(f) the actor profile is not under ${join(artifacts, 'actor-profiles')}`);
  assert(readdirSync(actorProfile).length > 0, '(f) the actor profile directory is empty');
  assert(!existsSync(join(DRIVER_ROOT, '.pw-profiles', 'live-f--actor-b')), '(f) the actor profile fell back to .pw-profiles despite ARGUS_BROWSER_ARTIFACTS');

  // (g) Race clicks on two tabs reach the server concurrently.
  const buysBefore = fixture.buys;
  fixture.maxConcurrentBuys = 0;
  const g = await driveCase('g', [
    '--agent', 'live-g', '--role', PRIMARY, '--tab', 'one', '--goto', '/', '--tab', 'two', '--goto', '/',
    '--race-arm', 'one::#buy', '--race-arm', 'two::#buy', '--race-fire', '--wait-ms', '500',
  ]);
  assert.equal(fixture.buys - buysBefore, 2, `(g) the race did not produce exactly two buys:\n${g.output}`);
  for (const tab of ['one', 'two']) assert.match(g.stdout, new RegExp(`\\] race primary/${tab} #buy ok$`, 'm'), `(g) no successful race line for tab ${tab}:\n${g.output}`);
  assert(fixture.maxConcurrentBuys >= 2, `(g) the race clicks did not overlap at the server (max concurrent ${fixture.maxConcurrentBuys})`);

  // (h) The installed clock advances across midnight; the timezone is emulated.
  const h = await driveCase('h', ['--agent', 'live-h', '--role', PRIMARY, '--clock', '2030-01-31T23:59:50Z', '--goto', '/', '--advance', '20000', '--eval', 'new Date().toISOString()']);
  const [advanced] = evalValues(h.stdout).map(({ value }) => value);
  assert(typeof advanced === 'string' && advanced.startsWith('2030-02-01'), `(h) the advanced clock reads ${advanced}:\n${h.output}`);
  const tz = await driveCase('h', ['--agent', 'live-h-tz', '--role', PRIMARY, '--tz', 'Pacific/Kiritimati', '--goto', '/', '--eval', 'Intl.DateTimeFormat().resolvedOptions().timeZone']);
  assert.deepEqual(evalValues(tz.stdout).map(({ value }) => value), ['Pacific/Kiritimati'], `(h) the timezone was not emulated:\n${tz.output}`);

  // (i) Uncaught page errors reach --console.
  const i = await driveCase('i', ['--agent', 'live-i', '--goto', '/?boom=1', '--console']);
  assert(i.stdout.includes('pageerror:'), `(i) the uncaught page error is missing from --console:\n${i.output}`);
  assert.match(i.stdout, /pageerror: .*fixture boom/, '(i) the page error message was not reported');

  // (j) --snapshot prints the aria snapshot of the page.
  const j = await driveCase('j', ['--agent', 'live-j', '--goto', '/', '--snapshot']);
  assert(j.stdout.includes('button "Buy"'), `(j) the aria snapshot does not list the Buy button:\n${j.output}`);

  // (l) A read-only run with a second actor still logs in both accounts (checked below).
  const l = await driveCase('l', [
    '--agent', 'live-l', '--role', PRIMARY, '--actor', `b=${SECONDARY}`, '--goto', '/', '--as', 'b', '--goto', '/', '--snapshot',
  ], { ARGUS_BROWSER_ARTIFACTS: join(WORK, 'lanes', 'live-l', 'browser-artifacts') });
  assert(l.stdout.includes('button "Buy"'), `(l) the actor's aria snapshot does not list the Buy button:\n${l.output}`);

  // Every decision above came from the real evaluator: reads for read-only runs (naming the
  // authenticated account), the extra actor account, and the browser:client-fault mutation
  // for each fault run.
  const audit = readFileSync(join(AUTHORIZATION_DIR, 'authorization-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert(audit.every((event) => event.decision === 'allow'), `an authorization check was denied: ${JSON.stringify(audit.filter((event) => event.decision !== 'allow'))}`);
  const decisions = (lane) => audit.filter((event) => event.lane === lane).map(({ action, account, mutation }) => [action, account, mutation]);
  assert.deepEqual(decisions('live-a'), [['browser-read', PRIMARY, null]], 'the authenticated read did not name its account');
  for (const lane of ['live-b', 'live-c', 'live-d', 'live-e']) {
    assert.deepEqual(decisions(lane), [
      ['browser-state-change', PRIMARY, 'browser:state-change'],
      ['browser-state-change', PRIMARY, 'browser:client-fault'],
    ], `${lane} did not pass the state-change and client-fault checks`);
  }
  assert.deepEqual(decisions('live-f'), [
    ['browser-state-change', PRIMARY, 'browser:state-change'],
    ['browser-state-change', SECONDARY, 'browser:state-change'],
  ], 'the second actor account was not authorized separately');
  assert.deepEqual(decisions('live-l'), [
    ['browser-read', PRIMARY, null],
    ['browser-read', SECONDARY, null],
  ], 'a read-only run did not authorize each authenticated account');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`PASS  Argus hunt driver v2 live (Playwright ${PLAYWRIGHT_VERSION}, Chromium): body capture with path-segment auth omission and capped-body redaction, fail/abort/delay/offline faults, actors with lane profiles, race clicks, clock advance and timezone, page errors, and aria snapshot`);

// ---- setup ------------------------------------------------------------------------
// The driver runs from its own copy of the template's scripts/ directory, so it resolves
// the pinned Playwright from WORK/driver/node_modules exactly as a scaffolded target does.
function prepareDriver() {
  mkdirSync(join(DRIVER_ROOT, 'scripts'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(TEMPLATE, name), join(DRIVER_ROOT, name));
  copyFileSync(join(TEMPLATE, 'scripts', 'hunt-driver.mjs'), DRIVER);
  setupStep('npm ci for the framework template', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    'The live hunt-driver smoke installs the framework template\'s pinned dependencies and needs network access to the npm registry.');
  const installed = JSON.parse(readFileSync(join(DRIVER_ROOT, 'node_modules', 'playwright', 'package.json'), 'utf8')).version;
  assert.equal(installed, PLAYWRIGHT_VERSION, `npm ci installed playwright ${installed}, but the template lockfile pins ${PLAYWRIGHT_VERSION}`);
  // The local CLI is the binary `npx playwright` resolves in WORK/driver; installing is idempotent.
  setupStep(`Chromium install for Playwright ${PLAYWRIGHT_VERSION}`, process.execPath, [join('node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
    `The live hunt-driver smoke needs network access to the Playwright browser download host (or a populated PLAYWRIGHT_BROWSERS_PATH). Install it manually with: npx --yes playwright@${PLAYWRIGHT_VERSION} install chromium`);
  writeFileSync(join(DRIVER_ROOT, 'scripts', 'launch-probe.mjs'), "import { chromium } from 'playwright';\nconst browser = await chromium.launch();\nawait browser.close();\n");
  setupStep('Chromium launch probe', process.execPath, [join('scripts', 'launch-probe.mjs')],
    `Chromium is installed but does not start. On Linux install its system libraries with: npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium (CI runs this before the release gate).`);
}

function setupStep(label, command, args, hint) {
  const result = spawnSync(command, args, { cwd: DRIVER_ROOT, encoding: 'utf8', timeout: SETUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return;
  const reason = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
  const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
  throw new Error(`${label} failed (${reason}).\n${hint}\n--- last output ---\n${tail}`);
}

function writeDriverConfig(baseUrl) {
  const config = {
    baseUrl,
    tokenStorageKey: 'fixture-token',
    postAuthMarker: '#ready',
    api: { login: '/api/login', me: '/api/me' },
    accounts: {
      [PRIMARY]: { loginPayload: { role: PRIMARY } },
      [SECONDARY]: { loginPayload: { role: SECONDARY } },
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, 'argus/schemas/driver-config.schema.json'), 'utf8')));
  assert(validate(config), `the live driver config violates the schema: ${ajv.errorsText(validate.errors)}`);
  writeFileSync(join(DRIVER_ROOT, 'scripts', 'driver.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

// The full fixture grants every action; the live copy targets any identifier in a test
// environment, allows argus-* accounts and every browser:* mutation (browser:client-fault
// included), and brackets now with the time window and every grant, because the driver
// checks at the current time.
function writeAuthorizationManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/argus-authorization/full.json'), 'utf8'));
  const startsAt = new Date(Date.now() - 3_600_000).toISOString();
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  manifest.engagementId = 'hunt-driver-live-smoke';
  manifest.target = { ...manifest.target, identifiers: ['*'], environment: 'test' };
  manifest.accounts = { ...manifest.accounts, allowedAliases: ['argus-*'] };
  manifest.allowedMutations = ['browser:*'];
  manifest.timeWindows = [{ startsAt, endsAt }];
  for (const grant of Object.values(manifest.actionGrants)) Object.assign(grant, { approvedAt: startsAt, expiresAt: endsAt });
  mkdirSync(AUTHORIZATION_DIR, { recursive: true });
  writeFileSync(AUTHORIZATION_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

// ---- loopback fixture ---------------------------------------------------------------
function startFixture() {
  server = createServer((request, response) => {
    handleFixture(request, response).catch((error) => {
      if (response.headersSent) response.destroy();
      else send(response, 500, 'application/json', JSON.stringify({ error: error.message }));
    });
  });
  return new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
  });
}

async function handleFixture(request, response) {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  const route = `${request.method} ${pathname}`;
  if (route === 'GET /') return send(response, 200, 'text/html; charset=utf-8', FIXTURE_PAGE);
  if (route === 'POST /api/login') {
    const { role } = JSON.parse((await readBody(request)) || '{}');
    if (typeof role !== 'string' || !role) return sendJson(response, 400, { error: 'loginPayload.role is required' });
    return sendJson(response, 200, { accessToken: `tok-${role}` });
  }
  if (route === 'GET /api/me') {
    const match = /^Bearer tok-(.+)$/.exec(request.headers.authorization ?? '');
    return match ? sendJson(response, 200, { name: `user:${match[1]}` }) : sendJson(response, 401, { error: 'unauthenticated' });
  }
  if (route === 'GET /api/items') return send(response, 200, 'application/json', ITEMS_BODY);
  if (route === 'GET /capture') return send(response, 200, 'text/html; charset=utf-8', CAPTURE_PAGE);
  if (route === 'GET /api/big') return send(response, 200, 'application/json', BIG_BODY);
  if (route === 'GET /api/state') return send(response, 200, 'text/html; charset=utf-8', STATE_PAGE);
  if (route === 'GET /api/messages') return send(response, 200, 'application/json', MESSAGES_BODY);
  if (route === 'GET /api/me/settings') return send(response, 200, 'application/json', ME_SETTINGS_BODY);
  if (route === 'POST /api/echo') {
    const received = await readBody(request);
    return sendJson(response, received === ECHO_REQUEST ? 200 : 400, { received: Buffer.byteLength(received) });
  }
  if (route === 'POST /api/buy') {
    const { qty } = JSON.parse((await readBody(request)) || '{}');
    if (qty !== 1) return sendJson(response, 400, { error: 'qty must be 1' });
    fixture.buys += 1;
    const count = fixture.buys;
    fixture.buysInFlight += 1;
    fixture.maxConcurrentBuys = Math.max(fixture.maxConcurrentBuys, fixture.buysInFlight);
    try {
      await new Promise((done) => setTimeout(done, BUY_HOLD_MS));
    } finally {
      fixture.buysInFlight -= 1;
    }
    return sendJson(response, 200, { count });
  }
  return sendJson(response, 404, { error: 'not found' });
}

function readBody(request) {
  return new Promise((done, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, 'application/json', JSON.stringify(value));
}

// ---- driver runs and output parsing -----------------------------------------------------
// execFile keeps this process's event loop free, so the in-process fixture keeps answering
// while the driver's browser talks to it.
function drive(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [DRIVER, ...args], {
      cwd: WORK,
      env: { ...DRIVER_ENV, ...env },
      encoding: 'utf8',
      timeout: DRIVER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const status = !error ? 0 : error.killed ? `killed after ${DRIVER_TIMEOUT_MS} ms` : (error.code ?? error.signal);
      done({ status, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

async function driveCase(id, args, env = {}) {
  const result = await drive(args, env);
  assert.equal(result.status, 0, `(${id}) hunt-driver ${args.join(' ')} exited ${result.status}:\n${result.output}`);
  return result;
}

// '[agent/role] eval [@actor/tab] <json>' lines, in order.
function evalValues(stdout) {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\[[^\]]*\] eval(?: @(\S+))? (.*)$/.exec(line);
    if (!match) return [];
    let value;
    try {
      value = JSON.parse(match[2]);
    } catch {
      value = match[2];
    }
    return [{ label: match[1] ?? 'primary/main', value }];
  });
}

// '<label> <method> <status|FAILED(reason)|PENDING> <duration>ms <resourceType> <url>
// [captured#<n>]' lines whose URL path ends with `path`. The redactor may rewrite the loopback
// host, never the path.
function netEntries(stdout, path) {
  return stdout.split('\n').flatMap((line) => {
    const match = /^(\S+) ([A-Z]+) (\d{3}|-|PENDING|FAILED\(.*\)) (\d+|\?)ms (\S+) (\S+?)(?: captured#(\d+))?$/.exec(line);
    if (!match || !match[6].endsWith(path)) return [];
    return [{
      label: match[1], method: match[2], status: match[3], durationMs: Number(match[4]), resourceType: match[5], url: match[6],
      captured: match[7] === undefined ? null : Number(match[7]),
    }];
  });
}

// The JSON lines --bodies prints, one per captured response.
function capturedBodies(stdout) {
  return stdout.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try {
      const entry = JSON.parse(line);
      return Number.isInteger(entry.n) && typeof entry.url === 'string' && 'body' in entry ? [entry] : [];
    } catch {
      return [];
    }
  });
}
