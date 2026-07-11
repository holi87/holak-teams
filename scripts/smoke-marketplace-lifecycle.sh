#!/usr/bin/env bash
# Clean-install the previous release, update the marketplace, update Argus, and
# exercise two installed specialist leases without requiring third-party APIs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT="$(jq -r '.version' "$ROOT/argus/claude/.claude-plugin/plugin.json")"
if [ -n "${ARGUS_PREVIOUS_VERSION:-}" ]; then
  PREVIOUS="$ARGUS_PREVIOUS_VERSION"
else
  PREVIOUS=""
  while read -r revision; do
    candidate="$(git -C "$ROOT" show "$revision:argus/claude/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version' || true)"
    if [ -n "$candidate" ] && [ "$candidate" != null ] && [ "$candidate" != "$CURRENT" ]; then
      PREVIOUS="$candidate"
      break
    fi
  done < <(git -C "$ROOT" rev-list --first-parent HEAD)
fi
WORK="$(mktemp -d)"
SOURCE="$WORK/marketplace"
CONFIG="$WORK/config"
TARGET="$WORK/target"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || fail 'claude CLI is required for marketplace lifecycle smoke'
[ "$CURRENT" != "$PREVIOUS" ] || fail "current version must differ from previous release $PREVIOUS"
[ -n "$PREVIOUS" ] && [ "$PREVIOUS" != null ] || fail 'previous Argus release could not be derived from Git history'

mkdir -p "$SOURCE" "$CONFIG" "$TARGET"
cp -R "$ROOT/.claude-plugin" "$ROOT/argus" "$ROOT/hephaestus" "$SOURCE/"
node "$ROOT/scripts/release-plugin.mjs" --root "$SOURCE" --plugin argus --set "$PREVIOUS" --write --allow-downgrade >/dev/null

git -C "$SOURCE" init -q
git -C "$SOURCE" config user.name 'Argus CI'
git -C "$SOURCE" config user.email 'argus-ci@example.invalid'
git -C "$SOURCE" add .
git -C "$SOURCE" commit -qm "Previous marketplace release"

CLAUDE_CONFIG_DIR="$CONFIG" claude plugin marketplace add "$SOURCE" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG" claude plugin install argus@holak-teams --scope user >/dev/null
test -d "$CONFIG/plugins/cache/holak-teams/argus/$PREVIOUS" || fail "clean install omitted Argus $PREVIOUS cache"

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
mkdir "$TARGET/ai_agents_internal"
cp "$ROOT/scripts/fixtures/argus-authorization/full.json" "$TARGET/ai_agents_internal/authorization.json"
"$INSTALLED/bin/argus-assets" preflight --target "$TARGET" --mode A \
  --authorization "$TARGET/ai_agents_internal/authorization.json" \
  --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" >/dev/null
MANIFEST="$TARGET/ai_agents_internal/engagement.json"
for lane in kleio theseus; do
  allocation="$("$INSTALLED/bin/argus-assets" engagement allocate --manifest "$MANIFEST" --lane "$lane")"
  token="$(jq -r .token <<<"$allocation")"
  "$INSTALLED/bin/argus-assets" engagement cleanup --manifest "$MANIFEST" \
    --lane "$lane" --token "$token" --outcome success >/dev/null
done
node - "$TARGET/ai_agents_internal/engagement-state.json" <<'NODE'
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const lane of ['kleio', 'theseus']) {
  if (state.allocations[lane]?.status !== 'released') throw new Error(`${lane} lease was not released`);
}
NODE

printf 'PASS  Marketplace lifecycle: clean install %s -> update %s, 27 agents, two-lane installed smoke\n' "$PREVIOUS" "$CURRENT"
