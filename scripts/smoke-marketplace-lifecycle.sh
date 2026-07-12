#!/usr/bin/env bash
# Clean-install the previous release, update the marketplace, update Argus, and
# exercise two installed specialist leases without requiring third-party APIs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/argus-smoke-model-control.sh"
CURRENT="$(jq -r '.version' "$ROOT/argus/claude/.claude-plugin/plugin.json")"
PREVIOUS_REVISION=""
if [ -n "${ARGUS_PREVIOUS_VERSION:-}" ]; then
  PREVIOUS="$ARGUS_PREVIOUS_VERSION"
  while read -r revision; do
    candidate="$(git -C "$ROOT" show "$revision:argus/claude/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' || true)"
    if [ "$candidate" = "$PREVIOUS" ]; then PREVIOUS_REVISION="$revision"; break; fi
  done < <(git -C "$ROOT" rev-list --all)
else
  PREVIOUS_REVISION="${ARGUS_PREVIOUS_REVISION:-origin/master}"
  PREVIOUS="$(git -C "$ROOT" show "$PREVIOUS_REVISION:argus/claude/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' || true)"
  if [ -z "$PREVIOUS" ] || [ "$PREVIOUS" = null ] || [ "$PREVIOUS" = "$CURRENT" ]; then
    PREVIOUS=""
    PREVIOUS_REVISION=""
    while read -r revision; do
      candidate="$(git -C "$ROOT" show "$revision:argus/claude/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' || true)"
      if [ -n "$candidate" ] && [ "$candidate" != null ] && [ "$candidate" != "$CURRENT" ]; then
        PREVIOUS="$candidate"
        PREVIOUS_REVISION="$revision"
        break
      fi
    done < <(git -C "$ROOT" rev-list --first-parent HEAD)
  fi
fi
WORK="$(mktemp -d)"
SOURCE="$WORK/marketplace"
CONFIG="$WORK/config"
TARGET="$WORK/target"
UPGRADE_TARGET="$WORK/upgrade-target"
URL_UPGRADE_TARGET="$WORK/url-upgrade-target"
LEGACY_URL='http://127.0.0.1:43124'
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || fail 'claude CLI is required for marketplace lifecycle smoke'
[ "$CURRENT" != "$PREVIOUS" ] || fail "current version must differ from previous release $PREVIOUS"
[ -n "$PREVIOUS" ] && [ "$PREVIOUS" != null ] && [ -n "$PREVIOUS_REVISION" ] || fail 'previous Argus release and revision could not be derived from Git history'

mkdir -p "$SOURCE" "$CONFIG" "$TARGET" "$UPGRADE_TARGET" "$URL_UPGRADE_TARGET/ai_agents_internal"
git -C "$ROOT" archive "$PREVIOUS_REVISION" .claude-plugin argus hephaestus | tar -xf - -C "$SOURCE"

git -C "$SOURCE" init -q
git -C "$SOURCE" config user.name 'Argus CI'
git -C "$SOURCE" config user.email 'argus-ci@example.invalid'
git -C "$SOURCE" add .
git -C "$SOURCE" commit -qm "Previous marketplace release"

CLAUDE_CONFIG_DIR="$CONFIG" claude plugin marketplace add "$SOURCE" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin install argus@holak-teams --scope user >/dev/null
test -d "$CONFIG/plugins/cache/holak-teams/argus/$PREVIOUS" || fail "clean install omitted Argus $PREVIOUS cache"
PREVIOUS_INSTALLED="$CONFIG/plugins/cache/holak-teams/argus/$PREVIOUS"
"$PREVIOUS_INSTALLED/bin/argus-assets" engagement init --target "$UPGRADE_TARGET" \
  --artifact-root "$UPGRADE_TARGET" --mode A >/dev/null
