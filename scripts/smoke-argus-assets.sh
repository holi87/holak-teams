#!/usr/bin/env bash
# Validate that all prompt-required Argus assets survive marketplace packaging.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/argus/claude"
MODE="${1:---static}"

source "$ROOT/scripts/lib/argus-smoke-model-control.sh"

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

STATIC_WORK="$(mktemp -d)"
trap 'rm -rf "$STATIC_WORK"' EXIT

copy_sync_fixture() {
  local destination="$1"
  mkdir -p "$destination"
  while IFS= read -r path; do
    [ -f "$ROOT/$path" ] || continue
    mkdir -p "$destination/$(dirname "$path")"
    cp -p "$ROOT/$path" "$destination/$path"
  done < <(cd "$ROOT" && git ls-files --cached --others --exclude-standard -- argus scripts)
  git -C "$destination" init -q
  git -C "$destination" add -f argus scripts
}

"$ROOT/scripts/sync-argus-runtime-assets.mjs" --check
node "$ROOT/scripts/smoke-argus-asset-consumers.mjs"
"$PLUGIN/bin/argus-assets" verify

mkdir "$STATIC_WORK/restrictive-umask"
(umask 077; cp -R "$PLUGIN" "$STATIC_WORK/restrictive-umask/plugin")
node "$STATIC_WORK/restrictive-umask/plugin/bin/argus-assets" verify >/dev/null || \
  fail "content-identical plugin failed verification after restrictive-umask extraction"

# Direct invocation through a symlink must execute argument validation rather than
# silently skipping main().
ln -s "$ROOT" "$STATIC_WORK/repo-link"
if node "$STATIC_WORK/repo-link/scripts/sync-argus-runtime-assets.mjs" --invalid >/dev/null 2>&1; then
  fail "runtime asset sync silently skipped direct invocation through a symlink"
fi

# No generated asset write may follow a file or directory symlink. Both cases run
# against isolated repository fixtures and prove that an external sentinel survives.
copy_sync_fixture "$STATIC_WORK/file-link-repo"
printf 'external-file-sentinel\n' >"$STATIC_WORK/file-sentinel"
rm "$STATIC_WORK/file-link-repo/argus/claude/references/BROWSER-ISOLATION.md"
ln -s "$STATIC_WORK/file-sentinel" "$STATIC_WORK/file-link-repo/argus/claude/references/BROWSER-ISOLATION.md"
if (cd "$STATIC_WORK/file-link-repo" && node scripts/sync-argus-runtime-assets.mjs --write) >/dev/null 2>&1; then
  fail "runtime asset sync accepted a file destination symlink"
fi
grep -Fxq 'external-file-sentinel' "$STATIC_WORK/file-sentinel" || fail "file destination symlink modified an external sentinel"

copy_sync_fixture "$STATIC_WORK/directory-link-repo"
mkdir "$STATIC_WORK/external-references"
printf 'external-directory-sentinel\n' >"$STATIC_WORK/external-references/sentinel"
rm -rf "$STATIC_WORK/directory-link-repo/argus/claude/references"
ln -s "$STATIC_WORK/external-references" "$STATIC_WORK/directory-link-repo/argus/claude/references"
if (cd "$STATIC_WORK/directory-link-repo" && node scripts/sync-argus-runtime-assets.mjs --write) >/dev/null 2>&1; then
  fail "runtime asset sync accepted a directory destination symlink"
fi
grep -Fxq 'external-directory-sentinel' "$STATIC_WORK/external-references/sentinel" || fail "directory destination symlink modified an external sentinel"

# Stale package files are rejected in check mode and removed in write mode without
# touching the declared static plugin components.
copy_sync_fixture "$STATIC_WORK/unowned-repo"
printf 'stale\n' >"$STATIC_WORK/unowned-repo/argus/claude/references/STALE.md"
if (cd "$STATIC_WORK/unowned-repo" && node scripts/sync-argus-runtime-assets.mjs --check) >/dev/null 2>&1; then
  fail "runtime asset check accepted an unowned packaged path"
