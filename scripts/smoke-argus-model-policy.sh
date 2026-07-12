#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLICY="$ROOT/argus/model-policy.json"
ADAPTERS="$ROOT/argus/runtime-adapters.json"
CLI="$ROOT/argus/claude/bin/argus-assets"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

sign_document() {
  node --input-type=module - "$1" "$2" "$ROOT" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
const [path, keyPath] = process.argv.slice(2, 4);
const { modelAuthenticationPayload } = await import(`file://${process.argv[4]}/argus/runtime/model-policy.mjs`);
const document = JSON.parse(readFileSync(path, 'utf8'));
const payload = modelAuthenticationPayload(document);
document.authentication.signatureBase64 = sign(null, Buffer.from(payload), createPrivateKey(readFileSync(keyPath, 'utf8'))).toString('base64');
writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
NODE
}

make_mda_variant() {
  local source="$1" directory="$2" issued_at="$3" expires_at="$4" nonce="$5" parent_session="$6" reason="$7"
  local temporary digest output
  temporary="$directory/mda-variant-${nonce}.json"
  jq --arg issuedAt "$issued_at" --arg expiresAt "$expires_at" --arg nonce "$nonce" \
    --arg parentSessionId "$parent_session" --arg reason "$reason" '
      .issuedAt=$issuedAt | .expiresAt=$expiresAt | .nonce=$nonce | .parentSessionId=$parentSessionId |
      .reason=$reason | .authentication.signatureBase64=""
    ' "$source" >"$temporary"
  sign_document "$temporary" "$runtime_private"
  digest="$(shasum -a 256 "$temporary" | awk '{print $1}')"
  output="$directory/MDA-${digest:0:24}.json"
  mv "$temporary" "$output"
  printf '%s\n' "$output"
}

create_mda_for_decision() {
  local decision="$1" allocation="$2" issued_at="$3" expires_at="$4" nonce="$5" parent_session="$6" reason="$7"
  local directory temporary config_sha digest output
  directory="$(dirname "$(dirname "$decision")")/operator-decisions"
  temporary="$directory/mda-create-${nonce}.json"
  config_sha="$(node --input-type=module - "$decision" "$ROOT" <<'NODE'
import { readFileSync } from 'node:fs';
const { modelConfigSha256 } = await import(`file://${process.argv[3]}/argus/runtime/model-policy.mjs`);
console.log(modelConfigSha256(JSON.parse(readFileSync(process.argv[2], 'utf8')).selectedConfig));
NODE
)"
  jq -n --arg engagement "$(jq -r .engagementId "$decision")" --arg decisionId "$(jq -r .decisionId "$decision")" \
    --arg integrity "$(jq -r .integritySha256 "$decision")" --arg allocationId "$allocation" \
    --arg agent "$(jq -r .agent "$decision")" --arg config "$config_sha" --arg parentSessionId "$parent_session" \
    --arg issuedAt "$issued_at" --arg expiresAt "$expires_at" --arg nonce "$nonce" --arg reason "$reason" \
    --arg fingerprint "$runtime_fingerprint" \
    '{schema:"argus/model-dispatch-authorization@1",kind:"MODEL_DISPATCH_AUTHORIZATION",engagementId:$engagement,decisionId:$decisionId,decisionIntegritySha256:$integrity,allocationId:$allocationId,agent:$agent,runtime:"codex",parentRuntime:"codex",parentSessionId:$parentSessionId,selectedConfigSha256:$config,issuedBy:"codex-parent-smoke",issuedAt:$issuedAt,expiresAt:$expiresAt,nonce:$nonce,reason:$reason,authentication:{algorithm:"Ed25519",keyId:"runtime-smoke",purpose:"runtime-attestation",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' \
    >"$temporary"
  sign_document "$temporary" "$runtime_private"
  digest="$(shasum -a 256 "$temporary" | awk '{print $1}')"
  output="$directory/MDA-${digest:0:24}.json"
  mv "$temporary" "$output"
  printf '%s\n' "$output"
}

jq empty \
  "$POLICY" \
  "$ADAPTERS" \
  "$ROOT/argus/schemas/model-policy.schema.json" \
  "$ROOT/argus/schemas/runtime-adapters.schema.json" \
  "$ROOT/argus/schemas/model-decision.schema.json" \
  "$ROOT/argus/schemas/model-dispatch-authorization.schema.json" \
  "$ROOT/argus/schemas/model-operator-decision.schema.json" \
  "$ROOT/argus/schemas/model-runtime-attestation.schema.json" \
  "$ROOT/argus/schemas/model-trust-store.schema.json" \
  "$ROOT/argus/schemas/model-telemetry-event.schema.json"
node "$ROOT/scripts/sync-argus-model-policy.mjs" --check
node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --check >/dev/null
node "$ROOT/scripts/smoke-argus-model-routing.mjs"

[ "$(jq '[.roles[] | select(.tier == "frontier")] | length' "$POLICY")" -eq 10 ] || fail 'frontier role count is not 10'
[ "$(jq '[.roles[] | select(.tier == "standard")] | length' "$POLICY")" -eq 17 ] || fail 'standard role count is not 17'
[ "$(jq '[.roles[] | select(.mechanicalDowngrade != false)] | length' "$POLICY")" -eq 0 ] || fail 'a full role permits mechanical downgrade'
[ "$(jq '[.fallbackPolicies[] | select(.allowWeakerModel != false)] | length' "$POLICY")" -eq 0 ] || fail 'a fallback policy permits a weaker model'

expected_frontier='ariadne aristarchus atlas kalchas metis minos odysseus perseus tiresias tyche'
actual_frontier="$(jq -r '.roles[] | select(.tier == "frontier") | .slug' "$POLICY" | sort | paste -sd' ' -)"
[ "$actual_frontier" = "$expected_frontier" ] || fail "frontier roster drift: $actual_frontier"

for slug in $(jq -r '.roles[].slug' "$POLICY"); do
  tier="$(jq -r --arg slug "$slug" '.roles[] | select(.slug == $slug) | .tier' "$POLICY")"
  turns="$(jq -r --arg slug "$slug" '.roles[] | select(.slug == $slug) | .maxTurns' "$POLICY")"
  claude_model="$(jq -r --arg tier "$tier" '.tiers[$tier].claude.model' "$POLICY")"
  claude_effort="$(jq -r --arg tier "$tier" '.tiers[$tier].claude.effort' "$POLICY")"
  codex_model="$(jq -r --arg tier "$tier" '.tiers[$tier].codex.model' "$POLICY")"
  codex_effort="$(jq -r --arg tier "$tier" '.tiers[$tier].codex.reasoningEffort' "$POLICY")"
  grep -Fqx "model: $claude_model" "$ROOT/argus/claude/agents/$slug.md" || fail "$slug Claude model drift"
  grep -Fqx "effort: $claude_effort" "$ROOT/argus/claude/agents/$slug.md" || fail "$slug Claude effort drift"
  grep -Fqx "maxTurns: $turns" "$ROOT/argus/claude/agents/$slug.md" || fail "$slug Claude turn-budget drift"
  grep -Fqx "model = \"$codex_model\"" "$ROOT/argus/codex/$slug.toml" || fail "$slug Codex model drift"
  grep -Fqx "model_reasoning_effort = \"$codex_effort\"" "$ROOT/argus/codex/$slug.toml" || fail "$slug Codex effort drift"
done

work="$(mktemp -d)"
host="$(mktemp -d)"
codex_work="$(mktemp -d)"
trap 'rm -rf "$work" "$host" "$codex_work"' EXIT
"$CLI" engagement init --target "$work" --artifact-root "$work" --mode A --engagement-id routing-cli-smoke >/dev/null
manifest="$work/ai_agents_internal/engagement.json"
run_preflight() {
  "$CLI" preflight --target "$work" --artifact-root "$work" --mode A --model-runtime "$1" \
    --engagement "$manifest" --engagement-id routing-cli-smoke \
    --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
}
run_preflight claude
jq 'del(.modelTrust)' "$manifest" >"$work/ai_agents_internal/legacy-engagement.json"
"$CLI" engagement validate --manifest "$work/ai_agents_internal/legacy-engagement.json" >/dev/null || fail 'legacy v1 engagement without modelTrust no longer validates'

if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id no-trust --attempt 1 >/dev/null 2>&1; then
  fail 'model route did not fail closed without a pinned trust key'