UPGRADE_MANIFEST="$UPGRADE_TARGET/ai_agents_internal/engagement.json"
upgrade_declared_artifact_root="$(jq -r .artifactRoot "$UPGRADE_MANIFEST")"
upgrade_declared_target_root="$(jq -r .target.root "$UPGRADE_MANIFEST")"
if [ "$(uname -s)" = Darwin ] && [ "$(realpath "$UPGRADE_TARGET")" = "$UPGRADE_TARGET" ]; then
  fail 'Darwin lifecycle fixture did not exercise a lexical /var or /tmp physical-path alias'
fi
old_allocation="$("$PREVIOUS_INSTALLED/bin/argus-assets" engagement allocate --manifest "$UPGRADE_MANIFEST" --lane kleio)"
old_token="$(jq -r .token <<<"$old_allocation")"
printf '%s\n' '{"legacy":true}' | "$PREVIOUS_INSTALLED/bin/argus-assets" engagement checkpoint \
  --manifest "$UPGRADE_MANIFEST" --lane kleio --token "$old_token" \
  --phase hunting --sequence 1 --input - >/dev/null
jq --arg target "$LEGACY_URL" '.target.identifiers = [$target]' \
  "$ROOT/scripts/fixtures/argus-authorization/full.json" >"$URL_UPGRADE_TARGET/ai_agents_internal/authorization.json"
"$PREVIOUS_INSTALLED/bin/argus-assets" preflight \
  --target "$LEGACY_URL" \
  --artifact-root "$URL_UPGRADE_TARGET" \
  --mode A \
  --authorization "$URL_UPGRADE_TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" \
  >/dev/null
cp "$URL_UPGRADE_TARGET/ai_agents_internal/preflight.json" "$WORK/genuine-preflight-v1.json"
jq -e '.schemaVersion == 1' "$WORK/genuine-preflight-v1.json" >/dev/null || fail 'previous release did not emit a v1 preflight report'
jq -e --arg target "$LEGACY_URL" '.target.identifier == $target' \
  "$URL_UPGRADE_TARGET/ai_agents_internal/engagement.json" >/dev/null || fail 'previous release did not preserve the raw URL target identity'
url_old_allocation="$("$PREVIOUS_INSTALLED/bin/argus-assets" engagement allocate \
  --manifest "$URL_UPGRADE_TARGET/ai_agents_internal/engagement.json" --lane odysseus)"
url_old_token="$(jq -r .token <<<"$url_old_allocation")"

rm -rf "$SOURCE/.claude-plugin" "$SOURCE/argus" "$SOURCE/hephaestus"
cp -R "$ROOT/.claude-plugin" "$ROOT/argus" "$ROOT/hephaestus" "$SOURCE/"
git -C "$SOURCE" add .
git -C "$SOURCE" commit -qm "Current marketplace release"

CLAUDE_CONFIG_DIR="$CONFIG" claude plugin marketplace update holak-teams >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin update argus@holak-teams --scope user >/dev/null
test -d "$CONFIG/plugins/cache/holak-teams/argus/$CURRENT" || fail "marketplace update omitted Argus $CURRENT cache"

INSTALLED="$CONFIG/plugins/cache/holak-teams/argus/$CURRENT"
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin details argus@holak-teams >"$WORK/details.txt"
grep -Fq 'Agents (27)' "$WORK/details.txt" || fail 'updated plugin does not expose 27 agents'
"$INSTALLED/bin/argus-assets" verify >/dev/null
node --input-type=module - \
  "$INSTALLED/lib/json-schema.mjs" \
  "$INSTALLED/schemas/preflight-report-v1.schema.json" \
  "$WORK/genuine-preflight-v1.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [runtimePath, schemaPath, reportPath] = process.argv.slice(2);
