#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LAUNCHER="$ROOT/argus/claude/bin/argus-launch"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURE_BIN="$ROOT/scripts/fixtures/argus-launcher"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
ln -s "$FIXTURE_BIN" "$WORK/fixture-bin-parent-alias"
FIXTURE_PATH="$WORK/fixture-bin-parent-alias"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

known_argus_environment=(
  ARGUS_ALLOWED_WRITE_ROOTS ARGUS_ASSETS ARGUS_AUTH_DIRECTORY ARGUS_AUTHORIZATION_MANIFEST
  ARGUS_AUTHORIZATION_MUTATION ARGUS_AUTHORIZATION_SOURCE_TRUST ARGUS_BINARY_EVIDENCE_REVIEWED
  ARGUS_BROWSER_ARTIFACTS ARGUS_BROWSER_PROFILE ARGUS_CAPTURE_TRACE ARGUS_CAPTURE_VIDEO
  ARGUS_CONTRACT_SMOKE ARGUS_ENGAGEMENT_CONTROLLER_TOKEN ARGUS_ENGAGEMENT_LEASE_TOKEN
  ARGUS_ENGAGEMENT_MANIFEST ARGUS_IMMUTABILITY_BYPASS_TOKEN ARGUS_MODEL_SIGNING_KEY
  ARGUS_MODEL_TRUST_STORE ARGUS_NATIVE_LAUNCH_AUTHORIZATION ARGUS_NATIVE_LAUNCH_CAPABILITY
  ARGUS_NATIVE_LAUNCH_PROOF ARGUS_NATIVE_LAUNCH_RECEIPT ARGUS_OUTCOME_FILE
  ARGUS_PREVIOUS_REVISION ARGUS_TEST_ROOT ARGUS_TODAY
)

set +e
"$FIXTURE_BIN/claude" --max-turns 3 --argus-turn-cap-probe "$WORK/small-turn-cap.json" >/dev/null 2>&1
small_cap_status=$?
set -e
[ "$small_cap_status" -eq 42 ] || fail 'bounded runtime fixture did not stop on the supervisor turn-cap outcome'
jq -e '.requestedTurns == 4 and .completedTurns == 3 and .outcome == "error_max_turns" and .supervisorObserved == true' \
  "$WORK/small-turn-cap.json" >/dev/null || fail 'small native turn-cap behavior was not observed at the exact boundary'

# The controller turn cap lives in four places that must never drift: the model-policy
# controllerBudget role, the launcher constant (source and packaged copy), and the
# maxTurns const of both native-launch schemas (source and packaged copies). argus-assets
# derives the signed cap from the policy; the authenticated launches below prove it.
readonly REVIEWED_CONTROLLER_TURNS=400
policy_controller="$(jq -er '.controllerBudget.agent' "$ROOT/argus/model-policy.json")" || fail 'model policy has no controllerBudget agent'
[ "$policy_controller" = odysseus ] || fail "model policy controllerBudget names $policy_controller instead of odysseus"
policy_controller_turns="$(jq -er --arg agent "$policy_controller" '.roles[] | select(.slug == $agent) | .maxTurns' "$ROOT/argus/model-policy.json")" || \
  fail 'model policy has no controller role turn cap'
[ "$policy_controller_turns" = "$REVIEWED_CONTROLLER_TURNS" ] || \
  fail "model policy controller maxTurns $policy_controller_turns differs from the reviewed $REVIEWED_CONTROLLER_TURNS-turn cap"
for launcher_copy in "$ROOT/argus/bin/argus-launch" "$ROOT/argus/claude/bin/argus-launch"; do
  launcher_turns="$(sed -n 's/^readonly CONTROLLER_MAX_TURNS=\([0-9][0-9]*\)$/\1/p' "$launcher_copy")"
  [ "$(printf '%s\n' "$launcher_turns" | grep -c .)" -eq 1 ] || fail "$launcher_copy must declare readonly CONTROLLER_MAX_TURNS exactly once"
  [ "$launcher_turns" = "$policy_controller_turns" ] || \
    fail "$launcher_copy CONTROLLER_MAX_TURNS=$launcher_turns differs from model-policy $policy_controller maxTurns $policy_controller_turns"
done
for schema_copy in \
  "$ROOT/argus/schemas/native-launch-authorization.schema.json" "$ROOT/argus/schemas/native-launch-receipt.schema.json" \
  "$ROOT/argus/claude/schemas/native-launch-authorization.schema.json" "$ROOT/argus/claude/schemas/native-launch-receipt.schema.json"; do
  schema_turns="$(jq -er '.properties.maxTurns.const' "$schema_copy")" || fail "$schema_copy has no maxTurns const"
  [ "$schema_turns" = "$policy_controller_turns" ] || \
    fail "$schema_copy maxTurns const $schema_turns differs from model-policy $policy_controller maxTurns $policy_controller_turns"
done