fi
(cd "$STATIC_WORK/unowned-repo" && node scripts/sync-argus-runtime-assets.mjs --write) >/dev/null
test ! -e "$STATIC_WORK/unowned-repo/argus/claude/references/STALE.md" || fail "runtime asset write retained an unowned packaged path"
test -f "$STATIC_WORK/unowned-repo/argus/claude/.claude-plugin/plugin.json" || fail "unowned cleanup removed the plugin manifest"
test -f "$STATIC_WORK/unowned-repo/argus/claude/agents/odysseus.md" || fail "unowned cleanup removed a generated agent"
test -f "$STATIC_WORK/unowned-repo/argus/claude/bin/argus-assets" || fail "unowned cleanup removed the plugin CLI"
test -f "$STATIC_WORK/unowned-repo/argus/claude/hooks/hooks.json" || fail "unowned cleanup removed plugin hooks"
test -f "$STATIC_WORK/unowned-repo/argus/claude/skills/run/SKILL.md" || fail "unowned cleanup removed the entrypoint"
test -f "$STATIC_WORK/unowned-repo/argus/claude/runtime-assets.json" || fail "unowned cleanup removed the generated manifest"
test -f "$STATIC_WORK/unowned-repo/argus/claude/runtime-reference-inventory.json" || fail "unowned cleanup removed the generated inventory"

node "$PLUGIN/templates/typescript/scripts/hunt-driver.mjs" --help >/dev/null
INVENTORY="$PLUGIN/runtime-reference-inventory.json"
jq -e '
  .schemaVersion == 2 and
  .agentsScanned == 27 and .skillsScanned == 7 and .entrypointsScanned == 1 and
  (.unconsumedAssets | length) == 0 and
  (.unknownAssetReferences | length) == 0 and
  (.unknownProfileReferences | length) == 0 and
  (.unownedPluginReferences | length) == 0 and
  (.unownedRuntimeReferences | length) == 0 and
  (.unownedSkills | length) == 0
' "$INVENTORY" >/dev/null || \
  fail "runtime reference inventory v2 is incomplete or contains unresolved ownership"
jq -e '
  .inventory.path == "runtime-reference-inventory.json" and
  .inventory.schemaVersion == 2 and
  (.inventory.bytes | type) == "number" and
  (.inventory.sha256 | test("^[a-f0-9]{64}$"))
' "$PLUGIN/runtime-assets.json" >/dev/null || fail "runtime manifest does not bind inventory v2 metadata"
jq -e '.pluginAssetReferences[] | select(.value == "skills/orchestration-core/SKILL.md") | .consumers | index("/argus:run")' "$INVENTORY" >/dev/null || \
  fail "runtime reference inventory did not scan the /argus:run entrypoint"
for consumer in \
  "command:argus-assets model benchmark" \
  "command:argus-assets orchestration plan" \
  "command:argus-assets schema validate (schema compatibility)"; do
  jq -e --arg consumer "$consumer" \
    '[.assetConsumers[].consumers[] | select(.consumer == $consumer)] | length > 0' \
    "$INVENTORY" >/dev/null || fail "runtime reference inventory omitted semantic consumer: $consumer"
done
for command in grpcurl buf grpc_cli websocat wscat kcat kafka-console-producer kafka-console-consumer rabbitmqadmin nc; do
  jq -e --arg command "$command" \
    '.commandReferences[] | select(.value == $command) | .consumers == ["proteus"]' \
    "$INVENTORY" >/dev/null || fail "runtime reference inventory omitted or misattributed Proteus command: $command"
done
test -f "$PLUGIN/hooks/hooks.json" || fail "plugin does not package hooks/hooks.json"
jq -e '.assets[] | select(.id == "runtime-schemas")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits canonical schemas"
jq -e '.assets[] | select(.id == "runner-contract")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits runner contract"
jq -e '.assets[] | select(.id == "template-contract")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits template contract"
jq -e '.assets[] | select(.id == "template-policy")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits template policy"
jq -e '
  .templateCompositions.typescript == {source:"argus/framework-template",commonAsset:"common-template",runtimeAsset:"typescript-template"} and
  .templateCompositions.java == {source:"argus/framework-template-java",commonAsset:"common-template",runtimeAsset:"java-template"} and
  .templateCompositions.python == {source:"argus/framework-template-python",commonAsset:"common-template",runtimeAsset:"python-template"} and
  ([.assets[] | select(.id == "common-template")] | length) == 1
' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits template compositions"
while IFS= read -r common_path; do
  for runtime in typescript java python; do
    test ! -e "$PLUGIN/templates/$runtime/$common_path" || fail "$runtime packaged layer duplicates common path: $common_path"
  done
done < <(cd "$PLUGIN/templates/common" && find . -type f -print | sed 's#^./##' | sort)
jq -e '.assets[] | select(.id == "coverage-contract")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits coverage contract"
jq -e '.assets[] | select(.id == "raci-contract")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits RACI contract"
jq -e '.assets[] | select(.id == "raci-matrix")' "$PLUGIN/runtime-assets.json" >/dev/null || fail "plugin runtime manifest omits RACI matrix"
jq -e '.hooks.PreToolUse[] | select(.matcher == "Write|Edit|MultiEdit|Bash")' "$PLUGIN/hooks/hooks.json" >/dev/null || fail "plugin hook does not cover direct and shell writes"

cp -R "$PLUGIN" "$STATIC_WORK/tampered-plugin"
jq '.schemaVersion = 999 | .unknownAssetReferences = [{assetId:"ghost"}]' \
  "$STATIC_WORK/tampered-plugin/runtime-reference-inventory.json" >"$STATIC_WORK/tampered-inventory.json"
mv "$STATIC_WORK/tampered-inventory.json" "$STATIC_WORK/tampered-plugin/runtime-reference-inventory.json"
if "$STATIC_WORK/tampered-plugin/bin/argus-assets" verify >/dev/null 2>&1; then
  fail "argus-assets verify accepted inventory content outside its manifest digest"
fi

if command -v claude >/dev/null 2>&1; then
  claude plugin validate --strict "$PLUGIN" >/dev/null
else
  [ "$MODE" != "--installed" ] || fail "claude CLI is required for --installed"
fi

printf 'PASS  Argus runtime assets static contract\n'

case "$MODE" in
  --static)
    exit 0
    ;;
  --installed)
    ;;
  *)
    fail "usage: $0 [--static|--installed]"
    ;;
esac

command -v claude >/dev/null 2>&1 || fail "claude CLI is required for --installed"

CONFIG_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
HOST_DIR="$(mktemp -d)"
trap 'rm -rf "$STATIC_WORK" "$CONFIG_DIR" "$WORK_DIR" "$HOST_DIR"' EXIT

CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin marketplace add "$ROOT" >/dev/null
CLAUDE_CONFIG_DIR="$CONFIG_DIR" claude plugin install argus@holak-teams --scope user >/dev/null

INSTALLED_PLUGIN="$(find "$CONFIG_DIR/plugins/cache/holak-teams/argus" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$INSTALLED_PLUGIN" ] && [ -d "$INSTALLED_PLUGIN" ] || fail "clean marketplace install did not create an Argus plugin cache"
test -f "$INSTALLED_PLUGIN/hooks/hooks.json" || fail "clean marketplace install omitted the PreToolUse hook"

if find "$INSTALLED_PLUGIN" -type l -print -quit | grep -q .; then
  fail "installed plugin contains a symlink instead of self-contained assets"
fi

(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" verify)
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template typescript "$WORK_DIR/typescript")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template java "$WORK_DIR/java")
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-template python "$WORK_DIR/python")
for runtime in typescript java python; do
  test -f "$WORK_DIR/$runtime/solution/TRACEABILITY.md" || fail "$runtime composition omitted shared solution documents"
  test -f "$WORK_DIR/$runtime/solution/ARCHITECTURE.md" || fail "$runtime composition omitted runtime architecture"
  test -x "$WORK_DIR/$runtime/scripts/runner-contract.sh" || fail "$runtime composition lost executable mode"