const { compileJsonSchema } = await import(pathToFileURL(runtimePath));
const validate = compileJsonSchema(JSON.parse(readFileSync(schemaPath, 'utf8')));
const errors = validate(JSON.parse(readFileSync(reportPath, 'utf8')));
if (errors.length) throw new Error(`preserved v1 reader rejected genuine previous-release preflight: ${JSON.stringify(errors)}`);
NODE
"$INSTALLED/bin/argus-assets" schema validate --kind preflight-report --input "$WORK/genuine-preflight-v1.json" >/dev/null
"$INSTALLED/bin/argus-assets" engagement status --manifest "$UPGRADE_MANIFEST" >/dev/null
"$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$UPGRADE_MANIFEST" \
  --lane kleio --token "$old_token" --outcome interrupted >/dev/null
upgrade_authorization="$UPGRADE_TARGET/ai_agents_internal/authorization.json"
jq --arg engagementId "$(jq -r .engagementId "$UPGRADE_MANIFEST")" \
  '.engagementId=$engagementId' "$ROOT/scripts/fixtures/argus-authorization/full.json" >"$upgrade_authorization"
"$INSTALLED/bin/argus-assets" preflight --target "$UPGRADE_TARGET" --artifact-root "$UPGRADE_TARGET" --mode A \
  --engagement "$UPGRADE_MANIFEST" --authorization "$upgrade_authorization" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
jq -e '.checks[] | select(.id == "engagement-manifest" and .status == "pass")' \
  "$UPGRADE_TARGET/ai_agents_internal/preflight.json" >/dev/null || fail 'current preflight rejected a physically equivalent previous-release path manifest'
[ "$(jq -r .artifactRoot "$UPGRADE_MANIFEST")" = "$upgrade_declared_artifact_root" ] && \
  [ "$(jq -r .target.root "$UPGRADE_MANIFEST")" = "$upgrade_declared_target_root" ] || \
  fail 'current runtime silently rewrote previous-release lexical path bindings'
node - "$UPGRADE_TARGET/ai_agents_internal/engagement-state.json" <<'NODE'
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const allocation = state.allocations.kleio;
const checkpoint = state.checkpoints.kleio;
if (state.schemaVersion < 2) throw new Error('genuine previous-release state was not migrated');
if (!/^[a-f0-9]{24}$/.test(allocation?.allocationId ?? '') || allocation.status !== 'released') throw new Error('legacy allocation was not safely migrated and released');
if (!/^[a-f0-9]{24}$/.test(checkpoint?.allocationId ?? '') || !checkpoint.dispatchId || checkpoint.attempt !== 1) throw new Error('legacy checkpoint binding was not safely migrated');
NODE
"$INSTALLED/bin/argus-assets" preflight \
  --target "$LEGACY_URL/" \
  --artifact-root "$URL_UPGRADE_TARGET" \
  --mode A \
  --authorization "$URL_UPGRADE_TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" \
  >/dev/null
jq -e --arg target "$LEGACY_URL" '.target.identifier == $target' \
  "$URL_UPGRADE_TARGET/ai_agents_internal/engagement.json" >/dev/null || fail 'updated preflight rewrote the previous release URL binding'
jq -e '.checks[] | select(.id == "engagement-manifest" and .status == "pass")' \
  "$URL_UPGRADE_TARGET/ai_agents_internal/preflight.json" >/dev/null || fail 'updated preflight rejected the URL-equivalent previous release engagement'
jq -e '.checks[] | select(.id == "authorization-target-boundary" and .status == "pass")' \
  "$URL_UPGRADE_TARGET/ai_agents_internal/preflight.json" >/dev/null || fail 'updated preflight rejected the URL-equivalent previous release authorization'
