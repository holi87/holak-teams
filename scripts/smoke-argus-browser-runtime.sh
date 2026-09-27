#!/usr/bin/env bash
# Verify host-side browser provisioning (`argus-assets browser provision`), its host/operator-only
# boundary, the engagement guard denial, and the managed hunt driver resolving and
# digest-verifying the preflight-recorded Playwright runtime in place from the plugin.
# A recording Playwright stand-in replaces the real browser, so no network or Chromium is needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CLI="$ROOT/argus/claude/bin/argus-assets"
DRIVER="$ROOT/argus/claude/templates/typescript/scripts/hunt-driver.mjs"
FIXTURE="$ROOT/scripts/fixtures/argus-browser/fake-playwright-recording"
FULL_AUTHORIZATION="$ROOT/scripts/fixtures/argus-authorization/full.json"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
server_pid=''
cleanup() {
  if [ -s "$WORK/server/pid" ]; then kill "$(cat "$WORK/server/pid")" 2>/dev/null || true; fi
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# Provisioning runs as the host operator: every call gets a private HOME (the host runtime
# lands in $HOME/.cache/argus/browser-runtime) and none of the launch or lease variables.
HOST_HOME="$WORK/home"
mkdir -p "$HOST_HOME"
chmod 700 "$HOST_HOME"
host_assets() {
  env -u ARGUS_LAUNCH_UNATTESTED -u ARGUS_ENGAGEMENT_LEASE_TOKEN -u ARGUS_ENGAGEMENT_CONTROLLER_TOKEN \
    -u ARGUS_NATIVE_LAUNCH_AUTHORIZATION -u ARGUS_NATIVE_LAUNCH_RECEIPT -u ARGUS_NATIVE_LAUNCH_CAPABILITY \
    -u ARGUS_NATIVE_LAUNCH_PROOF -u ARGUS_ENGAGEMENT_MANIFEST -u PLAYWRIGHT_BROWSERS_PATH HOME="$HOST_HOME" "$@"
}
expect_provision_failure() {
  local name="$1" expected_status="$2" message="$3"
  shift 3
  local status=0
  "$@" >"$WORK/$name.out" 2>&1 || status=$?
  [ "$status" -eq "$expected_status" ] || { cat "$WORK/$name.out" >&2; fail "$name exited $status instead of $expected_status"; }
  grep -Fq -- "$message" "$WORK/$name.out" || { cat "$WORK/$name.out" >&2; fail "$name did not report: $message"; }
}
assert_alias_free() {
  local root="$1" alias
  alias="$(find "$root" -type l -print -quit)"
  [ -z "$alias" ] || fail "symbolic link alias left under $root: $alias"
  alias="$(find "$root" -type f -links +1 -print -quit)"
  [ -z "$alias" ] || fail "hard-link alias left under $root: $alias"
}

# (a) Pack the recording stand-in and provision it from the archive into a 0700 artifact root.
mkdir -p "$WORK/pack"
npm_config_cache="$WORK/npm-cache" npm_config_update_notifier=false \
  npm pack "$FIXTURE" --pack-destination "$WORK/pack" --ignore-scripts --silent >/dev/null
TGZ="$WORK/pack/playwright-0.1.0.tgz"
[ -f "$TGZ" ] || fail 'npm pack did not produce the recording Playwright archive'
ARTIFACT="$WORK/artifact"
mkdir -p "$ARTIFACT"
chmod 700 "$ARTIFACT"
RUNTIME_ROOT="$HOST_HOME/.cache/argus/browser-runtime"
MODULE="$RUNTIME_ROOT/0.1.0/node_modules/playwright"

host_assets "$CLI" browser provision --artifact-root "$ARTIFACT" --package "$TGZ" --skip-browser-install --json \
  >"$WORK/provision.json" 2>"$WORK/provision.err" || { cat "$WORK/provision.err" >&2; fail 'browser provision from a package archive failed'; }
[ -f "$MODULE/index.mjs" ] && [ -f "$MODULE/package.json" ] || fail 'provisioned Playwright module is missing from the host runtime directory'
jq -e --arg module "$MODULE" --arg install "$RUNTIME_ROOT/0.1.0" '
  .action == "installed" and .installDirectory == $install and .browserInstall == "skipped" and
  .runtime.status == "available" and .runtime.source == "host-provisioned" and .runtime.modulePath == $module and
  .runtime.moduleVersion == "0.1.0" and (.runtime.packageJsonSha256 | test("^[a-f0-9]{64}$")) and
  (.runtime.moduleTreeSha256 | test("^[a-f0-9]{64}$")) and .runtime.moduleTreeRoots == [$module] and
  .runtime.candidates == [{source:"host-provisioned",modulePath:$module,result:"launched",evidence:.runtime.candidates[0].evidence}]
' "$WORK/provision.json" >/dev/null || { cat "$WORK/provision.json" >&2; fail 'provision --json did not report the committed, launched host runtime'; }
grep -Fq "BROWSER_PROVISION  installed host-provisioned $MODULE 0.1.0 chromium=skipped" "$WORK/provision.err" || \
  fail 'provision --json did not report its summary line on stderr'
[ "$(ls -A "$RUNTIME_ROOT")" = '0.1.0' ] || fail "provisioning left staging or retired entries: $(ls -A "$RUNTIME_ROOT" | tr '\n' ' ')"
assert_alias_free "$ARTIFACT"
assert_alias_free "$RUNTIME_ROOT"
[ "$(cd "$ARTIFACT" && find . -mindepth 1 | sort | tr '\n' ' ')" = './ai_agents_internal ./ai_agents_internal/tmp ' ] || \
  fail "provisioning wrote into the artifact root beyond its private probe scratch: $(cd "$ARTIFACT" && find . -mindepth 1 | tr '\n' ' ')"
runtime_mode="$(node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$RUNTIME_ROOT")"
[ "$runtime_mode" = 700 ] || fail "host runtime directory is not private (mode $runtime_mode)"

