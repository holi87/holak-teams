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
  local mode="${2:---write}"
  node "$repo/scripts/sync-argus-model-policy.mjs" "$mode" >/dev/null
  node "$repo/scripts/sync-argus-raci.mjs" "$mode" >/dev/null
  node "$repo/scripts/refactor-argus-prompts.mjs" "$mode" >/dev/null
}

expect_generator_failure() {
  local repo="$1"
  local mode="$2"
  local label="$3"
  if node "$repo/scripts/sync-argus-role-variants.mjs" "$mode" >"$WORK/generator.out" 2>"$WORK/generator.err"; then
    fail "$label was accepted in $mode mode"
  fi
}

node "$ROOT/scripts/sync-argus-role-variants.mjs" --check >/dev/null
snapshot_variants "$ROOT" "$WORK/root-before-secondary"
run_secondary_writers "$ROOT" --check
snapshot_variants "$ROOT" "$WORK/root-after-secondary"
cmp -s "$WORK/root-before-secondary" "$WORK/root-after-secondary" || fail 'a read-only generator check changed runtime role variants'

if node "$ROOT/scripts/sync-argus-role-variants.mjs" --bootstrap >/dev/null 2>&1; then
  fail 'retired generated-to-canonical bootstrap mode is still accepted'
fi
snapshot_variants "$ROOT" "$WORK/root-after-bootstrap"
cmp -s "$WORK/root-after-secondary" "$WORK/root-after-bootstrap" || fail 'rejected bootstrap mode changed runtime variants'

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
node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
snapshot_variants "$CASE" "$WORK/case-idempotent"
cmp -s "$WORK/case-canonical" "$WORK/case-idempotent" || fail 'role-variant generation is not byte-idempotent'

cp "$CASE/argus/codex/aegis.toml" "$WORK/aegis.toml"
printf 'DO-NOT-OVERWRITE\n' >"$WORK/external-output-sentinel"
cp "$WORK/external-output-sentinel" "$WORK/external-output-sentinel.expected"
for generator_mode in --write --check; do
  rm "$CASE/argus/codex/aegis.toml"
  ln -s "$WORK/external-output-sentinel" "$CASE/argus/codex/aegis.toml"
  expect_generator_failure "$CASE" "$generator_mode" 'symlinked generated leaf'
  cmp -s "$WORK/external-output-sentinel.expected" "$WORK/external-output-sentinel" || fail "symlinked generated leaf overwrote the external sentinel in $generator_mode mode"
  rm "$CASE/argus/codex/aegis.toml"
  cp "$WORK/aegis.toml" "$CASE/argus/codex/aegis.toml"
done

mv "$CASE/argus/codex" "$CASE/argus/codex.real"
mkdir "$WORK/external-codex"
printf 'DO-NOT-OVERWRITE\n' >"$WORK/external-codex/sentinel"
ln -s "$WORK/external-codex" "$CASE/argus/codex"
for generator_mode in --write --check; do
  expect_generator_failure "$CASE" "$generator_mode" 'symlinked generated parent directory'
  test "$(cat "$WORK/external-codex/sentinel")" = 'DO-NOT-OVERWRITE' || fail "symlinked generated directory overwrote the external sentinel in $generator_mode mode"
  test "$(find "$WORK/external-codex" -maxdepth 1 -type f | wc -l | tr -d ' ')" = 1 || fail "symlinked generated directory created external files in $generator_mode mode"
done
rm "$CASE/argus/codex"
mv "$CASE/argus/codex.real" "$CASE/argus/codex"

cp "$CASE/argus/roles/aegis.md" "$WORK/aegis-source.md"
rm "$CASE/argus/roles/aegis.md"
ln -s "$WORK/aegis-source.md" "$CASE/argus/roles/aegis.md"
for generator_mode in --write --check; do
  snapshot_variants "$CASE" "$WORK/source-symlink-before"
  expect_generator_failure "$CASE" "$generator_mode" 'symlinked canonical source leaf'
  snapshot_variants "$CASE" "$WORK/source-symlink-after"
  cmp -s "$WORK/source-symlink-before" "$WORK/source-symlink-after" || fail "symlinked source changed generated variants in $generator_mode mode"
done
rm "$CASE/argus/roles/aegis.md"
cp "$WORK/aegis-source.md" "$CASE/argus/roles/aegis.md"

mv "$CASE/argus/shared-skills" "$WORK/external-shared-skills"
ln -s "$WORK/external-shared-skills" "$CASE/argus/shared-skills"
snapshot_variants "$CASE" "$WORK/source-parent-before"
expect_generator_failure "$CASE" --write 'symlinked canonical source parent directory'
snapshot_variants "$CASE" "$WORK/source-parent-after"
cmp -s "$WORK/source-parent-before" "$WORK/source-parent-after" || fail 'symlinked source parent changed generated variants'
rm "$CASE/argus/shared-skills"
mv "$WORK/external-shared-skills" "$CASE/argus/shared-skills"

rm "$CASE/argus/claude/agents/aegis.md"
node "$CASE/scripts/sync-argus-role-variants.mjs" --write >/dev/null
cmp -s "$CASE/argus/claude/agents/aegis.md" "$ROOT/argus/claude/agents/aegis.md" || fail 'atomic publisher did not recreate a missing generated leaf'
find "$CASE/argus/claude/agents" "$CASE/argus/codex" -maxdepth 1 -type f -name '.*.tmp' -print -quit | grep -q . && fail 'atomic publisher left a temporary generated file'

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

printf 'PASS  Argus generator ownership: sole writer, atomic idempotent repair, source/output symlink rejection, external sentinels, RACI/model propagation, and retired bootstrap\n'