jq -e '.schemaVersion == 2' "$URL_UPGRADE_TARGET/ai_agents_internal/engagement-state.json" >/dev/null || fail 'URL engagement state was not migrated during resume'
URL_MANIFEST="$URL_UPGRADE_TARGET/ai_agents_internal/engagement.json"
URL_TRUST_ROOT="$WORK/url-host-trust"
mkdir -p "$URL_TRUST_ROOT"
chmod 700 "$URL_TRUST_ROOT"
openssl genpkey -algorithm ED25519 -out "$URL_TRUST_ROOT/runtime-private.pem" >/dev/null 2>&1
openssl pkey -in "$URL_TRUST_ROOT/runtime-private.pem" -pubout -out "$URL_TRUST_ROOT/runtime-public.pem" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$URL_TRUST_ROOT/operator-private.pem" >/dev/null 2>&1
openssl pkey -in "$URL_TRUST_ROOT/operator-private.pem" -pubout -out "$URL_TRUST_ROOT/operator-public.pem" >/dev/null 2>&1
jq -n --rawfile runtimePublic "$URL_TRUST_ROOT/runtime-public.pem" --rawfile operatorPublic "$URL_TRUST_ROOT/operator-public.pem" \
  '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
    {keyId:"marketplace-runtime",purpose:"runtime-attestation",subjectId:"marketplace-runtime-wrapper",algorithm:"Ed25519",publicKeyPem:$runtimePublic,status:"active"},
    {keyId:"marketplace-operator",purpose:"operator-approval",subjectId:"argus-lifecycle-operator",algorithm:"Ed25519",publicKeyPem:$operatorPublic,status:"active"}
  ]}' \
  >"$URL_TRUST_ROOT/model-trust.json"