# Chromium goes to Playwright's host default cache: the installer never sees PLAYWRIGHT_BROWSERS_PATH.
# Reinstalling the same version swaps it in place and leaves no retired copy behind.
host_assets env PLAYWRIGHT_BROWSERS_PATH="$ARTIFACT/browsers" \
  "$CLI" browser provision --artifact-root "$ARTIFACT" --package "$TGZ" >"$WORK/provision-chromium.out" 2>&1 || \
  { cat "$WORK/provision-chromium.out" >&2; fail 'browser provision with the Chromium install step failed'; }
grep -Fq "BROWSER_PROVISION  installed host-provisioned $MODULE 0.1.0 chromium=installed" "$WORK/provision-chromium.out" || \
  { cat "$WORK/provision-chromium.out" >&2; fail 'provisioning did not report the Chromium install'; }
grep -Fxq 'cli install chromium PLAYWRIGHT_BROWSERS_PATH=unset' "$HOST_HOME/fake-playwright-cli.log" || \
  fail 'Chromium install did not run through the package CLI with PLAYWRIGHT_BROWSERS_PATH unset'
[ ! -e "$ARTIFACT/browsers" ] || fail 'Chromium was installed under the artifact root'
[ "$(ls -A "$RUNTIME_ROOT")" = '0.1.0' ] || fail 'reinstalling the same version left a retired copy behind'

# Without --version or --package a host runtime that already launches is reused, not reinstalled.
host_assets "$CLI" browser provision --artifact-root "$ARTIFACT" >"$WORK/provision-reuse.out" 2>&1 || \
  { cat "$WORK/provision-reuse.out" >&2; fail 'browser provision reuse failed'; }
grep -Fxq "BROWSER_PROVISION  reused host-provisioned $MODULE 0.1.0" "$WORK/provision-reuse.out" || \
  { cat "$WORK/provision-reuse.out" >&2; fail 'a launching host runtime was not reused'; }
[ "$(grep -c '^cli ' "$HOST_HOME/fake-playwright-cli.log")" -eq 1 ] || fail 'reuse reran the Chromium installer'

# Invalid requests fail closed before anything is installed.
expect_provision_failure bad-version 1 'plain x.y.z release' \
  host_assets "$CLI" browser provision --artifact-root "$ARTIFACT" --version 1.61
expect_provision_failure version-and-package 1 'mutually exclusive' \
  host_assets "$CLI" browser provision --artifact-root "$ARTIFACT" --version 1.61.0 --package "$TGZ"
expect_provision_failure relative-root 1 'absolute, normalized path' \
  host_assets "$CLI" browser provision --artifact-root artifact
mkdir -p "$WORK/shared-artifact"
chmod 770 "$WORK/shared-artifact"
expect_provision_failure shared-root 1 'must not be group/world writable' \
  host_assets "$CLI" browser provision --artifact-root "$WORK/shared-artifact"
mkdir -p "$RUNTIME_ROOT/nested-artifact"
chmod 700 "$RUNTIME_ROOT/nested-artifact"
expect_provision_failure nested-root 1 'physically disjoint from the artifact root' \
  host_assets "$CLI" browser provision --artifact-root "$RUNTIME_ROOT/nested-artifact" --package "$TGZ"
