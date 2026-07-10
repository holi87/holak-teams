#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

jq empty "$ROOT/argus/raci.json" "$ROOT/argus/schemas/raci.schema.json"
node "$ROOT/scripts/sync-argus-raci.mjs" --check
node "$ROOT/scripts/sync-argus-runtime-assets.mjs" --check >/dev/null

[ "$(jq -r '.accountable' <<<"$($CLI raci route --surface event-protocol --activity discover)")" = proteus ] || fail 'event discovery did not route to Proteus'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --surface data-direct --activity automate)")" = mnemosyne ] || fail 'direct-data automation did not route to Mnemosyne'
[ "$(jq -r '.gate' <<<"$($CLI raci route --surface data-direct --activity discover)")" = db-access ] || fail 'direct-data route lost its DB gate'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --activity persist)")" = minos ] || fail 'canonical defect persistence did not route to Minos'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --artifact solution/STATE_MODEL.md)")" = ariadne ] || fail 'STATE_MODEL ownership did not route to Ariadne'
[ "$(jq -r '.accountable' <<<"$($CLI raci route --transition defect:confirmed:automated)")" = atlas ] || fail 'defect automation transition did not route to Atlas'
if "$CLI" raci route --surface unknown --activity discover >/dev/null 2>&1; then fail 'unknown surface route was accepted'; fi

for file in "$ROOT/argus/claude/agents/atlas.md" "$ROOT/argus/codex/atlas.md" "$ROOT/argus/codex/atlas.toml"; do
  grep -Fq '## Ten shared oracle helpers' "$file" || fail "Atlas helper heading is stale in $file"
  count="$(awk '/^## Ten shared oracle helpers/{inside=1; next} inside && /^Rules:/{inside=0} inside && /^\| `/{count++} END{print count+0}' "$file")"
  [ "$count" -eq 10 ] || fail "Atlas declares ten helpers but lists $count in $file"
done

grep -Eq '^tools: .*Write' "$ROOT/argus/claude/agents/tiresias.md" && fail 'Tiresias unexpectedly has Write'
grep -Fq 'Minos persists' "$ROOT/argus/claude/agents/tiresias.md" || fail 'Tiresias persistence handoff is missing'
grep -Fq 'execute it unless the user explicitly requested planning only' "$ROOT/argus/claude/agents/odysseus.md" || fail 'Odysseus plan-versus-execute behavior is ambiguous'
grep -Fq '<!-- RACI_ROSTER_START -->' "$ROOT/argus/README.md" || fail 'README roster is not generated from RACI'

printf 'PASS  Argus RACI: runtime routing, single-owner artifacts/transitions, 27 descriptions, roster, and known contradiction regressions\n'