chmod 600 "$URL_TRUST_ROOT"/*.pem "$URL_TRUST_ROOT/model-trust.json"
ARGUS_MODEL_TRUST_STORE="$(realpath "$URL_TRUST_ROOT/model-trust.json")" \
  "$INSTALLED/bin/argus-assets" model trust --manifest "$URL_MANIFEST" \
    --runtime-key-id marketplace-runtime --operator-key-id marketplace-operator \
    --legacy-lane odysseus --legacy-lease-token "$url_old_token" >/dev/null
"$INSTALLED/bin/argus-assets" preflight \
  --target "$LEGACY_URL/" --artifact-root "$URL_UPGRADE_TARGET" --mode A \
  --engagement "$URL_MANIFEST" \
  --authorization "$URL_UPGRADE_TARGET/ai_agents_internal/authorization.json" \
  --model-runtime claude --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
url_legacy_decision_json="$("$INSTALLED/bin/argus-assets" model route \
  --manifest "$URL_MANIFEST" --agent odysseus --runtime claude --signal normal \
  --dispatch-id marketplace-legacy-odysseus --attempt 1 --legacy-lease-token "$url_old_token")"
jq -e '.status == "selected" and .legacyResumeBinding.checkpointRef == null and .legacyResumeBinding.checkpointSha256 == null' \
  <<<"$url_legacy_decision_json" >/dev/null || fail 'active previous-release Odysseus without a checkpoint was not authenticated for resume'
url_legacy_decision="$URL_UPGRADE_TARGET/$(jq -r .relativePath <<<"$url_legacy_decision_json")"
url_resumed="$("$INSTALLED/bin/argus-assets" engagement allocate --manifest "$URL_MANIFEST" \
  --lane odysseus --decision "$url_legacy_decision" --token "$url_old_token")"
jq -e '.resumed == true' <<<"$url_resumed" >/dev/null || fail 'authenticated previous-release Odysseus did not resume its exact allocation'
if "$INSTALLED/bin/argus-assets" model route \
  --manifest "$URL_MANIFEST" --agent odysseus --runtime claude --signal normal \
  --dispatch-id marketplace-legacy-orphan --attempt 1 --legacy-lease-token "$url_old_token" >/dev/null 2>&1; then
  fail 'legacy resume persisted a second normal decision after binding the active allocation'
fi
[ "$(jq -s '[.[] | select(.agent=="odysseus" and .runtime=="claude" and .signal=="normal" and .attempt==1 and .status=="selected")] | length' \
  "$URL_UPGRADE_TARGET"/ai_agents_internal/model-decisions/MDR-*.json)" -eq 1 ] || \
  fail 'legacy resume left an orphan selected normal decision'
"$INSTALLED/bin/argus-assets" engagement heartbeat \
  --manifest "$URL_MANIFEST" \
  --lane odysseus --token "$url_old_token" --phase discovery --completed 0 --total 1 --status started >/dev/null
"$INSTALLED/bin/argus-assets" preflight \
  --target "$LEGACY_URL/" \
  --artifact-root "$URL_UPGRADE_TARGET" \
  --mode A \
  --authorization "$URL_UPGRADE_TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" \
  >/dev/null
jq -e '.checks[] | select(.id == "controller-heartbeat" and .status == "pass") | .evidence | contains("migrated v1 controller heartbeat")' \
  "$URL_UPGRADE_TARGET/ai_agents_internal/preflight.json" >/dev/null || fail 'migrated active Odysseus could not resume after its first current heartbeat'
"$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$URL_MANIFEST" \
  --lane odysseus --token "$url_old_token" --outcome interrupted >/dev/null
mkdir "$TARGET/ai_agents_internal"
cp "$ROOT/scripts/fixtures/argus-authorization/full.json" "$TARGET/ai_agents_internal/authorization.json"
"$INSTALLED/bin/argus-assets" preflight --target "$TARGET" --mode A \
  --authorization "$TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
argus_smoke_prepare_model_control "$INSTALLED/bin/argus-assets" "$MANIFEST" "$TARGET" "$TARGET" A \
  "$ROOT/scripts/fixtures/argus-preflight/full.json" "$WORK/current-host-trust"
controller="$(argus_smoke_allocate "$INSTALLED/bin/argus-assets" "$MANIFEST" "$WORK/current-host-trust" odysseus)"
controller_token="$(jq -r .token <<<"$controller")"
for lane in kleio theseus; do
  allocation="$(argus_smoke_allocate "$INSTALLED/bin/argus-assets" "$MANIFEST" "$WORK/current-host-trust" "$lane" "$controller_token")"
  token="$(jq -r .token <<<"$allocation")"
  "$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$MANIFEST" \
    --lane "$lane" --token "$token" --outcome interrupted >/dev/null
done
"$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$MANIFEST" \
  --lane odysseus --token "$controller_token" --outcome interrupted >/dev/null
node - "$TARGET/ai_agents_internal/engagement-state.json" \
  "$UPGRADE_TARGET/ai_agents_internal/engagement-state.json" \
  "$URL_UPGRADE_TARGET/ai_agents_internal/engagement-state.json" <<'NODE'
const fs = require('fs');
const [currentPath, pathUpgradePath, urlUpgradePath] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
for (const lane of ['odysseus', 'kleio', 'theseus']) {
  if (current.allocations[lane]?.status !== 'released') throw new Error(`${lane} current lease was not released`);
}
const pathUpgrade = JSON.parse(fs.readFileSync(pathUpgradePath, 'utf8'));
if (pathUpgrade.allocations.kleio?.status !== 'released') throw new Error('path-upgrade Kleio lease was not released');
const urlUpgrade = JSON.parse(fs.readFileSync(urlUpgradePath, 'utf8'));
if (urlUpgrade.allocations.odysseus?.status !== 'released') throw new Error('URL-upgrade Odysseus lease was not released');
for (const [label, state] of [['current', current], ['path-upgrade', pathUpgrade], ['url-upgrade', urlUpgrade]]) {
  if (Object.values(state.allocations).some((allocation) => allocation.status === 'active')) throw new Error(`${label} left an active allocation`);
  if (Object.keys(state.exclusiveLocks ?? {}).length !== 0) throw new Error(`${label} left an exclusive lock`);
}
NODE

printf 'PASS  Marketplace lifecycle: genuine %s state and raw URL -> %s migration, 27 agents, two-lane installed smoke\n' "$PREVIOUS" "$CURRENT"
