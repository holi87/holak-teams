#!/usr/bin/env bash
# Prove lazy catalog selection, integrity binding, and conservative full fallback.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
SOURCE="$ROOT/scripts/fixtures/argus-coverage/surface-inventory.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node "$ROOT/scripts/sync-argus-technique-bundle.mjs" --check >/dev/null

"$CLI" technique scopes --role proteus >"$WORK/proteus-scopes.json"
jq -e '.schema == "argus/technique-scope-list@1" and (.scopes | index("proteus:graphql")) != null and (.scopes | index("proteus:websocket-sse")) != null' "$WORK/proteus-scopes.json" >/dev/null

"$CLI" technique select --role atalanta --inventory "$SOURCE" >"$WORK/atalanta-full.json"
jq -e '.disposition == "full-fallback" and .reason == "missing-role-scopes" and (.selectedIds | length) == 20 and (.catalog.entries | length) == 20' "$WORK/atalanta-full.json" >/dev/null

jq '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:["atalanta:validation"]}' "$SOURCE" >"$WORK/atalanta-inventory.json"
"$CLI" technique select --role atalanta --inventory "$WORK/atalanta-inventory.json" >"$WORK/atalanta-selected.json"
jq -e '.disposition == "selected" and (.selectedIds | length) < 20 and (.selectedIds | index("ATA-T01")) != null and (.catalog.entries | length) == (.selectedIds | length)' "$WORK/atalanta-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-EVENT-ORDER-CREATED")) += {techniqueScopes:["proteus:graphql"]}' "$SOURCE" >"$WORK/proteus-inventory.json"
"$CLI" technique select --role proteus --inventory "$WORK/proteus-inventory.json" >"$WORK/proteus-selected.json"
jq -e '.disposition == "selected" and .selectedIds == ["PRO-T01", "PRO-T02", "PRO-T03", "PRO-T04"]' "$WORK/proteus-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-UI-CHECKOUT")) += {techniqueScopes:["metis:security"]}' "$SOURCE" >"$WORK/metis-inventory.json"
"$CLI" technique select --role metis --inventory "$WORK/metis-inventory.json" >"$WORK/metis-selected.json"
jq -e '.disposition == "selected" and .selectedIds == ["security"] and (.catalog.istqb.techniques | length) > 0 and .catalog.boundaryRegister.required == true' "$WORK/metis-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-EVENT-ORDER-CREATED")) += {techniqueScopes:["proteus:unknown-scope"]}' "$SOURCE" >"$WORK/proteus-unknown.json"
"$CLI" technique select --role proteus --inventory "$WORK/proteus-unknown.json" >"$WORK/proteus-fallback.json"
jq -e '.disposition == "full-fallback" and (.reason | startswith("unknown-role-scopes:")) and (.selectedIds | length) == 15' "$WORK/proteus-fallback.json" >/dev/null

printf 'PASS  Argus lazy technique selection: scoped Atalanta/Proteus/Metis plus full fallback\n'
