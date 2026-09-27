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

# Usage: run_authenticated_launch <name> <target> <artifact-root> [<workspace>|''] [<launcher option>...]
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
  if [ "$#" -gt 4 ]; then
    shift 4
    command+=("$@")
  fi
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

# Operator-declared features ride unsigned in the launch payload and reach preflight verbatim.
# The launcher's cleared environment hides database coordinates, so without --feature a
# database lane stays conditional on db-access, which recon never releases; with it,
# preflight confirms the capability.
launch_payload_of() {
  tail -n 1 "$1/ai_agents_internal/fixture-claude-arguments.txt" | sed 's|^/argus:run authenticatedLaunch=||'
}
launch_payload_of "$WORK/path artifacts" | jq -e '.features == []' >/dev/null || \
  fail 'featureless launch payload did not carry an empty features array'
jq -e '(.capabilities[] | select(.id == "db-access") | .available == false)
  and (.agents[] | select(.slug == "charon") | .status == "conditional" and .pendingGates == ["db-access"] and (.missingCapabilities | index("db-access")) != null)' \
  "$WORK/path artifacts/ai_agents_internal/preflight.json" >/dev/null || \
  fail 'featureless Mode B launch detected db-access or released charon from its db-access gate'
mkdir -p "$WORK/feature-target" "$WORK/feature-artifacts"
run_authenticated_launch feature "$WORK/feature-target" "$WORK/feature-artifacts" '' --feature db-access
launch_payload_of "$WORK/feature-artifacts" | jq -e '.features == ["db-access"]' >/dev/null || \
  fail 'feature launch payload did not carry the declared db-access feature'
jq -e 'has("features") | not' "$WORK/feature-operator/request.json" >/dev/null || \
  fail 'operator-declared features leaked into the signed launch request'
jq -e '[.capabilities[] | select(.id == "db-access")] | length == 1
  and all(.available == true and .evidence == "target/profile feature confirmed: db-access")' \
  "$WORK/feature-artifacts/ai_agents_internal/preflight.json" >/dev/null || {
  jq '.capabilities' "$WORK/feature-artifacts/ai_agents_internal/preflight.json" >&2
  fail 'declared db-access feature was not confirmed by preflight'
}
# Charon becomes dispatchable (degraded only by optional host commands or authorization
# restrictions), while the default read-only authorization manifest still denies its
# database reads: a feature widens availability, never authorization.
jq -e '.agents[] | select(.slug == "charon") | (.status == "ready" or .status == "degraded") and .dispatchAllowed == true
  and (.missingCapabilities | index("db-access")) == null' \
  "$WORK/feature-artifacts/ai_agents_internal/preflight.json" >/dev/null || {
  jq '.agents[] | select(.slug == "charon")' "$WORK/feature-artifacts/ai_agents_internal/preflight.json" >&2
  fail 'declared db-access feature did not make charon dispatchable'
}
jq -e '[.agents[] | select(.slug == "charon") | .authorization[] | select(.action == "database-read") | .decision]
  | length >= 1 and all(. == "deny")' \
  "$WORK/feature-artifacts/ai_agents_internal/preflight.json" >/dev/null || \
  fail 'declared db-access feature widened the default read-only authorization for database reads'
launch_payload_of "$WORK/path artifacts" | jq -e '.operatorAuthorization == {source:"preflight",environment:null,sha256:null}' >/dev/null || \
  fail 'launch without operator authorization did not record the preflight default in its payload'

# An operator-supplied authorization manifest (--authorization) is bound to the engagement id
# and target, installed byte-for-byte with mode 0600 before the sandbox starts, and loaded by
# preflight instead of the default. It rides unsigned in the payload; the evaluator still
# decides every action, so the fixture's expired browser-state-change grant stays denied.
AUTHORIZATION_FIXTURE="$ROOT/scripts/fixtures/argus-launcher/authorization.valid.json"
OPERATOR_INPUT="$WORK/operator-authorization-input"
mkdir -p "$OPERATOR_INPUT"
chmod 700 "$OPERATOR_INPUT"
# Usage: bind_operator_manifest <name> <engagement-id> [<jq filter>]
bind_operator_manifest() {
  local path="$OPERATOR_INPUT/$1.json"
  jq --arg engagementId "$2" ".engagementId = \$engagementId | ${3:-.}" "$AUTHORIZATION_FIXTURE" >"$path"
  chmod 600 "$path"
  printf '%s\n' "$path"
}
assert_mode_0600() {
  [ -n "$(find "$1" -maxdepth 0 -type f -perm 600 -print)" ] || fail "$2 is not a mode 0600 regular file"
}
jq -e '.engagementId == "launcher-operator-authorization" and .target.environment == "test"' "$AUTHORIZATION_FIXTURE" >/dev/null || \
  fail 'operator authorization fixture changed its engagement id or environment'
operator_manifest="$(bind_operator_manifest operator launcher-operator-authorization)"
mkdir -p "$WORK/operator-authorization-target" "$WORK/operator-authorization-artifacts"
run_authenticated_launch operator-authorization "$WORK/operator-authorization-target" "$WORK/operator-authorization-artifacts" '' \
  --authorization "$operator_manifest"
installed_manifest="$WORK/operator-authorization-artifacts/ai_agents_internal/authorization.json"
cmp -s "$operator_manifest" "$installed_manifest" || fail 'launcher did not install the exact operator authorization manifest'
assert_mode_0600 "$installed_manifest" 'installed operator authorization manifest'
jq -e 'has("authorization") or has("operatorAuthorization") | not' "$WORK/operator-authorization-operator/request.json" >/dev/null || \
  fail 'operator authorization leaked into the signed launch request'