rmdir "$RUNTIME_ROOT/nested-artifact"
printf 'not an archive\n' >"$WORK/pack/broken.tgz"
expect_provision_failure broken-archive 1 'browser provisioning failed: npm install exited' \
  host_assets "$CLI" browser provision --artifact-root "$ARTIFACT" --package "$WORK/pack/broken.tgz" --skip-browser-install
[ "$(ls -A "$RUNTIME_ROOT")" = '0.1.0' ] || fail 'a failed install left staging entries or replaced the working runtime'

# (b) Provisioning is host/operator-only: launch and lease variables refuse it with exit 2.
REFUSED_HOME="$WORK/refused-home"
mkdir -p "$REFUSED_HOME"
expect_provision_failure refused-unattested 2 'browser provisioning is host/operator-only; run it before the launch sandbox (argus-launch --provision-browser)' \
  env ARGUS_LAUNCH_UNATTESTED=1 HOME="$REFUSED_HOME" "$CLI" browser provision --artifact-root "$ARTIFACT" --package "$TGZ"
expect_provision_failure refused-lease 2 'browser provisioning is host/operator-only' \
  env ARGUS_ENGAGEMENT_LEASE_TOKEN=lease HOME="$REFUSED_HOME" "$CLI" browser provision --artifact-root "$ARTIFACT" --package "$TGZ"
[ -z "$(ls -A "$REFUSED_HOME")" ] || fail 'a refused provisioning touched the host cache'

# (c) Inside an engagement the PreToolUse guard denies provisioning; the in-place driver runs.
ENGAGED="$WORK/engaged"
mkdir -p "$ENGAGED"
"$CLI" engagement init --target "$ENGAGED" --artifact-root "$ENGAGED" --mode A --engagement-id browser-runtime-smoke >/dev/null
CONTROL="$ENGAGED/ai_agents_internal"
MANIFEST="$CONTROL/engagement.json"
guard_output() {
  jq -nc --arg cwd "$ENGAGED" --arg command "$1" '{tool_name:"Bash",cwd:$cwd,tool_input:{command:$command}}' | "$CLI" guard
}
denial="$(guard_output "argus-assets browser provision --artifact-root $ENGAGED")"
grep -Fq '"permissionDecision":"deny"' <<<"$denial" && grep -Fq 'browser provisioning is host/operator-only' <<<"$denial" || \
  fail "guard did not deny browser provisioning inside an engagement: $denial"
denial="$(guard_output "$CLI browser provision --artifact-root $ENGAGED --package $TGZ --json")"
grep -Fq 'GUARD-SHELL-AMBIGUOUS' <<<"$denial" || fail "guard did not deny the absolute-path provisioning command: $denial"
[ -z "$(guard_output 'argus-assets path typescript-template')" ] || fail 'guard denied the read-only template path lookup'
[ -z "$(guard_output "node $DRIVER --agent kalchas --goto / --snapshot")" ] || fail 'guard denied the in-place managed driver invocation'

# (d) The managed driver resolves its config, authorization, and Playwright module from the
# engagement control directory and imports exactly the recorded, digest-verified module.
mkdir -p "$WORK/server"
cat >"$WORK/server.cjs" <<'NODE'
const fs = require('fs');
const http = require('http');
const path = require('path');
const directory = process.argv[2];
const server = http.createServer((request, response) => {
  fs.appendFileSync(path.join(directory, 'requests.log'), `${request.method} ${request.url}\n`);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Argus recording fixture</title></head><body><h1>Recorded landing page</h1></body></html>');
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(directory, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(directory, 'port'), String(server.address().port));
});
// Never outlive an interrupted smoke by more than a few minutes.
setTimeout(() => process.exit(0), 300000);
NODE
# The server records its own PID: a version-manager shim may run node as a child of $!.
node "$WORK/server.cjs" "$WORK/server" </dev/null >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do [ -s "$WORK/server/port" ] && break; sleep 0.1; done
[ -s "$WORK/server/port" ] || fail 'fixture HTTP server did not start'
BASE="http://127.0.0.1:$(cat "$WORK/server/port")"

