#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
PREFLIGHT_CLI="$ROOT/scripts/lib/argus-smoke-cli.sh"
source "$ROOT/scripts/lib/argus-smoke-model-control.sh"
WORK="$(mktemp -d)"
TARGET="$WORK/target"
HOST="$WORK/host"
NATIVE_HOST="$WORK/native-host"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

node "$ROOT/scripts/smoke-argus-model-routing.mjs"
mkdir -p "$TARGET/ai_agents_internal" "$HOST"
cp "$ROOT/scripts/fixtures/argus-authorization/full.json" "$TARGET/ai_agents_internal/authorization.json"
ARGUS_SMOKE_REAL_CLI="$CLI" ARGUS_SMOKE_HOST_ROOT="$NATIVE_HOST" \
ARGUS_SMOKE_LAUNCHER="$ROOT/argus/claude/bin/argus-launch" \
ARGUS_SMOKE_CLAUDE="$ROOT/scripts/fixtures/argus-launcher/claude" \
"$PREFLIGHT_CLI" preflight --target "$TARGET" --mode A \
  --authorization "$TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"

argus_smoke_prepare_model_control "$CLI" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST"

controller="$(argus_smoke_allocate "$CLI" "$MANIFEST" "$HOST" odysseus)"
controller_token="$(jq -r .token <<<"$controller")"
decision="$(argus_smoke_model_decision "$MANIFEST" "$HOST" odysseus)"
"$CLI" model telemetry --manifest "$MANIFEST" --decision "$decision" --token "$controller_token" \
  --input-tokens 100 --output-tokens 20 --duration-ms 250 --success true >/dev/null
jq -e 'length == 1 and .[0].agent == "odysseus" and .[0].schema == "argus/model-telemetry-event@2"' \
  <(jq -s . "$TARGET/ai_agents_internal/model-telemetry.jsonl") >/dev/null || fail 'decision telemetry was not recorded exactly once'

# A trust-store status change must take effect immediately. The pinned manifest
# remains unchanged; every sensitive operation rereads the live host store.
trust_store="$ARGUS_MODEL_TRUST_STORE"
jq '(.keys[] | select(.purpose == "operator-approval") | .status) = "revoked"' "$trust_store" >"$WORK/revoked.json"
mv "$WORK/revoked.json" "$trust_store"
chmod 600 "$trust_store"
if "$CLI" model route --manifest "$MANIFEST" --agent aegis --runtime claude --signal safety \
  --dispatch-id smoke-live-revocation --attempt 2 --controller-token "$controller_token" >/dev/null 2>&1; then
  fail 'model route ignored live operator-key revocation'
fi
if "$CLI" model telemetry --manifest "$MANIFEST" --decision "$decision" --token "$controller_token" \
  --input-tokens 1 --output-tokens 1 --duration-ms 1 --success false >/dev/null 2>&1; then
  fail 'model telemetry ignored live operator-key revocation'
fi

"$CLI" engagement cleanup --manifest "$MANIFEST" --lane odysseus --token "$controller_token" --outcome interrupted >/dev/null
printf 'PASS  Argus model policy: native Claude route, fail-closed Codex, live revocation, bounded telemetry\n'