operator_manifest_sha256="$(launch_payload_of "$WORK/operator-authorization-artifacts" | \
  jq -er '.operatorAuthorization | select(.source == "operator" and .environment == "test") | .sha256')" || \
  fail 'operator authorization launch payload did not record the operator manifest'
jq -e --arg sha256 "$operator_manifest_sha256" --arg manifest "$installed_manifest" \
  '.authorization | .created == false and .sha256 == $sha256 and .manifestPath == $manifest
    and .environment == "test" and .productionLike == false' \
  "$WORK/operator-authorization-artifacts/ai_agents_internal/preflight.json" >/dev/null || {
  jq '.authorization' "$WORK/operator-authorization-artifacts/ai_agents_internal/preflight.json" >&2
  fail 'preflight did not load the installed operator authorization manifest'
}
jq -e '[.agents[].authorization[]? | select(.action == "browser-state-change")] | length >= 1
  and all(.decision == "deny" and .ruleId == "AUTH-AUTHORIZATION-EXPIRED")' \
  "$WORK/operator-authorization-artifacts/ai_agents_internal/preflight.json" >/dev/null || {
  jq '[.agents[] | {slug, authorization}]' "$WORK/operator-authorization-artifacts/ai_agents_internal/preflight.json" >&2
  fail 'an installed operator manifest widened an expired browser-state-change grant'
}

# --environment test alone installs the packaged default-deny manifest for that environment.
mkdir -p "$WORK/environment-target" "$WORK/environment-artifacts"
run_authenticated_launch environment "$WORK/environment-target" "$WORK/environment-artifacts" '' --environment test
environment_manifest="$WORK/environment-artifacts/ai_agents_internal/authorization.json"
assert_mode_0600 "$environment_manifest" 'installed environment authorization manifest'
jq -e --arg target "$WORK/environment-target" \
  '.engagementId == "launcher-environment" and .target == {identifiers:[$target],environment:"test",productionLike:null}
    and ([.actionGrants[].enabled] | all(. == false)) and .allowedMutations == []' \
  "$environment_manifest" >/dev/null || { cat "$environment_manifest" >&2; fail '--environment test did not install the default-deny test manifest'; }
environment_manifest_sha256="$(launch_payload_of "$WORK/environment-artifacts" | \
  jq -er '.operatorAuthorization | select(.source == "environment" and .environment == "test") | .sha256')" || \
  fail '--environment launch payload did not record the environment choice'
jq -e --arg sha256 "$environment_manifest_sha256" \
  '.authorization | .created == false and .sha256 == $sha256 and .environment == "test" and .defaultReadOnly == true' \
  "$WORK/environment-artifacts/ai_agents_internal/preflight.json" >/dev/null || {
  jq '.authorization' "$WORK/environment-artifacts/ai_agents_internal/preflight.json" >&2
  fail 'preflight did not load the launcher-initialized test manifest'
}

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
grep -Fq 'browserProvisioning=none' "$WORK/dry-run.stdout" || \
  { cat "$WORK/dry-run.stdout" >&2; fail 'authenticated dry run did not report browserProvisioning=none'; }
grep -Eq ' authorizationSource=preflight targetEnvironment=none features=none$' "$WORK/dry-run.stdout" || \
  { cat "$WORK/dry-run.stdout" >&2; fail 'authenticated dry run did not report the preflight authorization default and features=none'; }
[ ! -e "$WORK/dry-run-artifacts/ai_agents_internal/fixture-claude-arguments.txt" ] || fail 'authenticated dry run started the controller'

# --usage-json captures Claude's final JSON result document in a one-shot file outside the
# artifact root. It switches only Claude's output format: the turn cap, model, effort, child
# environment, and every signed binding stay exactly those of a text-mode launch. Both usage
# forms advertise it, because the discovery adapter feature-detects it from --help.
[ "$("$LAUNCHER" --help | grep -Fc -- '[--usage-json <absolute-path>]')" -eq 2 ] || \
  fail 'argus-launch --help does not list --usage-json in both launch forms'
assert_no_usage_temporaries() {
  [ -z "$(find "$1" -name '.argus-usage.*' -print -quit)" ] || fail "$2 left a usage report temporary file in $1"
}
mkdir -p "$WORK/usage-target" "$WORK/usage-artifacts"
usage_report="$WORK/usage-operator/usage.json"
run_authenticated_launch usage "$WORK/usage-target" "$WORK/usage-artifacts" '' --usage-json "$usage_report"
[ -f "$usage_report" ] || fail 'attested --usage-json launch did not write the usage report'
assert_mode_0600 "$usage_report" 'attested usage report'
assert_no_usage_temporaries "$WORK/usage-operator" 'attested --usage-json launch'
jq -e '.type == "result" and .subtype == "success" and .is_error == false and (.usage | type) == "object"
  and (.modelUsage | type) == "object" and .num_turns == 1 and .result == "ARGUS_FIXTURE_NATIVE_PREFLIGHT_OK"' \
  "$usage_report" >/dev/null || { cat "$usage_report" >&2; fail 'attested usage report is not the Claude JSON result document'; }
! grep -Fq '"type":"result"' "$WORK/usage.stdout" || fail 'attested --usage-json launch printed the JSON document instead of its result text'
usage_arguments="$WORK/usage-artifacts/ai_agents_internal/fixture-claude-arguments.txt"
[ "$(grep -Fx -A 1 -- '--output-format' "$usage_arguments" | tail -n 1)" = json ] || \
  { cat "$usage_arguments" >&2; fail 'attested --usage-json launch did not run Claude with --output-format json'; }