node - "$FULL_AUTHORIZATION" "$CONTROL/authorization.json" "$BASE" <<'NODE'
const fs = require('fs');
const [source, target, baseUrl] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
manifest.engagementId = 'browser-runtime-smoke';
manifest.target = { identifiers: [baseUrl], environment: 'test', productionLike: false };
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
mkdir -p "$CONTROL/recon"
jq -n --arg base "$BASE" '{baseUrl:$base,api:{login:"/api/login",me:"/api/me"},accounts:{}}' >"$CONTROL/recon/driver.config.json"
node - "$WORK/provision.json" "$CONTROL/browser-runtime.json" <<'NODE'
const fs = require('fs');
const [source, target] = process.argv.slice(2);
const { runtime } = JSON.parse(fs.readFileSync(source, 'utf8'));
const record = { $schema: 'argus/browser-runtime@1', schemaVersion: 1, engagementId: 'browser-runtime-smoke', ...runtime };
fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
NODE
node --input-type=module - "$ROOT/argus/runtime/json-schema.mjs" "$ROOT/argus/schemas/browser-runtime.schema.json" "$CONTROL/browser-runtime.json" <<'NODE' || \
  fail 'the provisioned runtime does not form a valid argus/browser-runtime@1 record'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [compilerPath, schemaPath, recordPath] = process.argv.slice(2);
const { compileJsonSchema } = await import(pathToFileURL(compilerPath).href);
const errors = compileJsonSchema(JSON.parse(readFileSync(schemaPath, 'utf8')))(JSON.parse(readFileSync(recordPath, 'utf8')));
if (errors.length > 0) {
  console.error(JSON.stringify(errors));
  process.exit(1);
}
NODE

PROFILE="$CONTROL/workers/kalchas/browser-profile"
ARTIFACTS="$CONTROL/workers/kalchas/browser-artifacts"
LOG="$WORK/playwright.log"
run_driver() {
  local output="$1"
  shift
  : >"$LOG"
  env -u DRIVER_CONFIG -u ARGUS_AUTHORIZATION_MANIFEST -u ARGUS_AUTHORIZATION_SOURCE_TRUST -u ARGUS_AUTHORIZATION_MUTATION \
    -u ARGUS_BINARY_EVIDENCE_REVIEWED -u ARGUS_CAPTURE_TRACE -u ARGUS_CAPTURE_VIDEO -u QCA_BASE_URL -u QCA_GOTO_WAIT_UNTIL \
    -u ARGUS_BROWSER_PROFILE HOME="$HOST_HOME" PATH="$ROOT/argus/claude/bin:$PATH" FAKE_PLAYWRIGHT_LOG="$LOG" \
    ARGUS_ENGAGEMENT_MANIFEST="$MANIFEST" ARGUS_BROWSER_ARTIFACTS="$ARTIFACTS" "$@" \
    node "$DRIVER" --agent kalchas --goto / --snapshot >"$output" 2>&1
}

run_driver "$WORK/driver.out" ARGUS_BROWSER_PROFILE="$PROFILE" || { cat "$WORK/driver.out" >&2; fail 'managed driver failed against the recorded runtime'; }
grep -Fxq "import $MODULE" "$LOG" || { cat "$LOG" >&2; fail 'managed driver did not import the recorded Playwright module'; }
[ "$(grep -c '^import ' "$LOG")" -eq 1 ] || fail 'managed driver imported more than one Playwright module'
grep -Fxq "launch $PROFILE headless=true" "$LOG" || { cat "$LOG" >&2; fail 'managed driver did not launch the allocated profile'; }
grep -Fq "page.goto $BASE/ status=200" "$LOG" || { cat "$LOG" >&2; fail 'managed driver did not navigate to the recon config base URL'; }
grep -Fxq 'locator.ariaSnapshot body' "$LOG" || { cat "$LOG" >&2; fail 'managed driver did not take the aria snapshot of the page body'; }
grep -Fxq "context.close $PROFILE" "$LOG" || fail 'managed driver did not close its browser context'
grep -Fq 'Recorded landing page' "$WORK/driver.out" || { cat "$WORK/driver.out" >&2; fail 'managed driver did not print the snapshot'; }
grep -Fxq 'GET /' "$WORK/server/requests.log" || fail 'fixture server did not receive the navigation'
jq -se 'any(.[]; .lane == "kalchas" and .action == "browser-read" and .decision == "allow")' \
  "$CONTROL/authorization-audit.jsonl" >/dev/null || fail 'managed driver did not check the control-directory authorization manifest'
for child in downloads traces videos screenshots; do [ -d "$ARTIFACTS/$child" ] || fail "managed driver did not create the $child artifact directory"; done

# A changed package.json, a changed module file, a non-available record, or a missing profile
# each stop the driver before Playwright is imported.
cp -p "$MODULE/package.json" "$WORK/package.json.orig"
printf '\n' >>"$MODULE/package.json"
set +e
run_driver "$WORK/driver-tampered-manifest.out" ARGUS_BROWSER_PROFILE="$PROFILE"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'managed driver accepted a changed package.json'
grep -Fq 'browser runtime changed' "$WORK/driver-tampered-manifest.out" || { cat "$WORK/driver-tampered-manifest.out" >&2; fail 'changed package.json was not reported as a changed runtime'; }
! grep -q '^import ' "$LOG" || fail 'managed driver imported a runtime with a changed package.json'
cp -p "$WORK/package.json.orig" "$MODULE/package.json"

