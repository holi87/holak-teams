#!/usr/bin/env bash
# Prove that one generator exclusively owns every Argus runtime role variant.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

snapshot_variants() {
  local repo="$1"
  local output="$2"
  (
    cd "$repo"
    {
      find argus/claude/agents -maxdepth 1 -type f -name '*.md' -print
      find argus/codex -maxdepth 1 -type f \( -name '*.md' -o -name '*.toml' \) -print
    } | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done
  ) >"$output"
}

run_secondary_writers() {
  local repo="$1"
  node "$repo/scripts/sync-argus-model-policy.mjs" --write >/dev/null
  node "$repo/scripts/sync-argus-raci.mjs" --write >/dev/null
  node "$repo/scripts/refactor-argus-prompts.mjs" --write >/dev/null
}

node "$ROOT/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$ROOT" "$WORK/root-before-secondary"
run_secondary_writers "$ROOT"
snapshot_variants "$ROOT" "$WORK/root-after-secondary"
cmp -s "$WORK/root-before-secondary" "$WORK/root-after-secondary" || fail 'a secondary generator changed runtime role variants'

node "$ROOT/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$ROOT" "$WORK/root-primary-first"
node "$ROOT/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$ROOT" "$WORK/root-primary-second"
cmp -s "$WORK/root-primary-first" "$WORK/root-primary-second" || fail 'role-variant generation is not byte-idempotent'

if node "$ROOT/scripts/sync-argus-role-variants.mjs" --bootstrap >/dev/null 2>&1; then
  fail 'retired generated-to-canonical bootstrap mode is still accepted'
fi
snapshot_variants "$ROOT" "$WORK/root-after-bootstrap"
cmp -s "$WORK/root-primary-second" "$WORK/root-after-bootstrap" || fail 'rejected bootstrap mode changed runtime variants'

CASE="$WORK/case"
mkdir -p "$CASE/scripts" "$CASE/argus/claude"
test -d "$ROOT/node_modules" || fail 'node_modules is required for the isolated generator ownership case'
ln -s "$ROOT/node_modules" "$CASE/node_modules"
cp "$ROOT/README.md" "$ROOT/agents-roster.html" "$CASE/"
cp "$ROOT/scripts/sync-argus-role-variants.mjs" "$ROOT/scripts/sync-argus-model-policy.mjs" "$ROOT/scripts/sync-argus-raci.mjs" "$ROOT/scripts/refactor-argus-prompts.mjs" "$CASE/scripts/"
cp -R "$ROOT/argus/roles" "$ROOT/argus/capabilities" "$ROOT/argus/policies" "$ROOT/argus/runtime" "$ROOT/argus/shared-skills" "$ROOT/argus/schemas" "$ROOT/argus/technique-catalogs" "$ROOT/argus/codex" "$CASE/argus/"
cp -R "$ROOT/argus/claude/agents" "$CASE/argus/claude/"
cp "$ROOT/argus/model-policy.json" "$ROOT/argus/runtime-adapters.json" "$ROOT/argus/raci.json" "$ROOT/argus/MODEL-POLICY.md" "$ROOT/argus/RACI-CONTRACT.md" "$ROOT/argus/README.md" "$CASE/argus/"

node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-canonical"
printf '\nSECONDARY-WRITER-CORRUPTION\n' >>"$CASE/argus/claude/agents/aegis.md"
snapshot_variants "$CASE" "$WORK/case-corrupt"
run_secondary_writers "$CASE"
snapshot_variants "$CASE" "$WORK/case-after-secondary"
cmp -s "$WORK/case-corrupt" "$WORK/case-after-secondary" || fail 'a secondary generator repaired or rewrote corrupted runtime output'
node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-repaired"
cmp -s "$WORK/case-canonical" "$WORK/case-repaired" || fail 'the sole role generator did not repair corrupted runtime output'

node - "$CASE/argus/raci.json" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
data.agents.find((agent) => agent.slug === 'aegis').description += ' Ownership smoke mutation.';
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
NODE
snapshot_variants "$CASE" "$WORK/case-before-raci"
node "$CASE/scripts/sync-argus-raci.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-after-raci-secondary"
cmp -s "$WORK/case-before-raci" "$WORK/case-after-raci-secondary" || fail 'RACI document generator wrote runtime variants'
node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-after-raci-primary"
cmp -s "$WORK/case-before-raci" "$WORK/case-after-raci-primary" && fail 'role generator ignored a RACI description change'

node - "$CASE/argus/model-policy.json" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
data.roles.find((role) => role.slug === 'aegis').maxTurns += 1;
fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
NODE
snapshot_variants "$CASE" "$WORK/case-before-model"
node "$CASE/scripts/sync-argus-model-policy.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-after-model-secondary"
cmp -s "$WORK/case-before-model" "$WORK/case-after-model-secondary" || fail 'model-policy document generator wrote runtime variants'
node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-after-model-primary"
cmp -s "$WORK/case-before-model" "$WORK/case-after-model-primary" && fail 'role generator ignored a model-policy change'

printf 'PASS  Argus generator ownership: sole writer, idempotence, corruption repair, RACI/model propagation, and retired bootstrap\n'