[ "$(grep -Fxc -- '--max-turns' "$usage_arguments")" -eq 1 ] && \
  [ "$(grep -Fx -A 1 -- '--max-turns' "$usage_arguments" | tail -n 1)" = "$REVIEWED_CONTROLLER_TURNS" ] || \
  fail "attested --usage-json launch did not keep exactly one --max-turns $REVIEWED_CONTROLLER_TURNS"
text_arguments="$WORK/path artifacts/ai_agents_internal/fixture-claude-arguments.txt"
! grep -Fxq -- '--output-format' "$text_arguments" || fail 'a launch without --usage-json changed the Claude output format'
# Apart from the prompt, which names launch-specific paths, the argv differs only by the pair.
[ "$(sed '$d' "$text_arguments")" = "$(sed '$d' "$usage_arguments" | awk 'skip { skip = 0; next } $0 == "--output-format" { skip = 1; next } { print }')" ] || \
  fail 'attested --usage-json launch changed a Claude argument other than the output format'
[ "$(jq -cS 'keys' "$WORK/path-operator/request.json")" = "$(jq -cS 'keys' "$WORK/usage-operator/request.json")" ] || \
  fail '--usage-json changed the fields of the signed launch request'

# An authenticated dry run validates the report path and reports it without writing anything.
mkdir -p "$WORK/usage-dry-run-target" "$WORK/usage-dry-run-artifacts"
prepare_signer "$WORK/usage-dry-run-operator" runtime-usage-dry-run
PATH="$FIXTURE_PATH:$PATH" "$LAUNCHER" claude --target "$WORK/usage-dry-run-target" \
  --artifact-root "$WORK/usage-dry-run-artifacts" --mode B --engagement-id launcher-usage-dry-run \
  --trust-store "$WORK/usage-dry-run-operator/model-trust.json" --runtime-key-id runtime-usage-dry-run \
  --request-output "$WORK/usage-dry-run-operator/request.json" --launch-authorization "$WORK/usage-dry-run-operator/authorization.json" \
  --usage-json "$WORK/usage-dry-run-operator/usage.json" --wait-seconds 30 --dry-run \
  >"$WORK/usage-dry-run.stdout" 2>"$WORK/usage-dry-run.stderr" &
usage_dry_run_pid=$!
wait_for_file "$WORK/usage-dry-run-operator/request.json" || { cat "$WORK/usage-dry-run.stderr" >&2; fail 'authenticated usage dry-run request was not created'; }
sign_request "$WORK/usage-dry-run-operator" "$WORK/usage-dry-run-operator/request.json" "$WORK/usage-dry-run-operator/authorization.json"
if ! wait "$usage_dry_run_pid"; then cat "$WORK/usage-dry-run.stderr" >&2; fail 'authenticated usage dry run failed'; fi
grep -Eq "^ARGUS_LAUNCH .*maxTurns=$REVIEWED_CONTROLLER_TURNS .* features=none usageReport=json$" "$WORK/usage-dry-run.stdout" || \
  { cat "$WORK/usage-dry-run.stdout" >&2; fail 'authenticated dry run did not report usageReport=json'; }
[ ! -e "$WORK/usage-dry-run-operator/usage.json" ] || fail 'authenticated dry run wrote the usage report'
assert_no_usage_temporaries "$WORK/usage-dry-run-operator" 'authenticated usage dry run'
[ ! -e "$WORK/usage-dry-run-artifacts/ai_agents_internal/fixture-claude-arguments.txt" ] || fail 'authenticated usage dry run started the controller'

# The report may not reuse an operator handshake path; the refusal precedes the request.
prepare_signer "$WORK/usage-collision-operator" runtime-usage-collision
for collision in request authorization; do
  set +e
  PATH="$FIXTURE_PATH:$PATH" "$LAUNCHER" claude --target "$WORK/usage-target" \
    --artifact-root "$WORK/usage-collision-artifacts" --mode B --engagement-id launcher-usage-collision \
    --trust-store "$WORK/usage-collision-operator/model-trust.json" --runtime-key-id runtime-usage-collision \
    --request-output "$WORK/usage-collision-operator/request.json" --launch-authorization "$WORK/usage-collision-operator/authorization.json" \
    --usage-json "$WORK/usage-collision-operator/$collision.json" --wait-seconds 30 \
    >/dev/null 2>"$WORK/usage-collision-$collision.stderr"
  usage_status=$?
  set -e
  [ "$usage_status" -ne 0 ] || fail "launcher accepted a usage report at the $collision path"
  grep -Fq 'usage report must differ from the request and authorization paths' "$WORK/usage-collision-$collision.stderr" || \
    { cat "$WORK/usage-collision-$collision.stderr" >&2; fail "usage report at the $collision path was not refused as a collision"; }
  [ ! -e "$WORK/usage-collision-operator/request.json" ] || fail "usage report collision with the $collision path still wrote a launch request"
  [ ! -e "$WORK/usage-collision-artifacts" ] || fail "usage report collision with the $collision path created the artifact root"
done

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
grep -Fq 'browserProvisioning=none' "$WORK/unattested-dry-run.stdout" || fail 'unattested dry run did not report browserProvisioning=none'
grep -Eq ' features=none$' "$WORK/unattested-dry-run.stdout" || fail 'unattested dry run did not report features=none'