done
mkdir "$WORK_DIR/driver-target"
(cd "$WORK_DIR" && "$INSTALLED_PLUGIN/bin/argus-assets" copy-browser-driver "$WORK_DIR/driver-target")
mkdir "$WORK_DIR/preflight-target"
mkdir "$WORK_DIR/template-target"
"$INSTALLED_PLUGIN/bin/argus-assets" template detect --target "$WORK_DIR/template-target" --output "$WORK_DIR/template-capabilities.json" >/dev/null
"$INSTALLED_PLUGIN/bin/argus-assets" template select --target "$WORK_DIR/template-target" \
  --runtime typescript --package-manager npm --test-root qa/specs --harness-root qa/support \
  --output "$WORK_DIR/template-selection.json" >/dev/null
"$INSTALLED_PLUGIN/bin/argus-assets" template scaffold --selection "$WORK_DIR/template-selection.json" \
  --destination "$WORK_DIR/selected-typescript" >/dev/null
jq -e '.action == "build" and .choiceSource == "explicit-user"' "$WORK_DIR/selected-typescript/ai_agents_internal/template-selection.json" >/dev/null
mkdir "$WORK_DIR/preflight-target/ai_agents_internal"
cp "$ROOT/scripts/fixtures/argus-authorization/full.json" "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json"
(
  cd "$WORK_DIR"
  ARGUS_SMOKE_REAL_CLI="$INSTALLED_PLUGIN/bin/argus-assets" \
    ARGUS_SMOKE_HOST_ROOT="$HOST_DIR/native-launch" \
    ARGUS_SMOKE_LAUNCHER="$INSTALLED_PLUGIN/bin/argus-launch" \
    ARGUS_SMOKE_CLAUDE="$ROOT/scripts/fixtures/argus-launcher/claude" \
    "$ROOT/scripts/lib/argus-smoke-cli.sh" preflight \
    --target "$WORK_DIR/preflight-target" \
    --mode A \
    --authorization "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json" \
    --profile "$ROOT/scripts/fixtures/argus-preflight/full.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" authorization check \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/authorization.json" \
    --lane hermes --action load --target "$WORK_DIR/preflight-target" \
    --source-trust user --rate 1 --concurrency 1 --total-requests 10 --duration 10 \
    --at 2026-07-10T12:00:00.000Z \
    >/dev/null
  printf '%s\n' '{"password":"installed-secret","email":"installed@example.com"}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" redact --input - --output "$WORK_DIR/preflight-target/redacted.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" engagement validate \
    --manifest "$WORK_DIR/preflight-target/ai_agents_internal/engagement.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" schema validate \
    --kind final-summary --input "$ROOT/scripts/fixtures/argus-schemas/valid/final-summary.json" \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" coverage validate \
    --inventory "$ROOT/scripts/fixtures/argus-coverage/surface-inventory.json" \
    --observations "$ROOT/scripts/fixtures/argus-coverage/coverage-observations.json" \
    >/dev/null
  test "$("$INSTALLED_PLUGIN/bin/argus-assets" raci route --surface api-rest --activity discover | jq -r .accountable)" = atalanta
  test "$("$INSTALLED_PLUGIN/bin/argus-assets" raci route --activity persist | jq -r .accountable)" = minos
  control_manifest="$WORK_DIR/preflight-target/ai_agents_internal/engagement.json"
  argus_smoke_prepare_model_control "$INSTALLED_PLUGIN/bin/argus-assets" "$control_manifest" \
    "$WORK_DIR/preflight-target" "$WORK_DIR/preflight-target" A \
    "$ROOT/scripts/fixtures/argus-preflight/full.json" "$HOST_DIR"
  controller="$(argus_smoke_allocate "$INSTALLED_PLUGIN/bin/argus-assets" "$control_manifest" "$HOST_DIR" odysseus)"
  controller_lease="$(jq -r .token <<<"$controller")"
  allocation="$(argus_smoke_allocate "$INSTALLED_PLUGIN/bin/argus-assets" "$control_manifest" "$HOST_DIR" kleio "$controller_lease")"
  lease="$(jq -r .token <<<"$allocation")"
  "$INSTALLED_PLUGIN/bin/argus-assets" engagement cleanup \
    --manifest "$control_manifest" \
    --lane kleio --token "$lease" --outcome interrupted \
    >/dev/null
  "$INSTALLED_PLUGIN/bin/argus-assets" engagement cleanup \
    --manifest "$control_manifest" --lane odysseus --token "$controller_lease" --outcome interrupted \
    >/dev/null
)