fi
runtime_private="$host/runtime-signing-private.pem"
runtime_public="$host/runtime-signing-public.pem"
operator_private="$host/operator-signing-private.pem"
operator_public="$host/operator-signing-public.pem"
wrong_private="$host/wrong-signing-private.pem"
wrong_public="$host/wrong-signing-public.pem"
openssl genpkey -algorithm ED25519 -out "$runtime_private" >/dev/null 2>&1
openssl pkey -in "$runtime_private" -pubout -out "$runtime_public" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$operator_private" >/dev/null 2>&1
openssl pkey -in "$operator_private" -pubout -out "$operator_public" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$wrong_private" >/dev/null 2>&1
openssl pkey -in "$wrong_private" -pubout -out "$wrong_public" >/dev/null 2>&1
trust_store="$host/model-trust.json"
jq -n --rawfile runtime "$runtime_public" --rawfile operator "$operator_public" --rawfile wrong "$wrong_public" \
  '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
    {keyId:"runtime-smoke",purpose:"runtime-attestation",subjectId:"codex-parent-smoke",algorithm:"Ed25519",publicKeyPem:$runtime,status:"active"},
    {keyId:"operator-smoke",purpose:"operator-approval",subjectId:"model-policy-smoke-operator",algorithm:"Ed25519",publicKeyPem:$operator,status:"active"},
    {keyId:"wrong-runtime",purpose:"runtime-attestation",subjectId:"attacker",algorithm:"Ed25519",publicKeyPem:$wrong,status:"active"}
  ]}' >"$trust_store"
chmod 600 "$trust_store"
export ARGUS_MODEL_TRUST_STORE="$(realpath "$trust_store")"
chmod 666 "$trust_store"
if "$CLI" model trust --manifest "$manifest" --runtime-key-id runtime-smoke --operator-key-id operator-smoke >/dev/null 2>&1; then
  fail 'model trust accepted a group/world-writable host trust store'
fi
chmod 600 "$trust_store"
ln "$trust_store" "$host/model-trust-hardlink.json"
if "$CLI" model trust --manifest "$manifest" --runtime-key-id runtime-smoke --operator-key-id operator-smoke >/dev/null 2>&1; then
  fail 'model trust accepted a hard-linked host trust store'
fi
rm "$host/model-trust-hardlink.json"
ln -s "$trust_store" "$host/model-trust-symlink.json"
if ARGUS_MODEL_TRUST_STORE="$host/model-trust-symlink.json" \
  "$CLI" model trust --manifest "$manifest" --runtime-key-id runtime-smoke --operator-key-id operator-smoke >/dev/null 2>&1; then
  fail 'model trust accepted a symbolic-link host trust store'
fi
if "$CLI" model trust --manifest "$manifest" --public-key "$runtime_public" --pinned-by arbitrary >/dev/null 2>&1; then
  fail 'model trust still accepts arbitrary public-key TOFU arguments'
fi
"$CLI" model trust --manifest "$manifest" --runtime-key-id runtime-smoke --operator-key-id operator-smoke >/dev/null
runtime_fingerprint="$(jq -r .modelTrust.keys.runtimeAttestation.keyFingerprintSha256 "$manifest")"
operator_fingerprint="$(jq -r .modelTrust.keys.operatorApproval.keyFingerprintSha256 "$manifest")"
[ "$runtime_fingerprint" != null ] && [ "$operator_fingerprint" != null ] && [ "$runtime_fingerprint" != "$operator_fingerprint" ] || fail 'purpose-separated model trust fingerprints were not pinned'
if "$CLI" model trust --manifest "$manifest" --runtime-key-id wrong-runtime --operator-key-id operator-smoke >/dev/null 2>&1; then
  fail 'model trust accepted a replacement key'
fi
if "$CLI" model trust --manifest "$manifest" --runtime-key-id operator-smoke --operator-key-id runtime-smoke >/dev/null 2>&1; then
  fail 'model trust accepted swapped key purposes'
fi
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id stale-preflight --attempt 1 >/dev/null 2>&1; then
  fail 'model route accepted the pre-pin stale preflight digest'
fi
run_preflight claude

mkdir -p "$work/ai_agents_internal/model-decisions/.initial-control.lock"
touch -t 202001010000 "$work/ai_agents_internal/model-decisions/.initial-control.lock"
"$CLI" model route --manifest "$manifest" --agent atlas --runtime claude --signal normal \
  --dispatch-id dispatch-atlas-001 --attempt 1 >/dev/null
mkdir "$work/ai_agents_internal/model-decisions/.initial-control.lock"
printf '{' >"$work/ai_agents_internal/model-decisions/.initial-control.lock/owner.json"
touch -t 202001010000 "$work/ai_agents_internal/model-decisions/.initial-control.lock"
"$CLI" model route --manifest "$manifest" --agent atlas --runtime claude --signal normal \
  --dispatch-id dispatch-atlas-001 --attempt 1 >/dev/null
mkdir "$work/ai_agents_internal/model-decisions/.initial-control.lock"
printf '%s\n' '{"pid":2147483647,"acquiredAt":"2026-07-12T00:00:00.000Z"}' \
  >"$work/ai_agents_internal/model-decisions/.initial-control.lock/owner.json"