# (a2) --provision-browser is host preparation outside the signed request: a dry run only
# reports it and never provisions anything into the (private) host cache.
mkdir -p "$WORK/unattested-home-provision"
set +e
env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-provision" PATH="$FIXTURE_BIN:$PATH" \
  "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-provision" \
  --mode A --engagement-id launcher-unattested-provision --unattested --provision-browser --dry-run \
  >"$WORK/unattested-provision.stdout" 2>"$WORK/unattested-provision.stderr"
unattested_status=$?
set -e
[ "$unattested_status" -eq 0 ] || { cat "$WORK/unattested-provision.stderr" >&2; fail 'unattested --provision-browser dry run failed'; }
grep -Fq 'browserProvisioning=requested' "$WORK/unattested-provision.stdout" || \
  { cat "$WORK/unattested-provision.stdout" >&2; fail 'dry run with --provision-browser did not report browserProvisioning=requested'; }
[ ! -e "$WORK/unattested-home-provision/.cache/argus/browser-runtime" ] || fail 'dry run with --provision-browser provisioned a browser runtime'

# (a3) --feature is repeatable: ids are validated against the packaged capability matrix,
# deduplicated, and sorted before the dry run reports them.
mkdir -p "$WORK/unattested-home-features"
set +e
env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-features" PATH="$FIXTURE_BIN:$PATH" \
  "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-features" \
  --mode A --engagement-id launcher-unattested-features --unattested --dry-run \
  --feature non-rest-surface --feature db-access --feature db-access \
  >"$WORK/unattested-features.stdout" 2>"$WORK/unattested-features.stderr"
unattested_status=$?
set -e
[ "$unattested_status" -eq 0 ] || { cat "$WORK/unattested-features.stderr" >&2; fail 'unattested dry run with --feature failed'; }
grep -Eq ' features=db-access,non-rest-surface$' "$WORK/unattested-features.stdout" || \
  { cat "$WORK/unattested-features.stdout" >&2; fail 'dry run did not report the sorted, deduplicated features=db-access,non-rest-surface'; }

# (a4) An unknown or malformed feature id stops the launch before the artifact root exists.
for bad_feature in bogus DB-ACCESS 'db-access,source-access' '-db-access' ''; do
  set +e
  env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-features" PATH="$FIXTURE_BIN:$PATH" \
    "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-bad-feature" \
    --mode A --engagement-id launcher-unattested-bad-feature --unattested --dry-run --feature "$bad_feature" \
    >"$WORK/unattested-bad-feature.stdout" 2>"$WORK/unattested-bad-feature.stderr"
  unattested_status=$?
  set -e
  [ "$unattested_status" -ne 0 ] || fail "launcher accepted the capability feature '$bad_feature'"
  grep -Fq "unknown capability feature: $bad_feature" "$WORK/unattested-bad-feature.stderr" || \
    { cat "$WORK/unattested-bad-feature.stderr" >&2; fail "feature '$bad_feature' refusal did not report an unknown capability feature"; }
  [ ! -e "$WORK/unattested-artifacts-bad-feature" ] || fail "feature '$bad_feature' refusal created the artifact root"
done
# Browser and MCP capabilities are proven only by preflight's own probes, so a declaration
# can never release browser lanes whose runtime failed its probe.
for probed_feature in browser-runtime playwright-mcp context7; do
  set +e
  env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-features" PATH="$FIXTURE_BIN:$PATH" \
    "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-bad-feature" \
    --mode A --engagement-id launcher-unattested-bad-feature --unattested --dry-run --feature db-access --feature "$probed_feature" \
    >"$WORK/unattested-bad-feature.stdout" 2>"$WORK/unattested-bad-feature.stderr"
  unattested_status=$?
  set -e
  [ "$unattested_status" -ne 0 ] || fail "launcher accepted the probe-only capability feature '$probed_feature'"
  grep -Fq "capability feature $probed_feature is not operator-declarable" "$WORK/unattested-bad-feature.stderr" || \
    { cat "$WORK/unattested-bad-feature.stderr" >&2; fail "probe-only feature '$probed_feature' was not refused as not operator-declarable"; }
  [ ! -e "$WORK/unattested-artifacts-bad-feature" ] || fail "feature '$probed_feature' refusal created the artifact root"
done
set +e
env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-features" PATH="$FIXTURE_BIN:$PATH" \
  "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-bad-feature" \
  --mode A --engagement-id launcher-unattested-bad-feature --unattested --dry-run --feature \
  >/dev/null 2>"$WORK/unattested-bad-feature.stderr"
unattested_status=$?
set -e
[ "$unattested_status" -ne 0 ] || fail 'launcher accepted --feature without a capability id'
grep -Fq -- '--feature requires a capability id' "$WORK/unattested-bad-feature.stderr" || \
  { cat "$WORK/unattested-bad-feature.stderr" >&2; fail '--feature without a capability id was not refused as such'; }