(
  cd "$WORK_DIR"
  node typescript/scripts/hunt-driver.mjs --help >/dev/null
  node driver-target/scripts/hunt-driver.mjs --help >/dev/null
  printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/typescript","tool_input":{"file_path":"tests/smoke.spec.ts"}}' | node typescript/scripts/app-source-guard.mjs
  if printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/typescript","tool_input":{"file_path":"app/source.ts"}}' | node typescript/scripts/app-source-guard.mjs >/dev/null 2>&1; then
    fail "packaged app-source guard allowed an application-source write"
  fi
  SMOKE=1 node typescript/scripts/bug-coverage.mjs >/dev/null 2>&1
  cp "$ROOT/scripts/fixtures/argus-coverage/surface-inventory.json" typescript/solution/surface-inventory.json
  cp "$ROOT/scripts/fixtures/argus-coverage/coverage-observations.json" typescript/solution/coverage-observations.json
  ARGUS_ASSETS="$INSTALLED_PLUGIN/bin/argus-assets" node typescript/scripts/baseline-coverage.mjs >/dev/null
  jq -e '."$schema" == "argus/coverage-result@1" and .defectOutcomes.scoreContribution == 0' typescript/solution/coverage-result.json >/dev/null
  bash -n typescript/run-tests.sh java/run-tests.sh python/run-tests.sh
  for template in typescript java python; do
    test -x "$template/scripts/runner-contract.sh" || fail "$template template omitted runner contract evaluator"
    "$template/scripts/runner-contract.sh" --mode baseline \
      --events "$ROOT/scripts/fixtures/argus-runner/baseline.tsv" \
      --output "$WORK_DIR/$template-runner-result.json" --runner-exit 0
    jq -e '."$schema" == "argus/runner-result@1" and .exitCode == 0' "$WORK_DIR/$template-runner-result.json" >/dev/null
  done
  test -f driver-target/scripts/driver-config.schema.json
  test -f typescript/solution/bug-ledger.example.json
  node - <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('preflight-target/ai_agents_internal/preflight.json', 'utf8'));
if (report.status !== 'ready' || report.summary.ready !== 27) throw new Error('installed preflight did not evaluate all 27 agents as ready');
if (!report.engagement?.hookPackaged || !report.engagement?.sha256 || report.engagement?.phase !== 'discovery') throw new Error('installed preflight did not create guarded engagement state');
NODE
  if grep -Fq 'installed-secret' preflight-target/redacted.json; then
    fail "installed redactor leaked a secret"
  fi
  test -f preflight-target/ai_agents_internal/authorization-audit.jsonl
  test -f preflight-target/ai_agents_internal/engagement.json
  test -f preflight-target/ai_agents_internal/engagement-state.json
  denied="$(printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/preflight-target","tool_input":{"file_path":"app/source.ts","content":"installed-secret"}}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" guard)"
  grep -Fq 'GUARD-TARGET-IMMUTABLE' <<<"$denied" || fail "installed guard allowed target-source mutation"
  allowed="$(printf '%s\n' '{"tool_name":"Write","cwd":"'"$WORK_DIR"'/preflight-target","tool_input":{"file_path":"tests/installed.spec.ts","content":"safe"}}' | \
    "$INSTALLED_PLUGIN/bin/argus-assets" guard)"
  test -z "$allowed" || fail "installed guard denied generated-test output"
  if grep -Fq 'installed-secret' preflight-target/ai_agents_internal/immutability-audit.jsonl; then
    fail "installed guard audit leaked tool content"
  fi
)

printf 'PASS  clean marketplace install runs packaged assets outside repository\n'