set +e
(cd /tmp && "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1) >"$work/aegis-race-1.out" 2>"$work/aegis-race-1.err" &
aegis_race_pid_1=$!
(cd /tmp && "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1) >"$work/aegis-race-2.out" 2>"$work/aegis-race-2.err" &
aegis_race_pid_2=$!
wait "$aegis_race_pid_1"; aegis_race_status_1=$?
wait "$aegis_race_pid_2"; aegis_race_status_2=$?
set -e
[ "$aegis_race_status_1" -eq 0 ] && [ "$aegis_race_status_2" -eq 0 ] || fail 'parallel stale initial-control lock recovery did not fail closed safely'
normal="$(<"$work/aegis-race-1.out")"
[ "$(jq -r .decisionId "$work/aegis-race-1.out")" = "$(jq -r .decisionId "$work/aegis-race-2.out")" ] || \
  fail 'parallel stale-lock recovery selected different immutable decisions'
printf '%s\n' "$normal" >"$work/preselected-aegis.json"
[ "$(jq -r '.status' <<<"$normal")" = selected ] || fail 'Claude baseline was not selected'
[ "$(jq -r '.reasonCode' <<<"$normal")" = BASELINE_SELECTED ] || fail 'Claude baseline reason code drifted'
normal_relative="$(jq -r '.relativePath' <<<"$normal")"
normal_path="$work/$normal_relative"
[ -f "$normal_path" ] || fail 'route did not persist the decision under manifest.artifactRoot'
jq -e '.schema == "argus/model-decision@2" and .adapter.adapterId == "claude-plugin-agent@1" and (.requiredOverrides | length) == 0 and (.requiredEnforcements | sort == ["effort", "maxTurns", "model"])' "$normal_path" >/dev/null || fail 'persisted baseline decision is malformed'

# The controller preselects every normal Claude attempt 1 before creating any
# workspace-write allocation. Each decision uses one stable per-role dispatch ID.
preselected_count=1
while IFS= read -r slug; do
  [ "$slug" = aegis ] && continue
  selected="$work/preselected-$slug.json"
  "$CLI" model route --manifest "$manifest" --agent "$slug" --runtime claude \
    --signal normal --dispatch-id "dispatch-$slug-001" --attempt 1 >"$selected"
  jq -e --arg slug "$slug" --arg dispatch "dispatch-$slug-001" '
    .status == "selected" and .reasonCode == "BASELINE_SELECTED" and
    .agent == $slug and .runtime == "claude" and .signal == "normal" and
    .dispatchId == $dispatch and .attempt == 1
  ' "$selected" >/dev/null || fail "$slug Claude attempt 1 was not selected before allocation"
  selected_path="$work/$(jq -r .relativePath "$selected")"
  [ -f "$selected_path" ] || fail "$slug preselected decision was not persisted"
  preselected_count=$((preselected_count + 1))
done < <(jq -r '.roles[].slug' "$POLICY" | sort)
[ "$preselected_count" -eq 27 ] || fail "expected 27 preselected Claude decisions, found $preselected_count"
jq -s -e '
  length == 27 and
  ([.[].agent] | unique | length) == 27 and
  all(.[]; .status == "selected" and .runtime == "claude" and .signal == "normal" and .attempt == 1)
' "$work"/preselected-*.json >/dev/null || fail 'the pre-allocation Claude decision set is incomplete or ambiguous'
state_path="$work/$(jq -r .statePath "$manifest")"
jq -e '.allocations | length == 0' "$state_path" >/dev/null || fail 'a worker allocation existed before all 27 Claude decisions were selected'

ariadne_normal="$(<"$work/preselected-ariadne.json")"
ariadne_normal_path="$work/$(jq -r .relativePath "$work/preselected-ariadne.json")"
tyche_normal="$(<"$work/preselected-tyche.json")"
tyche_normal_path="$work/$(jq -r .relativePath "$work/preselected-tyche.json")"
odysseus_decision_path="$work/$(jq -r .relativePath "$work/preselected-odysseus.json")"
talos_decision_path="$work/$(jq -r .relativePath "$work/preselected-talos.json")"
[ "$(jq -r .status <<<"$ariadne_normal")" = selected ] || fail 'frontier baseline was not selected pre-allocation'
[ "$(jq -r .status <<<"$tyche_normal")" = selected ] || fail 'frontier availability baseline was not selected pre-allocation'

run_preflight codex
mkdir -p "$work/ai_agents_internal/operator-decisions"
codex_issued_at="$(node -e 'console.log(new Date().toISOString())')"
codex_expires_at="$(node -e 'console.log(new Date(Date.now() + 600000).toISOString())')"
codex_turns="$(jq -r '.roles[] | select(.slug == "aegis") | .maxTurns' "$POLICY")"
codex_attestation="$work/ai_agents_internal/operator-decisions/aegis-codex-attestation.json"
jq -n --arg issuedAt "$codex_issued_at" --arg expiresAt "$codex_expires_at" --arg fingerprint "$runtime_fingerprint" --argjson maxTurns "$codex_turns" \
  '{schema:"argus/model-runtime-attestation@1",kind:"MODEL_RUNTIME_ATTESTATION",engagementId:"routing-cli-smoke",dispatchId:"dispatch-aegis-codex-attested",attempt:1,agent:"aegis",runtime:"codex",parentRuntime:"codex",parentSessionId:"codex-parent-smoke-001",adapterContractId:"argus/runtime-adapters@3",adapterId:"codex-custom-agent@1",selectedConfig:{tier:"standard",model:"terra",effort:"medium",maxTurns:$maxTurns},enforcements:{model:true,effort:true,maxTurns:true},issuedBy:"codex-parent-smoke",issuedAt:$issuedAt,expiresAt:$expiresAt,reason:"Exact signed Codex dispatch controls.",authentication:{algorithm:"Ed25519",keyId:"runtime-smoke",purpose:"runtime-attestation",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' >"$codex_attestation"
sign_document "$codex_attestation" "$runtime_private"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime codex --signal normal \
  --dispatch-id dispatch-aegis-codex-attested --attempt 1 --runtime-attestation "$codex_attestation" \
  >"$work/cross-runtime.out" 2>"$work/cross-runtime.err"; then
  fail 'one engagement selected both Claude and Codex normal attempt-1 decisions for Aegis'
fi
grep -Fq 'different selected normal attempt-1 decision already exists for this agent' "$work/cross-runtime.err" || \
  fail 'cross-runtime initial selection failed for an unexpected reason'

run_preflight claude
odysseus_allocation="$("$CLI" engagement allocate --manifest "$manifest" --lane odysseus \
  --decision "$odysseus_decision_path")"
odysseus_token="$(jq -r .token <<<"$odysseus_allocation")"
export ARGUS_ENGAGEMENT_CONTROLLER_TOKEN="$odysseus_token"
jq -e --arg decision "$(jq -r .decisionId "$odysseus_decision_path")" '
  .lane == "odysseus" and .resumed == false and .modelDecisionId == $decision
' <<<"$odysseus_allocation" >/dev/null || fail 'Odysseus was not bootstrapped from its exact preselected decision'
jq -e '.allocations | keys == ["odysseus"]' "$state_path" >/dev/null || fail 'Odysseus was not the first and only controller allocation'
if "$CLI" model route --manifest "$manifest" --agent nike --runtime claude \
  --signal normal --dispatch-id late-after-controller-allocation --attempt 1 >/dev/null 2>&1; then
  fail 'normal attempt 1 was selected after the controller allocation closed preselection'
fi
if "$CLI" engagement allocate --manifest "$manifest" --lane aegis \
  --decision "$normal_path" >/dev/null 2>&1; then
  fail 'worker allocation succeeded without the Odysseus controller token'
fi
if "$CLI" engagement allocate --manifest "$manifest" --lane aegis \
  --decision "$ariadne_normal_path" --controller-token "$odysseus_token" >/dev/null 2>&1; then
  fail 'worker allocation accepted another agent model decision'
fi
aegis_allocation="$("$CLI" engagement allocate --manifest "$manifest" --lane aegis \
  --decision "$normal_path" --controller-token "$odysseus_token")"
aegis_token="$(jq -r .token <<<"$aegis_allocation")"
jq -e --arg decision "$(jq -r .decisionId "$normal_path")" '
  .lane == "aegis" and .resumed == false and .modelDecisionId == $decision
' <<<"$aegis_allocation" >/dev/null || fail 'Aegis was not allocated by Odysseus with its exact preselected decision'
ariadne_allocation="$("$CLI" engagement allocate --manifest "$manifest" --lane ariadne \
  --decision "$ariadne_normal_path" --controller-token "$odysseus_token")"
ariadne_token="$(jq -r .token <<<"$ariadne_allocation")"
tyche_allocation="$("$CLI" engagement allocate --manifest "$manifest" --lane tyche \
  --decision "$tyche_normal_path" --controller-token "$odysseus_token")"
tyche_token="$(jq -r .token <<<"$tyche_allocation")"

# A workspace-write worker cannot replace the pinned key after the immutable
# attempt-1 decision: the manifest hash chain and pre-allocation rule both fail closed.
cp "$manifest" "$work/engagement-before-forgery.json"
wrong_fingerprint="$(node --input-type=module - "$wrong_public" "$ROOT" <<'NODE'
import { readFileSync } from 'node:fs';
const { modelPublicKeyFingerprint } = await import(`file://${process.argv[3]}/argus/runtime/model-policy.mjs`);
console.log(modelPublicKeyFingerprint(readFileSync(process.argv[2], 'utf8')));
NODE
)"
jq --rawfile pem "$wrong_public" --arg fingerprint "$wrong_fingerprint" \
  '.modelTrust.keys.runtimeAttestation.publicKeyPem=$pem | .modelTrust.keys.runtimeAttestation.keyFingerprintSha256=$fingerprint | .modelTrust.keys.runtimeAttestation.subjectId="attacker"' \
  "$manifest" >"$work/forged-engagement.json"
mv "$work/forged-engagement.json" "$manifest"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id dispatch-aegis-001 --attempt 1 >/dev/null 2>&1; then
  fail 'worker-replaced trust key reused a prior selected decision'
fi
mv "$work/engagement-before-forgery.json" "$manifest"
if "$CLI" model route --manifest "$manifest" --agent talos --runtime claude --signal normal --dispatch-id late-worker-route --attempt 1 >/dev/null 2>&1; then
  fail 'normal attempt 1 was selected after a worker allocation became active'
fi

normal_again="$("$CLI" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1)"
[ "$(jq -r '.decisionId' <<<"$normal_again")" = "$(jq -r '.decisionId' <<<"$normal")" ] || fail 'idempotent route changed decisionId'
[ "$(jq -r '.createdAt' <<<"$normal_again")" = "$(jq -r '.createdAt' <<<"$normal")" ] || fail 'idempotent route replaced the immutable decision'
ln "$normal_path" "$work/model-decision-hardlink.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1 >/dev/null 2>&1; then
  fail 'model routing accepted an aliased persisted decision'
fi
rm "$work/model-decision-hardlink.json"

if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id dispatch-aegis-001 --attempt 2 >/dev/null 2>&1; then
  fail 'normal routing accepted a second attempt without escalation evidence'
fi

printf '%s\n' '{"completed":["baseline"],"next":"resume-after-escalation"}' >"$work/aegis-checkpoint.json"
"$CLI" engagement checkpoint --manifest "$manifest" --lane aegis --token "$aegis_token" \
  --phase automation --sequence 1 --dispatch-id dispatch-aegis-001 --attempt 1 \
  --input "$work/aegis-checkpoint.json" >/dev/null
request_record="$("$CLI" model request --manifest "$manifest" --agent aegis --runtime claude \
  --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 \
  --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json --token "$aegis_token")"
request="$(sed -E 's/^MODEL_REQUEST  persisted path=([^ ]+) sha256=.*/\1/' <<<"$request_record")"
[ -f "$request" ] || fail 'bounded model request command did not persist its output'
request_again="$("$CLI" model request --manifest "$manifest" --agent aegis --runtime claude \
  --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 \
  --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json --token "$aegis_token")"
[ "$request_record" = "$request_again" ] || fail 'bounded model request persistence is not idempotent'
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 >/dev/null 2>&1; then
  fail 'worker escalation succeeded without a bound request'
fi
ln "$request" "$work/ai_agents_internal/model-requests/request-hardlink.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety \
  --dispatch-id dispatch-aegis-001 --attempt 2 --request "$work/ai_agents_internal/model-requests/request-hardlink.json" >/dev/null 2>&1; then
  fail 'model route accepted a hard-linked escalation request'
fi
rm "$work/ai_agents_internal/model-requests/request-hardlink.json"

blocked_file="$work/blocked.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --request "$request" >"$blocked_file"; then
  fail 'Claude escalation succeeded without an effort override'
fi
jq -e '.status == "blocked" and .reasonCode == "CAPABILITY_DRIFT" and .missingCapabilities == ["effort"] and .escalationBinding.requestSha256 != null and .escalationBinding.checkpointRef == "ai_agents_internal/checkpoints/aegis/00000001.json"' "$blocked_file" >/dev/null || fail 'Claude capability drift or escalation binding is not exact'
blocked_path="$work/$(jq -r '.relativePath' "$blocked_file")"
[ -f "$blocked_path" ] || fail 'blocked route was not persisted'

jq '.agent = "talos"' "$request" >"$work/ai_agents_internal/mismatched-request.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --request "$work/ai_agents_internal/mismatched-request.json" >/dev/null 2>&1; then
  fail 'model route accepted an escalation request for another agent'
fi
printf '%s\n' '{"completed":["baseline","extra"],"next":"newer-state"}' >"$work/aegis-checkpoint-2.json"
"$CLI" engagement checkpoint --manifest "$manifest" --lane aegis --token "$aegis_token" \
  --phase automation --sequence 2 --dispatch-id dispatch-aegis-001 --attempt 1 \
  --input "$work/aegis-checkpoint-2.json" >/dev/null
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-001 --attempt 2 --request "$request" >/dev/null 2>&1; then
  fail 'model route accepted a stale checkpoint reference'
fi

# Frontier escalation pauses, then resumes only from one immutable external
# operator decision bound to the exact blocked decision.
printf '%s\n' '{"completed":["baseline"],"next":"operator-decision"}' >"$work/ariadne-checkpoint.json"
"$CLI" engagement checkpoint --manifest "$manifest" --lane ariadne --token "$ariadne_token" \
  --phase hunting --sequence 1 --dispatch-id dispatch-ariadne-001 --attempt 1 \
  --input "$work/ariadne-checkpoint.json" >/dev/null
ariadne_request_record="$("$CLI" model request --manifest "$manifest" --agent ariadne --runtime claude \
  --signal safety --dispatch-id dispatch-ariadne-001 --attempt 2 \
  --checkpoint-ref ai_agents_internal/checkpoints/ariadne/00000001.json --token "$ariadne_token")"
ariadne_request="$(sed -E 's/^MODEL_REQUEST  persisted path=([^ ]+) sha256=.*/\1/' <<<"$ariadne_request_record")"
ariadne_blocked="$work/ariadne-operator-blocked.json"
if "$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" >"$ariadne_blocked"; then
  fail 'frontier escalation continued without operator input'
fi
jq -e '.status == "blocked" and .reasonCode == "OPERATOR_ESCALATION_REQUIRED" and .operatorEscalation == true' "$ariadne_blocked" >/dev/null || fail 'frontier operator pause is malformed'
blocked_id="$(jq -r .decisionId "$ariadne_blocked")"
approved_at="$(node -e 'console.log(new Date(Date.parse(process.argv[1]) + 1000).toISOString())' "$(jq -r .createdAt "$ariadne_blocked")")"
mkdir -p "$work/ai_agents_internal/operator-decisions"
operator_file="$work/ai_agents_internal/operator-decisions/ariadne-approval.json"
jq -n \
  --arg blocked "$blocked_id" \
  --arg approvedAt "$approved_at" \
  --arg fingerprint "$operator_fingerprint" \
  '{schema:"argus/model-operator-decision@1",kind:"MODEL_OPERATOR_DECISION",engagementId:"routing-cli-smoke",dispatchId:"dispatch-ariadne-001",attempt:2,agent:"ariadne",signal:"safety",blockedDecisionId:$blocked,action:"continue-frontier",approvedBy:"model-policy-smoke-operator",approvedAt:$approvedAt,reason:"Continue on the unchanged frontier baseline.",authentication:{algorithm:"Ed25519",keyId:"operator-smoke",purpose:"operator-approval",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' \
  >"$operator_file"
sign_document "$operator_file" "$operator_private"
ariadne_approved="$("$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" --operator-decision "$operator_file")"
ariadne_approved_path="$work/$(jq -r .relativePath <<<"$ariadne_approved")"
jq -e --arg blocked "$blocked_id" '.status == "selected" and .reasonCode == "OPERATOR_APPROVAL_SELECTED" and .operatorEscalation == false and .operatorDecision.blockedDecisionId == $blocked and .operatorDecision.documentSha256 != ""' <<<"$ariadne_approved" >/dev/null || fail 'approved frontier continuation is malformed'
ln "$operator_file" "$work/ai_agents_internal/operator-decisions/ariadne-approval-hardlink.json"
if "$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" \
  --operator-decision "$work/ai_agents_internal/operator-decisions/ariadne-approval-hardlink.json" >/dev/null 2>&1; then
  fail 'frontier escalation accepted a hard-linked operator decision'
fi
rm "$work/ai_agents_internal/operator-decisions/ariadne-approval-hardlink.json"
operator_resolution="$work/ai_agents_internal/model-decisions/OPR-${blocked_id#MDR-}.json"
ln "$operator_resolution" "$work/operator-resolution-hardlink.json"
if "$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" --operator-decision "$operator_file" >/dev/null 2>&1; then
  fail 'frontier escalation accepted an aliased immutable operator resolution'
fi
rm "$work/operator-resolution-hardlink.json"
wrong_key_operator="$work/ai_agents_internal/operator-decisions/ariadne-wrong-key.json"
jq '.authentication.signatureBase64 = ""' "$operator_file" >"$wrong_key_operator"
sign_document "$wrong_key_operator" "$wrong_private"
if "$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" --operator-decision "$wrong_key_operator" >/dev/null 2>&1; then
  fail 'frontier escalation accepted an operator document signed by the wrong key'
fi
jq '.action = "abort" | .reason = "Conflicting action must fail."' "$operator_file" >"$work/ai_agents_internal/operator-decisions/ariadne-conflict.json"
if "$CLI" model route --manifest "$manifest" --agent ariadne --runtime claude --signal safety \
  --dispatch-id dispatch-ariadne-001 --attempt 2 --request "$ariadne_request" \
  --operator-decision "$work/ai_agents_internal/operator-decisions/ariadne-conflict.json" >/dev/null 2>&1; then
  fail 'frontier escalation accepted conflicting operator resolutions'
fi
"$CLI" engagement heartbeat --manifest "$manifest" --lane ariadne --token "$ariadne_token" \
  --phase hunting --completed 1 --total 2 --status failed >/dev/null
ariadne_attempt_two="$($CLI engagement start-attempt --manifest "$manifest" --lane ariadne \
  --decision "$ariadne_approved_path" --token "$ariadne_token" --controller-token "$odysseus_token")"
ariadne_retry_token="$(jq -r .token <<<"$ariadne_attempt_two")"
jq -e --arg allocation "$(jq -r .allocationId <<<"$ariadne_allocation")" --arg decision "$(jq -r .decisionId <<<"$ariadne_approved")" '
  .allocationId == $allocation and .attempt == 2 and .dispatchId == "dispatch-ariadne-001" and
  .modelDecisionId == $decision and .attemptStarted == true and .previousAttempt == 1 and (.token | length) == 64
' <<<"$ariadne_attempt_two" >/dev/null || fail 'approved frontier retry did not atomically rebind the active allocation'
[ "$ariadne_retry_token" != "$ariadne_token" ] || fail 'retry rebind did not revoke the prior attempt lane capability'
"$CLI" engagement heartbeat --manifest "$manifest" --lane ariadne --token "$ariadne_retry_token" \
  --phase hunting --completed 0 --total 2 --status running >/dev/null
if "$CLI" model telemetry --manifest "$manifest" --decision "$ariadne_normal_path" \
  --token "$ariadne_retry_token" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success false >/dev/null 2>&1; then
  fail 'attempt-1 telemetry was accepted after retry rebind; telemetry ordering is not enforced'
fi
ariadne_state_before_replay="$(shasum -a 256 "$work/ai_agents_internal/engagement-state.json" | awk '{print $1}')"
if "$CLI" engagement start-attempt --manifest "$manifest" --lane ariadne \
  --decision "$ariadne_approved_path" --token "$ariadne_token" --controller-token "$odysseus_token" >/dev/null 2>&1; then
  fail 'the same retry decision started a second worker attempt'
fi
[ "$(shasum -a 256 "$work/ai_agents_internal/engagement-state.json" | awk '{print $1}')" = "$ariadne_state_before_replay" ] || \
  fail 'rejected retry replay mutated engagement state'
if "$CLI" engagement cleanup --manifest "$manifest" --lane ariadne --token "$ariadne_token" --outcome interrupted >/dev/null 2>&1; then
  fail 'stale attempt-1 token cleaned the rebound attempt-2 allocation'
fi
if "$CLI" engagement checkpoint --manifest "$manifest" --lane ariadne --token "$ariadne_token" \
  --phase hunting --sequence 2 --dispatch-id dispatch-ariadne-001 --attempt 2 \
  --input "$work/ariadne-checkpoint.json" >/dev/null 2>&1; then
  fail 'stale attempt-1 token wrote an attempt-2 checkpoint'
fi
printf '%s\n' '{"completed":["baseline","operator-resolution"],"next":"resume-attempt-2"}' >"$work/ariadne-checkpoint-2.json"
"$CLI" engagement checkpoint --manifest "$manifest" --lane ariadne --token "$ariadne_retry_token" \
  --phase hunting --sequence 2 --dispatch-id dispatch-ariadne-001 --attempt 2 \
  --input "$work/ariadne-checkpoint-2.json" >/dev/null

# Frontier model unavailability is never a free-form retry. It must follow an
# exact selected attempt on an active allocation, then pause for an external
# retry-frontier or abort decision bound to the blocked route.
if "$CLI" model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id dispatch-tyche-001 --attempt 1 >/dev/null 2>&1; then
  fail 'model-unavailable accepted an initial attempt'
fi
if "$CLI" model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id invented-dispatch --attempt 2 >/dev/null 2>&1; then
  fail 'model-unavailable accepted an arbitrary dispatch without a prior selected decision'
fi
tyche_unavailable_file="$work/tyche-unavailable.json"
if "$CLI" model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id dispatch-tyche-001 --attempt 2 >"$tyche_unavailable_file"; then
  fail 'frontier unavailability continued without an operator decision'
fi
jq -e --arg previous "$(jq -r .decisionId <<<"$tyche_normal")" '
  .status == "blocked" and .reasonCode == "FRONTIER_UNAVAILABLE" and .operatorEscalation == true and
  .availabilityBinding.previousDecisionId == $previous and .availabilityBinding.allocationId != "" and
  .availabilityBinding.allocationSha256 != "" and
  .escalationBinding == null
' "$tyche_unavailable_file" >/dev/null || fail 'frontier unavailability binding is malformed'
unavailable_id="$(jq -r .decisionId "$tyche_unavailable_file")"
unavailable_approved_at="$(node -e 'console.log(new Date(Date.parse(process.argv[1]) + 1000).toISOString())' "$(jq -r .createdAt "$tyche_unavailable_file")")"
unavailable_operator="$work/ai_agents_internal/operator-decisions/tyche-retry.json"
jq -n \
  --arg blocked "$unavailable_id" \
  --arg approvedAt "$unavailable_approved_at" \
  --arg fingerprint "$operator_fingerprint" \
  '{schema:"argus/model-operator-decision@1",kind:"MODEL_OPERATOR_DECISION",engagementId:"routing-cli-smoke",dispatchId:"dispatch-tyche-001",attempt:2,agent:"tyche",signal:"model-unavailable",blockedDecisionId:$blocked,action:"retry-frontier",approvedBy:"model-policy-smoke-operator",approvedAt:$approvedAt,reason:"Retry the unchanged frontier configuration after the parent confirms availability.",authentication:{algorithm:"Ed25519",keyId:"operator-smoke",purpose:"operator-approval",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' \
  >"$unavailable_operator"
sign_document "$unavailable_operator" "$operator_private"
# Unrelated lane state may advance while the operator decides. The availability
# binding is scoped to Ariadne's allocation, not the entire mutable state file.
"$CLI" engagement allocate --manifest "$manifest" --lane talos \
  --decision "$talos_decision_path" --controller-token "$odysseus_token" >/dev/null
tyche_retried="$($CLI model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id dispatch-tyche-001 --attempt 2 \
  --operator-decision "$unavailable_operator")"
jq -e --arg blocked "$unavailable_id" '
  .status == "selected" and .reasonCode == "OPERATOR_RETRY_SELECTED" and
  .operatorDecision.action == "retry-frontier" and .operatorDecision.blockedDecisionId == $blocked and
  .weakerFallbackAllowed == false
' <<<"$tyche_retried" >/dev/null || fail 'frontier retry decision is malformed'
jq '.action = "continue-frontier"' "$unavailable_operator" >"$work/ai_agents_internal/operator-decisions/tyche-invalid-unavailable-action.json"
if "$CLI" model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id dispatch-tyche-001 --attempt 2 \
  --operator-decision "$work/ai_agents_internal/operator-decisions/tyche-invalid-unavailable-action.json" >/dev/null 2>&1; then
  fail 'model-unavailable accepted continue-frontier instead of retry-frontier'
fi
# Replacing the exact allocation must invalidate the blocked availability
# decision even if dispatch/attempt strings are replayed.
rm "$work/ai_agents_internal/workers/tyche/.lease"
"$CLI" engagement allocate --manifest "$manifest" --lane tyche \
  --decision "$tyche_normal_path" --token "$tyche_token" \
  --controller-token "$odysseus_token" >/dev/null
if "$CLI" model route --manifest "$manifest" --agent tyche --runtime claude \
  --signal model-unavailable --dispatch-id dispatch-tyche-001 --attempt 2 \
  --operator-decision "$unavailable_operator" >/dev/null 2>&1; then
  fail 'frontier retry accepted a replaced allocation'
fi

unknown_file="$work/unknown-blocked.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal invented-signal --dispatch-id dispatch-aegis-004 --attempt 1 >"$unknown_file"; then
  fail 'unknown signal did not fail closed'
fi
jq -e '.status == "blocked" and .reasonCode == "SIGNAL_NOT_ALLOWED"' "$unknown_file" >/dev/null || fail 'unknown signal block is malformed'

set +e
"$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" \
  --token "$aegis_token" --input-tokens 120 --output-tokens 30 --duration-ms 450 --reported-cost-usd 0.012 --success true \
  >"$work/telemetry-1.out" 2>"$work/telemetry-1.err" &
telemetry_pid_1=$!
"$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" \
  --token "$aegis_token" --input-tokens 120 --output-tokens 30 --duration-ms 450 --reported-cost-usd 0.012 --success true \
  >"$work/telemetry-2.out" 2>"$work/telemetry-2.err" &
telemetry_pid_2=$!
wait "$telemetry_pid_1"; telemetry_status_1=$?
wait "$telemetry_pid_2"; telemetry_status_2=$?
set -e
telemetry_successes=0
[ "$telemetry_status_1" -eq 0 ] && telemetry_successes=$((telemetry_successes + 1))
[ "$telemetry_status_2" -eq 0 ] && telemetry_successes=$((telemetry_successes + 1))
[ "$telemetry_successes" -eq 1 ] || fail 'concurrent telemetry writers did not produce exactly one accepted event'
grep -Fq 'model telemetry already contains an event for this immutable decision' "$work"/telemetry-*.err || \
  fail 'concurrent duplicate telemetry failed for an unexpected reason'
telemetry="$work/ai_agents_internal/model-telemetry.jsonl"
[ -f "$telemetry" ] || fail 'telemetry was not written under manifest.artifactRoot'
[ "$(wc -l <"$telemetry" | tr -d ' ')" -eq 1 ] || fail 'telemetry event count drifted'
jq -e --arg decision "$(jq -r '.decisionId' <<<"$normal")" '
  .schema == "argus/model-telemetry-event@2" and
  .decisionId == $decision and
  .decisionIntegritySha256 != "" and
  .adapterId == "claude-plugin-agent@1" and
  .adapterSnapshotSha256 != "" and
  .reasonCode == "BASELINE_SELECTED" and
  .totalTokens == 150 and .durationMs == 450 and .reportedCostUsd == 0.012
' "$telemetry" >/dev/null || fail 'decision-bound telemetry event is malformed'
for forbidden in prompt completion target url path account token evidence; do
  jq -e --arg field "$forbidden" 'has($field) | not' "$telemetry" >/dev/null || fail "telemetry leaked forbidden field: $forbidden"
done

"$CLI" model telemetry --manifest "$manifest" --decision "$ariadne_approved_path" \
  --token "$ariadne_retry_token" --input-tokens 80 --output-tokens 20 --duration-ms 300 --success true >/dev/null
if "$CLI" model telemetry --manifest "$manifest" --decision "$ariadne_approved_path" \
  --token "$ariadne_retry_token" --input-tokens 80 --output-tokens 20 --duration-ms 300 --success true >/dev/null 2>&1; then
  fail 'retry telemetry accepted a duplicate event for one immutable decision'
fi
jq -s -e --arg decision "$(jq -r .decisionId "$ariadne_approved_path")" '
  ([.[] | select(.decisionId == $decision)] | length) == 1
' "$telemetry" >/dev/null || fail 'retry attempt telemetry is not exactly once'
[ "$(wc -l <"$telemetry" | tr -d ' ')" -eq 2 ] || fail 'retry telemetry event count drifted'

if "$CLI" model telemetry --manifest "$manifest" --decision "$blocked_path" --token "$aegis_token" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success false >/dev/null 2>&1; then
  fail 'telemetry accepted a blocked decision'
fi
if "$CLI" model telemetry --manifest "$manifest" --decision "$work/blocked.json" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true >/dev/null 2>&1; then
  fail 'telemetry accepted a decision outside the exact decision directory'
fi
if "$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true --output ai_agents_internal/alternate.jsonl >/dev/null 2>&1; then
  fail 'telemetry accepted an alternate output sink'
fi
if "$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true --at 2026-07-12T00:00:00Z >/dev/null 2>&1; then
  fail 'telemetry accepted a caller-controlled timestamp'
fi
if "$CLI" model telemetry --agent aegis --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true >/dev/null 2>&1; then
  fail 'telemetry accepted legacy route-recomputation arguments'
fi

tampered_tmp="$work/tampered.tmp"
jq '.selectedConfig.model = "tampered"' "$normal_path" >"$tampered_tmp"
mv "$tampered_tmp" "$normal_path"
if "$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true >/dev/null 2>&1; then
  fail 'telemetry accepted a tampered decision'
fi
[ "$(wc -l <"$telemetry" | tr -d ' ')" -eq 2 ] || fail 'rejected telemetry mutated the telemetry stream'

if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id missing-attempt >/dev/null 2>&1; then
  fail 'route accepted a missing attempt'
fi
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id arbitrary-cap --attempt 1 --adapter-capability effort=true >/dev/null 2>&1; then
  fail 'route accepted an arbitrary caller capability flag'
fi

# A separate Codex engagement proves the complete preselection seal and the
# short-lived JIT authorization that is bound to the actual allocation start.
"$CLI" engagement init --target "$codex_work" --artifact-root "$codex_work" --mode A --engagement-id routing-codex-jit-smoke >/dev/null
codex_manifest="$codex_work/ai_agents_internal/engagement.json"
"$CLI" preflight --target "$codex_work" --artifact-root "$codex_work" --mode A --model-runtime codex \
  --engagement "$codex_manifest" --engagement-id routing-codex-jit-smoke \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
"$CLI" model trust --manifest "$codex_manifest" --runtime-key-id runtime-smoke --operator-key-id operator-smoke >/dev/null
"$CLI" preflight --target "$codex_work" --artifact-root "$codex_work" --mode A --model-runtime codex \
  --engagement "$codex_manifest" --engagement-id routing-codex-jit-smoke \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
mkdir -p "$codex_work/ai_agents_internal/operator-decisions"
codex_jit_issued="$(node -e 'console.log(new Date(Date.now() - 5000).toISOString())')"
codex_jit_expires="$(node -e 'console.log(new Date(Date.now() + 600000).toISOString())')"
odysseus_codex_decision=''
aegis_codex_decision=''
while IFS= read -r slug; do
  tier="$(jq -r --arg slug "$slug" '.roles[] | select(.slug==$slug) | .tier' "$POLICY")"
  model="$(jq -r --arg tier "$tier" '.tiers[$tier].codex.model' "$POLICY")"
  effort="$(jq -r --arg tier "$tier" '.tiers[$tier].codex.reasoningEffort' "$POLICY")"
  max_turns="$(jq -r --arg slug "$slug" '.roles[] | select(.slug==$slug) | .maxTurns' "$POLICY")"
  attestation="$codex_work/ai_agents_internal/operator-decisions/$slug-attempt-1.json"
  jq -n --arg engagement routing-codex-jit-smoke --arg slug "$slug" --arg dispatch "jit-$slug-001" \
    --arg tier "$tier" --arg model "$model" --arg effort "$effort" --arg issuedAt "$codex_jit_issued" \
    --arg expiresAt "$codex_jit_expires" --arg fingerprint "$runtime_fingerprint" --argjson maxTurns "$max_turns" \
    '{schema:"argus/model-runtime-attestation@1",kind:"MODEL_RUNTIME_ATTESTATION",engagementId:$engagement,dispatchId:$dispatch,attempt:1,agent:$slug,runtime:"codex",parentRuntime:"codex",parentSessionId:"codex-parent-jit-smoke",adapterContractId:"argus/runtime-adapters@3",adapterId:"codex-custom-agent@1",selectedConfig:{tier:$tier,model:$model,effort:$effort,maxTurns:$maxTurns},enforcements:{model:true,effort:true,maxTurns:true},issuedBy:"codex-parent-smoke",issuedAt:$issuedAt,expiresAt:$expiresAt,reason:"Trusted wrapper attests the exact immutable Codex route configuration.",authentication:{algorithm:"Ed25519",keyId:"runtime-smoke",purpose:"runtime-attestation",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' >"$attestation"
  sign_document "$attestation" "$runtime_private"
  selected="$($CLI model route --manifest "$codex_manifest" --agent "$slug" --runtime codex --signal normal \
    --dispatch-id "jit-$slug-001" --attempt 1 --runtime-attestation "$attestation")"
  jq -e '.status=="selected" and .runtime=="codex"' <<<"$selected" >/dev/null || fail "$slug Codex JIT baseline was not selected"
  if [ "$slug" = odysseus ]; then
    odysseus_codex_decision="$codex_work/$(jq -r .relativePath <<<"$selected")"
  elif [ "$slug" = aegis ]; then
    aegis_codex_decision="$codex_work/$(jq -r .relativePath <<<"$selected")"
  fi
done < <(jq -r '.roles[].slug' "$POLICY" | sort)
[ -f "$odysseus_codex_decision" ] || fail 'Codex JIT smoke did not persist the Odysseus decision'
[ -f "$aegis_codex_decision" ] || fail 'Codex JIT smoke did not persist the Aegis decision'

allocation_id="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
selected_config_sha="$(node --input-type=module - "$odysseus_codex_decision" "$ROOT" <<'NODE'
import { readFileSync } from 'node:fs';
const { modelConfigSha256 } = await import(`file://${process.argv[3]}/argus/runtime/model-policy.mjs`);
console.log(modelConfigSha256(JSON.parse(readFileSync(process.argv[2], 'utf8')).selectedConfig));
NODE
)"
dispatch_unsigned="$codex_work/ai_agents_internal/operator-decisions/odysseus-dispatch-unsigned.json"
jq -n --arg decision "$(jq -r .decisionId "$odysseus_codex_decision")" \
  --arg integrity "$(jq -r .integritySha256 "$odysseus_codex_decision")" --arg allocation "$allocation_id" \
  --arg config "$selected_config_sha" --arg issuedAt "$codex_jit_issued" --arg expiresAt "$codex_jit_expires" \
  --arg fingerprint "$runtime_fingerprint" \
  '{schema:"argus/model-dispatch-authorization@1",kind:"MODEL_DISPATCH_AUTHORIZATION",engagementId:"routing-codex-jit-smoke",decisionId:$decision,decisionIntegritySha256:$integrity,allocationId:$allocation,agent:"odysseus",runtime:"codex",parentRuntime:"codex",parentSessionId:"codex-parent-jit-smoke",selectedConfigSha256:$config,issuedBy:"codex-parent-smoke",issuedAt:$issuedAt,expiresAt:$expiresAt,nonce:"jit-odysseus-dispatch-0001",reason:"Trusted wrapper is starting this exact allocation with the selected configuration.",authentication:{algorithm:"Ed25519",keyId:"runtime-smoke",purpose:"runtime-attestation",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' >"$dispatch_unsigned"