# (a5) A real unattested launch appends the features to its prompt only when some are declared.
for feature_case in none declared; do
  feature_options=()
  [ "$feature_case" = none ] || feature_options=(--feature source-access --feature db-access)
  mkdir -p "$WORK/unattested-home-launch-$feature_case"
  set +e
  env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-launch-$feature_case" PATH="$FIXTURE_PATH:$PATH" \
    "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-launch-$feature_case" \
    --mode A --engagement-id "launcher-unattested-launch-$feature_case" --unattested \
    ${feature_options[@]+"${feature_options[@]}"} \
    >"$WORK/unattested-launch-$feature_case.stdout" 2>"$WORK/unattested-launch-$feature_case.stderr"
  unattested_status=$?
  set -e
  [ "$unattested_status" -eq 0 ] || { cat "$WORK/unattested-launch-$feature_case.stderr" >&2; fail "unattested $feature_case-feature launch failed"; }
  grep -Fxq 'ARGUS_FIXTURE_UNATTESTED_PROMPT_OK' "$WORK/unattested-launch-$feature_case.stdout" || \
    fail "unattested $feature_case-feature launch did not reach the sandboxed controller"
  unattested_prompt="$(tail -n 1 "$WORK/unattested-artifacts-launch-$feature_case/ai_agents_internal/fixture-claude-arguments.txt")"
  case "$feature_case:$unattested_prompt" in
    'none:/argus:run '*' unattestedLaunch=true engagementId=launcher-unattested-launch-none') ;;
    'declared:/argus:run '*' unattestedLaunch=true engagementId=launcher-unattested-launch-declared features=db-access,source-access') ;;
    *) fail "unattested $feature_case-feature launch prompt has unexpected features: $unattested_prompt" ;;
  esac
done

# (a6) Operator authorization flags. A dry run verifies the binding and reports both choices
# without installing anything; every refusal happens before the artifact root exists.
# Usage: run_authorization_case <name> <engagement-id> [<launcher option>...]
run_authorization_case() {
  local name="$1" engagement="$2"
  shift 2
  mkdir -p "$WORK/unattested-home-authorization"
  env -u ARGUS_MODEL_TRUST_STORE HOME="$WORK/unattested-home-authorization" PATH="$FIXTURE_PATH:$PATH" \
    "$LAUNCHER" claude --target "$WORK/unattested-target" --artifact-root "$WORK/unattested-artifacts-authorization-$name" \
    --mode A --engagement-id "$engagement" --unattested "$@" \
    >"$WORK/unattested-authorization-$name.stdout" 2>"$WORK/unattested-authorization-$name.stderr"
}
expect_authorization_refusal() {
  local name="$1" status="$2" message="$3"
  [ "$status" -ne 0 ] || fail "launcher accepted the $name operator authorization"
  grep -Fq -- "$message" "$WORK/unattested-authorization-$name.stderr" || \
    { cat "$WORK/unattested-authorization-$name.stderr" >&2; fail "$name operator authorization refusal did not report: $message"; }
  [ ! -e "$WORK/unattested-artifacts-authorization-$name" ] || fail "$name operator authorization refusal created the artifact root"
}
unattested_manifest="$(bind_operator_manifest unattested launcher-unattested-authorization)"

set +e
run_authorization_case dry-run launcher-unattested-authorization --authorization "$unattested_manifest" --environment test --dry-run
authorization_status=$?
set -e
[ "$authorization_status" -eq 0 ] || { cat "$WORK/unattested-authorization-dry-run.stderr" >&2; fail 'operator authorization dry run failed'; }
grep -Eq ' authorizationSource=operator targetEnvironment=test features=none$' "$WORK/unattested-authorization-dry-run.stdout" || \
  { cat "$WORK/unattested-authorization-dry-run.stdout" >&2; fail 'dry run did not report authorizationSource=operator targetEnvironment=test'; }
grep -Fq 'AUTHORIZATION  verified source=operator environment=test sha256=' "$WORK/unattested-authorization-dry-run.stderr" || \
  { cat "$WORK/unattested-authorization-dry-run.stderr" >&2; fail 'dry run did not verify the operator authorization manifest'; }
[ ! -e "$WORK/unattested-artifacts-authorization-dry-run/ai_agents_internal/authorization.json" ] || \
  fail 'dry run installed the operator authorization manifest'

# local is the manifest environment development.
set +e
run_authorization_case local launcher-unattested-authorization --environment local --dry-run
authorization_status=$?
set -e
[ "$authorization_status" -eq 0 ] || { cat "$WORK/unattested-authorization-local.stderr" >&2; fail '--environment local dry run failed'; }
grep -Eq ' authorizationSource=environment targetEnvironment=development features=none$' "$WORK/unattested-authorization-local.stdout" || \
  { cat "$WORK/unattested-authorization-local.stdout" >&2; fail '--environment local did not map to the development manifest environment'; }

# A real unattested launch installs the manifest and names the choice in its prompt; the same
# manifest may be relaunched into the same artifact root.
for attempt in first repeat; do
  set +e
  run_authorization_case launch launcher-unattested-authorization --authorization "$unattested_manifest"
  authorization_status=$?
  set -e
  [ "$authorization_status" -eq 0 ] || { cat "$WORK/unattested-authorization-launch.stderr" >&2; fail "unattested operator authorization $attempt launch failed"; }
done
grep -Fq 'AUTHORIZATION  unchanged source=operator environment=test' "$WORK/unattested-authorization-launch.stderr" || \
  { cat "$WORK/unattested-authorization-launch.stderr" >&2; fail 'relaunch with the same operator manifest did not keep the installed copy'; }
unattested_installed="$WORK/unattested-artifacts-authorization-launch/ai_agents_internal/authorization.json"
cmp -s "$unattested_manifest" "$unattested_installed" || fail 'unattested launch did not install the exact operator authorization manifest'
assert_mode_0600 "$unattested_installed" 'unattested installed operator authorization manifest'
unattested_prompt="$(tail -n 1 "$WORK/unattested-artifacts-authorization-launch/ai_agents_internal/fixture-claude-arguments.txt")"
[[ "$unattested_prompt" =~ \ engagementId=launcher-unattested-authorization\ authorizationSource=operator\ targetEnvironment=test\ authorizationSha256=[0-9a-f]{64}$ ]] || \
  fail "unattested operator authorization prompt has unexpected authorization data: $unattested_prompt"

