#!/usr/bin/env bash
# Install the immediately previous Argus release, update to the current major,
# and prove a clean current engagement. Active pre-v3 engagements are not resumed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/argus-smoke-model-control.sh"
CURRENT="$(jq -r '.version' "$ROOT/argus/claude/.claude-plugin/plugin.json")"
PREVIOUS_REVISION="${ARGUS_PREVIOUS_REVISION:-}"

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

if [ -z "$PREVIOUS_REVISION" ]; then
  while read -r revision; do
    candidate="$(git -C "$ROOT" show "${revision}:argus/claude/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' || true)"
    if [ -n "$candidate" ] && [ "$candidate" != null ] && [ "$candidate" != "$CURRENT" ]; then
      PREVIOUS_REVISION="$revision"
      PREVIOUS="$candidate"
      break
    fi
  done < <(git -C "$ROOT" rev-list --first-parent HEAD)
else
  PREVIOUS="$(git -C "$ROOT" show "${PREVIOUS_REVISION}:argus/claude/.claude-plugin/plugin.json" | jq -r '.version')"
fi

[ -n "${PREVIOUS_REVISION:-}" ] && [ -n "${PREVIOUS:-}" ] || fail 'previous Argus release could not be derived'
[ "$PREVIOUS" != "$CURRENT" ] || fail 'previous and current Argus versions must differ'
command -v claude >/dev/null 2>&1 || fail 'claude CLI is required'

WORK="$(mktemp -d)"
SOURCE="$WORK/marketplace"
CONFIG="$WORK/config"
TARGET="$WORK/target"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$SOURCE" "$CONFIG" "$TARGET/ai_agents_internal"

git -C "$ROOT" archive "$PREVIOUS_REVISION" .claude-plugin argus hephaestus | tar -xf - -C "$SOURCE"
git -C "$SOURCE" init -q
git -C "$SOURCE" config user.name 'Argus CI'
git -C "$SOURCE" config user.email 'argus-ci@example.invalid'
git -C "$SOURCE" add .
git -C "$SOURCE" commit -qm 'Previous marketplace release'

CLAUDE_CONFIG_DIR="$CONFIG" claude plugin marketplace add "$SOURCE" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin install argus@holak-teams --scope user >/dev/null
test -d "$CONFIG/plugins/cache/holak-teams/argus/$PREVIOUS" || fail "clean install omitted Argus $PREVIOUS"

rm -rf "$SOURCE/.claude-plugin" "$SOURCE/argus" "$SOURCE/hephaestus"
cp -R "$ROOT/.claude-plugin" "$ROOT/argus" "$ROOT/hephaestus" "$SOURCE/"
git -C "$SOURCE" add .
git -C "$SOURCE" commit -qm 'Current marketplace release'
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin marketplace update holak-teams >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin update argus@holak-teams --scope user >/dev/null

INSTALLED="$CONFIG/plugins/cache/holak-teams/argus/$CURRENT"
test -d "$INSTALLED" || fail "marketplace update omitted Argus $CURRENT"
test -x "$INSTALLED/bin/argus-launch" || fail 'updated plugin omitted the native launcher'
test ! -e "$INSTALLED/schemas/preflight-report-v1.schema.json" || fail 'updated plugin retained the preflight v1 reader'
test ! -e "$INSTALLED/schemas/engagement-state-v1.schema.json" || fail 'updated plugin retained the engagement-state v1 reader'
"$INSTALLED/bin/argus-assets" verify >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin details argus@holak-teams >"$WORK/details.txt"
grep -Fq 'Agents (27)' "$WORK/details.txt" || fail 'updated plugin does not expose 27 agents'

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
  "$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$MANIFEST" --lane "$lane" --token "$token" --outcome interrupted >/dev/null
done
"$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$MANIFEST" --lane odysseus --token "$controller_token" --outcome interrupted >/dev/null
jq -e '.schemaVersion == 2 and (has("migrations") | not) and ([.allocations[] | select(.status == "active")] | length) == 0' \
  "$TARGET/ai_agents_internal/engagement-state.json" >/dev/null || fail 'current lifecycle left incompatible or active state'

printf 'PASS  Marketplace lifecycle: %s -> %s clean major update, retired readers absent, current two-lane smoke\n' "$PREVIOUS" "$CURRENT"
