#!/usr/bin/env node
/**
 * hunt-driver — isolated per-agent browser driver for EXPLORATORY UI hunting.
 *
 * WHY THIS EXISTS
 * ---------------
 * Hunters used to drive the live app through the SHARED Playwright MCP server:
 * ONE browser, ONE profile, shared by every concurrent agent. The app keeps its
 * JWT in localStorage (not a cookie), so two agents logging in as different roles
 * clobber each other's session — "identity cross-swap / auth-token flapping" —
 * and the shared browser's screenshots time out under contention. Result: the
 * whole UI/visual/i18n surface goes effectively untested (Run-E recall: ui 12%,
 * i18n 0%). See wyniki/RUNE-SCORING-vs-oracle.md.
 *
 * THE FIX
 * -------
 * Each hunter runs its OWN chromium via launchPersistentContext(userDataDir =
 * ARGUS_BROWSER_PROFILE (or fallback .pw-profiles/<agent>). Separate process/profile =>
 * localStorage => zero cross-swap, and screenshots are no longer contended.
 * The role token is minted via the API and injected with addInitScript BEFORE the
 * first navigation, so the SPA route-guard always sees a valid session (the proven
 * qca-v7 seedSessionTokens pattern, now process-isolated).
 *
 * Driver v2 adds named tabs and extra actors (each actor is its own persistent browser
 * process), client-side network faults on the lane's own browser, opt-in response-body
 * capture, UI race clicks, clock advance, and a --plan dry run.
 *
 * USAGE
 * -----
 *   node scripts/hunt-driver.mjs --agent <name> [--role <role>|anon] [options...] [actions...]
 *
 * Inside a managed engagement run the packaged copy IN PLACE from the plugin; nothing is
 * copied into the target. Print the template path first, then pass it literally (the write
 * guard rejects $(...) composition around argus-assets):
 *   argus-assets path typescript-template        # prints <template>
 *   ARGUS_ENGAGEMENT_MANIFEST=<artifact-root>/ai_agents_internal/engagement.json \
 *   ARGUS_BROWSER_PROFILE=<allocated-browserProfile> \
 *   ARGUS_BROWSER_ARTIFACTS=<allocated-browserArtifactsDirectory> \
 *   node <template>/scripts/hunt-driver.mjs --agent <slug> [--role <role>|anon] [actions...]
 * ARGUS_ENGAGEMENT_MANIFEST selects the managed defaults, all under its directory
 * (ai_agents_internal/): recon/driver.config.json, authorization.json, and the Playwright
 * module recorded in browser-runtime.json, whose package and module-tree digests are
 * re-verified before the import.
 *
 * Config (app-specific) comes from scripts/driver.config.json (see
 * driver.config.example.json), or recon/driver.config.json in a managed engagement.
 * One launch per invocation; the profile (and thus the session) persists on disk
 * between invocations, so follow-up calls stay logged in. Batch several actions in
 * one call to amortise the ~1s launch.
 *
 * SESSION OPTIONS (order-independent):
 *   --agent <name>          lane slug; drives the per-agent profile directory (required)
 *   --role <role>|anon      primary account (config.accounts key); default anon
 *   --actor <name>=<role|anon>  declare an extra actor (repeatable). Each actor is a
 *                           separate persistent browser: <ARGUS_BROWSER_ARTIFACTS>/actor-profiles/
 *                           <name> when the lane artifact directory is set, otherwise
 *                           .pw-profiles/<agent>--actor-<name>. 'primary' is reserved.
 *   --capture-bodies <glob> capture text/JSON response bodies for matching URLs (repeatable)
 *   --plan                  print the parsed plan and authorization checks as JSON; no browser
 *   --keep                  reuse the profile (default)
 *   --fresh                 wipe this agent's profile and actor profiles before launch
 *   --headed                run headed (debug only; default headless)
 *   --tz <timezoneId>       emulate a timezone (context timezoneId, e.g. Europe/Warsaw)
 *   --locale <locale>       emulate a browser locale (context locale, e.g. pl-PL)
 *   --clock <ISO datetime>  install the Playwright clock on every context before the first
 *                           navigation — deterministic Date/timers for date/format oracles
 *   --reduced-motion        emulate prefers-reduced-motion: reduce (context reducedMotion)
 *   --version               print the driver version
 *
 * ACTIONS (executed in the order given, all in a single browser launch):
 *   --goto <route>          navigate to baseUrl+route, wait for SPA render
 *   --wait <selector>       wait for selector visible (overrides default marker)
 *   --viewport <WxH>        set viewport (e.g. 375x812) before navigating
 *   --shot <file>           screenshot (full page) to <file>
 *   --eval <js>             evaluate JS in page, print JSON result
 *   --click <selector>      click selector
 *   --type <selector::text> fill selector with text (split on '::')
 *   --press <key>           press a key (e.g. Enter, Tab)
 *   --hover <selector>      hover selector (reveal menus/tooltips)
 *   --select <sel::value>   select <option> by value/label in a <select>
 *   --upload <sel::path>    set file input to <path> (file-upload flows)
 *   --dialog <accept|dismiss[::text]>  arm a handler for the NEXT native
 *                           confirm/alert/prompt/beforeunload (so a click that
 *                           triggers it does not hang); place BEFORE the trigger
 *   --back                  navigate back (history) and wait for render
 *   --snapshot              print the aria snapshot YAML of <body> (the DOM oracle)
 *   --console               print console messages and uncaught page errors
 *   --net                   print network entries: label, method, status or
 *                           FAILED(reason), duration, resource type, url (last 200);
 *                           requests still unanswered after a 2s settle show PENDING
 *   --bodies                print captured response bodies as JSON lines (stdout only)
 *   --whoami                print the current actor's session identity (GET <api.me>)
 *   --tab <name>            switch to or open a named tab in the current actor's
 *                           browser (the first tab is 'main'; popups are popup-<n>)
 *   --as <actor>            switch to 'primary' or a declared actor's current tab
 *   --fail-next <glob>[::<status>[::<count>]]  answer the next matching request(s) with
 *                           <status> (default 503) and an empty JSON body; count 1-1000|all
 *   --abort-next <glob>[::<count>]  fail the next matching request(s) at the network level
 *   --delay-next <glob>::<ms>[::<count>]  hold the next matching request(s) <ms>, then continue
 *   --unroute               remove the current actor's driver routes
 *   --offline / --online    take the current actor's browser offline / back online
 *   --wait-ms <ms>          wait 0-60000 ms
 *   --advance <ms>          fast-forward the current actor's installed clock (needs --clock)
 *   --race-arm <[actor/]tab>::<selector>  arm a click target for the next --race-fire
 *   --race-fire             click every armed target concurrently, report each outcome
 * Globs match the absolute URL: '**' matches anything, '*' anything except '/', '?' one
 * character. Faults act only on this lane's own browser; they never touch the target.
 *
 * Example — sweep My Courses at mobile width as a student, capture evidence:
 *   node scripts/hunt-driver.mjs --agent orion --role student \
 *     --viewport 375x812 --goto /moje-kursy \
 *     --shot out/mycourses-375.png --snapshot --console --net
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DRIVER_VERSION = '2.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---- help and version: before config load or the Playwright import ------
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`hunt-driver ${DRIVER_VERSION} — isolated per-agent browser driver

Usage:
  node scripts/hunt-driver.mjs --agent <name> [--role <role>|anon] [options...] [actions...]

Session options (order-independent):
  --agent <name> --role <role>|anon --actor <name>=<role|anon> (repeatable)
  --capture-bodies <glob> (repeatable) --plan --keep --fresh --headed
  --tz <timezoneId> --locale <locale> --clock <ISO datetime> --reduced-motion
  --version --help

Core actions (executed in order):
  --goto <route> --wait <selector> --viewport <WxH> --shot <file>
  --snapshot --eval <js> --click <selector> --type <selector::text>
  --press <key> --hover <selector> --select <selector::value>
  --upload <selector::path> --dialog <accept|dismiss[::text]> --back
  --console --net --bodies --whoami

Tabs and actors:
  --tab <name>            switch to or open a named tab (first tab: main; popups: popup-<n>)
  --as <actor>            switch to primary or a declared --actor

Client-side faults (this lane's browser only; need the browser:client-fault grant):
  --fail-next <glob>[::<status>[::<count>]]   status 100-599 (default 503), count 1-1000|all
  --abort-next <glob>[::<count>]              network-level failure
  --delay-next <glob>::<ms>[::<count>]        ms 1-60000, then continue
  --unroute --offline --online

Timing and races:
  --wait-ms <0-60000> --advance <ms> (requires --clock)
  --race-arm <[actor/]tab>::<selector> ... --race-fire

Globs match the absolute URL: ** = anything, * = anything except '/', ? = one character.
--capture-bodies records text/JSON bodies (capped, auth endpoints omitted) for --bodies;
nothing is written to disk. --plan prints the parsed actions and the authorization
checks as one JSON line and exits before any config load or browser launch.

Configuration:
  Copy scripts/driver.config.example.json to scripts/driver.config.json and
  fill it from recon. Set DRIVER_CONFIG to use another path.
  The driver requires the shared authorization manifest at
  ai_agents_internal/authorization.json (override with ARGUS_AUTHORIZATION_MANIFEST).

Managed engagement (run in place: node <argus-assets path typescript-template>/scripts/hunt-driver.mjs):
  ARGUS_ENGAGEMENT_MANIFEST=<artifact-root>/ai_agents_internal/engagement.json selects
  the managed defaults next to it: recon/driver.config.json, authorization.json, and the
  verified Playwright module from browser-runtime.json. ARGUS_BROWSER_PROFILE and
  ARGUS_BROWSER_ARTIFACTS (the allocated lane coordinates) are required.`);
  process.exit(0);
}
if (argv.includes('--version')) {
  console.log(DRIVER_VERSION);
  process.exit(0);
}

// ---- parser: session options plus an ordered list of [action, value] ----
// Every value is validated here, before --plan, config load, or the Playwright import;
// any error exits 2 through fail().
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ACTOR_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TAB_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SESSION_VALUE_FLAGS = new Set(['--agent', '--role', '--tz', '--locale', '--clock', '--actor', '--capture-bodies']);
const SESSION_BARE_FLAGS = new Set(['--keep', '--fresh', '--headed', '--reduced-motion', '--plan']);
const VALUE_ACTIONS = new Set([
  'goto', 'wait', 'viewport', 'shot', 'eval', 'click', 'type', 'press', 'hover', 'select', 'upload', 'dialog',
  'tab', 'as', 'fail-next', 'abort-next', 'delay-next', 'wait-ms', 'advance', 'race-arm',
]);
const BARE_ACTIONS = new Set(['back', 'snapshot', 'console', 'net', 'whoami', 'unroute', 'offline', 'online', 'race-fire', 'bodies']);
const KNOWN_FLAGS = new Set([
  ...SESSION_VALUE_FLAGS, ...SESSION_BARE_FLAGS, '--help', '-h', '--version',
  ...[...VALUE_ACTIONS, ...BARE_ACTIONS].map((action) => `--${action}`),
]);
// Any interactive verb is treated as a target state change; client-side faults additionally
// need their own audited mutation grant.
const INTERACTIVE_ACTIONS = new Set([
  'eval', 'click', 'type', 'press', 'hover', 'select', 'upload', 'dialog',
  'fail-next', 'abort-next', 'delay-next', 'offline', 'online', 'unroute', 'advance', 'race-fire',
]);
const CLIENT_FAULT_ACTIONS = new Set(['fail-next', 'abort-next', 'delay-next', 'offline']);

const parsed = parseArguments(argv);
const { agent, role, fresh, headed, tz, locale, clock, reducedMotion, actions } = parsed;
const anon = !role || role === 'anon';
const captureTrace = process.env.ARGUS_CAPTURE_TRACE === 'true';
const captureVideo = process.env.ARGUS_CAPTURE_VIDEO === 'true';

if (parsed.plan) {
  safePrintJsonLines([buildPlan(parsed)]);
  process.exit(0);
}

// ---- config + deferred dependency load ----------------------------------
// Keep --help runnable directly from an installed plugin cache before the
// template has been copied or npm dependencies installed.
// ARGUS_ENGAGEMENT_MANIFEST marks a managed engagement: its control directory
// (ai_agents_internal/) supplies the recon config, the authorization manifest,
// and the preflight-verified Playwright runtime, so the packaged driver runs in
// place from the plugin instead of being copied into the target.
const controlDir = process.env.ARGUS_ENGAGEMENT_MANIFEST ? dirname(resolve(process.env.ARGUS_ENGAGEMENT_MANIFEST)) : null;
if (controlDir && !process.env.ARGUS_BROWSER_PROFILE) fail('ARGUS_BROWSER_PROFILE is required inside a managed engagement');
const CONFIG_PATH = process.env.DRIVER_CONFIG ?? (controlDir ? join(controlDir, 'recon', 'driver.config.json') : join(HERE, 'driver.config.json'));
if (!existsSync(CONFIG_PATH)) {
  fail(controlDir
    ? `No config at ${CONFIG_PATH}. Kalchas writes recon/driver.config.json during recon; ask Odysseus to route recon before driving the browser.`
    : `No config at ${CONFIG_PATH}. Copy driver.config.example.json -> driver.config.json and fill it from recon.`);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const BASE = process.env.QCA_BASE_URL ?? cfg.baseUrl;
const ACCESS_KEY = cfg.tokenStorageKey ?? 'access-token';
const REFRESH_KEY = cfg.refreshTokenStorageKey ?? null;
const POST_AUTH_MARKER = cfg.postAuthMarker ?? null;
const managedEngagement = Boolean(process.env.ARGUS_ENGAGEMENT_MANIFEST || process.env.ARGUS_BROWSER_PROFILE);
const browserArtifactsDir = process.env.ARGUS_BROWSER_ARTIFACTS ? resolve(process.env.ARGUS_BROWSER_ARTIFACTS) : null;
if (managedEngagement && !browserArtifactsDir) fail('ARGUS_BROWSER_ARTIFACTS is required inside a managed engagement');
if (browserArtifactsDir) {
  for (const name of ['downloads', 'traces', 'videos', 'screenshots']) mkdirSync(join(browserArtifactsDir, name), { recursive: true });
}
const bodyCapture = bodyCaptureSettings(cfg);

// ---- shared authorization gate ------------------------------------------
// This check is defense in depth: the agent must check before calling the driver,
// and the driver independently checks again, in order, before Playwright starts.
const authorizationManifest = process.env.ARGUS_AUTHORIZATION_MANIFEST
  ?? (controlDir ? join(controlDir, 'authorization.json') : join(ROOT, 'ai_agents_internal', 'authorization.json'));
for (const check of authorizationPlan(parsed)) runAuthorizationCheck(check);
const { chromium } = await loadPlaywright();

// ---- token mint (API login) ---------------------------------------------
async function mintTokens(session) {
  const acct = (cfg.accounts ?? {})[session.role];
  if (!acct) fail(`role '${session.role}' not in config.accounts (have: ${Object.keys(cfg.accounts ?? {}).join(', ')})`);
  const res = await session.context.request.post(cfg.api.login, { data: acct.loginPayload ?? { email: acct.email, password: acct.password } });
  await captureDriverResponse(session, 'POST', res);
  if (!res.ok()) fail(`login(${session.role}) failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  const access = dig(body, cfg.accessTokenPath ?? 'accessToken');
  const refresh = REFRESH_KEY ? dig(body, cfg.refreshTokenPath ?? 'refreshToken') : null;
  if (!access) fail(`no access token at path '${cfg.accessTokenPath}' in login response`);
  return { access, refresh };
}

// ---- main ----------------------------------------------------------------
const profileDir = resolve(process.env.ARGUS_BROWSER_PROFILE ?? join(ROOT, '.pw-profiles', agent));
const actorProfileRoot = browserArtifactsDir ? join(browserArtifactsDir, 'actor-profiles') : null;
if (fresh) {
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  wipeActorProfiles();
}
mkdirSync(profileDir, { recursive: true });

const log = (tag, ...rest) => safePrint(`[${agent}${role ? '/' + role : ''}] ${tag} ${rest.map(formatLogValue).join(' ')}`.trim());

// Session state. Every actor (the primary included) owns one persistent context with named
// tabs; every page gets its listeners exactly once and a '<actor>/<tab>' label.
const MAX_NET_ENTRIES = 200;
const MAX_CAPTURED_BODIES = 200;
const MAX_REQUEST_BODY_BYTES = 16384;
const INFLIGHT_SETTLE_MS = 2000;
const OMITTED_AUTH_BODY = '[OMITTED:AUTH-ENDPOINT]';
const sessions = new Map();
const pageRecords = new WeakMap();
const requestStarts = new WeakMap();
const inflightRequests = new Map();
const pendingNetworkWork = new Set();
const consoleMsgs = [];
const netReqs = [];
const capturedBodies = [];
const armedRace = [];
const multiSession = parsed.actors.length > 0 || actions.some(([action]) => action === 'tab' || action === 'as');
let capturedCount = 0;
let attachedPages = 0;
let currentActor = 'primary';

try {
  const primary = await openSession('primary', role, profileDir, { video: captureVideo });
  if (captureTrace) await primary.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  if (tz || locale || reducedMotion) {
    log('context', [tz && `tz=${tz}`, locale && `locale=${locale}`, reducedMotion && 'reducedMotion=reduce'].filter(Boolean).join(' '));
  }
  for (const actor of parsed.actors) await openSession(actor.name, actor.role, actorProfileDir(actor.name), { video: false });
  // The clock is pinned on every context and the role tokens are injected BEFORE any
  // navigation, so Date/timers are deterministic and the SPA guard sees a session on the
  // first script run. clock.install pins the START instant; time still ticks.
  if (clock) {
    for (const session of sessions.values()) await session.context.clock.install({ time: new Date(clock) });
    log('clock', `installed @ ${new Date(clock).toISOString()}`);
  }
  for (const session of sessions.values()) {
    if (session.anon) continue;
    const { access, refresh } = await mintTokens(session);
    await session.context.addInitScript(
      ([k, v, rk, rv]) => {
        try {
          localStorage.setItem(k, v);
          if (rk && rv) localStorage.setItem(rk, rv);
        } catch { /* storage unavailable */ }
      },
      [ACCESS_KEY, access, REFRESH_KEY, refresh],
    );
    log('token injected', `(${ACCESS_KEY})${session.name === 'primary' ? '' : ` actor=${session.name}/${session.role}`}`);
  }

  for (const [act, val] of actions) {
    const session = sessions.get(currentActor);
    switch (act) {
      case 'tab': {
        const existing = session.tabs.get(val);
        if (!existing) await openTab(session, val);
        session.currentTab = val;
        log('tab', `${session.name}/${val} (${existing ? 'switched' : 'opened'})`);
        break;
      }
      case 'as': {
        currentActor = val;
        const target = sessions.get(val);
        log('as', `${target.name}/${target.currentTab}`);
        break;
      }
      case 'viewport': {
        const [w, h] = val.split('x').map(Number);
        await currentPage().setViewportSize({ width: w, height: h });
        pageLog('viewport', `${w}x${h}`);
        break;
      }
      case 'goto': {
        const page = currentPage();
        // Default to domcontentloaded: an SPA constantly polls/streams, so 'networkidle'
        // routinely never fires and burns the full 30s before timing out. We instead reach
        // a deterministic ready state via the explicit marker/selector wait below.
        // networkidle stays OPT-IN for the rare static/SSR page that genuinely needs it:
        //   QCA_GOTO_WAIT_UNTIL=networkidle node scripts/hunt-driver.mjs ...
        const gotoWaitUntil = process.env.QCA_GOTO_WAIT_UNTIL ?? 'domcontentloaded';
        await page.goto(val, { waitUntil: gotoWaitUntil, timeout: 30_000 });
        // wait for SPA render so screenshots are never blank — this explicit marker/selector
        // wait (NOT networkidle) is the real readiness signal.
        if (!session.anon && POST_AUTH_MARKER) {
          await page.locator(POST_AUTH_MARKER).waitFor({ state: 'visible', timeout: 20_000 }).catch(() =>
            log('warn', `post-auth marker ${POST_AUTH_MARKER} not visible (guard bounce? unauth route?)`),
          );
        } else if (POST_AUTH_MARKER) {
          // anon: still wait for a concrete render marker rather than a blind sleep.
          await page.locator(POST_AUTH_MARKER).waitFor({ state: 'visible', timeout: 20_000 }).catch(() =>
            page.waitForTimeout(400),
          );
        } else {
          await page.waitForTimeout(400); // last-resort settle when no marker is configured
        }
        pageRecords.get(page).navigated = true;
        pageLog('goto', `${val} -> ${page.url()} (waitUntil=${gotoWaitUntil})`);
        break;
      }
      case 'wait':
        await currentPage().locator(val).waitFor({ state: 'visible', timeout: 20_000 });
        pageLog('wait', `${val} visible`);
        break;
      case 'shot': {
        const output = resolve(val);
        if (browserArtifactsDir && !isWithin(join(browserArtifactsDir, 'screenshots'), output)) {
          fail(`screenshot must stay under ${join(browserArtifactsDir, 'screenshots')}`);
        }
        mkdirSync(dirname(output), { recursive: true });
        await currentPage().screenshot({ path: output, fullPage: true, timeout: 15_000 });
        pageLog('shot', output);
        break;
      }
      case 'eval': {
        // SAFE-BY-CONTEXT: eval runs inside page.evaluate (the browser page sandbox,
        // NOT node) and the expression comes from the trusted hunter operating its
        // own driver — identical trust model to MCP browser_evaluate. It is the
        // geometry/state oracle (getBoundingClientRect, querySelectorAll counts, etc).
        const out = await currentPage().evaluate((js) => {
          // eslint-disable-next-line no-eval
          const r = eval(js);
          return r;
        }, val);
        pageLog('eval', JSON.stringify(out));
        break;
      }
      case 'click':
        await currentPage().locator(val).first().click({ timeout: 10_000 });
        pageLog('click', val);
        break;
      case 'type': {
        const [sel, ...rest] = val.split('::');
        await currentPage().locator(sel).first().fill(rest.join('::'));
        pageLog('type', `${sel} <- [REDACTED:INPUT]`);
        break;
      }
      case 'press':
        await currentPage().keyboard.press(val);
        pageLog('press', val);
        break;
      case 'hover':
        await currentPage().locator(val).first().hover({ timeout: 10_000 });
        pageLog('hover', val);
        break;
      case 'select': {
        const [sel, ...rest] = val.split('::');
        const chosen = await currentPage().locator(sel).first().selectOption(rest.join('::'));
        pageLog('select', `${sel} <- ${rest.join('::')} (${JSON.stringify(chosen)})`);
        break;
      }
      case 'upload': {
        const [sel, ...rest] = val.split('::');
        await currentPage().locator(sel).first().setInputFiles(rest.join('::'));
        pageLog('upload', `${sel} <- ${rest.join('::')}`);
        break;
      }
      case 'dialog': {
        const [mode, ...t] = val.split('::');
        currentPage().once('dialog', async (d) => {
          log('dialog', `${d.type()}: "${d.message()}" -> ${mode}`);
          if (mode === 'accept') await d.accept(t.length ? t.join('::') : undefined);
          else await d.dismiss();
        });
        pageLog('dialog armed', mode);
        break;
      }
      case 'back': {
        const page = currentPage();
        await page.goBack({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
        pageLog('back', page.url());
        break;
      }
      case 'snapshot': {
        const page = currentPage();
        if (!pageRecords.get(page).navigated) log('warn', 'snapshot before any --goto');
        // Page.accessibility was removed in Playwright 1.57; the aria snapshot is the
        // supported DOM oracle and prints as YAML.
        const tree = await page.locator('body').ariaSnapshot({ timeout: 15_000 });
        pageLog('snapshot (aria YAML):');
        safePrint(tree);
        break;
      }
      case 'console':
        log('console messages:');
        safePrint(consoleMsgs.length ? consoleMsgs.map(({ label, text }) => (labelsVisible() ? `${label} ${text}` : text)).join('\n') : '(none)');
        break;
      case 'net': {
        await settleNetworkWork({ inflightMs: INFLIGHT_SETTLE_MS });
        const lines = [...netReqs, ...pendingNetLines()];
        log('network:');
        safePrint(lines.length ? lines.join('\n') : '(none)');
        break;
      }
      case 'bodies':
        await settleNetworkWork({ inflightMs: INFLIGHT_SETTLE_MS });
        log('captured bodies:');
        if (capturedBodies.length) safePrintJsonLines(capturedBodies, { jsonKeys: ['body', 'requestBody'] });
        else safePrint('(none)');
        break;
      case 'whoami': {
        const apiCtx = session.context.request;
        const tok = session.anon ? null : (await mintTokens(session)).access;
        const res = await apiCtx.get(cfg.api.me, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
        await captureDriverResponse(session, 'GET', res);
        log(multiSession ? `whoami @${session.name}` : 'whoami', res.status(), res.ok() ? JSON.stringify(await res.json()) : await res.text());
        break;
      }
      case 'fail-next':
      case 'abort-next':
      case 'delay-next': {
        const fault = parseFaultSpec(act, val);
        await armFault(session, fault);
        log(act, `armed ${fault.glob}${fault.status ? ` status=${fault.status}` : ''}${fault.ms ? ` ms=${fault.ms}` : ''} count=${fault.count === Infinity ? 'all' : fault.count} (${session.name})`);
        break;
      }
      case 'unroute': {
        const removed = session.routes.splice(0);
        for (const route of removed) await session.context.unroute(route.pattern, route.handler);
        log('unroute', `${removed.length} driver route(s) removed (${session.name})`);
        break;
      }
      case 'offline':
      case 'online':
        await session.context.setOffline(act === 'offline');
        log(act, session.name);
        break;
      case 'wait-ms':
        await delay(Number(val));
        log('wait-ms', `${val}ms`);
        break;
      case 'advance':
        await session.context.clock.fastForward(Number(val));
        log('advance', `${val}ms (${session.name})`);
        break;
      case 'race-arm': {
        const target = parseRaceTarget(val);
        const actorName = target.actor ?? currentActor;
        const page = sessions.get(actorName).tabs.get(target.tab);
        if (!page) fail(`--race-arm ${val}: tab ${actorName}/${target.tab} is not open`);
        armedRace.push({ label: `${actorName}/${target.tab}`, page, selector: target.selector });
        log('race armed', `${actorName}/${target.tab} ${target.selector}`);
        break;
      }
      case 'race-fire': {
        const targets = armedRace.splice(0);
        const outcomes = await Promise.allSettled(targets.map(({ page, selector }) => page.locator(selector).first().click({ timeout: 10_000 })));
        outcomes.forEach((outcome, index) => {
          const { label, selector } = targets[index];
          log('race', `${label} ${selector} ${outcome.status === 'fulfilled' ? 'ok' : `error:${firstLine(outcome.reason)}`}`);
        });
        break;
      }
    }
  }
  log('DONE');
} finally {
  await settleNetworkWork();
  try {
    const primary = sessions.get('primary');
    if (captureTrace && browserArtifactsDir && primary) await primary.context.tracing.stop({ path: join(browserArtifactsDir, 'traces', 'session.zip') });
  } finally {
    await closeSessions();
  }
}

// ---- argument parsing and validation ---------------------------------------
function parseArguments(args) {
  const result = {
    agent: null, role: null, fresh: false, headed: false, plan: false,
    tz: null, locale: null, clock: null, reducedMotion: false,
    actors: [], captureBodies: [], actions: [],
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => {
      const next = args[i + 1];
      if (next === undefined || KNOWN_FLAGS.has(next)) fail(`missing value for ${flag}`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--agent': result.agent = value(); break;
      case '--role': result.role = value(); break;
      case '--keep': break;
      case '--fresh': result.fresh = true; break;
      case '--headed': result.headed = true; break;
      case '--plan': result.plan = true; break;
      case '--tz': result.tz = value(); break;
      case '--locale': result.locale = value(); break;
      case '--clock': result.clock = value(); break;
      case '--reduced-motion': result.reducedMotion = true; break;
      case '--actor': result.actors.push(parseActor(value(), result.actors)); break;
      case '--capture-bodies': {
        const glob = value();
        if (!glob.trim()) fail('--capture-bodies: the URL glob is empty');
        result.captureBodies.push(glob);
        break;
      }
      default: {
        const action = flag.startsWith('--') ? flag.slice(2) : null;
        if (action && VALUE_ACTIONS.has(action)) {
          const actionValue = value();
          validateActionValue(action, actionValue);
          result.actions.push([action, actionValue]);
        } else if (action && BARE_ACTIONS.has(action)) {
          result.actions.push([action, null]);
        } else {
          fail(`unknown arg: ${flag}`);
        }
      }
    }
  }
  validateSequence(result);
  return result;
}

function parseActor(raw, declared) {
  const separator = raw.indexOf('=');
  if (separator <= 0 || separator === raw.length - 1) fail(`--actor requires <name>=<role|anon> (got '${raw}')`);
  const name = raw.slice(0, separator);
  const actorRole = raw.slice(separator + 1);
  if (name === 'primary') fail("--actor: the name 'primary' is reserved for the --role session");
  if (!ACTOR_NAME.test(name)) fail(`--actor: name '${name}' must match ${ACTOR_NAME.source}`);
  if (declared.some((actor) => actor.name === name)) fail(`--actor: duplicate actor '${name}'`);
  return { name, role: actorRole };
}

function validateActionValue(action, value) {
  if (!value) fail(`missing value for --${action}`);
  switch (action) {
    case 'viewport': {
      const match = /^(\d{1,5})x(\d{1,5})$/.exec(value);
      if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) fail(`--viewport: '${value}' is not <width>x<height> (e.g. 375x812)`);
      break;
    }
    case 'dialog':
      if (!['accept', 'dismiss'].includes(value.split('::')[0])) fail(`--dialog: '${value}' must start with accept or dismiss`);
      break;
    case 'type':
    case 'select':
    case 'upload':
      if (!value.split('::')[0]) fail(`--${action}: the selector before '::' is empty`);
      break;
    case 'tab':
      if (!TAB_NAME.test(value)) fail(`--tab: name '${value}' must match ${TAB_NAME.source}`);
      break;
    case 'as':
      if (value !== 'primary' && !ACTOR_NAME.test(value)) fail(`--as: '${value}' is not an actor name`);
      break;
    case 'fail-next':
    case 'abort-next':
    case 'delay-next':
      parseFaultSpec(action, value);
      break;
    case 'wait-ms':
      boundedInteger('--wait-ms', value, 0, 60_000);
      break;
    case 'advance':
      boundedInteger('--advance', value, 1, 2_678_400_000);
      break;
    case 'race-arm':
      parseRaceTarget(value);
      break;
    default:
      break;
  }
}

// Order-dependent checks run over the whole ordered action list once every
// order-independent session option (--actor, --clock) is known.
function validateSequence(result) {
  if (!result.agent) fail('--agent <name> is required (drives the per-agent profile dir)');
  if (!AGENT_NAME.test(result.agent)) fail(`--agent: '${result.agent}' must be one path segment matching ${AGENT_NAME.source}`);
  if (result.role === '') fail('--role: the role is empty (use anon for an anonymous session)');
  if (result.clock && Number.isNaN(Date.parse(result.clock))) fail(`--clock: '${result.clock}' is not a parseable datetime (use ISO 8601, e.g. 2026-01-15T12:00:00Z)`);
  const declared = new Set(['primary', ...result.actors.map((actor) => actor.name)]);
  const openTabs = new Map([...declared].map((name) => [name, new Set(['main'])]));
  let actor = 'primary';
  let armed = 0;
  for (const [action, value] of result.actions) {
    switch (action) {
      case 'as':
        if (!declared.has(value)) fail(`--as ${value}: unknown actor; declare it with --actor ${value}=<role|anon> or use primary`);
        actor = value;
        break;
      case 'tab':
        openTabs.get(actor).add(value);
        break;
      case 'advance':
        if (!result.clock) fail('--advance requires --clock <ISO datetime> (the clock is installed before the first navigation)');
        break;
      case 'race-arm': {
        const target = parseRaceTarget(value);
        const owner = target.actor ?? actor;
        if (!declared.has(owner)) fail(`--race-arm ${value}: unknown actor '${owner}'`);
        if (!openTabs.get(owner).has(target.tab) && !/^popup-\d+$/.test(target.tab)) {
          fail(`--race-arm ${value}: tab ${owner}/${target.tab} is not open; open it with --tab ${target.tab} first`);
        }
        armed += 1;
        break;
      }
      case 'race-fire':
        if (armed === 0) fail('--race-fire: nothing is armed; add --race-arm <[actor/]tab>::<selector> first');
        armed = 0;
        break;
      default:
        break;
    }
  }
  if (armed > 0) fail('--race-arm: armed targets are never fired; add --race-fire after the last --race-arm');
}

function parseFaultSpec(kind, raw) {
  const parts = raw.split('::');
  const glob = parts[0];
  if (!glob.trim()) fail(`--${kind}: the URL glob is empty`);
  if (kind === 'fail-next') {
    if (parts.length > 3) fail(`--fail-next requires <glob>[::<status>[::<count>]] (got '${raw}')`);
    const status = parts[1] === undefined || parts[1] === '' ? 503 : boundedInteger('--fail-next status', parts[1], 100, 599);
    return { kind, glob, status, count: faultCount(kind, parts[2]) };
  }
  if (kind === 'abort-next') {
    if (parts.length > 2) fail(`--abort-next requires <glob>[::<count>] (got '${raw}')`);
    return { kind, glob, count: faultCount(kind, parts[1]) };
  }
  if (parts.length < 2 || parts.length > 3 || parts[1] === '') fail(`--delay-next requires <glob>::<ms>[::<count>] (got '${raw}')`);
  const ms = boundedInteger('--delay-next ms', parts[1], 1, 60_000);
  return { kind, glob, ms, count: faultCount(kind, parts[2]) };
}

function faultCount(kind, raw) {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'all') return Infinity;
  return boundedInteger(`--${kind} count`, raw, 1, 1000);
}

function parseRaceTarget(raw) {
  const separator = raw.indexOf('::');
  if (separator <= 0 || separator + 2 >= raw.length) fail(`--race-arm requires <[actor/]tab>::<selector> (got '${raw}')`);
  const ref = raw.slice(0, separator);
  const selector = raw.slice(separator + 2);
  const slash = ref.indexOf('/');
  const actor = slash === -1 ? null : ref.slice(0, slash);
  const tab = slash === -1 ? ref : ref.slice(slash + 1);
  if (actor !== null && actor !== 'primary' && !ACTOR_NAME.test(actor)) fail(`--race-arm: '${actor}' is not an actor name`);
  if (!TAB_NAME.test(tab)) fail(`--race-arm: tab '${tab}' must match ${TAB_NAME.source}`);
  return { actor, tab, selector };
}

function boundedInteger(label, raw, min, max) {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} (got '${raw}')`);
  }
  return value;
}

// ---- dry-run plan and authorization plan --------------------------------------
function buildPlan(plan) {
  return {
    driverVersion: DRIVER_VERSION,
    agent: plan.agent,
    role: plan.role ?? 'anon',
    actors: plan.actors.map(({ name, role: actorRole }) => ({ name, role: actorRole })),
    sessionOptions: {
      tz: plan.tz,
      locale: plan.locale,
      clock: plan.clock,
      reducedMotion: plan.reducedMotion,
      captureBodies: plan.captureBodies,
    },
    actions: plan.actions.map(([action, value]) => [action, action === 'type' ? `${value.split('::')[0]}::[REDACTED:INPUT]` : value]),
    authorization: authorizationPlan(plan).map(({ action, account, mutation }) => ({ action, account, mutation })),
  };
}

// The ordered `argus-assets authorization check` calls this invocation needs. The main
// check covers the primary account; every non-anonymous actor account is authorized
// separately; client-side faults need their own mutation, which never comes from the
// environment; binary evidence is checked last, unchanged.
function authorizationPlan(plan) {
  const verbs = new Set(plan.actions.map(([action]) => action));
  const primaryAccount = plan.role ?? 'anon';
  const checks = [];
  if ([...verbs].some((verb) => INTERACTIVE_ACTIONS.has(verb))) {
    const mutation = process.env.ARGUS_AUTHORIZATION_MUTATION ?? 'browser:state-change';
    checks.push({
      action: 'browser-state-change', account: primaryAccount, mutation,
      denial: 'authorization denied browser-state-change; inspect the shared authorization audit and do not launch the browser',
    });
    for (const actor of plan.actors) {
      if (actor.role === 'anon') continue;
      checks.push({
        action: 'browser-state-change', account: actor.role, mutation,
        denial: `authorization denied browser-state-change for actor ${actor.name}; inspect the shared authorization audit and do not launch the browser`,
      });
    }
  } else {
    checks.push({
      action: 'browser-read', account: null, mutation: null,
      denial: 'authorization denied browser-read; inspect the shared authorization audit and do not launch the browser',
    });
  }
  if ([...verbs].some((verb) => CLIENT_FAULT_ACTIONS.has(verb))) {
    checks.push({
      action: 'browser-state-change', account: primaryAccount, mutation: 'browser:client-fault',
      denial: 'authorization denied browser-client-fault; client-side network faults are not granted for this lane',
    });
  }
  if (verbs.has('shot') || captureTrace || captureVideo) {
    checks.push({
      action: 'binary-evidence', account: null, mutation: null,
      denial: 'authorization denied binary-evidence; do not capture the screenshot until the view is synthetic/masked and independently reviewed',
    });
  }
  return checks;
}

function runAuthorizationCheck(check) {
  const args = [
    'authorization', 'check',
    '--manifest', authorizationManifest,
    '--lane', agent,
    '--action', check.action,
    '--target', BASE,
    '--source-trust', process.env.ARGUS_AUTHORIZATION_SOURCE_TRUST ?? 'manifest',
  ];
  if (check.account) args.push('--account', check.account);
  if (check.mutation) args.push('--mutation', check.mutation);
  if (check.action === 'binary-evidence') args.push('--binary-reviewed', process.env.ARGUS_BINARY_EVIDENCE_REVIEWED ?? 'false');
  try {
    execFileSync('argus-assets', args, { stdio: 'inherit' });
  } catch {
    fail(check.denial);
  }
}

// ---- sessions, tabs, and page listeners -----------------------------------------
function contextOptions({ video }) {
  return {
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    userAgent: cfg.userAgent,
    baseURL: BASE,
    ...(tz ? { timezoneId: tz } : {}),
    ...(locale ? { locale } : {}),
    ...(reducedMotion ? { reducedMotion: 'reduce' } : {}),
    ...(browserArtifactsDir ? { downloadsPath: join(browserArtifactsDir, 'downloads') } : {}),
    ...(video && browserArtifactsDir ? { recordVideo: { dir: join(browserArtifactsDir, 'videos') } } : {}),
  };
}

async function openSession(name, accountRole, directory, { video }) {
  mkdirSync(directory, { recursive: true });
  const context = await chromium.launchPersistentContext(directory, contextOptions({ video }));
  const session = {
    name, role: accountRole, anon: !accountRole || accountRole === 'anon', context,
    tabs: new Map(), currentTab: 'main', routes: [], pendingTab: null, popups: 0,
  };
  sessions.set(name, session);
  // Network events are observed on the context, so a popup's first requests are timed and
  // logged even when they start before its 'page' event is handled; each entry is labelled
  // with its page when it settles.
  context.on('request', (request) => {
    requestStarts.set(request, Date.now());
    inflightRequests.set(request, session);
  });
  context.on('requestfinished', (request) => {
    inflightRequests.delete(request);
    trackNetworkWork(recordFinishedRequest(requestLabel(session, request), request));
  });
  context.on('requestfailed', (request) => {
    inflightRequests.delete(request);
    pushNet(`${requestLabel(session, request)} ${request.method()} FAILED(${request.failure()?.errorText ?? 'unknown'}) ${elapsedMs(request)}ms ${request.resourceType()} ${request.url()}`);
  });
  // Pages the app opens (window.open, target=_blank) arrive here as popup-<n>; a tab the
  // driver opens itself claims its pending name instead.
  context.on('page', (page) => {
    const tab = session.pendingTab;
    session.pendingTab = null;
    attachPage(session, page, tab);
  });
  attachPage(session, context.pages()[0] ?? (await openTab(session, 'main')), 'main');
  return session;
}

async function openTab(session, tab) {
  session.pendingTab = tab;
  let page;
  try {
    page = await session.context.newPage();
  } finally {
    session.pendingTab = null;
  }
  attachPage(session, page, tab);
  return page;
}

function attachPage(session, page, tab) {
  if (pageRecords.has(page)) return pageRecords.get(page);
  const popup = !tab;
  const name = tab ?? nextPopupTab(session);
  const record = { label: `${session.name}/${name}`, navigated: false };
  pageRecords.set(page, record);
  session.tabs.set(name, page);
  attachedPages += 1;
  page.on('console', (message) => consoleMsgs.push({ label: record.label, text: `${message.type()}: ${message.text()}` }));
  page.on('pageerror', (error) => consoleMsgs.push({ label: record.label, text: `pageerror: ${error?.message ?? String(error)}` }));
  page.on('close', () => {
    if (session.tabs.get(name) === page) session.tabs.delete(name);
    // A closed page never finishes its requests; stop waiting for them.
    for (const request of inflightRequests.keys()) if (pageOf(request) === page) inflightRequests.delete(request);
  });
  if (popup) log('popup', record.label);
  return record;
}

// The page that issued a request, or null for a service-worker request (no frame).
function pageOf(request) {
  try {
    return request.frame().page();
  } catch {
    return null;
  }
}

function requestLabel(session, request) {
  const page = pageOf(request);
  if (!page) return `${session.name}/worker`;
  return pageRecords.get(page)?.label ?? `${session.name}/unattached`;
}

function nextPopupTab(session) {
  do session.popups += 1; while (session.tabs.has(`popup-${session.popups}`));
  return `popup-${session.popups}`;
}

function currentPage() {
  const session = sessions.get(currentActor);
  const page = session.tabs.get(session.currentTab);
  if (!page) fail(`tab ${session.name}/${session.currentTab} is closed; switch with --tab <name>`);
  return page;
}

function actorProfileDir(name) {
  return actorProfileRoot ? join(actorProfileRoot, name) : join(ROOT, '.pw-profiles', `${agent}--actor-${name}`);
}

function wipeActorProfiles() {
  if (actorProfileRoot) {
    rmSync(actorProfileRoot, { recursive: true, force: true });
    return;
  }
  const localProfiles = join(ROOT, '.pw-profiles');
  if (!existsSync(localProfiles)) return;
  for (const name of readdirSync(localProfiles)) {
    if (name.startsWith(`${agent}--actor-`)) rmSync(join(localProfiles, name), { recursive: true, force: true });
  }
}

async function closeSessions() {
  let firstError = null;
  for (const session of [...sessions.values()].reverse()) {
    // A fault still holding a request (--delay-next) must not keep the browser open: its
    // handler is released and its late continue() is ignored.
    if (session.routes.length > 0) await session.context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    try {
      await session.context.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

// Page-scoped log lines name the page once more than one page or actor is in play.
function labelsVisible() {
  return multiSession || attachedPages > 1;
}

function pageLog(tag, ...rest) {
  log(labelsVisible() ? `${tag} @${pageRecords.get(currentPage()).label}` : tag, ...rest);
}

// ---- client-side faults -----------------------------------------------------------
// Faults act only on this actor's own browser context (context.route / setOffline); the
// target server and its dependencies never see them. The fulfilled response matches the
// automation helper failNext in src/api/route-mocks.ts.
async function armFault(session, fault) {
  const pattern = globToRegExp(fault.glob);
  let remaining = fault.count;
  const route = { pattern, handler: null };
  // Unrouting the last route turns request interception off, and Chromium then releases every
  // request still paused at a route. So the exhausted route is retired only after its request
  // has been answered, never before.
  const retire = async () => {
    const index = session.routes.indexOf(route);
    if (index === -1) return;
    session.routes.splice(index, 1);
    await session.context.unroute(pattern, route.handler).catch(() => {});
  };
  route.handler = async (intercepted) => {
    if (remaining <= 0) {
      await intercepted.fallback().catch(() => {});
      return;
    }
    remaining -= 1;
    const url = intercepted.request().url();
    try {
      if (fault.kind === 'fail-next') {
        await intercepted.fulfill({ status: fault.status, contentType: 'application/json', body: '{}' });
        log('fault', `fail-next ${fault.status} ${url}`);
      } else if (fault.kind === 'abort-next') {
        await intercepted.abort('failed');
        log('fault', `abort-next failed ${url}`);
      } else {
        await delay(fault.ms, { unref: true });
        await intercepted.continue();
        log('fault', `delay-next ${fault.ms}ms ${url}`);
      }
    } catch {
      // The page or context closed while the fault was pending; nothing left to answer.
    } finally {
      if (remaining === 0) await retire();
    }
  };
  session.routes.push(route);
  await session.context.route(pattern, route.handler);
}

// '**' matches anything, '*' anything except '/', '?' exactly one character; everything
// else is literal. The pattern is anchored and matched against the absolute URL.
function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// ---- network log and response-body capture ----------------------------------------
function bodyCaptureSettings(config) {
  const maxBytes = config.maxCapturedBodyBytes ?? 65536;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1_048_576) {
    fail(`driver config maxCapturedBodyBytes must be an integer from 1024 to 1048576 (got ${JSON.stringify(config.maxCapturedBodyBytes)})`);
  }
  const exclude = config.bodyCaptureExclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((glob) => typeof glob !== 'string' || !glob.trim())) {
    fail('driver config bodyCaptureExclude must be an array of non-empty URL globs');
  }
  const authPaths = [config.api?.login, config.api?.me, config.api?.refresh]
    .filter((path) => typeof path === 'string' && path.length > 0)
    .map((path) => {
      try { return new URL(path, BASE).pathname; }
      catch { return path; }
    });
  return {
    maxBytes,
    include: parsed.captureBodies.map(globToRegExp),
    exclude: exclude.map(globToRegExp),
    authPaths,
  };
}

// Auth endpoints (login, me, refresh, and bodyCaptureExclude globs) never expose a body or
// request body: they carry credentials and session tokens. An auth path covers itself and the
// path segments below it, never a sibling that only shares its string prefix (api.me=/api/me
// omits /api/me/ and /api/me/settings but not /api/messages); a trailing slash is ignored.
function isOmittedEndpoint(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  return bodyCapture.authPaths.some((path) => {
    const base = path.replace(/\/+$/, '');
    return pathname === base || pathname.startsWith(`${base}/`);
  }) || bodyCapture.exclude.some((pattern) => pattern.test(url));
}

function mediaType(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

function isJsonType(type) {
  return type === 'application/json' || type.endsWith('+json');
}

function isTextualType(type) {
  return isJsonType(type) || type.startsWith('text/') || type === 'application/xml';
}

// Records one captured body (FIFO, at most 200) and returns its number, or null when the
// URL is not selected or the content type is not text. Only the content-type header is kept.
async function recordCapture({ page, method, status, url, contentType, readBody, readRequestBody }) {
  if (!bodyCapture.include.some((pattern) => pattern.test(url))) return null;
  let entry;
  if (isOmittedEndpoint(url)) {
    entry = { bytes: null, sha256: null, truncated: false, requestBody: null, body: OMITTED_AUTH_BODY };
  } else {
    if (!isTextualType(mediaType(contentType))) return null;
    const buffer = await readBody();
    entry = {
      bytes: buffer.length,
      sha256: sha256(buffer),
      truncated: buffer.length > bodyCapture.maxBytes,
      requestBody: readRequestBody(),
      body: buffer.subarray(0, bodyCapture.maxBytes).toString('utf8'),
    };
  }
  capturedCount += 1;
  const { bytes, sha256: digest, truncated, requestBody, body } = entry;
  capturedBodies.push({ n: capturedCount, page, method, status, url, contentType: contentType ?? null, bytes, sha256: digest, truncated, requestBody, body });
  if (capturedBodies.length > MAX_CAPTURED_BODIES) capturedBodies.shift();
  return capturedCount;
}

function requestBodyText(request) {
  const type = mediaType(request.headers()['content-type']);
  if (!isJsonType(type) && type !== 'application/x-www-form-urlencoded') return null;
  const buffer = request.postDataBuffer();
  return buffer ? buffer.subarray(0, MAX_REQUEST_BODY_BYTES).toString('utf8') : null;
}

// Driver-issued API calls (token mint, whoami) never pass through a page, so they are
// captured here when a capture glob selects them.
async function captureDriverResponse(session, method, response) {
  try {
    await recordCapture({
      page: `${session.name}/driver`,
      method,
      status: response.status(),
      url: response.url(),
      contentType: response.headers()['content-type'] ?? null,
      readBody: () => response.body(),
      readRequestBody: () => null,
    });
  } catch {
    // An unreadable driver response body is simply not captured.
  }
}

async function recordFinishedRequest(label, request) {
  const duration = elapsedMs(request);
  let status = '-';
  let captured = null;
  try {
    const response = await request.response();
    if (response) {
      status = response.status();
      captured = await recordCapture({
        page: label,
        method: request.method(),
        status,
        url: request.url(),
        contentType: response.headers()['content-type'] ?? null,
        readBody: () => response.body(),
        readRequestBody: () => requestBodyText(request),
      });
    }
  } catch {
    // Redirect responses have no body, and a closing page cancels the read; the network
    // line is still recorded.
  }
  pushNet(`${label} ${request.method()} ${status} ${duration}ms ${request.resourceType()} ${request.url()}${captured ? ` captured#${captured}` : ''}`);
}

function pushNet(line) {
  netReqs.push(line);
  if (netReqs.length > MAX_NET_ENTRIES) netReqs.shift();
}

function elapsedMs(request) {
  const started = requestStarts.get(request);
  return started === undefined ? '?' : Date.now() - started;
}

function trackNetworkWork(promise) {
  const settled = promise.catch(() => {}).finally(() => pendingNetworkWork.delete(settled));
  pendingNetworkWork.add(settled);
}

// Protocol events queued behind a synchronous redaction call are dispatched only once the
// event loop turns, and finished-request handlers read bodies asynchronously. --net and
// --bodies first give requests already in flight a bounded chance to finish (a long poll,
// a stream, or a held --delay-next cannot hang the driver), then wait for the pending body
// reads; shutdown waits for the reads only. Both waits are bounded.
async function settleNetworkWork({ inflightMs = 0, timeoutMs = 5000 } = {}) {
  await delay(0);
  const inflightDeadline = Date.now() + inflightMs;
  while (inflightRequests.size > 0 && Date.now() < inflightDeadline) await delay(25);
  const deadline = Date.now() + timeoutMs;
  while (pendingNetworkWork.size > 0 && Date.now() < deadline) {
    let timer;
    await Promise.race([
      Promise.allSettled([...pendingNetworkWork]),
      new Promise((done) => { timer = setTimeout(done, Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
  }
}

// Requests still unanswered when --net prints are listed as PENDING with their age so far.
function pendingNetLines() {
  return [...inflightRequests].map(([request, session]) => `${requestLabel(session, request)} ${request.method()} PENDING ${elapsedMs(request)}ms ${request.resourceType()} ${request.url()}`);
}

// ---- helpers --------------------------------------------------------------
function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function fail(msg) {
  console.error('hunt-driver ERROR:', redactForConsole(msg));
  process.exit(2);
}

function delay(milliseconds, { unref = false } = {}) {
  return new Promise((done) => {
    const timer = setTimeout(done, milliseconds);
    if (unref) timer.unref();
  });
}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0];
}

function safePrint(value) {
  process.stdout.write(`${redactForConsole(value)}\n`);
}

// Prints each value as one JSON line. The redactor pretty-prints an input that parses as one
// JSON document and blanks whole values under sensitive keys (the plan's "authorization"
// list among them), while its line-based text mode can cut through JSON syntax. So every
// string leaf is redacted in place instead: an array of bare strings carries no keys, and
// each string gets the shared text patterns on its own. A string under one of `jsonKeys`
// (captured bodies) that holds a complete JSON object or array is sent parsed, so the
// redactor also blanks its sensitive keys; it comes back re-serialized and compact.
function safePrintJsonLines(values, { jsonKeys = [] } = {}) {
  const items = [];
  const structured = [];
  const collect = (node, key = null) => {
    if (typeof node === 'string') {
      const parsedJson = jsonKeys.includes(key) ? parseJsonContainer(node) : undefined;
      structured.push(parsedJson !== undefined);
      items.push(parsedJson !== undefined ? parsedJson : node);
    } else if (Array.isArray(node)) node.forEach((child) => collect(child));
    else if (isPlainObject(node)) Object.entries(node).forEach(([childKey, child]) => collect(child, childKey));
  };
  values.forEach((value) => collect(value));
  let redacted = [];
  if (items.length > 0) {
    try {
      redacted = JSON.parse(redactForConsole(JSON.stringify(items)));
    } catch {
      redacted = null;
    }
  }
  if (!Array.isArray(redacted) || redacted.length !== items.length
    || redacted.some((item, position) => !structured[position] && typeof item !== 'string')) {
    process.stdout.write('[OUTPUT SUPPRESSED: REDACTION UNAVAILABLE]\n');
    return;
  }
  let index = 0;
  const rebuild = (node) => {
    if (typeof node === 'string') {
      const position = index++;
      return structured[position] ? JSON.stringify(redacted[position]) : redacted[position];
    }
    if (Array.isArray(node)) return node.map(rebuild);
    if (isPlainObject(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rebuild(child)]));
    return node;
  };
  process.stdout.write(`${values.map((value) => JSON.stringify(rebuild(value))).join('\n')}\n`);
}

// A complete JSON object or array, or undefined for anything else (a truncated body, text).
function parseJsonContainer(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function redactForConsole(value) {
  try {
    return execFileSync('argus-assets', ['redact', '--input', '-', '--output', '-'], {
      input: String(value),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return '[OUTPUT SUPPRESSED: REDACTION UNAVAILABLE]';
  }
}

function formatLogValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

function isWithin(root, candidate) {
  const normalizedRoot = `${resolve(root)}/`;
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === resolve(root) || normalizedCandidate.startsWith(normalizedRoot);
}

// In a managed engagement the Playwright module is the one preflight or gate resolution
// proved and recorded in browser-runtime.json. Both digests are recomputed immediately
// before the import, so a module changed after the probe is refused instead of executed.
// Without a record (unmanaged runs) the driver imports its own playwright dependency.
async function loadPlaywright() {
  const recordPath = controlDir ? join(controlDir, 'browser-runtime.json') : null;
  if (!recordPath || !existsSync(recordPath)) return import('playwright');
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    fail(`browser runtime record ${recordPath} is unreadable: ${error.message}`);
  }
  if (record?.$schema !== 'argus/browser-runtime@1') fail(`${recordPath} is not an argus/browser-runtime@1 record`);
  if (record.status !== 'available') {
    fail(`browser runtime is ${record.status} (${record.evidence ?? 'no evidence'}); ask Odysseus to rerun gate resolution`);
  }
  const modulePath = record.modulePath;
  if (typeof modulePath !== 'string' || !modulePath.startsWith('/')) fail(`${recordPath} has no absolute modulePath`);
  const changed = (detail) => fail(`browser runtime changed since preflight; ask Odysseus to rerun gate resolution (${detail})`);
  let tree;
  try {
    if (realpathSync(modulePath) !== modulePath) changed('the module path no longer resolves to itself');
    if (sha256(readFileSync(join(modulePath, 'package.json'))) !== record.packageJsonSha256) changed('package.json digest differs');
    tree = digestModuleTree(modulePath);
  } catch (error) {
    changed(error.message);
  }
  if (tree.sha256 !== record.moduleTreeSha256 || JSON.stringify(tree.roots) !== JSON.stringify(record.moduleTreeRoots)) {
    changed('module tree digest differs');
  }
  return import(pathToFileURL(join(modulePath, 'index.mjs')).href);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Recomputes argus/browser-runtime@1 moduleTreeSha256 exactly as argus-assets does: the roots
// are the package plus every runtime dependency found by Node's node_modules lookup outside an
// already covered root; entries are labelled by their path relative to dirname(modulePath)
// with "/" separators, sorted by code unit, and hashed as `${label}\0${kind}\0${payload}\n`,
// where files carry the SHA-256 of their bytes and symbolic links their unfollowed link text.
function digestModuleTree(modulePath) {
  const roots = [modulePath];
  const scanned = new Set();
  const queue = [modulePath];
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    if (scanned.has(packageRoot)) continue;
    scanned.add(packageRoot);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')); }
    catch { manifest = null; }
    const names = Object.keys({
      ...(isPlainObject(manifest?.dependencies) ? manifest.dependencies : {}),
      ...(isPlainObject(manifest?.optionalDependencies) ? manifest.optionalDependencies : {}),
    }).sort();
    for (const name of names) {
      const dependency = resolvePackageDirectory(packageRoot, name);
      if (!dependency) continue;
      if (!roots.some((root) => isWithin(root, dependency))) roots.push(dependency);
      if (roots.length > 16) throw new Error('module tree spans more than 16 package roots');
      queue.push(dependency);
    }
  }
  const base = dirname(modulePath);
  const entries = [];
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const entry = lstatSync(path);
        const label = relative(base, path).split(sep).join('/');
        if (entry.isSymbolicLink()) entries.push([label, 'symlink', readlinkSync(path)]);
        else if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) entries.push([label, 'file', sha256(readFileSync(path))]);
        else throw new Error(`module tree holds an unsupported filesystem entry: ${label}`);
        if (entries.length > 20000) throw new Error('module tree holds more than 20000 entries');
      }
    }
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const digest = createHash('sha256');
  for (const [label, kind, payload] of entries) digest.update(`${label}\0${kind}\0${payload}\n`);
  return { sha256: digest.digest('hex'), roots };
}

function resolvePackageDirectory(fromDirectory, name) {
  for (let cursor = fromDirectory; ; cursor = dirname(cursor)) {
    if (basename(cursor) !== 'node_modules') {
      const candidate = join(cursor, 'node_modules', name);
      let manifestEntry = null;
      try { manifestEntry = statSync(join(candidate, 'package.json')); }
      catch { manifestEntry = null; }
      if (manifestEntry?.isFile()) {
        try { return realpathSync(candidate); }
        catch { return null; }
      }
    }
    if (dirname(cursor) === cursor) return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
