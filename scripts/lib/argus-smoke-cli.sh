#!/usr/bin/env bash

# Test-only authenticated wrapper for unit suites that exercise argus-assets preflight
# without starting Claude. The release gate separately runs smoke-argus-launcher.sh through
# the real OS sandbox; this wrapper supplies a short-lived signed host fixture only.

set -euo pipefail

REAL_CLI="${ARGUS_SMOKE_REAL_CLI:?ARGUS_SMOKE_REAL_CLI is required}"
HOST_ROOT="${ARGUS_SMOKE_HOST_ROOT:?ARGUS_SMOKE_HOST_ROOT is required}"
LAUNCHER="${ARGUS_SMOKE_LAUNCHER:?ARGUS_SMOKE_LAUNCHER is required}"
CLAUDE_FIXTURE="${ARGUS_SMOKE_CLAUDE:?ARGUS_SMOKE_CLAUDE is required}"
LAUNCHER="$(cd "$(dirname "$LAUNCHER")" && pwd -P)/$(basename "$LAUNCHER")"
CLAUDE_FIXTURE="$(cd "$(dirname "$CLAUDE_FIXTURE")" && pwd -P)/$(basename "$CLAUDE_FIXTURE")"

if [ "${1:-}" != preflight ]; then exec "$REAL_CLI" "$@"; fi
shift
arguments=("$@")

target=''
artifact_root=''
mode=A
engagement_id=''
authorization_manifest=''
for ((index=0; index<${#arguments[@]}; index+=1)); do
  case "${arguments[$index]}" in
    --target) target="${arguments[$((index+1))]}"; index=$((index+1)) ;;
    --artifact-root) artifact_root="${arguments[$((index+1))]}"; index=$((index+1)) ;;
    --mode) mode="$(printf '%s' "${arguments[$((index+1))]}" | tr '[:lower:]' '[:upper:]')"; index=$((index+1)) ;;
    --engagement-id) engagement_id="${arguments[$((index+1))]}"; index=$((index+1)) ;;
    --authorization) authorization_manifest="${arguments[$((index+1))]}"; index=$((index+1)) ;;
  esac
done
[ -n "$target" ] || { printf 'FAIL  smoke preflight wrapper requires --target\n' >&2; exit 2; }

if [ -z "$artifact_root" ]; then
  if [[ "$target" =~ ^https?:// ]]; then artifact_root="$(pwd -P)"; else artifact_root="$target"; fi
fi
mkdir -p "$artifact_root"
artifact_root="$(cd "$artifact_root" && pwd -P)"
workspace="$(pwd -P)"
if [ -L "$artifact_root/ai_agents_internal" ] || { [ -e "$artifact_root/ai_agents_internal" ] && [ ! -d "$artifact_root/ai_agents_internal" ]; }; then
  while IFS='=' read -r name _; do
    case "$name" in ARGUS_*) unset "$name" ;; esac
  done < <(env)
  exec "$REAL_CLI" preflight "${arguments[@]}"
fi
if [ -z "$engagement_id" ]; then
  if [ -n "$authorization_manifest" ] && [ -f "$authorization_manifest" ]; then
    engagement_id="$(jq -r '.engagementId // empty' "$authorization_manifest")"
  fi
  if [ -z "$engagement_id" ]; then
    engagement_id="smoke-$(node -e 'const c=require("crypto"); process.stdout.write(c.createHash("sha256").update(process.argv.slice(1).join("\0")).digest("hex").slice(0,24))' "$target" "$artifact_root" "$mode")"
  fi
  arguments+=(--engagement-id "$engagement_id")
fi

mkdir -p "$HOST_ROOT"
chmod 700 "$HOST_ROOT"
case_root="$(mktemp -d "$HOST_ROOT/native-launch.XXXXXX")"
case_root="$(cd "$case_root" && pwd -P)"
chmod 700 "$case_root"
runtime_key_id="runtime-$(basename "$case_root" | tr -cd 'A-Za-z0-9')"
openssl genpkey -algorithm ED25519 -out "$case_root/runtime-private.pem" >/dev/null 2>&1
openssl pkey -in "$case_root/runtime-private.pem" -pubout -out "$case_root/runtime-public.pem" >/dev/null 2>&1
jq -n --arg keyId "$runtime_key_id" --rawfile publicKey "$case_root/runtime-public.pem" \
  '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
    {keyId:$keyId,purpose:"runtime-attestation",subjectId:"argus-unit-smoke-signer",algorithm:"Ed25519",publicKeyPem:$publicKey,status:"active"}
  ]}' >"$case_root/model-trust.json"
