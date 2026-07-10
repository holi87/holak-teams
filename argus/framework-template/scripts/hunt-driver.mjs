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
 * USAGE
 * -----
 *   node scripts/hunt-driver.mjs --agent <name> [--role <role>|anon] [actions...]
 *
 * Config (app-specific) comes from scripts/driver.config.json (see
 * driver.config.example.json). One launch per invocation; the profile (and thus
 * the session) persists on disk between invocations, so follow-up calls stay
 * logged in. Batch several actions in one call to amortise the ~1s launch.
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
 *   --snapshot              print compact accessibility tree (the DOM oracle)
 *   --console               print collected console messages
 *   --net                   print collected network requests (method + status + url)
 *   --whoami                print the session identity (GET <api.me>)
 *   --keep                  do NOT clear the profile first (default: reuse profile)
 *   --fresh                 wipe this agent's profile before launch (clean session)
 *   --headed                run headed (debug only; default headless)
 *   --tz <timezoneId>       emulate a timezone (context timezoneId, e.g. Europe/Warsaw)
 *   --locale <locale>       emulate a browser locale (context locale, e.g. pl-PL)
 *   --clock <ISO datetime>  pin the page clock (Playwright clock API) before the first
 *                           navigation — deterministic Date/timers for date/format oracles
 *   --reduced-motion        emulate prefers-reduced-motion: reduce (context reducedMotion)
 *
 * Example — sweep My Courses at mobile width as a student, capture evidence:
 *   node scripts/hunt-driver.mjs --agent orion --role student \
 *     --viewport 375x812 --goto /moje-kursy \
 *     --shot out/mycourses-375.png --snapshot --console --net
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---- tiny arg parser: ordered list of [action, value] -------------------
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`hunt-driver — isolated per-agent browser driver

Usage:
  node scripts/hunt-driver.mjs --agent <name> [--role <role>|anon] [actions...]

Core actions:
  --goto <route> --wait <selector> --viewport <WxH> --shot <file>
  --snapshot --eval <js> --click <selector> --type <selector::text>
  --press <key> --hover <selector> --select <selector::value>
  --upload <selector::path> --dialog <accept|dismiss[::text]> --back
  --console --net --whoami --fresh --headed
  --tz <timezoneId> --locale <locale> --clock <ISO datetime>
  --reduced-motion

Configuration:
  Copy scripts/driver.config.example.json to scripts/driver.config.json and
  fill it from recon. Set DRIVER_CONFIG to use another path.
  The driver requires the shared authorization manifest at
  ai_agents_internal/authorization.json (override with ARGUS_AUTHORIZATION_MANIFEST).`);
  process.exit(0);
}
let agent = null;
let role = null;
let keep = true;
let fresh = false;
let headed = false;
let tz = null;
let locale = null;
let clock = null;
let reducedMotion = false;
const actions = []; // ordered

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  switch (a) {
    case '--agent': agent = next(); break;
    case '--role': role = next(); break;
    case '--keep': keep = true; break;
    case '--fresh': fresh = true; break;
    case '--headed': headed = true; break;
    case '--tz': tz = next(); break;
    case '--locale': locale = next(); break;
    case '--clock': clock = next(); break;
    case '--reduced-motion': reducedMotion = true; break;
    case '--goto': actions.push(['goto', next()]); break;
    case '--wait': actions.push(['wait', next()]); break;
    case '--viewport': actions.push(['viewport', next()]); break;
    case '--shot': actions.push(['shot', next()]); break;
    case '--eval': actions.push(['eval', next()]); break;
    case '--click': actions.push(['click', next()]); break;
    case '--type': actions.push(['type', next()]); break;
    case '--press': actions.push(['press', next()]); break;
    case '--hover': actions.push(['hover', next()]); break;
    case '--select': actions.push(['select', next()]); break;
    case '--upload': actions.push(['upload', next()]); break;
    case '--dialog': actions.push(['dialog', next()]); break;
    case '--back': actions.push(['back', null]); break;
    case '--snapshot': actions.push(['snapshot', null]); break;
    case '--console': actions.push(['console', null]); break;
    case '--net': actions.push(['net', null]); break;
    case '--whoami': actions.push(['whoami', null]); break;
    default: fail(`unknown arg: ${a}`);
  }
}
if (!agent) fail('--agent <name> is required (drives the per-agent profile dir)');
if (clock && Number.isNaN(Date.parse(clock))) fail(`--clock: '${clock}' is not a parseable datetime (use ISO 8601, e.g. 2026-01-15T12:00:00Z)`);
const anon = !role || role === 'anon';