sign_document "$dispatch_unsigned" "$runtime_private"
dispatch_digest="$(shasum -a 256 "$dispatch_unsigned" | awk '{print $1}')"
dispatch_document_sha="$(node --input-type=module - "$dispatch_unsigned" "$ROOT" <<'NODE'
import { readFileSync } from 'node:fs';
const { modelAuthenticatedDocumentSha256 } = await import(`file://${process.argv[3]}/argus/runtime/model-policy.mjs`);
console.log(modelAuthenticatedDocumentSha256(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
NODE
)"
dispatch_authorization="$codex_work/ai_agents_internal/operator-decisions/MDA-${dispatch_digest:0:24}.json"
mv "$dispatch_unsigned" "$dispatch_authorization"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus --decision "$odysseus_codex_decision" >/dev/null 2>&1; then
  fail 'Codex allocation started without a JIT dispatch authorization'
fi
ln "$dispatch_authorization" "$codex_work/ai_agents_internal/operator-decisions/MDA-hardlink.json"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus --decision "$odysseus_codex_decision" \
  --dispatch-authorization "$dispatch_authorization" >/dev/null 2>&1; then
  fail 'Codex allocation accepted a hard-linked JIT dispatch authorization'
fi
rm "$codex_work/ai_agents_internal/operator-decisions/MDA-hardlink.json"
wrong_parent_authorization="$(make_mda_variant "$dispatch_authorization" "$codex_work/ai_agents_internal/operator-decisions" \
  "$codex_jit_issued" "$codex_jit_expires" "jit-odysseus-wrong-parent" "different-parent-session" \
  "Mismatched parent session must fail.")"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus --decision "$odysseus_codex_decision" \
  --dispatch-authorization "$wrong_parent_authorization" >/dev/null 2>&1; then
  fail 'Codex allocation accepted an MDA from a different route-attestation parent session'
fi
codex_allocation="$($CLI engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$dispatch_authorization")"
codex_controller_token="$(jq -r .token <<<"$codex_allocation")"
jq -e --arg allocation "$allocation_id" --arg digest "$dispatch_document_sha" \
  '.allocationId==$allocation and .dispatchAuthorizationSha256==$digest and .resumed==false' <<<"$codex_allocation" >/dev/null || \
  fail 'Codex allocation did not bind the exact JIT authorization'

