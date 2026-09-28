#!/usr/bin/env node
// Browser-free contract smoke for hunt-driver v2: --help and --version, the --plan dry run
// (action order, input redaction, and the ordered authorization checks), parse-time validation
// that exits 2 before any config load or browser launch, the body-capture config bounds, and
// the driver-config schema fields the driver reads. Live browser behavior is covered elsewhere.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DRIVER = join(ROOT, 'argus/framework-template/scripts/hunt-driver.mjs');
const PACKAGED_DRIVER = join(ROOT, 'argus/claude/templates/typescript/scripts/hunt-driver.mjs');
const EXAMPLE_CONFIG = join(ROOT, 'argus/framework-template/scripts/driver.config.example.json');
const CONFIG_SCHEMA = join(ROOT, 'argus/schemas/driver-config.schema.json');
const WORK = mkdtempSync(join(tmpdir(), 'argus-hunt-driver-'));

// argus-assets must be on PATH: every plan line and error message goes through its redactor.
// DRIVER_CONFIG names a file that does not exist, so any run that reaches the config load
// fails loudly instead of silently passing a --plan or validation case.
const BASE_ENV = {
  ...process.env,
  PATH: `${join(ROOT, 'argus/claude/bin')}${delimiter}${process.env.PATH ?? ''}`,
  DRIVER_CONFIG: join(WORK, 'absent', 'driver.config.json'),
};
for (const key of [
  'ARGUS_ENGAGEMENT_MANIFEST', 'ARGUS_BROWSER_PROFILE', 'ARGUS_BROWSER_ARTIFACTS', 'ARGUS_AUTHORIZATION_MANIFEST',
  'ARGUS_AUTHORIZATION_MUTATION', 'ARGUS_AUTHORIZATION_SOURCE_TRUST', 'ARGUS_BINARY_EVIDENCE_REVIEWED',
  'ARGUS_CAPTURE_TRACE', 'ARGUS_CAPTURE_VIDEO', 'QCA_BASE_URL', 'QCA_GOTO_WAIT_UNTIL',
]) delete BASE_ENV[key];

const NEW_FLAGS = [
  '--actor', '--capture-bodies', '--plan', '--version', '--tab', '--as', '--fail-next', '--abort-next', '--delay-next',
  '--unroute', '--offline', '--online', '--wait-ms', '--advance', '--race-arm', '--race-fire', '--bodies',
];
const read = (account) => ({ action: 'browser-read', account, mutation: null });
const READ = read(null);
const stateChange = (account, mutation = 'browser:state-change') => ({ action: 'browser-state-change', account, mutation });
const clientFault = (account) => ({ action: 'browser-state-change', account, mutation: 'browser:client-fault' });
const BINARY = { action: 'binary-evidence', account: null, mutation: null };