# os-native-target-readonly@3 widens the @2 Darwin profile only by what headless Chromium
# needs: one scoped IOKit user-client class and the org.chromium mach namespace. A bare or
# additional iokit, mach, or ipc rule is a sandbox regression.
count_fixed() { grep -cF -- "$1" "$2" || true; }
for launcher_copy in "$ROOT/argus/bin/argus-launch" "$ROOT/argus/claude/bin/argus-launch"; do
  [ "$(count_fixed 'global-name-regex #"^org\.chromium\."' "$launcher_copy")" -eq 2 ] || \
    fail "$launcher_copy must scope exactly two mach rules to the org.chromium namespace"
  [ "$(count_fixed "'(allow mach-register (global-name-regex #\"^org\\.chromium\\.\"))'" "$launcher_copy")" -eq 1 ] || \
    fail "$launcher_copy must register only org.chromium mach names"
  [ "$(count_fixed "'(allow mach-lookup (global-name-regex #\"^org\\.chromium\\.\"))'" "$launcher_copy")" -eq 1 ] || \
    fail "$launcher_copy must look up only org.chromium mach names"
  [ "$(count_fixed "'(allow iokit-open (iokit-user-client-class \"RootDomainUserClient\"))'" "$launcher_copy")" -eq 1 ] || \
    fail "$launcher_copy must scope IOKit access to the RootDomainUserClient user-client class"
  [ "$(count_fixed '(allow iokit' "$launcher_copy")" -eq 1 ] || fail "$launcher_copy carries an additional IOKit rule"
  [ "$(count_fixed '(allow mach' "$launcher_copy")" -eq 2 ] || fail "$launcher_copy carries an additional mach rule"
  [ "$(count_fixed '(allow ipc' "$launcher_copy")" -eq 0 ] || fail "$launcher_copy carries an ipc rule"
  for bare_rule in '(allow iokit-open)' '(allow mach-lookup)' '(allow mach-register)' '(allow mach*)'; do
    [ "$(count_fixed "$bare_rule" "$launcher_copy")" -eq 0 ] || fail "$launcher_copy carries the unscoped rule $bare_rule"
  done
  [ "$(count_fixed 'os-native-target-readonly@2' "$launcher_copy")" -eq 0 ] || fail "$launcher_copy still names sandbox policy @2"
done