# A real Codex attempt-2 path proves route attestation -> fresh MDA -> atomic
# retry rebind -> token rotation -> exactly-once telemetry.
aegis_codex_allocation_id="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
aegis_codex_mda1="$(create_mda_for_decision "$aegis_codex_decision" "$aegis_codex_allocation_id" \
  "$codex_jit_issued" "$codex_jit_expires" "jit-aegis-dispatch-0001" "codex-parent-jit-smoke" \
  "Trusted wrapper authorizes the exact Aegis baseline spawn.")"
aegis_codex_allocation="$($CLI engagement allocate --manifest "$codex_manifest" --lane aegis \
  --decision "$aegis_codex_decision" --dispatch-authorization "$aegis_codex_mda1" \
  --controller-token "$codex_controller_token")"
aegis_codex_token="$(jq -r .token <<<"$aegis_codex_allocation")"
printf '%s\n' '{"completed":["baseline"],"next":"retry"}' >"$codex_work/aegis-codex-checkpoint.json"
"$CLI" engagement checkpoint --manifest "$codex_manifest" --lane aegis --token "$aegis_codex_token" \
  --phase automation --sequence 1 --dispatch-id jit-aegis-001 --attempt 1 \
  --input "$codex_work/aegis-codex-checkpoint.json" >/dev/null