# A symbolic link is refused, even to a valid manifest.
ln -s "$unattested_manifest" "$OPERATOR_INPUT/symlink.json"
set +e
run_authorization_case symlink launcher-unattested-authorization --authorization "$OPERATOR_INPUT/symlink.json" --dry-run
authorization_status=$?
set -e
expect_authorization_refusal symlink "$authorization_status" 'authorization manifest may not be a symbolic link'

# The manifest must carry this engagement id and cover this target.
set +e
run_authorization_case engagement-mismatch launcher-unattested-other --authorization "$unattested_manifest" --dry-run
authorization_status=$?
set -e
expect_authorization_refusal engagement-mismatch "$authorization_status" 'engagementId differs from the launch engagement id'
foreign_manifest="$(bind_operator_manifest foreign launcher-unattested-authorization '.target.identifiers = ["https://other.example.test/"]')"
set +e
run_authorization_case target-mismatch launcher-unattested-authorization --authorization "$foreign_manifest" --dry-run
authorization_status=$?
set -e
expect_authorization_refusal target-mismatch "$authorization_status" 'AUTH-TARGET-MISMATCH'

# Schema violations, a conflicting --environment, and an unknown environment are refused.
unknown_field_manifest="$(bind_operator_manifest unknown-field launcher-unattested-authorization '.actionGrants.load.productionOverrides = true')"
set +e
run_authorization_case schema launcher-unattested-authorization --authorization "$unknown_field_manifest" --dry-run
authorization_status=$?
set -e
expect_authorization_refusal schema "$authorization_status" 'must NOT have additional property productionOverrides'
set +e
run_authorization_case environment-conflict launcher-unattested-authorization --authorization "$unattested_manifest" --environment production --dry-run
authorization_status=$?
set -e
expect_authorization_refusal environment-conflict "$authorization_status" 'target.environment test differs from the requested environment production'
set +e
run_authorization_case bad-environment launcher-unattested-authorization --environment development --dry-run
authorization_status=$?
set -e
expect_authorization_refusal bad-environment "$authorization_status" '--environment must be local, test, staging, or production'

# A manifest inside the artifact root is refused: sandboxed agents can write there.
mkdir -p "$WORK/unattested-artifacts-authorization-inside"
cp "$unattested_manifest" "$WORK/unattested-artifacts-authorization-inside/operator.json"
set +e
run_authorization_case inside launcher-unattested-authorization \
  --authorization "$WORK/unattested-artifacts-authorization-inside/operator.json" --dry-run
authorization_status=$?
set -e
[ "$authorization_status" -ne 0 ] || fail 'launcher accepted an operator authorization manifest inside the artifact root'
grep -Fq 'artifact root and authorization manifest must be physically disjoint' "$WORK/unattested-authorization-inside.stderr" || \
  { cat "$WORK/unattested-authorization-inside.stderr" >&2; fail 'manifest inside the artifact root was not refused as such'; }

# A different manifest already in the artifact root is never replaced, for either flag.
mkdir -p "$WORK/unattested-artifacts-authorization-existing/ai_agents_internal"
chmod 700 "$WORK/unattested-artifacts-authorization-existing" "$WORK/unattested-artifacts-authorization-existing/ai_agents_internal"
existing_manifest="$WORK/unattested-artifacts-authorization-existing/ai_agents_internal/authorization.json"
bind_operator_manifest existing-seed launcher-unattested-authorization '.rateLimits.maxTotalRequests = 10' >/dev/null
cp "$OPERATOR_INPUT/existing-seed.json" "$existing_manifest"
chmod 600 "$existing_manifest"
for existing_case in manifest environment; do
  existing_options=(--authorization "$unattested_manifest")
  [ "$existing_case" = manifest ] || existing_options=(--environment test)
  set +e
  run_authorization_case existing launcher-unattested-authorization "${existing_options[@]}"
  authorization_status=$?
  set -e
  [ "$authorization_status" -ne 0 ] || fail "launcher replaced an existing different authorization manifest (--$existing_case)"
  grep -Fq 'a different authorization manifest already exists' "$WORK/unattested-authorization-existing.stderr" || \
    { cat "$WORK/unattested-authorization-existing.stderr" >&2; fail "existing different manifest refusal (--$existing_case) did not report the conflict"; }
  cmp -s "$OPERATOR_INPUT/existing-seed.json" "$existing_manifest" || fail "existing authorization manifest changed on refusal (--$existing_case)"
  [ ! -e "$WORK/unattested-artifacts-authorization-existing/ai_agents_internal/fixture-claude-arguments.txt" ] || \
    fail "existing different manifest refusal (--$existing_case) still started the controller"
done

# (a7) --usage-json on keyless launches. Every case runs with a fresh HOME that holds no trust
# store and with every other known Argus variable forged, so the child environment proves the
# unattested allowlist. Usage: run_usage_case <name> <engagement-id> [<launcher option>...]
mkdir -p "$WORK/usage-unattested-target" "$WORK/usage-reports" "$WORK/usage-home"
chmod 700 "$WORK/usage-reports"
usage_seeded_environment=()
for environment_name in "${known_argus_environment[@]}"; do
  [ "$environment_name" = ARGUS_MODEL_TRUST_STORE ] || usage_seeded_environment+=("$environment_name=forged-$environment_name")