// ---- config + deferred dependency load ----------------------------------
// Keep --help runnable directly from an installed plugin cache before the
// template has been copied or npm dependencies installed.
const CONFIG_PATH = process.env.DRIVER_CONFIG ?? join(HERE, 'driver.config.json');
if (!existsSync(CONFIG_PATH)) {
  fail(`No config at ${CONFIG_PATH}. Copy driver.config.example.json -> driver.config.json and fill it from recon.`);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const BASE = process.env.QCA_BASE_URL ?? cfg.baseUrl;
const ACCESS_KEY = cfg.tokenStorageKey ?? 'access-token';
const REFRESH_KEY = cfg.refreshTokenStorageKey ?? null;
const POST_AUTH_MARKER = cfg.postAuthMarker ?? null;

// ---- shared authorization gate ------------------------------------------
// Any interactive verb is treated as a target state change. This check is
// defense in depth: the agent must check before calling the driver, and the
// driver independently checks again before Playwright starts.
const interactiveActions = new Set(['eval', 'click', 'type', 'press', 'hover', 'select', 'upload', 'dialog']);
const authorizationAction = actions.some(([action]) => interactiveActions.has(action))
  ? 'browser-state-change'
  : 'browser-read';
const authorizationManifest = process.env.ARGUS_AUTHORIZATION_MANIFEST ?? join(ROOT, 'ai_agents_internal', 'authorization.json');
const authorizationArgs = [
  'authorization', 'check',
  '--manifest', authorizationManifest,
  '--lane', agent,
  '--action', authorizationAction,
  '--target', BASE,
  '--source-trust', process.env.ARGUS_AUTHORIZATION_SOURCE_TRUST ?? 'manifest',
];
if (authorizationAction === 'browser-state-change') {
  authorizationArgs.push('--account', role ?? 'anon');
  authorizationArgs.push('--mutation', process.env.ARGUS_AUTHORIZATION_MUTATION ?? 'browser:state-change');
}
try {
  execFileSync('argus-assets', authorizationArgs, { stdio: 'inherit' });
} catch {
  fail(`authorization denied ${authorizationAction}; inspect the shared authorization audit and do not launch the browser`);
}
if (actions.some(([action]) => action === 'shot')) {
  const binaryArgs = [
    'authorization', 'check',
    '--manifest', authorizationManifest,
    '--lane', agent,
    '--action', 'binary-evidence',
    '--target', BASE,
    '--source-trust', process.env.ARGUS_AUTHORIZATION_SOURCE_TRUST ?? 'manifest',
    '--binary-reviewed', process.env.ARGUS_BINARY_EVIDENCE_REVIEWED ?? 'false',
  ];
  try {
    execFileSync('argus-assets', binaryArgs, { stdio: 'inherit' });
  } catch {
    fail('authorization denied binary-evidence; do not capture the screenshot until the view is synthetic/masked and independently reviewed');
  }
}
const { chromium } = await import('playwright');

// ---- token mint (API login) ---------------------------------------------
async function mintTokens(apiCtx) {
  const acct = (cfg.accounts ?? {})[role];
  if (!acct) fail(`role '${role}' not in config.accounts (have: ${Object.keys(cfg.accounts ?? {}).join(', ')})`);
  const res = await apiCtx.post(cfg.api.login, { data: acct.loginPayload ?? { email: acct.email, password: acct.password } });
  if (!res.ok()) fail(`login(${role}) failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  const access = dig(body, cfg.accessTokenPath ?? 'accessToken');
  const refresh = REFRESH_KEY ? dig(body, cfg.refreshTokenPath ?? 'refreshToken') : null;
  if (!access) fail(`no access token at path '${cfg.accessTokenPath}' in login response`);
  return { access, refresh };
}

// ---- main ----------------------------------------------------------------
const profileDir = resolve(process.env.ARGUS_BROWSER_PROFILE ?? join(ROOT, '.pw-profiles', agent));
if (fresh && existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

const log = (tag, ...rest) => safePrint(`[${agent}${role ? '/' + role : ''}] ${tag} ${rest.map(formatLogValue).join(' ')}`.trim());

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: !headed,
  viewport: { width: 1280, height: 800 },
  userAgent: cfg.userAgent,
  baseURL: BASE,
  ...(tz ? { timezoneId: tz } : {}),
  ...(locale ? { locale } : {}),
  ...(reducedMotion ? { reducedMotion: 'reduce' } : {}),
});
if (tz || locale || reducedMotion) {
  log('context', [tz && `tz=${tz}`, locale && `locale=${locale}`, reducedMotion && 'reducedMotion=reduce'].filter(Boolean).join(' '));
}

// collect console + network for the whole session
const consoleMsgs = [];
const netReqs = [];

const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on('response', (r) => netReqs.push(`${r.request().method()} ${r.status()} ${r.url()}`));

try {
  // Pin the page clock BEFORE any navigation so Date/timers are deterministic from
  // the first script run (UTC-vs-local, expiry tick-over, stale relative-time oracles).
  // clock.install pins the START instant; time still ticks (not a frozen clock).
  if (clock) {
    await page.clock.install({ time: new Date(clock) });
    log('clock', `installed @ ${new Date(clock).toISOString()}`);
  }

  // Inject role tokens BEFORE any navigation (guard sees session on first script run).
  if (!anon) {
    const apiCtx = await ctx.request;
    const { access, refresh } = await mintTokens(apiCtx);
    await page.addInitScript(
      ([k, v, rk, rv]) => {
        try {
          localStorage.setItem(k, v);
          if (rk && rv) localStorage.setItem(rk, rv);
        } catch { /* storage unavailable */ }
      },
      [ACCESS_KEY, access, REFRESH_KEY, refresh],
    );
    log('token injected', `(${ACCESS_KEY})`);
  }

  let navigated = false;
  for (const [act, val] of actions) {
    switch (act) {
      case 'viewport': {
        const [w, h] = val.split('x').map(Number);
        await page.setViewportSize({ width: w, height: h });
        log('viewport', `${w}x${h}`);
        break;
      }
      case 'goto': {
        // Default to domcontentloaded: an SPA constantly polls/streams, so 'networkidle'
        // routinely never fires and burns the full 30s before timing out. We instead reach
        // a deterministic ready state via the explicit marker/selector wait below.
        // networkidle stays OPT-IN for the rare static/SSR page that genuinely needs it:
        //   QCA_GOTO_WAIT_UNTIL=networkidle node scripts/hunt-driver.mjs ...
        const gotoWaitUntil = process.env.QCA_GOTO_WAIT_UNTIL ?? 'domcontentloaded';
        await page.goto(val, { waitUntil: gotoWaitUntil, timeout: 30_000 });
        // wait for SPA render so screenshots are never blank — this explicit marker/selector
        // wait (NOT networkidle) is the real readiness signal.
        if (!anon && POST_AUTH_MARKER) {
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
        navigated = true;
        log('goto', `${val} -> ${page.url()} (waitUntil=${gotoWaitUntil})`);
        break;
      }
      case 'wait':
        await page.locator(val).waitFor({ state: 'visible', timeout: 20_000 });
        log('wait', `${val} visible`);
        break;
      case 'shot': {
        mkdirSync(dirname(resolve(val)), { recursive: true });
        await page.screenshot({ path: val, fullPage: true, timeout: 15_000 });
        log('shot', resolve(val));
        break;
      }
      case 'eval': {
        // SAFE-BY-CONTEXT: eval runs inside page.evaluate (the browser page sandbox,
        // NOT node) and the expression comes from the trusted hunter operating its
        // own driver — identical trust model to MCP browser_evaluate. It is the
        // geometry/state oracle (getBoundingClientRect, querySelectorAll counts, etc).
        const out = await page.evaluate((js) => {
          // eslint-disable-next-line no-eval
          const r = eval(js);
          return r;
        }, val);
        log('eval', JSON.stringify(out));
        break;
      }
      case 'click':
        await page.locator(val).first().click({ timeout: 10_000 });
        log('click', val);
        break;
      case 'type': {
        const [sel, ...rest] = val.split('::');
        await page.locator(sel).first().fill(rest.join('::'));
        log('type', `${sel} <- [REDACTED:INPUT]`);
        break;
      }
      case 'press':
        await page.keyboard.press(val);
        log('press', val);
        break;
      case 'hover':
        await page.locator(val).first().hover({ timeout: 10_000 });
        log('hover', val);
        break;
      case 'select': {
        const [sel, ...rest] = val.split('::');
        const chosen = await page.locator(sel).first().selectOption(rest.join('::'));
        log('select', `${sel} <- ${rest.join('::')} (${JSON.stringify(chosen)})`);
        break;
      }
      case 'upload': {
        const [sel, ...rest] = val.split('::');
        await page.locator(sel).first().setInputFiles(rest.join('::'));
        log('upload', `${sel} <- ${rest.join('::')}`);
        break;
      }
      case 'dialog': {
        const [mode, ...t] = val.split('::');
        page.once('dialog', async (d) => {
          log('dialog', `${d.type()}: "${d.message()}" -> ${mode}`);
          if (mode === 'accept') await d.accept(t.length ? t.join('::') : undefined);
          else await d.dismiss();
        });
        log('dialog armed', mode);
        break;
      }
      case 'back':
        await page.goBack({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
        log('back', page.url());
        break;
      case 'snapshot': {
        if (!navigated) log('warn', 'snapshot before any --goto');
        const tree = await page.accessibility.snapshot({ interestingOnly: true });
        log('snapshot (a11y tree):');
        safePrint(JSON.stringify(tree, null, 1));
        break;
      }
      case 'console':
        log('console messages:');
        safePrint(consoleMsgs.length ? consoleMsgs.join('\n') : '(none)');
        break;
      case 'net':
        log('network:');
        safePrint(netReqs.length ? netReqs.slice(-80).join('\n') : '(none)');
        break;
      case 'whoami': {
        const apiCtx = ctx.request;
        const tok = anon ? null : (await mintTokens(apiCtx)).access;
        const res = await apiCtx.get(cfg.api.me, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
        log('whoami', res.status(), res.ok() ? JSON.stringify(await res.json()) : await res.text());
        break;
      }
    }
  }
  log('DONE');
} finally {
  await ctx.close();
}

// ---- helpers --------------------------------------------------------------
function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function fail(msg) {
  console.error('hunt-driver ERROR:', redactForConsole(msg));
  process.exit(2);
}

function safePrint(value) {
  process.stdout.write(`${redactForConsole(value)}\n`);
}

function redactForConsole(value) {
  try {
    return execFileSync('argus-assets', ['redact', '--input', '-', '--output', '-'], {
      input: String(value),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
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