aegis_codex_request_record="$($CLI model request --manifest "$codex_manifest" --agent aegis --runtime codex \
  --signal repeated-failure --dispatch-id jit-aegis-001 --attempt 2 \
  --checkpoint-ref ai_agents_internal/checkpoints/aegis/00000001.json --token "$aegis_codex_token")"
aegis_codex_request="$(sed -E 's/^MODEL_REQUEST  persisted path=([^ ]+) sha256=.*/\1/' <<<"$aegis_codex_request_record")"
aegis_retry_issued="$(node -e 'console.log(new Date().toISOString())')"
aegis_retry_expires="$(node -e 'console.log(new Date(Date.now()+600000).toISOString())')"
aegis_retry_attestation="$codex_work/ai_agents_internal/operator-decisions/aegis-attempt-2.json"
jq -n --arg issuedAt "$aegis_retry_issued" --arg expiresAt "$aegis_retry_expires" \
  --arg fingerprint "$runtime_fingerprint" --argjson maxTurns "$(jq -r '.roles[] | select(.slug=="aegis") | .maxTurns' "$POLICY")" \
  '{schema:"argus/model-runtime-attestation@1",kind:"MODEL_RUNTIME_ATTESTATION",engagementId:"routing-codex-jit-smoke",dispatchId:"jit-aegis-001",attempt:2,agent:"aegis",runtime:"codex",parentRuntime:"codex",parentSessionId:"codex-parent-jit-retry",adapterContractId:"argus/runtime-adapters@3",adapterId:"codex-custom-agent@1",selectedConfig:{tier:"frontier",model:"sol",effort:"xhigh",maxTurns:$maxTurns},enforcements:{model:true,effort:true,maxTurns:true},issuedBy:"codex-parent-smoke",issuedAt:$issuedAt,expiresAt:$expiresAt,reason:"Trusted wrapper can enforce the selected Aegis retry configuration.",authentication:{algorithm:"Ed25519",keyId:"runtime-smoke",purpose:"runtime-attestation",keyFingerprintSha256:$fingerprint,signatureBase64:""}}' \
  >"$aegis_retry_attestation"