done
run_usage_case() {
  local name="$1" engagement="$2"
  shift 2
  env -u ARGUS_MODEL_TRUST_STORE "${usage_seeded_environment[@]}" HOME="$WORK/usage-home" PATH="$FIXTURE_PATH:$PATH" \
    "$LAUNCHER" claude --target "$WORK/usage-unattested-target" --artifact-root "$WORK/usage-artifacts-$name" \
    --mode A --engagement-id "$engagement" --unattested "$@" \
    >"$WORK/usage-unattested-$name.stdout" 2>"$WORK/usage-unattested-$name.stderr"
}

# A dry run validates the path and appends usageReport=json; nothing is written.
set +e
run_usage_case dry-run launcher-usage-dry-run --usage-json "$WORK/usage-reports/dry-run.json" --dry-run
usage_status=$?
set -e
[ "$usage_status" -eq 0 ] || { cat "$WORK/usage-unattested-dry-run.stderr" >&2; fail 'unattested --usage-json dry run failed'; }
grep -Eq "^ARGUS_LAUNCH .*maxTurns=$REVIEWED_CONTROLLER_TURNS .*attestation=UNATTESTED .* features=none usageReport=json$" \
  "$WORK/usage-unattested-dry-run.stdout" || { cat "$WORK/usage-unattested-dry-run.stdout" >&2; fail 'unattested dry run did not report usageReport=json'; }
[ ! -e "$WORK/usage-reports/dry-run.json" ] || fail 'unattested dry run wrote the usage report'

# A real keyless launch writes the report, prints only the result text, and gives the child
# ARGUS_LAUNCH_UNATTESTED=1 as its only Argus variable.
set +e
run_usage_case launch launcher-usage-launch --usage-json "$WORK/usage-reports/launch.json"
usage_status=$?
set -e
[ "$usage_status" -eq 0 ] || { cat "$WORK/usage-unattested-launch.stderr" >&2; fail 'unattested --usage-json launch failed'; }
[ "$(cat "$WORK/usage-unattested-launch.stdout")" = ARGUS_FIXTURE_UNATTESTED_PROMPT_OK ] || \
  { cat "$WORK/usage-unattested-launch.stdout" >&2; fail 'unattested --usage-json launch did not print exactly the result text'; }
assert_mode_0600 "$WORK/usage-reports/launch.json" 'unattested usage report'
jq -e '.type == "result" and .subtype == "success" and (.usage | type) == "object"
  and .modelUsage["claude-opus-fixture"].inputTokens == 10 and .result == "ARGUS_FIXTURE_UNATTESTED_PROMPT_OK"' \
  "$WORK/usage-reports/launch.json" >/dev/null || { cat "$WORK/usage-reports/launch.json" >&2; fail 'unattested usage report is not the Claude JSON result document'; }
usage_env_file="$WORK/usage-artifacts-launch/ai_agents_internal/fixture-child-environment.txt"
[ "$(grep -c '^ARGUS_' "$usage_env_file")" -eq 1 ] && grep -Fxq 'ARGUS_LAUNCH_UNATTESTED=1' "$usage_env_file" || \
  { grep '^ARGUS_' "$usage_env_file" >&2; fail 'unattested child received an Argus variable other than ARGUS_LAUNCH_UNATTESTED=1'; }
usage_arguments="$WORK/usage-artifacts-launch/ai_agents_internal/fixture-claude-arguments.txt"
[ "$(grep -Fx -A 1 -- '--output-format' "$usage_arguments" | tail -n 1)" = json ] && \
  [ "$(grep -Fx -A 1 -- '--max-turns' "$usage_arguments" | tail -n 1)" = "$REVIEWED_CONTROLLER_TURNS" ] || \
  { cat "$usage_arguments" >&2; fail "unattested --usage-json launch did not run Claude with --output-format json and --max-turns $REVIEWED_CONTROLLER_TURNS"; }

# A controller stopped at its native turn cap still leaves its report, and the launcher exits
# with Claude's own status.
set +e
run_usage_case max-turns launcher-usage-fixture-error-max-turns --usage-json "$WORK/usage-reports/max-turns.json"
usage_status=$?
set -e
[ "$usage_status" -eq 1 ] || { cat "$WORK/usage-unattested-max-turns.stderr" >&2; fail "turn-capped launch exited $usage_status instead of Claude's status 1"; }
jq -e --argjson turns "$REVIEWED_CONTROLLER_TURNS" \
  '.type == "result" and .subtype == "error_max_turns" and .is_error == true and .num_turns == $turns and (has("result") | not)' \
  "$WORK/usage-reports/max-turns.json" >/dev/null || { cat "$WORK/usage-reports/max-turns.json" >&2; fail 'turn-capped launch did not keep its error_max_turns usage report'; }
[ ! -s "$WORK/usage-unattested-max-turns.stdout" ] || fail 'turn-capped launch printed result text it does not have'
assert_no_usage_temporaries "$WORK/usage-reports" 'unattested --usage-json launches'

# Every unsafe report path is refused before the artifact root exists. The root case, a report
# path equal to the artifact root, would otherwise turn the report path into that directory.
mkdir -p "$WORK/usage-shared"
chmod 777 "$WORK/usage-shared"
ln -s "$WORK/usage-reports" "$WORK/usage-reports-alias"
ln -s "$WORK/usage-reports/missing.json" "$WORK/usage-reports/dangling.json"
printf 'previous report\n' >"$WORK/usage-reports/existing.json"
while IFS='|' read -r usage_case usage_path usage_message; do
  set +e
  run_usage_case "$usage_case" launcher-usage-refused --usage-json "$usage_path" --dry-run </dev/null
  usage_status=$?
  set -e
  [ "$usage_status" -ne 0 ] || fail "launcher accepted the $usage_case usage report path"
  grep -Fq -- "$usage_message" "$WORK/usage-unattested-$usage_case.stderr" || \
    { cat "$WORK/usage-unattested-$usage_case.stderr" >&2; fail "$usage_case usage report refusal did not report: $usage_message"; }
  [ ! -e "$WORK/usage-artifacts-$usage_case" ] || fail "$usage_case usage report refusal created the artifact root"