chmod 600 "$case_root"/*.pem "$case_root/model-trust.json"

authorization="$case_root/authorization.json"
receipt="$artifact_root/ai_agents_internal/native-launch-receipt.json"
capability_file="$case_root/launch-capability"
sandbox_probe="$case_root/sandbox-probe"
mkdir -p "$artifact_root/ai_agents_internal"
mkdir "$sandbox_probe"
chmod 700 "$sandbox_probe"
openssl rand -hex 32 | tr -d '\n' >"$capability_file"
chmod 600 "$capability_file"
capability_sha256="$(shasum -a 256 "$capability_file" | awk '{print $1}')"
target_kind=path
target_identity="$target"
if [[ "$target" =~ ^https?:// ]]; then
  target_kind=url
  target_identity="$(node -e 'process.stdout.write(new URL(process.argv[1]).toString())' "$target")"
else
  target_identity="$(cd "$target" && pwd -P)"
fi
node "$(dirname "$0")/../fixtures/argus-launcher/create-unit-authorization.mjs" \
  "$target_kind" "$target_identity" "$workspace" "$artifact_root" "$mode" "$engagement_id" \
  "$LAUNCHER" "$$" "$CLAUDE_FIXTURE" "$runtime_key_id" "$case_root/model-trust.json" \
  "$case_root/runtime-private.pem" "$authorization" "$receipt" "$capability_sha256" "$sandbox_probe"
rm -f "$case_root/runtime-private.pem"

capability="$(tr -d '\n' <"$capability_file")"
rm -f "$capability_file"

while IFS='=' read -r name _; do
  case "$name" in ARGUS_*) unset "$name" ;; esac
done < <(env)
export ARGUS_MODEL_TRUST_STORE="$case_root/model-trust.json"
export ARGUS_NATIVE_LAUNCH_AUTHORIZATION="$authorization"
export ARGUS_NATIVE_LAUNCH_RECEIPT="$receipt"
export ARGUS_NATIVE_LAUNCH_CAPABILITY="$capability"

command=("$REAL_CLI" preflight "${arguments[@]}" \
  --launch-authorization "$authorization" --launch-receipt "$receipt" --trust-store "$case_root/model-trust.json")
environment=(
  "HOME=${HOME:-}"
  "PATH=${PATH:-/usr/bin:/bin}"
  "TMPDIR=$artifact_root/ai_agents_internal"
  "ARGUS_MODEL_TRUST_STORE=$case_root/model-trust.json"
  "ARGUS_NATIVE_LAUNCH_AUTHORIZATION=$authorization"
  "ARGUS_NATIVE_LAUNCH_RECEIPT=$receipt"
  "ARGUS_NATIVE_LAUNCH_CAPABILITY=$capability"
)
cd "$workspace"
case "$(uname -s)" in
  Darwin)
    escaped_artifact="${artifact_root//\\/\\\\}"
    escaped_artifact="${escaped_artifact//\"/\\\"}"
    profile="$case_root/unit-sandbox.sb"
    printf '%s\n' \
      '(version 1)' '(deny default)' '(import "system.sb")' \
      '(allow process-exec)' '(allow process-fork)' '(allow signal)' '(allow process-info*)' \
      '(allow network*)' '(allow sysctl-read)' '(allow file-read*)' \
      "(allow file-write* (subpath \"$escaped_artifact\"))" >"$profile"
    exec sandbox-exec -f "$profile" env -i "${environment[@]}" "${command[@]}"
    ;;
  Linux)
    exec bwrap --die-with-parent --new-session --unshare-all --share-net \
      --ro-bind / / --bind "$artifact_root" "$artifact_root" --proc /proc \
      --chdir "$workspace" env -i "${environment[@]}" "${command[@]}"
    ;;
  *) printf 'FAIL  unsupported unit-smoke sandbox: %s\n' "$(uname -s)" >&2; exit 2 ;;
esac
