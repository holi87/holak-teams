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
    '.target == $target and .artifactRoot == $artifact and .maxTurns == 96 and .sandboxPolicy == "os-native-target-readonly@2" and .environmentPolicy == "argus-launch-allowlist@1"' \
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
  grep -Fxq '96' "$artifact/ai_agents_internal/fixture-claude-arguments.txt" || fail "$name Claude argv omitted the exact 96-turn cap"
  jq -e '.requestedTurns == 97 and .completedTurns == 96 and .outcome == "error_max_turns" and .supervisorObserved == true' \
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

if "$LAUNCHER" codex >/dev/null 2>&1; then fail 'launcher accepted Codex without a native turn cap'; fi
if PATH="$FIXTURE_BIN:$PATH" "$LAUNCHER" claude --target "$WORK/path target" --artifact-root "$WORK/invalid-mode" \
  --mode Z --engagement-id invalid-mode --trust-store "$WORK/path-operator/model-trust.json" \
  --runtime-key-id runtime-path --request-output "$WORK/path-operator/invalid-request.json" \
  --launch-authorization "$WORK/path-operator/invalid-authorization.json" --wait-seconds 30 >/dev/null 2>&1; then
  fail 'launcher accepted an invalid mode'
fi

"$LAUNCHER" doctor >/dev/null
printf 'PASS  Authenticated native launcher: signed invocation, live sandbox, URL/path JSON, pre-write containment, alias denial, exact environment, turn-cap behavior, direct/replay rejection, and fail-closed Codex\n'