cp -p "$MODULE/index.mjs" "$WORK/index.mjs.orig"
printf '// changed after the probe\n' >>"$MODULE/index.mjs"
set +e
run_driver "$WORK/driver-tampered-tree.out" ARGUS_BROWSER_PROFILE="$PROFILE"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'managed driver accepted a changed module file'
grep -Fq 'browser runtime changed since preflight' "$WORK/driver-tampered-tree.out" && grep -Fq 'module tree digest differs' "$WORK/driver-tampered-tree.out" || \
  { cat "$WORK/driver-tampered-tree.out" >&2; fail 'changed module file was not caught by the module-tree digest'; }
! grep -q '^import ' "$LOG" || fail 'managed driver imported a runtime with a changed module file'
cp -p "$WORK/index.mjs.orig" "$MODULE/index.mjs"

cp -p "$CONTROL/browser-runtime.json" "$WORK/browser-runtime.json.orig"
jq '.status = "unavailable" | .evidence = "fixture: no functional Playwright runtime"' "$WORK/browser-runtime.json.orig" >"$CONTROL/browser-runtime.json"
set +e
run_driver "$WORK/driver-unavailable.out" ARGUS_BROWSER_PROFILE="$PROFILE"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'managed driver ran with an unavailable browser runtime record'
grep -Fq 'browser runtime is unavailable' "$WORK/driver-unavailable.out" || { cat "$WORK/driver-unavailable.out" >&2; fail 'unavailable runtime record was not reported'; }
# Gate resolution is one-shot, so the remedy is a named residual, never "rerun gate resolution".
for output in driver-unavailable driver-tampered-tree; do
  grep -Fq 'stop and report a browser-runtime residual to Odysseus' "$WORK/$output.out" && ! grep -Fq 'rerun gate resolution' "$WORK/$output.out" || \
    { cat "$WORK/$output.out" >&2; fail "$output advised an impossible remedy instead of a browser-runtime residual"; }
done

# A record naming a copy inside the worker-writable artifact root is refused although its
# digests match (the tree is labelled relative to the module's parent): no import happens.
PLANTED="$ENGAGED/node_modules/playwright"
mkdir -p "$ENGAGED/node_modules"
cp -Rp "$MODULE" "$PLANTED"
jq --arg planted "$PLANTED" '.modulePath = $planted | .moduleTreeRoots = [$planted]' "$WORK/browser-runtime.json.orig" >"$CONTROL/browser-runtime.json"
set +e
run_driver "$WORK/driver-planted.out" ARGUS_BROWSER_PROFILE="$PROFILE"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'managed driver ran a runtime recorded inside the artifact root'
grep -Fq "browser runtime $PLANTED lies inside the worker-writable artifact root" "$WORK/driver-planted.out" || \
  { cat "$WORK/driver-planted.out" >&2; fail 'a runtime inside the artifact root was not refused by location'; }
! grep -q '^import ' "$LOG" || fail 'managed driver imported a runtime recorded inside the artifact root'
rm -rf "$ENGAGED/node_modules"
cp -p "$WORK/browser-runtime.json.orig" "$CONTROL/browser-runtime.json"

set +e
run_driver "$WORK/driver-no-profile.out"
status=$?
set -e
[ "$status" -ne 0 ] || fail 'managed driver ran without ARGUS_BROWSER_PROFILE'
grep -Fq 'ARGUS_BROWSER_PROFILE is required inside a managed engagement' "$WORK/driver-no-profile.out" || \
  { cat "$WORK/driver-no-profile.out" >&2; fail 'missing ARGUS_BROWSER_PROFILE was not reported'; }
[ ! -s "$LOG" ] || fail 'managed driver touched Playwright without ARGUS_BROWSER_PROFILE'

# Restoring the exact bytes makes the recorded runtime acceptable again.
run_driver "$WORK/driver-restored.out" ARGUS_BROWSER_PROFILE="$PROFILE" || { cat "$WORK/driver-restored.out" >&2; fail 'managed driver rejected the restored runtime'; }
grep -Fxq "import $MODULE" "$LOG" || fail 'managed driver did not import the restored runtime'

printf 'PASS  Browser runtime: host-only provisioning into the host cache (package, Chromium install, reuse, fail-closed inputs), launch/lease refusal, guard denial and in-place driver allowance, and a managed driver that imports only the digest-verified recorded module\n'