try {
  // (a) + (e): help and version work from both the source and the packaged copy, with no
  // config, no Playwright import, and no --agent.
  for (const driver of [SOURCE_DRIVER, PACKAGED_DRIVER]) {
    const help = run(driver, ['--help']);
    assert.equal(help.status, 0, `${driver} --help failed: ${help.stderr}`);
    assert.match(help.stdout, /^hunt-driver 2\.0\.0 /, '--help does not name the driver version');
    for (const flag of NEW_FLAGS) assert(help.stdout.includes(flag), `${driver} --help does not list ${flag}`);
    const version = run(driver, ['--version']);
    assert.equal(version.status, 0, `${driver} --version failed: ${version.stderr}`);
    assert.equal(version.stdout, '2.0.0\n', `${driver} --version did not print 2.0.0`);
  }
  const source = readFileSync(SOURCE_DRIVER, 'utf8');
  assert.match(source, /^const DRIVER_VERSION = '2\.0\.0';$/m, 'DRIVER_VERSION is not declared as 2.0.0');
  const header = source.slice(0, source.indexOf('\n */\n'));
  for (const flag of NEW_FLAGS) assert(header.includes(flag), `header comment does not document ${flag}`);

  // (b) --plan: exact action order and the ordered authorization list.
  let plan = planOf(['--goto', '/', '--snapshot', '--console', '--net', '--bodies', '--whoami', '--tab', 'two', '--wait-ms', '250']);
  assert.deepEqual(plan.actions, [
    ['goto', '/'], ['snapshot', null], ['console', null], ['net', null], ['bodies', null], ['whoami', null],
    ['tab', 'two'], ['wait-ms', '250'],
  ]);
  assert.deepEqual(plan.authorization, [READ], 'a read-only run must need exactly one browser-read check');
  assert.equal(plan.driverVersion, '2.0.0');
  assert.equal(plan.agent, 'orion');
  assert.equal(plan.role, 'anon');
  assert.deepEqual(plan.actors, []);

  plan = planOf(['--role', 'argus-orion', '--goto', '/', '--click', '#submit']);
  assert.deepEqual(plan.authorization, [stateChange('argus-orion')], '--click must be a state change on the primary account');
  plan = planOf(['--goto', '/', '--hover', '#menu']);
  assert.deepEqual(plan.authorization, [stateChange('anon')], 'an anonymous state change must name the anon account');

  plan = planOf(['--role', 'argus-orion', '--fail-next', '**/api/**', '--goto', '/']);
  assert.deepEqual(plan.authorization, [stateChange('argus-orion'), clientFault('argus-orion')], '--fail-next must add the browser:client-fault check');
  for (const fault of [['--abort-next', '**/api/items'], ['--delay-next', '**/api/items::1500'], ['--offline']]) {
    plan = planOf(['--role', 'argus-orion', ...fault]);
    assert.deepEqual(plan.authorization, [stateChange('argus-orion'), clientFault('argus-orion')], `${fault[0]} must add the browser:client-fault check`);
  }
  for (const interactive of [['--online'], ['--unroute'], ['--clock', '2030-01-01T00:00:00Z', '--advance', '1000']]) {
    plan = planOf(['--role', 'argus-orion', ...interactive]);
    assert.deepEqual(plan.authorization, [stateChange('argus-orion')], `${interactive.at(-2) ?? interactive[0]} is a state change without a client fault`);
  }

  plan = planOf(['--role', 'argus-orion', '--actor', 'b=argus-x-b', '--actor', 'c=anon', '--click', '#buy']);
  assert.deepEqual(plan.actors, [{ name: 'b', role: 'argus-x-b' }, { name: 'c', role: 'anon' }]);
  assert.deepEqual(plan.authorization, [stateChange('argus-orion'), stateChange('argus-x-b')], 'every non-anonymous actor account needs its own check');
  // A read-only run logs in the same accounts, so every authenticated account needs its own
  // browser-read check inside accounts.allowedAliases; anonymous sessions name no account.
  plan = planOf(['--role', 'argus-orion', '--goto', '/', '--snapshot']);
  assert.deepEqual(plan.authorization, [read('argus-orion')], 'an authenticated read must name the primary account');
  plan = planOf(['--role', 'argus-orion', '--actor', 'b=argus-x-b', '--actor', 'c=anon', '--goto', '/', '--as', 'b', '--goto', '/']);
  assert.deepEqual(plan.authorization, [read('argus-orion'), read('argus-x-b')], 'every non-anonymous actor account needs its own browser-read check');
  plan = planOf(['--actor', 'b=argus-x-b', '--goto', '/', '--as', 'b', '--goto', '/']);
  assert.deepEqual(plan.authorization, [READ, read('argus-x-b')], 'an anonymous primary read must still authorize each actor account');

  // The client-fault mutation never comes from the environment; the main check's does.
  plan = planOf(['--role', 'argus-orion', '--actor', 'b=argus-x-b', '--offline'], { ARGUS_AUTHORIZATION_MUTATION: 'browser:custom' });
  assert.deepEqual(plan.authorization, [
    stateChange('argus-orion', 'browser:custom'), stateChange('argus-x-b', 'browser:custom'), clientFault('argus-orion'),
  ], 'ARGUS_AUTHORIZATION_MUTATION must not replace browser:client-fault');

  // Binary evidence stays the last check, for a screenshot or for trace/video capture.
  plan = planOf(['--role', 'argus-orion', '--fail-next', '**/api/**', '--goto', '/', '--shot', 'out/page.png']);
  assert.deepEqual(plan.authorization, [stateChange('argus-orion'), clientFault('argus-orion'), BINARY]);
  plan = planOf(['--goto', '/'], { ARGUS_CAPTURE_TRACE: 'true' });
  assert.deepEqual(plan.authorization, [READ, BINARY]);

  // A mixed run keeps every action, in order, with raw values; session options are reported.
  plan = planOf([
    '--role', 'argus-orion', '--actor', 'b=argus-x-b', '--tz', 'Europe/Warsaw', '--locale', 'pl-PL',
    '--clock', '2030-01-31T23:59:50Z', '--reduced-motion', '--capture-bodies', '**/api/**', '--capture-bodies', '**/graphql',
    '--fail-next', '**/api/items::500::all', '--tab', 'two', '--goto', '/', '--as', 'b', '--goto', '/',
    '--race-arm', 'primary/two::#buy', '--race-arm', 'main::#buy', '--race-fire', '--advance', '20000', '--unroute',
  ]);
  assert.deepEqual(plan.sessionOptions, {
    tz: 'Europe/Warsaw', locale: 'pl-PL', clock: '2030-01-31T23:59:50Z', reducedMotion: true, captureBodies: ['**/api/**', '**/graphql'],
  });
  assert.deepEqual(plan.actions, [
    ['fail-next', '**/api/items::500::all'], ['tab', 'two'], ['goto', '/'], ['as', 'b'], ['goto', '/'],
    ['race-arm', 'primary/two::#buy'], ['race-arm', 'main::#buy'], ['race-fire', null], ['advance', '20000'], ['unroute', null],
  ]);
  assert.deepEqual(plan.authorization, [stateChange('argus-orion'), stateChange('argus-x-b'), clientFault('argus-orion')]);

  // (c) --type input never reaches the plan output.
  const typed = run(SOURCE_DRIVER, ['--agent', 'orion', '--role', 'argus-orion', '--type', '#q::plain-typed-input-value', '--plan']);
  assert.equal(typed.status, 0, typed.stderr);
  assert(!typed.stdout.includes('plain-typed-input-value'), '--plan leaked --type input');
  assert.deepEqual(JSON.parse(typed.stdout).actions, [['type', '#q::[REDACTED:INPUT]']]);

  // (d) Parse-time validation exits 2 with a clear message before --plan or config load.
  const rejected = [
    [['--delay-next', 'x::0'], /--delay-next ms must be an integer from 1 to 60,000 \(got '0'\)/],
    [['--delay-next', 'x::70000'], /--delay-next ms must be an integer from 1 to 60,000 \(got '70000'\)/],
    [['--delay-next', 'x'], /--delay-next requires <glob>::<ms>\[::<count>\]/],
    [['--fail-next', 'x::99'], /--fail-next status must be an integer from 100 to 599 \(got '99'\)/],
    [['--fail-next', 'x::503::0'], /--fail-next count must be an integer from 1 to 1,000 \(got '0'\)/],
    [['--fail-next', '::503'], /--fail-next: the URL glob is empty/],
    [['--abort-next', 'x::1::2'], /--abort-next requires <glob>\[::<count>\]/],
    [['--advance', '10'], /--advance requires --clock/],
    [['--clock', '2030-01-01T00:00:00Z', '--advance', '2678400001'], /--advance must be an integer from 1 to 2,678,400,000/],
    [['--clock', 'not-a-date'], /--clock: 'not-a-date' is not a parseable datetime/],
    [['--wait-ms', '60001'], /--wait-ms must be an integer from 0 to 60,000/],
    [['--actor', 'primary=anon'], /--actor: the name 'primary' is reserved/],
    [['--actor', 'b=anon', '--actor', 'b=argus-x-b'], /--actor: duplicate actor 'b'/],
    [['--actor', 'Bob=anon'], /--actor: name 'Bob' must match/],
    [['--actor', 'b'], /--actor requires <name>=<role\|anon>/],
    [['--as', 'unknown'], /--as unknown: unknown actor/],
    [['--tab', 'Main'], /--tab: name 'Main' must match/],
    [['--race-fire'], /--race-fire: nothing is armed/],
    [['--race-arm', 'one::#buy', '--race-fire'], /tab primary\/one is not open/],
    [['--race-arm', 'main::#buy'], /armed targets are never fired/],
    [['--goto'], /missing value for --goto/],
    [['--goto', '--click', '#x'], /missing value for --goto/],
    [['--actor'], /missing value for --actor/],
    [['--capture-bodies', '--goto', '/'], /missing value for --capture-bodies/],
    [['--bogus'], /unknown arg: --bogus/],
  ];
  for (const [args, message] of rejected) expectRejected(['--agent', 'orion', ...args, '--plan'], message);
  expectRejected(['--goto', '/', '--plan'], /--agent <name> is required/);
  expectRejected(['--agent', '../escape', '--plan'], /--agent: '\.\.\/escape' must be one path segment/);

  // Body-capture config bounds fail closed after the config load, before any authorization
  // check or Playwright import.
  const config = { baseUrl: 'http://127.0.0.1:9', api: { login: '/api/login', me: '/api/me' }, accounts: {} };
  for (const [override, message] of [
    [{ maxCapturedBodyBytes: 100 }, /maxCapturedBodyBytes must be an integer from 1024 to 1048576/],
    [{ maxCapturedBodyBytes: 2_000_000 }, /maxCapturedBodyBytes must be an integer from 1024 to 1048576/],
    [{ bodyCaptureExclude: ['**/api/**', ''] }, /bodyCaptureExclude must be an array of non-empty URL globs/],
  ]) {
    const path = join(WORK, 'driver.config.json');
    writeFileSync(path, `${JSON.stringify({ ...config, ...override })}\n`);
    const result = run(SOURCE_DRIVER, ['--agent', 'orion', '--goto', '/'], { DRIVER_CONFIG: path, ARGUS_AUTHORIZATION_MANIFEST: join(WORK, 'absent.json') });
    assert.equal(result.status, 2, `config ${JSON.stringify(override)} exited ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, message);
    assert(!/authorization/i.test(result.stderr), 'an invalid body-capture config reached the authorization gate');
  }

  // The driver-config schema declares every optional field the driver reads.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(CONFIG_SCHEMA, 'utf8')));
  const example = JSON.parse(readFileSync(EXAMPLE_CONFIG, 'utf8'));
  assert(validate(example), `driver.config.example.json violates the schema: ${ajv.errorsText(validate.errors)}`);
  assert.deepEqual(example.bodyCaptureExclude, []);
  assert.equal(example.maxCapturedBodyBytes, 65536);
  assert(typeof example._bodyCaptureNote === 'string' && typeof example._actorsNote === 'string', 'example config lacks the body-capture and actor notes');
  assert.match(example._actorsNote, /argus-perseus-b/, 'the actor note does not recommend a lane-suffixed account alias');
  const complete = {
    ...config,
    api: { ...config.api, refresh: '/api/refresh' },
    accounts: { 'argus-orion': { loginPayload: { role: 'argus-orion' } } },
    bodyCaptureExclude: ['**/api/session/**'],
    maxCapturedBodyBytes: 1024,
  };
  assert(validate(complete), `schema rejected the optional driver fields: ${ajv.errorsText(validate.errors)}`);
  for (const invalid of [
    { ...complete, maxCapturedBodyBytes: 1023 },
    { ...complete, maxCapturedBodyBytes: 1_048_577 },
    { ...complete, maxCapturedBodyBytes: 65536.5 },
    { ...complete, bodyCaptureExclude: [42] },
    { ...complete, bodyCaptureExclude: '**' },
    { ...complete, api: { ...complete.api, refresh: '' } },
  ]) assert(!validate(invalid), `schema accepted an invalid driver config: ${JSON.stringify(invalid)}`);
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log('PASS  Argus hunt driver v2: help/version, --plan order and authorization checks, input redaction, parse-time validation, and body-capture config');

function run(driver, args, env = {}) {
  const result = spawnSync(process.execPath, [driver, ...args], {
    env: { ...BASE_ENV, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

function planOf(args, env = {}) {
  const result = run(SOURCE_DRIVER, ['--agent', 'orion', ...args, '--plan'], env);
  assert.equal(result.status, 0, `--plan ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, `--plan must print exactly one JSON line, got: ${result.stdout}`);
  const parsed = JSON.parse(lines[0]);
  const packaged = run(PACKAGED_DRIVER, ['--agent', 'orion', ...args, '--plan'], env);
  assert.equal(packaged.stdout, result.stdout, 'the packaged driver plans differently from the source driver');
  return parsed;
}

function expectRejected(args, message) {
  const result = run(SOURCE_DRIVER, args);
  assert.equal(result.status, 2, `${args.join(' ')} exited ${result.status} instead of 2: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^hunt-driver ERROR: /, `${args.join(' ')} printed no driver error`);
  assert.match(result.stderr, message, `${args.join(' ')} printed an unclear message: ${result.stderr}`);
  assert.equal(result.stdout, '', `${args.join(' ')} printed a plan despite the validation error`);
}
