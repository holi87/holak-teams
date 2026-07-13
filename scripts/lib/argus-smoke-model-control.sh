#!/usr/bin/env bash

# Shared test-only setup for the production model-control sequence. Callers keep
# the host root outside the engagement artifact root and own its cleanup.

argus_smoke_prepare_model_control() {
  local cli="$1"
  local manifest="$2"
  local target="$3"
  local artifact_root="$4"
  local mode="$5"
  local profile="$6"
  local host_root="$7"
  local runtime="${8:-claude}"
  local control_id control_root runtime_private runtime_public operator_private operator_public trust_store runtime_key_id operator_key_id lane result relative_path preflight_output preflight_cli repo_root preflight_real_cli preflight_launcher preflight_claude

  if [ "$runtime" != claude ]; then
    printf 'FAIL  shared model-control helper supports Claude only; Codex JIT is covered by smoke-argus-model-policy.sh\n' >&2
    return 1
  fi

  control_id="$(node -e 'const fs=require("fs"),c=require("crypto"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(c.createHash("sha256").update(p+"\0"+d.engagementId).digest("hex").slice(0,24));' "$manifest")"
  control_root="$host_root/$control_id"
  mkdir -p "$control_root/decisions"
  chmod 700 "$host_root" "$control_root" "$control_root/decisions"

  if ! jq -e '.modelTrust != null' "$manifest" >/dev/null; then
    runtime_private="$control_root/runtime-signing-private.pem"
    runtime_public="$control_root/runtime-signing-public.pem"
    operator_private="$control_root/operator-signing-private.pem"
    operator_public="$control_root/operator-signing-public.pem"
    trust_store="$control_root/model-trust.json"
    runtime_key_id="runtime-$control_id"
    operator_key_id="operator-$control_id"
    openssl genpkey -algorithm ED25519 -out "$runtime_private" >/dev/null 2>&1
    openssl pkey -in "$runtime_private" -pubout -out "$runtime_public" >/dev/null 2>&1
    openssl genpkey -algorithm ED25519 -out "$operator_private" >/dev/null 2>&1
    openssl pkey -in "$operator_private" -pubout -out "$operator_public" >/dev/null 2>&1
    jq -n --arg runtimeKeyId "$runtime_key_id" --arg operatorKeyId "$operator_key_id" \
      --rawfile runtimePublic "$runtime_public" --rawfile operatorPublic "$operator_public" \
      '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
        {keyId:$runtimeKeyId,purpose:"runtime-attestation",subjectId:"argus-runtime-wrapper",algorithm:"Ed25519",publicKeyPem:$runtimePublic,status:"active"},
        {keyId:$operatorKeyId,purpose:"operator-approval",subjectId:"argus-release-smoke-operator",algorithm:"Ed25519",publicKeyPem:$operatorPublic,status:"active"}
      ]}' \
      >"$trust_store"
    chmod 600 "$runtime_private" "$runtime_public" "$operator_private" "$operator_public" "$trust_store"
    ARGUS_MODEL_TRUST_STORE="$(realpath "$trust_store")" \
      "$cli" model trust --manifest "$manifest" --runtime-key-id "$runtime_key_id" --operator-key-id "$operator_key_id" >/dev/null
  fi
  trust_store="$control_root/model-trust.json"
  export ARGUS_MODEL_TRUST_STORE
  ARGUS_MODEL_TRUST_STORE="$(realpath "$trust_store")"

  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  preflight_cli="${ARGUS_SMOKE_PREFLIGHT_CLI:-$repo_root/scripts/lib/argus-smoke-cli.sh}"
  preflight_real_cli="${ARGUS_SMOKE_REAL_CLI:-$cli}"
  preflight_launcher="${ARGUS_SMOKE_LAUNCHER:-$(dirname "$preflight_real_cli")/argus-launch}"
  preflight_claude="${ARGUS_SMOKE_CLAUDE:-$repo_root/scripts/fixtures/argus-launcher/claude}"
  preflight_output="$control_root/preflight-output.json"
  if ! ARGUS_SMOKE_REAL_CLI="$preflight_real_cli" \
    ARGUS_SMOKE_HOST_ROOT="$control_root/native-launch" \
    ARGUS_SMOKE_LAUNCHER="$preflight_launcher" \
    ARGUS_SMOKE_CLAUDE="$preflight_claude" \
    "$preflight_cli" preflight --target "$target" --artifact-root "$artifact_root" --mode "$mode" \
    --engagement "$manifest" --engagement-id "$(jq -r .engagementId "$manifest")" \
    --model-runtime "$runtime" --profile "$profile" --json >"$preflight_output"; then
    printf 'FAIL  model-control preflight did not become dispatchable for %s/%s\n' "$target" "$runtime" >&2
    jq -r '.status as $status | "status=\($status)", (.checks[] | select(.status == "fail") | "\(.id): \(.evidence)")' \
      "$preflight_output" >&2 || true
    return 1
  fi
  if ! jq -e . "$preflight_output" >/dev/null; then
    printf 'FAIL  model-control preflight --json emitted non-JSON stdout\n' >&2
    return 1
  fi

  while IFS= read -r lane; do
    result="$("$cli" model route --manifest "$manifest" --agent "$lane" --runtime "$runtime" \
      --signal normal --dispatch-id "smoke-$control_id-$lane" --attempt 1)"
    [ "$(jq -r .status <<<"$result")" = selected ] || {
      printf 'FAIL  model control did not select %s/%s before allocation\n' "$lane" "$runtime" >&2
      return 1
    }
    relative_path="$(jq -r .relativePath <<<"$result")"
    printf '%s\n' "$artifact_root/$relative_path" >"$control_root/decisions/$lane.path"
  done < <(jq -r '.agents[] | select(.selected and (.status == "ready" or .status == "degraded") and (.slug == "odysseus" or .dispatchAllowed == true)) | .slug' "$preflight_output")
}

argus_smoke_model_decision() {
  local manifest="$1"
  local host_root="$2"
  local lane="$3"
  local control_id
  control_id="$(node -e 'const fs=require("fs"),c=require("crypto"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(c.createHash("sha256").update(p+"\0"+d.engagementId).digest("hex").slice(0,24));' "$manifest")"
  tr -d '\n' <"$host_root/$control_id/decisions/$lane.path"
}

argus_smoke_allocate() {
  local cli="$1"
  local manifest="$2"
  local host_root="$3"
  local lane="$4"
  local controller_token="${5:-}"
  local resume_token="${6:-}"
  local decision
  local -a command
  decision="$(argus_smoke_model_decision "$manifest" "$host_root" "$lane")"
  command=("$cli" engagement allocate --manifest "$manifest" --lane "$lane" --decision "$decision")
  [ -z "$controller_token" ] || command+=(--controller-token "$controller_token")
  [ -z "$resume_token" ] || command+=(--token "$resume_token")
  "${command[@]}"
}
