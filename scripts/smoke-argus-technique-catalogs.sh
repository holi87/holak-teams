#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

jq empty \
  "$ROOT/argus/schemas/technique-catalog.schema.json" \
  "$ROOT/argus/technique-catalogs/atalanta.json" \
  "$ROOT/argus/technique-catalogs/proteus.json" \
  "$ROOT/argus/technique-catalogs/metis.json" \
  "$ROOT/scripts/fixtures/argus-technique-catalogs/mutations.json"

node "$ROOT/scripts/validate-argus-technique-catalogs.mjs"