prepare_signer() {
  local root="$1" key_id="$2"
  mkdir -p "$root"
  chmod 700 "$root"
  openssl genpkey -algorithm ED25519 -out "$root/runtime-private.pem" >/dev/null 2>&1
  openssl pkey -in "$root/runtime-private.pem" -pubout -out "$root/runtime-public.pem" >/dev/null 2>&1
  jq -n --arg keyId "$key_id" --rawfile publicKey "$root/runtime-public.pem" \
    '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
      {keyId:$keyId,purpose:"runtime-attestation",subjectId:"argus-launcher-smoke-signer",algorithm:"Ed25519",publicKeyPem:$publicKey,status:"active"}
    ]}' >"$root/model-trust.json"
  chmod 600 "$root"/*.pem "$root/model-trust.json"
}

sign_request() {
  local signer_root="$1" request="$2" authorization="$3"
  "$CLI" model payload --document "$request" >"$signer_root/payload.txt"
  openssl pkeyutl -sign -rawin -inkey "$signer_root/runtime-private.pem" \
    -in "$signer_root/payload.txt" -out "$signer_root/signature.bin"
  signature="$(openssl base64 -A -in "$signer_root/signature.bin")"
  jq --arg signature "$signature" '.authentication.signatureBase64 = $signature' \
    "$request" >"$authorization.tmp"
  chmod 600 "$authorization.tmp"
  mv "$authorization.tmp" "$authorization"
  rm -f "$signer_root/runtime-private.pem" "$signer_root/payload.txt" "$signer_root/signature.bin"
}

wait_for_file() {
  local path="$1"
  for _ in $(seq 1 200); do
    [ -f "$path" ] && return 0
    sleep 0.05
  done
  return 1
}

run_authenticated_launch() {
  local name="$1" target="$2" artifact="$3" workspace="${4:-}"
  local operator="$WORK/$name-operator" request authorization trust key_id output error pid
  operator="$WORK/$name-operator"
  key_id="runtime-$name"
  prepare_signer "$operator" "$key_id"
  request="$operator/request.json"
  authorization="$operator/authorization.json"
  trust="$operator/model-trust.json"
  output="$WORK/$name.stdout"
  error="$WORK/$name.stderr"
  command=("$LAUNCHER" claude --target "$target" --artifact-root "$artifact" --mode B \
    --engagement-id "launcher-$name" --trust-store "$trust" --runtime-key-id "$key_id" \
    --request-output "$request" --launch-authorization "$authorization" --wait-seconds 30)
  [ -z "$workspace" ] || command+=(--workspace "$workspace")
  seeded_environment=()
  for environment_name in "${known_argus_environment[@]}"; do
    seeded_environment+=("$environment_name=forged-$environment_name")
  done
  PATH="$FIXTURE_PATH:$PATH" env "${seeded_environment[@]}" "${command[@]}" >"$output" 2>"$error" &
  pid=$!
  wait_for_file "$request" || { cat "$error" >&2; fail "$name launch request was not created"; }
  sign_request "$operator" "$request" "$authorization"
  wait_for_file "$artifact/ai_agents_internal/fixture-native-ready" || {
    cat "$error" >&2
    jq '{launcherPid,launcherExecutable}' "$authorization" >&2 2>/dev/null || true
    fail "$name sandboxed fixture did not become ready"
  }

  # Signed files copied into a sibling process are insufficient: the caller must
  # be the authorized launcher itself or one of its descendants.
  set +e
  (
    cd "$(jq -r .workspace "$authorization")"
    env -i HOME="${HOME:-}" PATH="${PATH:-/usr/bin:/bin}" \
      ARGUS_MODEL_TRUST_STORE="$trust" \
      ARGUS_NATIVE_LAUNCH_AUTHORIZATION="$authorization" \
      ARGUS_NATIVE_LAUNCH_RECEIPT="$artifact/ai_agents_internal/native-launch-receipt.json" \
      ARGUS_NATIVE_LAUNCH_CAPABILITY="$(printf forged-replay-capability | shasum -a 256 | awk '{print $1}')" \
      "$CLI" preflight --target "$(jq -r .target "$authorization")" --artifact-root "$artifact" \
        --mode B --engagement-id "launcher-$name" --launch-authorization "$authorization" \
        --launch-receipt "$artifact/ai_agents_internal/native-launch-receipt.json" --trust-store "$trust" \
        --output "ai_agents_internal/replay-preflight-$name.json" >/dev/null 2>"$WORK/$name-replay.stderr"
  )
  replay_status=$?
  set -e
  [ "$replay_status" -ne 0 ] || fail "$name signed launch files were replayed from an unrelated process"
  grep -Fq 'OS sandbox is not active' "$WORK/$name-replay.stderr" || fail "$name replay rejection did not prove live OS-sandbox enforcement"
  [ ! -e "$artifact/ai_agents_internal/replay-preflight-$name.json" ] || fail "$name rejected replay persisted a report"
  touch "$artifact/ai_agents_internal/fixture-replay-complete"

  if ! wait "$pid"; then cat "$error" >&2; fail "$name authenticated launcher failed"; fi
  grep -Fq 'ARGUS_FIXTURE_NATIVE_PREFLIGHT_OK' "$output" || fail "$name did not execute authenticated preflight inside the sandbox"
  jq -e '.checks[] | select(.id == "native-host-execution" and .status == "pass")' \
    "$artifact/ai_agents_internal/preflight.json" >/dev/null || fail "$name native preflight check did not pass"
  jq -e --arg target "$(jq -r .target "$request")" --arg artifact "$artifact" \
    '.target == $target and .artifactRoot == $artifact and .maxTurns == 400 and .sandboxPolicy == "os-native-target-readonly@3" and .environmentPolicy == "argus-launch-allowlist@1"' \
    "$authorization" >/dev/null || fail "$name signed authorization omitted exact launch bindings"
  env_file="$artifact/ai_agents_internal/fixture-child-environment.txt"
  [ "$(grep -c '^ARGUS_' "$env_file")" -eq 4 ] || { cat "$env_file" >&2; fail "$name child received an unexpected Argus environment variable"; }
  for forbidden in "${known_argus_environment[@]}"; do
    case "$forbidden" in
      ARGUS_MODEL_TRUST_STORE|ARGUS_NATIVE_LAUNCH_AUTHORIZATION|ARGUS_NATIVE_LAUNCH_CAPABILITY|ARGUS_NATIVE_LAUNCH_RECEIPT) continue ;;
    esac
    ! grep -q "^$forbidden=" "$env_file" || fail "$name inherited forbidden capability $forbidden"
  done
  grep -Fq -- '--max-turns' "$artifact/ai_agents_internal/fixture-claude-arguments.txt" || fail "$name Claude argv omitted --max-turns"
  grep -Fxq '400' "$artifact/ai_agents_internal/fixture-claude-arguments.txt" || fail "$name Claude argv omitted the exact 400-turn cap"
  jq -e '.requestedTurns == 401 and .completedTurns == 400 and .outcome == "error_max_turns" and .supervisorObserved == true' \
    "$artifact/ai_agents_internal/fixture-turn-cap-behavior.json" >/dev/null || fail "$name did not observe exact native turn-cap termination behavior"
}

mkdir -p "$WORK/path target" "$WORK/path artifacts"
printf 'immutable\n' >"$WORK/path target/sentinel.txt"
run_authenticated_launch path "$WORK/path target" "$WORK/path artifacts"
[ "$(cat "$WORK/path target/sentinel.txt")" = immutable ] || fail 'path launch changed the target sentinel'

mkdir -p "$WORK/url-artifacts"
run_authenticated_launch url 'https://example.test/qa' "$WORK/url-artifacts"
jq -e '.targetKind == "url" and .target == "https://example.test/qa" and .workspace == .artifactRoot' \
  "$WORK/url-operator/request.json" >/dev/null || fail 'URL-only launch did not separate target identity from workspace'

mkdir -p "$WORK/url-workspace" "$WORK/url-workspace-artifacts"
run_authenticated_launch url-workspace 'https://example.test/qa?lane=workspace' "$WORK/url-workspace-artifacts" "$WORK/url-workspace"
jq -e --arg workspace "$WORK/url-workspace" '.targetKind == "url" and .workspace == $workspace' \
  "$WORK/url-workspace-operator/request.json" >/dev/null || fail 'URL launch did not bind the explicit workspace'

# Signed coordinates are immutable even when the attacker reuses a valid signature.
jq '.mode = "A"' "$WORK/path-operator/authorization.json" >"$WORK/path-operator/tampered-authorization.json"
chmod 600 "$WORK/path-operator/tampered-authorization.json"
if "$CLI" launch verify --request "$WORK/path-operator/request.json" \
  --authorization "$WORK/path-operator/tampered-authorization.json" \
  --receipt "$WORK/path artifacts/ai_agents_internal/native-launch-receipt.json" \
  --trust-store "$WORK/path-operator/model-trust.json" >/dev/null 2>&1; then
  fail 'signed launch authorization accepted changed arguments'
fi

# A signed document carrying the retired 96-turn cap cannot be verified.
jq '.maxTurns = 96' "$WORK/path-operator/authorization.json" >"$WORK/path-operator/retired-cap-authorization.json"
chmod 600 "$WORK/path-operator/retired-cap-authorization.json"
if "$CLI" launch verify --request "$WORK/path-operator/request.json" \
  --authorization "$WORK/path-operator/retired-cap-authorization.json" \
  --receipt "$WORK/path artifacts/ai_agents_internal/native-launch-receipt.json" \
  --trust-store "$WORK/path-operator/model-trust.json" >/dev/null 2>"$WORK/retired-cap.stderr"; then
  fail 'signed launch authorization accepted a turn cap other than the controller cap'
fi
grep -Fq '/maxTurns' "$WORK/retired-cap.stderr" || { cat "$WORK/retired-cap.stderr" >&2; fail 'retired turn-cap rejection did not name maxTurns'; }

# Even a fully verified authorization cannot start Claude when its signed cap differs
# from the launcher's own constant: a packaged launcher copy with a drifted constant
# must refuse after launch verify and before spawning the controller.
drift_plugin="$WORK/drift-plugin"
cp -R "$ROOT/argus/claude" "$drift_plugin"
sed 's/^readonly CONTROLLER_MAX_TURNS=400$/readonly CONTROLLER_MAX_TURNS=399/' "$ROOT/argus/claude/bin/argus-launch" >"$drift_plugin/bin/argus-launch"
grep -Fxq 'readonly CONTROLLER_MAX_TURNS=399' "$drift_plugin/bin/argus-launch" || fail 'drift launcher fixture did not change the controller constant'
mkdir -p "$WORK/drift-target" "$WORK/drift-artifacts"
prepare_signer "$WORK/drift-operator" runtime-drift
PATH="$FIXTURE_PATH:$PATH" "$drift_plugin/bin/argus-launch" claude --target "$WORK/drift-target" \
  --artifact-root "$WORK/drift-artifacts" --mode B --engagement-id launcher-drift \
  --trust-store "$WORK/drift-operator/model-trust.json" --runtime-key-id runtime-drift \
  --request-output "$WORK/drift-operator/request.json" --launch-authorization "$WORK/drift-operator/authorization.json" \
  --wait-seconds 30 >"$WORK/drift.stdout" 2>"$WORK/drift.stderr" &
drift_pid=$!
wait_for_file "$WORK/drift-operator/request.json" || { cat "$WORK/drift.stderr" >&2; fail 'drift launch request was not created'; }
jq -e --argjson turns "$REVIEWED_CONTROLLER_TURNS" '.maxTurns == $turns' "$WORK/drift-operator/request.json" >/dev/null || \
  fail 'argus-assets did not sign the model-policy controller cap into the launch request'
sign_request "$WORK/drift-operator" "$WORK/drift-operator/request.json" "$WORK/drift-operator/authorization.json"
set +e
wait "$drift_pid"
drift_status=$?
set -e
[ "$drift_status" -ne 0 ] || fail 'launcher accepted a signed turn cap that differs from its controller constant'
grep -Fq 'signed launch authorization turn cap differs from the launcher controller cap' "$WORK/drift.stderr" || {
  cat "$WORK/drift.stderr" >&2
  fail 'drifted launcher constant was not rejected by the signed-cap cross-check'
}
[ -f "$WORK/drift-artifacts/ai_agents_internal/native-launch-receipt.json" ] || fail 'drift launch failed before launch verify'
[ ! -e "$WORK/drift-artifacts/ai_agents_internal/fixture-claude-arguments.txt" ] || fail 'drift launcher started the controller'

# An authenticated dry run verifies the signed request, then reports the exact sandbox and
# environment policies without starting the controller.
mkdir -p "$WORK/dry-run-target" "$WORK/dry-run-artifacts"
prepare_signer "$WORK/dry-run-operator" runtime-dry-run
PATH="$FIXTURE_PATH:$PATH" "$LAUNCHER" claude --target "$WORK/dry-run-target" \
  --artifact-root "$WORK/dry-run-artifacts" --mode B --engagement-id launcher-dry-run \
  --trust-store "$WORK/dry-run-operator/model-trust.json" --runtime-key-id runtime-dry-run \
  --request-output "$WORK/dry-run-operator/request.json" --launch-authorization "$WORK/dry-run-operator/authorization.json" \
  --wait-seconds 30 --dry-run >"$WORK/dry-run.stdout" 2>"$WORK/dry-run.stderr" &
dry_run_pid=$!
wait_for_file "$WORK/dry-run-operator/request.json" || { cat "$WORK/dry-run.stderr" >&2; fail 'authenticated dry-run request was not created'; }
jq -e '.sandboxPolicy == "os-native-target-readonly@3" and .environmentPolicy == "argus-launch-allowlist@1"' \
  "$WORK/dry-run-operator/request.json" >/dev/null || fail 'launch request did not bind sandbox policy @3'
sign_request "$WORK/dry-run-operator" "$WORK/dry-run-operator/request.json" "$WORK/dry-run-operator/authorization.json"
if ! wait "$dry_run_pid"; then cat "$WORK/dry-run.stderr" >&2; fail 'authenticated dry run failed'; fi
grep -Fq 'sandbox=os-native-target-readonly@3 environment=argus-launch-allowlist@1' "$WORK/dry-run.stdout" || \
  { cat "$WORK/dry-run.stdout" >&2; fail 'authenticated dry run omitted sandbox policy @3'; }
[ ! -e "$WORK/dry-run-artifacts/ai_agents_internal/fixture-claude-arguments.txt" ] || fail 'authenticated dry run started the controller'

# A public environment string must never satisfy the mandatory native check.
mkdir -p "$WORK/direct-target" "$WORK/direct-artifacts"
set +e
ARGUS_NATIVE_LAUNCH_PROOF='argus-launch/1:claude:96:os-native' \
  "$CLI" preflight --target "$WORK/direct-target" --artifact-root "$WORK/direct-artifacts" --mode B \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null 2>&1
direct_status=$?
set -e
[ "$direct_status" -ne 0 ] || fail 'direct preflight accepted the retired public environment proof'
[ ! -e "$WORK/direct-artifacts/ai_agents_internal" ] || fail 'direct preflight wrote control artifacts before authenticated-launch rejection'

# Even a complete valid signature, receipt, and per-launch secret cannot pass from
# an unsandboxed process: the signed host-writable probe remains writable there.
mkdir -p "$WORK/complete-replay-target" "$WORK/complete-replay-artifacts" "$WORK/complete-replay-operator/probe"
chmod 700 "$WORK/complete-replay-operator/probe"
prepare_signer "$WORK/complete-replay-operator" runtime-complete-replay
complete_capability="$(openssl rand -hex 32 | tr -d '\n')"
complete_capability_sha256="$(printf %s "$complete_capability" | shasum -a 256 | awk '{print $1}')"
complete_authorization="$WORK/complete-replay-operator/authorization.json"
complete_receipt="$WORK/complete-replay-artifacts/ai_agents_internal/native-launch-receipt.json"
mkdir -p "$WORK/complete-replay-artifacts/ai_agents_internal"
node "$ROOT/scripts/fixtures/argus-launcher/create-unit-authorization.mjs" \
  path "$WORK/complete-replay-target" "$WORK/complete-replay-target" "$WORK/complete-replay-artifacts" B \
  complete-replay "$LAUNCHER" "$$" "$FIXTURE_BIN/claude" runtime-complete-replay \
  "$WORK/complete-replay-operator/model-trust.json" "$WORK/complete-replay-operator/runtime-private.pem" \
  "$complete_authorization" "$complete_receipt" "$complete_capability_sha256" \
  "$WORK/complete-replay-operator/probe"
rm -f "$WORK/complete-replay-operator/runtime-private.pem"
set +e
(
  cd "$WORK/complete-replay-target"
  env -i HOME="${HOME:-}" PATH="${PATH:-/usr/bin:/bin}" \
    ARGUS_MODEL_TRUST_STORE="$WORK/complete-replay-operator/model-trust.json" \
    ARGUS_NATIVE_LAUNCH_AUTHORIZATION="$complete_authorization" \
    ARGUS_NATIVE_LAUNCH_RECEIPT="$complete_receipt" \
    ARGUS_NATIVE_LAUNCH_CAPABILITY="$complete_capability" \
    "$CLI" preflight --target "$WORK/complete-replay-target" --artifact-root "$WORK/complete-replay-artifacts" \
      --mode B --engagement-id complete-replay --launch-authorization "$complete_authorization" \
      --launch-receipt "$complete_receipt" --trust-store "$WORK/complete-replay-operator/model-trust.json" \
      >/dev/null 2>"$WORK/complete-replay.stderr"
)
complete_replay_status=$?
set -e
[ "$complete_replay_status" -ne 0 ] || fail 'complete authenticated launch material passed outside the OS sandbox'
grep -Fq 'OS sandbox is not active' "$WORK/complete-replay.stderr" || fail 'complete replay was not rejected by the live sandbox probe'
[ ! -e "$WORK/complete-replay-artifacts/ai_agents_internal/preflight.json" ] || fail 'complete replay persisted a preflight report before rejection'

# Making the signed probe itself non-writable must not counterfeit sandbox state.
chmod 500 "$WORK/complete-replay-operator/probe"
set +e
(
  cd "$WORK/complete-replay-target"
  env -i HOME="${HOME:-}" PATH="${PATH:-/usr/bin:/bin}" \
    ARGUS_MODEL_TRUST_STORE="$WORK/complete-replay-operator/model-trust.json" \
    ARGUS_NATIVE_LAUNCH_AUTHORIZATION="$complete_authorization" \
    ARGUS_NATIVE_LAUNCH_RECEIPT="$complete_receipt" \
    ARGUS_NATIVE_LAUNCH_CAPABILITY="$complete_capability" \
    "$CLI" preflight --target "$WORK/complete-replay-target" --artifact-root "$WORK/complete-replay-artifacts" \
      --mode B --engagement-id complete-replay --launch-authorization "$complete_authorization" \
      --launch-receipt "$complete_receipt" --trust-store "$WORK/complete-replay-operator/model-trust.json" \
      --output ai_agents_internal/probe-tamper-preflight.json >/dev/null 2>"$WORK/probe-tamper.stderr"
)
probe_tamper_status=$?
set -e
chmod 700 "$WORK/complete-replay-operator/probe"
[ "$probe_tamper_status" -ne 0 ] || fail 'changed sandbox-probe permissions counterfeited sandbox state'
grep -Fq 'sandboxProbeMode identity changed' "$WORK/probe-tamper.stderr" || fail 'sandbox probe mode was not bound to the signature'
[ ! -e "$WORK/complete-replay-artifacts/ai_agents_internal/probe-tamper-preflight.json" ] || fail 'probe-tamper rejection persisted a report'

# Validate containment before creation: a rejected child artifact path must remain absent.
mkdir -p "$WORK/reject-target" "$WORK/reject-operator"
chmod 700 "$WORK/reject-operator"
prepare_signer "$WORK/reject-operator" runtime-reject
set +e
PATH="$FIXTURE_BIN:$PATH" "$LAUNCHER" claude --target "$WORK/reject-target" \
  --artifact-root "$WORK/reject-target/new-artifacts" --mode A --engagement-id launcher-reject \
  --trust-store "$WORK/reject-operator/model-trust.json" --runtime-key-id runtime-reject \
  --request-output "$WORK/reject-operator/request.json" --launch-authorization "$WORK/reject-operator/authorization.json" \
  --wait-seconds 30 >/dev/null 2>&1
reject_status=$?
set -e
[ "$reject_status" -ne 0 ] || fail 'launcher accepted an artifact root inside the target tree'
[ ! -e "$WORK/reject-target/new-artifacts" ] || fail 'launcher mutated the target before rejecting nested artifact root'

# Existing artifact trees cannot smuggle target aliases into the writable boundary.
mkdir -p "$WORK/alias-target" "$WORK/symlink-artifacts" "$WORK/hardlink-artifacts" "$WORK/alias-operator"
printf 'alias-sentinel\n' >"$WORK/alias-target/sentinel.txt"
ln -s "$WORK/alias-target/sentinel.txt" "$WORK/symlink-artifacts/target-link"
ln "$WORK/alias-target/sentinel.txt" "$WORK/hardlink-artifacts/target-link"
prepare_signer "$WORK/alias-operator" runtime-alias
for kind in symlink hardlink; do
  if PATH="$FIXTURE_BIN:$PATH" "$LAUNCHER" claude --target "$WORK/alias-target" \
    --artifact-root "$WORK/$kind-artifacts" --mode A --engagement-id "launcher-$kind-alias" \
    --trust-store "$WORK/alias-operator/model-trust.json" --runtime-key-id runtime-alias \
    --request-output "$WORK/alias-operator/$kind-request.json" \
    --launch-authorization "$WORK/alias-operator/$kind-authorization.json" --wait-seconds 30 >/dev/null 2>&1; then
    fail "launcher accepted an artifact tree containing a $kind alias"
  fi
done
[ "$(cat "$WORK/alias-target/sentinel.txt")" = alias-sentinel ] || fail 'artifact alias rejection changed target content'

# URL classification rejects malformed and unsupported schemes before launch.
for bad_target in 'https://[' 'ftp://example.test/qa'; do
  if PATH="$FIXTURE_BIN:$PATH" "$LAUNCHER" claude --target "$bad_target" \
    --artifact-root "$WORK/bad-url-artifacts" --mode A --engagement-id launcher-bad-url \
    --trust-store "$WORK/alias-operator/model-trust.json" --runtime-key-id runtime-alias \
    --request-output "$WORK/alias-operator/bad-url-request.json" \
    --launch-authorization "$WORK/alias-operator/bad-url-authorization.json" --wait-seconds 30 >/dev/null 2>&1; then
    fail "launcher accepted malformed or unsupported target: $bad_target"
  fi
done

# A request cannot bind a missing supervisor PID.
mkdir "$WORK/alias-operator/dead-supervisor-probe"
chmod 700 "$WORK/alias-operator/dead-supervisor-probe"
if "$CLI" launch request --target "$WORK/alias-target" --workspace "$WORK/alias-target" \
  --artifact-root "$WORK/symlink-artifacts" --mode A --engagement-id dead-supervisor \
  --launcher "$LAUNCHER" --launcher-pid 99999999 --claude-executable "$FIXTURE_BIN/claude" \
  --runtime-key-id runtime-alias --trust-store "$WORK/alias-operator/model-trust.json" \
  --output "$WORK/alias-operator/dead-supervisor-request.json" \
  --sandbox-probe-path "$WORK/alias-operator/dead-supervisor-probe" \
  --capability-sha256 "$(printf dead-supervisor | shasum -a 256 | awk '{print $1}')" >/dev/null 2>&1; then
  fail 'launch request accepted a missing supervisor process'
fi

# --unattested is a keyless downgrade for hosts with no operator key material. Every case
# runs with a fresh HOME and no inherited trust store so the host's own keys never leak in.
mkdir -p "$WORK/unattested-target" "$WORK/unattested-operator"
chmod 700 "$WORK/unattested-operator"
printf '{}\n' >"$WORK/unattested-operator/model-trust.json"
run_unattested_case() {
  local name="$1" home="$WORK/unattested-home-$1"
  shift
  mkdir -p "$home"
  env -u ARGUS_MODEL_TRUST_STORE HOME="$home" PATH="$FIXTURE_BIN:$PATH" "$@" \
    "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-$name" \
    --mode A --engagement-id "launcher-unattested-$name" --unattested --dry-run \
    >"$WORK/unattested-$name.stdout" 2>"$WORK/unattested-$name.stderr"
}
expect_unattested_refusal() {
  local name="$1" status="$2" message="$3"
  [ "$status" -ne 0 ] || fail "unattested $name downgrade was accepted"
  grep -Fq -- "$message" "$WORK/unattested-$name.stderr" || { cat "$WORK/unattested-$name.stderr" >&2; fail "unattested $name refusal did not report: $message"; }
  [ ! -e "$WORK/unattested-artifacts-$name" ] || fail "unattested $name refusal created the artifact root"
}

# (a) A keyless dry run reports the controller cap and the explicit UNATTESTED marker.
set +e
run_unattested_case dry-run
unattested_status=$?
set -e
[ "$unattested_status" -eq 0 ] || { cat "$WORK/unattested-dry-run.stderr" >&2; fail 'unattested dry run failed on a host without key material'; }
grep -Fq "maxTurns=$REVIEWED_CONTROLLER_TURNS" "$WORK/unattested-dry-run.stdout" || fail 'unattested dry run omitted the controller turn cap'
grep -Fq 'attestation=UNATTESTED' "$WORK/unattested-dry-run.stdout" || fail 'unattested dry run omitted the UNATTESTED marker'
grep -Fq 'sandbox=os-native-target-readonly@3 ' "$WORK/unattested-dry-run.stdout" || fail 'unattested dry run omitted sandbox policy @3'

# (b) Keyless mode cannot be mixed with attested launch options.
set +e
env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-combined" PATH="$FIXTURE_BIN:$PATH" \
  "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-combined" \
  --mode A --engagement-id launcher-unattested-combined --unattested --dry-run \
  --trust-store "$WORK/unattested-operator/model-trust.json" \
  >"$WORK/unattested-combined.stdout" 2>"$WORK/unattested-combined.stderr"
unattested_status=$?
set -e
expect_unattested_refusal combined "$unattested_status" '--unattested cannot be combined'

# (c) An inherited trust-store variable proves key material exists on this host.
set +e
run_unattested_case env-trust-store ARGUS_MODEL_TRUST_STORE="$WORK/unattested-operator/model-trust.json"
unattested_status=$?
set -e
expect_unattested_refusal env-trust-store "$unattested_status" 'ARGUS_MODEL_TRUST_STORE is set'

# (d) The default host trust store is the operator's kill switch for keyless launches.
mkdir -p "$WORK/unattested-home-host-trust-store/.config/argus"
printf '{}\n' >"$WORK/unattested-home-host-trust-store/.config/argus/model-trust.json"
set +e
run_unattested_case host-trust-store
unattested_status=$?
set -e
expect_unattested_refusal host-trust-store "$unattested_status" 'a host model trust store exists'

if "$LAUNCHER" codex >/dev/null 2>&1; then fail 'launcher accepted Codex without a native turn cap'; fi
if PATH="$FIXTURE_BIN:$PATH" "$LAUNCHER" claude --target "$WORK/path target" --artifact-root "$WORK/invalid-mode" \
  --mode Z --engagement-id invalid-mode --trust-store "$WORK/path-operator/model-trust.json" \
  --runtime-key-id runtime-path --request-output "$WORK/path-operator/invalid-request.json" \
  --launch-authorization "$WORK/path-operator/invalid-authorization.json" --wait-seconds 30 >/dev/null 2>&1; then
  fail 'launcher accepted an invalid mode'
fi

# probe-browser proves headless Chromium runs inside the @3 profile. A host without a
# resolvable Playwright module skips. A failure is fatal on Darwin, and on Linux (Chromium
# under bwrap is unverified) only with REQUIRE_BROWSER_PROBE=1, which also forbids a skip.
require_browser_probe=false
if [ "$(uname -s)" = Darwin ] || [ "${REQUIRE_BROWSER_PROBE:-0}" = 1 ]; then require_browser_probe=true; fi
set +e
"$LAUNCHER" probe-browser >"$WORK/probe-browser.stdout" 2>"$WORK/probe-browser.stderr"
probe_browser_status=$?
set -e
case "$probe_browser_status" in
  0)
    grep -Eq '^PASS  headless Chromium runs inside os-native-target-readonly@3 \(module=/.+ version=.+\)$' "$WORK/probe-browser.stdout" || \
      { cat "$WORK/probe-browser.stdout" >&2; fail 'probe-browser passed without its PASS line'; }
    probe_module="$(sed -n 's/^PASS .*(module=\(.*\) version=.*)$/\1/p' "$WORK/probe-browser.stdout")"
    "$LAUNCHER" probe-browser --module "$probe_module" >"$WORK/probe-browser-module.stdout" 2>"$WORK/probe-browser-module.stderr" || \
      { cat "$WORK/probe-browser-module.stderr" >&2; fail 'probe-browser rejected the module it resolved itself'; }
    ;;
  3)
    grep -Fxq 'SKIP  no Playwright module resolvable on this host' "$WORK/probe-browser.stdout" || fail 'probe-browser skipped without its SKIP line'
    [ "${REQUIRE_BROWSER_PROBE:-0}" != 1 ] || fail 'REQUIRE_BROWSER_PROBE=1 but no Playwright module is resolvable'
    printf 'SKIP  browser probe: no Playwright module resolvable on this host\n'
    ;;
  2)
    cat "$WORK/probe-browser.stderr" >&2
    ! $require_browser_probe || fail 'headless Chromium does not run inside os-native-target-readonly@3'
    printf 'WARN  headless Chromium failed under the unverified Linux bwrap policy; set REQUIRE_BROWSER_PROBE=1 to enforce\n'
    ;;
  *) cat "$WORK/probe-browser.stderr" >&2; fail "probe-browser returned unexpected status $probe_browser_status" ;;
esac

# An explicit module is validated before any browser starts.
mkdir -p "$WORK/not-playwright"
printf '{"name":"not-playwright","version":"1.0.0"}\n' >"$WORK/not-playwright/package.json"
: >"$WORK/not-playwright/index.mjs"
for bad_module in relative/playwright "$WORK/not-playwright" "$WORK/missing-playwright"; do
  set +e
  "$LAUNCHER" probe-browser --module "$bad_module" >/dev/null 2>&1
  bad_module_status=$?
  set -e
  [ "$bad_module_status" -eq 2 ] || fail "probe-browser accepted the invalid module $bad_module (status $bad_module_status)"
done
if "$LAUNCHER" probe-browser --unknown >/dev/null 2>&1; then fail 'probe-browser accepted an unknown option'; fi
if "$LAUNCHER" doctor --unknown >/dev/null 2>&1; then fail 'doctor accepted an unknown option'; fi

# doctor reruns the unchanged write-denial sandbox probes against the @3 profile.
"$LAUNCHER" doctor >/dev/null
if [ "$probe_browser_status" -ne 2 ]; then
  "$LAUNCHER" doctor --browser >"$WORK/doctor-browser.stdout" 2>"$WORK/doctor-browser.stderr" || \
    { cat "$WORK/doctor-browser.stderr" >&2; fail 'doctor --browser failed'; }
  if [ "$probe_browser_status" -eq 0 ]; then
    grep -Fq 'PASS  headless Chromium runs inside os-native-target-readonly@3' "$WORK/doctor-browser.stdout" || fail 'doctor --browser omitted the browser probe'
  else
    grep -Fq 'WARN  no Playwright module is resolvable' "$WORK/doctor-browser.stdout" || fail 'doctor --browser did not warn about the skipped browser probe'
  fi
fi
printf 'PASS  Authenticated native launcher: signed invocation, live sandbox, URL/path JSON, pre-write containment, alias denial, exact environment, turn-cap behavior and four-site consistency, signed-cap cross-check, authenticated dry run, sandbox policy @3 scope, headless Chromium probe, unattested downgrade guards, direct/replay rejection, and fail-closed Codex\n'