sign_document "$aegis_retry_attestation" "$runtime_private"
aegis_codex_retry_json="$($CLI model route --manifest "$codex_manifest" --agent aegis --runtime codex \
  --signal repeated-failure --dispatch-id jit-aegis-001 --attempt 2 --request "$aegis_codex_request" \
  --runtime-attestation "$aegis_retry_attestation" --controller-token "$codex_controller_token")"
aegis_codex_retry="$codex_work/$(jq -r .relativePath <<<"$aegis_codex_retry_json")"
jq -e '.status=="selected" and .attempt==2 and .selectedConfig.model=="sol" and .runtimeAttestation.parentSessionId=="codex-parent-jit-retry"' \
  <<<"$aegis_codex_retry_json" >/dev/null || fail 'Codex attempt-2 route was not selected with its exact frontier attestation'
aegis_codex_mda2="$(create_mda_for_decision "$aegis_codex_retry" "$aegis_codex_allocation_id" \
  "$aegis_retry_issued" "$aegis_retry_expires" "jit-aegis-dispatch-0002" "codex-parent-jit-retry" \
  "Trusted wrapper authorizes one Aegis retry spawn.")"
aegis_wrong_parent_mda="$(make_mda_variant "$aegis_codex_mda2" "$codex_work/ai_agents_internal/operator-decisions" \
  "$aegis_retry_issued" "$aegis_retry_expires" "jit-aegis-wrong-parent" "wrong-retry-parent" \
  "Wrong retry parent must fail.")"
aegis_retry_state_before="$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')"
if "$CLI" engagement start-attempt --manifest "$codex_manifest" --lane aegis --decision "$aegis_codex_retry" \
  --token "$aegis_codex_token" --controller-token "$codex_controller_token" \
  --dispatch-authorization "$aegis_wrong_parent_mda" >/dev/null 2>&1; then
  fail 'Codex retry accepted an MDA from a different parent session'
fi
[ "$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')" = "$aegis_retry_state_before" ] || \
  fail 'rejected Codex retry parent mismatch mutated state'
aegis_codex_attempt_two="$($CLI engagement start-attempt --manifest "$codex_manifest" --lane aegis \
  --decision "$aegis_codex_retry" --token "$aegis_codex_token" --controller-token "$codex_controller_token" \
  --dispatch-authorization "$aegis_codex_mda2")"
aegis_codex_retry_token="$(jq -r .token <<<"$aegis_codex_attempt_two")"
jq -e --arg allocation "$aegis_codex_allocation_id" '.allocationId==$allocation and .attempt==2 and .attemptStarted==true and (.dispatchAuthorizationHistory|length)==2' \
  <<<"$aegis_codex_attempt_two" >/dev/null || fail 'Codex retry did not rebind the same allocation with fresh MDA history'
[ "$aegis_codex_retry_token" != "$aegis_codex_token" ] || fail 'Codex retry did not revoke the attempt-1 lane token'
if "$CLI" engagement start-attempt --manifest "$codex_manifest" --lane aegis --decision "$aegis_codex_retry" \
  --token "$aegis_codex_retry_token" --controller-token "$codex_controller_token" \
  --dispatch-authorization "$aegis_codex_mda2" >/dev/null 2>&1; then
  fail 'Codex retry replay consumed one MDA twice'
fi
"$CLI" model telemetry --manifest "$codex_manifest" --decision "$aegis_codex_retry" \
  --token "$aegis_codex_retry_token" --input-tokens 90 --output-tokens 10 --duration-ms 250 --success true >/dev/null
