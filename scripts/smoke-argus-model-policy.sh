#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POLICY="$ROOT/argus/model-policy.json"
CLI="$ROOT/argus/claude/bin/argus-assets"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

jq empty "$POLICY" "$ROOT/argus/schemas/model-policy.schema.json" "$ROOT/argus/schemas/model-telemetry-event.schema.json"
node "$ROOT/scripts/sync-argus-model-policy.mjs" --check
node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --check >/dev/null

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
  for file in "$ROOT/argus/claude/agents/$slug.md" "$ROOT/argus/codex/$slug.md" "$ROOT/argus/codex/$slug.toml"; do
    grep -Fq '## Runtime Model Policy' "$file" || fail "$slug model-policy block missing in $file"
    grep -Fq 'weaker-model fallback is forbidden' "$file" || fail "$slug weaker fallback guard missing in $file"
  done
done

normal="$($CLI model route --agent aegis --runtime claude --signal normal)"
[ "$(jq -r '.model' <<<"$normal")" = sonnet ] || fail 'standard baseline did not select Sonnet'
[ "$(jq -r '.maxTurns' <<<"$normal")" -eq 48 ] || fail 'Aegis turn budget drifted'

escalated="$($CLI model route --agent aegis --runtime codex --signal safety)"
[ "$(jq -r '.model' <<<"$escalated")" = sol ] || fail 'safety escalation did not select Codex frontier'
[ "$(jq -r '.fallbackUsed' <<<"$escalated")" = true ] || fail 'safety escalation was not recorded'
[ "$(jq -r '.weakerFallbackAllowed' <<<"$escalated")" = false ] || fail 'route permits weaker fallback'

blocked_file="$(mktemp)"
if "$CLI" model route --agent perseus --runtime claude --signal model-unavailable >"$blocked_file"; then
  fail 'frontier unavailability did not fail closed'
fi
[ "$(jq -r '.status' "$blocked_file")" = blocked ] || fail 'frontier block decision missing'
[ "$(jq -r '.operatorEscalation' "$blocked_file")" = true ] || fail 'frontier block did not escalate to operator'
rm -f "$blocked_file"

mechanical="$($CLI model route --agent theseus --signal schema-validated-mechanical --schema-validated true --bounded-subrole true)"
[ "$(jq -r '.selectedTier' <<<"$mechanical")" = standard ] || fail 'full Theseus role incorrectly downgraded to mechanical'

work="$(mktemp -d)"
(
  cd "$work"
  "$CLI" model telemetry --agent aegis --runtime claude --signal normal \
    --input-tokens 120 --output-tokens 30 --duration-ms 450 --reported-cost-usd 0.012 \
    --success true --at 2026-07-11T00:00:00.000Z >/dev/null
)
event="$work/ai_agents_internal/model-telemetry.jsonl"
[ -f "$event" ] || fail 'telemetry event was not written'
[ "$(wc -l <"$event" | tr -d ' ')" -eq 1 ] || fail 'telemetry event count drifted'
jq -e '.schema == "argus/model-telemetry-event@1" and .totalTokens == 150 and .durationMs == 450 and .reportedCostUsd == 0.012' "$event" >/dev/null || fail 'telemetry metrics are malformed'
for forbidden in prompt completion target url path account token evidence; do
  jq -e --arg field "$forbidden" 'has($field) | not' "$event" >/dev/null || fail "telemetry leaked forbidden field: $forbidden"
done
if (cd "$work" && "$CLI" model telemetry --agent aegis --input-tokens 1 --output-tokens 1 --duration-ms 1 --success true --output ../escape.jsonl >/dev/null 2>&1); then
  fail 'telemetry accepted an escaping output path'
fi
rm -rf "$work"

printf 'PASS  Argus model policy: 10/17 tiers, explicit effort/turns/escalation, upward-only fallback, mechanical guard, sanitized telemetry\n'