done <<EOF
existing|$WORK/usage-reports/existing.json|usage report already exists; usage reports are one-shot
dangling|$WORK/usage-reports/dangling.json|usage report already exists; usage reports are one-shot
relative|usage.json|usage report must be an absolute path
missing-parent|$WORK/usage-missing/usage.json|usage report directory must be an existing directory
alias-parent|$WORK/usage-reports-alias/usage.json|usage report directory may not be a symbolic link
shared-parent|$WORK/usage-shared/usage.json|usage report directory must not be group/world writable
target|$WORK/usage-unattested-target/usage.json|target and usage report must be physically disjoint
root|$WORK/usage-artifacts-root|artifact root and usage report must be physically disjoint
EOF
[ "$(cat "$WORK/usage-reports/existing.json")" = 'previous report' ] || fail 'a refused launch replaced an existing usage report'
[ ! -e "$WORK/usage-unattested-target/usage.json" ] || fail 'a refused launch wrote a usage report into the target'
# The report may not live inside an existing artifact root either.
mkdir -p "$WORK/usage-artifacts-inside"
chmod 700 "$WORK/usage-artifacts-inside"
set +e
run_usage_case inside launcher-usage-inside --usage-json "$WORK/usage-artifacts-inside/usage.json"
usage_status=$?
set -e
[ "$usage_status" -ne 0 ] || fail 'launcher accepted a usage report inside the artifact root'
grep -Fq 'artifact root and usage report must be physically disjoint' "$WORK/usage-unattested-inside.stderr" || \
  { cat "$WORK/usage-unattested-inside.stderr" >&2; fail 'usage report inside the artifact root was not refused as such'; }
[ ! -e "$WORK/usage-artifacts-inside/usage.json" ] && [ ! -e "$WORK/usage-artifacts-inside/ai_agents_internal" ] || \
  fail 'usage report refusal inside the artifact root still prepared or started the launch'
set +e
run_usage_case no-path launcher-usage-no-path --usage-json
usage_status=$?
set -e
[ "$usage_status" -ne 0 ] && grep -Fq -- '--usage-json requires a path' "$WORK/usage-unattested-no-path.stderr" || \
  fail '--usage-json without a path was not refused as such'

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

# probe-browser follows preflight's host order: the runtimes --provision-browser installs come
# before every global module, newest x.y.z release first (numerically, so 1.10.0 beats 1.2.0).
# A non-release entry and an entry that is not a Playwright package are skipped. The recording
# stand-in writes a real PNG, so the probe passes without a browser.
PROVISIONED_HOME="$WORK/probe-provisioned-home"
PROVISIONED_ROOT="$PROVISIONED_HOME/.cache/argus/browser-runtime"
for provisioned_version in 1.2.0 1.10.0 9.0.0 latest; do
  mkdir -p "$PROVISIONED_ROOT/$provisioned_version/node_modules"
  cp -R "$ROOT/scripts/fixtures/argus-browser/fake-playwright-recording" "$PROVISIONED_ROOT/$provisioned_version/node_modules/playwright"
  jq --arg version "$provisioned_version" '.version = $version' "$ROOT/scripts/fixtures/argus-browser/fake-playwright-recording/package.json" \
    >"$PROVISIONED_ROOT/$provisioned_version/node_modules/playwright/package.json"
done
jq '.name = "not-playwright"' "$ROOT/scripts/fixtures/argus-browser/fake-playwright-recording/package.json" \
  >"$PROVISIONED_ROOT/9.0.0/node_modules/playwright/package.json"
# The real node binary leads PATH: a version-manager shim would need state under the real HOME.
NODE_BIN_DIR="$(dirname "$(node -p process.execPath)")"
set +e
HOME="$PROVISIONED_HOME" PATH="$NODE_BIN_DIR:$PATH" "$LAUNCHER" probe-browser >"$WORK/probe-provisioned.stdout" 2>"$WORK/probe-provisioned.stderr"
probe_provisioned_status=$?
set -e
[ "$probe_provisioned_status" -eq 0 ] || \
  { cat "$WORK/probe-provisioned.stdout" "$WORK/probe-provisioned.stderr" >&2; fail "probe-browser did not pass with a host-provisioned runtime (status $probe_provisioned_status)"; }
grep -Fxq "PASS  headless Chromium runs inside os-native-target-readonly@3 (module=$PROVISIONED_ROOT/1.10.0/node_modules/playwright version=1.10.0)" \
  "$WORK/probe-provisioned.stdout" || { cat "$WORK/probe-provisioned.stdout" >&2; fail 'probe-browser did not prove the newest host-provisioned runtime first'; }

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
printf 'PASS  Authenticated native launcher: signed invocation, live sandbox, URL/path JSON, pre-write containment, alias denial, exact environment, turn-cap behavior and four-site consistency, signed-cap cross-check, authenticated dry run, browser-provisioning dry run, unsigned operator feature passthrough to preflight, operator authorization manifest and environment binding/installation, one-shot --usage-json Claude result capture and path containment, sandbox policy @3 scope, headless Chromium probe, unattested downgrade guards, direct/replay rejection, and fail-closed Codex\n'