if "$CLI" model telemetry --manifest "$codex_manifest" --decision "$aegis_codex_retry" \
  --token "$aegis_codex_retry_token" --input-tokens 90 --output-tokens 10 --duration-ms 250 --success true >/dev/null 2>&1; then
  fail 'Codex retry telemetry accepted a duplicate immutable decision event'
fi
"$CLI" engagement cleanup --manifest "$codex_manifest" --lane aegis --token "$aegis_codex_retry_token" --outcome interrupted >/dev/null

aegis_replacement_issued="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+1000).toISOString())' "$aegis_retry_issued")"
aegis_replacement_expires="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+600000).toISOString())' "$aegis_replacement_issued")"
aegis_replacement_id="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
aegis_replacement_mda="$(create_mda_for_decision "$aegis_codex_decision" "$aegis_replacement_id" \
  "$aegis_replacement_issued" "$aegis_replacement_expires" "jit-aegis-dispatch-0003" "codex-parent-jit-smoke" \
  "Trusted wrapper authorizes one replacement lifecycle.")"
aegis_replacement="$($CLI engagement allocate --manifest "$codex_manifest" --lane aegis \
  --decision "$aegis_codex_decision" --dispatch-authorization "$aegis_replacement_mda" \
  --controller-token "$codex_controller_token")"
aegis_replacement_token="$(jq -r .token <<<"$aegis_replacement")"
jq -e '(.dispatchAuthorizationHistory|length)==3' <<<"$aegis_replacement" >/dev/null || \
  fail 'replacement allocation did not retain prior MDA identities'
"$CLI" engagement cleanup --manifest "$codex_manifest" --lane aegis --token "$aegis_replacement_token" --outcome interrupted >/dev/null
aegis_reuse_issued="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+1000).toISOString())' "$aegis_replacement_issued")"
aegis_reuse_expires="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+600000).toISOString())' "$aegis_reuse_issued")"
aegis_reused_id_mda="$(create_mda_for_decision "$aegis_codex_decision" "$aegis_codex_allocation_id" \
  "$aegis_reuse_issued" "$aegis_reuse_expires" "jit-aegis-dispatch-0004" "codex-parent-jit-smoke" \
  "A consumed allocation identity must fail after multiple replacements.")"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane aegis --decision "$aegis_codex_decision" \
  --dispatch-authorization "$aegis_reused_id_mda" --controller-token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'replacement lifecycle reused a generation-1 Codex allocation identity'
fi
aegis_new_id="$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
aegis_reused_nonce_mda="$(create_mda_for_decision "$aegis_codex_decision" "$aegis_new_id" \
  "$aegis_reuse_issued" "$aegis_reuse_expires" "jit-aegis-dispatch-0001" "codex-parent-jit-smoke" \
  "A consumed nonce must fail after multiple replacements.")"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane aegis --decision "$aegis_codex_decision" \
  --dispatch-authorization "$aegis_reused_nonce_mda" --controller-token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'replacement lifecycle reused a generation-1 Codex dispatch nonce'
fi

codex_state_before_replay="$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$dispatch_authorization" --token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'exact Codex JIT allocation replay was accepted twice'
fi
[ "$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')" = "$codex_state_before_replay" ] || \
  fail 'rejected live Codex MDA replay mutated state'

codex_resume_issued="$(node -e 'console.log(new Date().toISOString())')"
codex_resume_expires="$(node -e 'console.log(new Date(Date.now()+600000).toISOString())')"
codex_resume_authorization="$(make_mda_variant "$dispatch_authorization" "$codex_work/ai_agents_internal/operator-decisions" \
  "$codex_resume_issued" "$codex_resume_expires" "jit-odysseus-dispatch-0002" "codex-parent-jit-smoke" \
  "Trusted wrapper authorizes one authenticated live resume.")"
codex_resume="$($CLI engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$codex_resume_authorization" --token "$codex_controller_token")"
jq -e '.resumed==true and (.dispatchAuthorizationHistory | length)==2' <<<"$codex_resume" >/dev/null || \
  fail 'fresh Codex live-resume authorization was not consumed exactly once'

codex_recovery_sentinel="$codex_work/ai_agents_internal/workers/odysseus/tmp/preserve-until-jit-valid"
printf 'sentinel\n' >"$codex_recovery_sentinel"
rm "$codex_work/ai_agents_internal/workers/odysseus/.lease"
codex_recovery_state_before="$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$codex_resume_authorization" --token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'Codex crash recovery replayed its current MDA'
fi
[ -f "$codex_recovery_sentinel" ] && [ "$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')" = "$codex_recovery_state_before" ] || \
  fail 'rejected Codex recovery mutated resources or state before JIT validation'
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'Codex crash recovery started without a fresh MDA'
fi
[ -f "$codex_recovery_sentinel" ] && [ "$(shasum -a 256 "$codex_work/ai_agents_internal/engagement-state.json" | awk '{print $1}')" = "$codex_recovery_state_before" ] || \
  fail 'missing-MDA recovery rejection mutated resources or state'
ln -s "$codex_work/nonexistent-lease-target" "$codex_work/ai_agents_internal/workers/odysseus/.lease"
if "$CLI" engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$codex_resume_authorization" --token "$codex_controller_token" >/dev/null 2>&1; then
  fail 'Codex crash recovery accepted a dangling symbolic lease entry'
fi
[ -f "$codex_recovery_sentinel" ] || fail 'dangling lease rejection mutated recovery resources'
rm "$codex_work/ai_agents_internal/workers/odysseus/.lease"
codex_recovery_issued="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+1000).toISOString())' "$codex_resume_issued")"
codex_recovery_expires="$(node -e 'console.log(new Date(Date.parse(process.argv[1])+600000).toISOString())' "$codex_recovery_issued")"
codex_recovery_authorization="$(make_mda_variant "$dispatch_authorization" "$codex_work/ai_agents_internal/operator-decisions" \
  "$codex_recovery_issued" "$codex_recovery_expires" "jit-odysseus-dispatch-0003" "codex-parent-jit-smoke" \
  "Trusted wrapper authorizes one crash-recovery spawn.")"
codex_recovered="$($CLI engagement allocate --manifest "$codex_manifest" --lane odysseus \
  --decision "$odysseus_codex_decision" --dispatch-authorization "$codex_recovery_authorization" --token "$codex_controller_token")"
codex_recovered_token="$(jq -r .token <<<"$codex_recovered")"
jq -e --arg allocation "$allocation_id" '.allocationId==$allocation and .recoveredFromCrash==true and (.dispatchAuthorizationHistory | length)==3' \
  <<<"$codex_recovered" >/dev/null || fail 'fresh Codex recovery did not preserve identity and advance JIT history'
[ ! -e "$codex_recovery_sentinel" ] || fail 'successful Codex recovery did not clear sensitive crash residue'
"$CLI" engagement cleanup --manifest "$codex_manifest" --lane odysseus --token "$codex_recovered_token" --outcome interrupted >/dev/null

tampered_policy_plugin="$work/tampered-policy-plugin"
cp -R "$ROOT/argus/claude" "$tampered_policy_plugin"
jq '(.roles[] | select(.slug == "aegis") | .maxTurns) += 1' \
  "$tampered_policy_plugin/capabilities/model-policy.json" >"$work/tampered-policy.json"
mv "$work/tampered-policy.json" "$tampered_policy_plugin/capabilities/model-policy.json"
if "$tampered_policy_plugin/bin/argus-assets" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id tampered-policy --attempt 1 >"$work/tampered-policy.out" 2>"$work/tampered-policy.err"; then
  fail 'route accepted model-policy bytes that differ from the packaged manifest'
fi
grep -Fq 'trusted model-policy differs from the packaged asset manifest' "$work/tampered-policy.err" || \
  fail 'model-policy drift failed for an unexpected reason'

tampered_schema_plugin="$work/tampered-schema-plugin"
cp -R "$ROOT/argus/claude" "$tampered_schema_plugin"
printf '\n' >>"$tampered_schema_plugin/schemas/model-policy.schema.json"
if "$tampered_schema_plugin/bin/argus-assets" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id tampered-schema --attempt 1 >"$work/tampered-schema.out" 2>"$work/tampered-schema.err"; then
  fail 'route accepted routing schema bytes that differ from the packaged manifest'
fi
grep -Fq 'trusted runtime-schemas differs from the packaged asset manifest' "$work/tampered-schema.err" || \
  fail 'routing schema drift failed for an unexpected reason'

printf 'PASS  Argus model policy: immutable capability-bound decisions, exact persisted routes, and decision-bound sanitized telemetry\n'
