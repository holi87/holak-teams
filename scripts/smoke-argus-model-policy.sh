#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLICY="$ROOT/argus/model-policy.json"
ADAPTERS="$ROOT/argus/runtime-adapters.json"
CLI="$ROOT/argus/claude/bin/argus-assets"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

jq empty \
  "$POLICY" \
  "$ADAPTERS" \
  "$ROOT/argus/schemas/model-policy.schema.json" \
  "$ROOT/argus/schemas/runtime-adapters.schema.json" \
  "$ROOT/argus/schemas/model-decision.schema.json" \
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
trap 'rm -rf "$work"' EXIT
"$CLI" engagement init --target "$work" --artifact-root "$work" --mode A --engagement-id routing-cli-smoke >/dev/null
manifest="$work/ai_agents_internal/engagement.json"

normal="$(cd /tmp && "$CLI" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1)"
[ "$(jq -r '.status' <<<"$normal")" = selected ] || fail 'Claude baseline was not selected'
[ "$(jq -r '.reasonCode' <<<"$normal")" = BASELINE_SELECTED ] || fail 'Claude baseline reason code drifted'
normal_relative="$(jq -r '.relativePath' <<<"$normal")"
normal_path="$work/$normal_relative"
[ -f "$normal_path" ] || fail 'route did not persist the decision under manifest.artifactRoot'
jq -e '.schema == "argus/model-decision@2" and .adapter.adapterId == "claude-plugin-agent@1" and (.requiredOverrides | length) == 0 and (.requiredEnforcements | sort == ["effort", "maxTurns", "model"])' "$normal_path" >/dev/null || fail 'persisted baseline decision is malformed'

normal_again="$("$CLI" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 1)"
[ "$(jq -r '.decisionId' <<<"$normal_again")" = "$(jq -r '.decisionId' <<<"$normal")" ] || fail 'idempotent route changed decisionId'
[ "$(jq -r '.createdAt' <<<"$normal_again")" = "$(jq -r '.createdAt' <<<"$normal")" ] || fail 'idempotent route replaced the immutable decision'

next_attempt="$("$CLI" model route \
  --manifest "$manifest" --agent aegis --runtime claude --signal normal \
  --dispatch-id dispatch-aegis-001 --attempt 2)"
[ "$(jq -r '.decisionId' <<<"$next_attempt")" != "$(jq -r '.decisionId' <<<"$normal")" ] || fail 'attempt is not bound into decisionId'

blocked_file="$work/blocked.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal safety --dispatch-id dispatch-aegis-002 --attempt 1 >"$blocked_file"; then
  fail 'Claude escalation succeeded without an effort override'
fi
jq -e '.status == "blocked" and .reasonCode == "CAPABILITY_DRIFT" and .missingCapabilities == ["effort"]' "$blocked_file" >/dev/null || fail 'Claude capability drift is not exact'
blocked_path="$work/$(jq -r '.relativePath' "$blocked_file")"
[ -f "$blocked_path" ] || fail 'blocked route was not persisted'

codex_file="$work/codex-blocked.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime codex --signal normal --dispatch-id dispatch-aegis-003 --attempt 1 >"$codex_file"; then
  fail 'Codex baseline succeeded without maxTurns enforcement'
fi
jq -e '.status == "blocked" and .reasonCode == "CAPABILITY_DRIFT" and .missingCapabilities == ["maxTurns"]' "$codex_file" >/dev/null || fail 'Codex baseline capability drift is not exact'

unknown_file="$work/unknown-blocked.json"
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal invented-signal --dispatch-id dispatch-aegis-004 --attempt 1 >"$unknown_file"; then
  fail 'unknown signal did not fail closed'
fi
jq -e '.status == "blocked" and .reasonCode == "SIGNAL_NOT_ALLOWED"' "$unknown_file" >/dev/null || fail 'unknown signal block is malformed'

"$CLI" model telemetry --manifest "$manifest" --decision "$normal_path" \
  --input-tokens 120 --output-tokens 30 --duration-ms 450 --reported-cost-usd 0.012 --success true >/dev/null
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

if "$CLI" model telemetry --manifest "$manifest" --decision "$blocked_path" --input-tokens 1 --output-tokens 1 --duration-ms 1 --success false >/dev/null 2>&1; then
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
[ "$(wc -l <"$telemetry" | tr -d ' ')" -eq 1 ] || fail 'rejected telemetry mutated the telemetry stream'

if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id missing-attempt >/dev/null 2>&1; then
  fail 'route accepted a missing attempt'
fi
if "$CLI" model route --manifest "$manifest" --agent aegis --runtime claude --signal normal --dispatch-id arbitrary-cap --attempt 1 --adapter-capability effort=true >/dev/null 2>&1; then
  fail 'route accepted an arbitrary caller capability flag'
fi

printf 'PASS  Argus model policy: immutable capability-bound decisions, exact persisted routes, and decision-bound sanitized telemetry\n'
