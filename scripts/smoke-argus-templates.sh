#!/usr/bin/env bash
# Clean-room validation for capability detection, explicit selection, path-agnostic
# scaffold layout, shared runner semantics, quarantine, and all three runtimes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARGUS_ASSETS:-$ROOT/argus/claude/bin/argus-assets}"
FIXTURES="$ROOT/scripts/fixtures/argus-templates"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
run_logged() {
  local name="$1"
  shift
  if ! "$@" >"$WORK/$name.log" 2>&1; then
    tail -80 "$WORK/$name.log" >&2
    fail "$name failed"
  fi
}

# Existing projects are detected from real files and produce ADAPT selections with
# every unsupported adapter declared. No competing scaffold may be created.
for runtime in typescript java python; do
  "$CLI" template detect --target "$FIXTURES/existing-$runtime" --output "$WORK/$runtime-capabilities.json" >/dev/null
  jq -e --arg runtime "$runtime" '.existingSuite and (.runtimeCandidates | index($runtime)) and (.testRoots | length) > 0 and (.packageManagers | length) > 0' "$WORK/$runtime-capabilities.json" >/dev/null || fail "$runtime capability detection is incomplete"
done
jq -e '.sourceRoots == ["webapp"] and .testRoots == ["specs"] and .ci == ["github-actions"] and (.unsupported | index("package-manager-adapter-required:pnpm")) and (.unsupported | index("test-runner-adapter-required:vitest"))' "$WORK/typescript-capabilities.json" >/dev/null || fail "TypeScript custom layout or unsupported adapters were hidden"
jq -e '(.unsupported | index("package-manager-adapter-required:gradle"))' "$WORK/java-capabilities.json" >/dev/null || fail "Gradle adapter requirement was hidden"
jq -e '(.unsupported | index("package-manager-adapter-required:poetry"))' "$WORK/python-capabilities.json" >/dev/null || fail "Poetry adapter requirement was hidden"

"$CLI" template select --target "$FIXTURES/existing-typescript" --runtime typescript --package-manager pnpm --test-root specs --harness-root webapp --output "$WORK/adapt.json" >/dev/null
jq -e '.action == "adapt" and .choiceSource == "explicit-user" and .framework == "vitest" and .testRunner == "vitest" and (.unsupported | length) >= 2' "$WORK/adapt.json" >/dev/null || fail "existing-suite selection did not preserve detected capabilities"
if "$CLI" template scaffold --selection "$WORK/adapt.json" --destination "$WORK/forbidden-adapt" >/dev/null 2>&1; then fail "ADAPT selection created a competing scaffold"; fi
if "$CLI" template select --target "$FIXTURES/existing-typescript" --runtime typescript --package-manager npm --test-root specs --harness-root webapp --output "$WORK/wrong-manager.json" >/dev/null 2>&1; then fail "ADAPT selection overrode the detected package manager"; fi
if "$CLI" template select --target "$FIXTURES/existing-typescript" --runtime typescript --package-manager pnpm --test-root tests --harness-root webapp --output "$WORK/wrong-root.json" >/dev/null 2>&1; then fail "ADAPT selection overrode the detected test root"; fi
"$CLI" template select --target "$FIXTURES/existing-java" --runtime java --package-manager gradle --test-root src/test/java --harness-root src --output "$WORK/java-adapt.json" >/dev/null
jq -e '.action == "adapt" and .testRoot == "src/test/java" and .harnessRoot == "src" and (.unsupported | index("package-manager-adapter-required:gradle"))' "$WORK/java-adapt.json" >/dev/null || fail "nested existing Java layout was not preserved"
if "$CLI" template select --target "$WORK" --package-manager npm --test-root specs --harness-root support --output "$WORK/no-runtime.json" >/dev/null 2>&1; then fail "selection succeeded without explicit runtime choice"; fi
"$CLI" copy-template typescript "$WORK/unselected" >/dev/null
set +e
(cd "$WORK/unselected" && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline >/dev/null 2>&1)
unselected_code=$?
set -e
[ "$unselected_code" -eq 13 ] && jq -e '.exitCode == 13 and .categories.policy == 1' "$WORK/unselected/reports/argus-runner-result.json" >/dev/null || fail "unselected template runner did not fail as policy exit 13"
mkdir -p "$WORK/persisted-target"
"$CLI" template select --target "$WORK/persisted-target" --runtime typescript --package-manager npm --test-root specs --harness-root support --output "$WORK/persisted-target/ai_agents_internal/template-selection.json" >/dev/null
"$CLI" template scaffold --selection "$WORK/persisted-target/ai_agents_internal/template-selection.json" --destination "$WORK/persisted-scaffold" >/dev/null || fail "persisted control artifact caused false capability drift"
mkdir -p "$WORK/drift-target"
"$CLI" template select --target "$WORK/drift-target" --runtime python --package-manager pip --test-root specs --harness-root support --output "$WORK/drift-selection.json" >/dev/null
printf '[tool.pytest.ini_options]\n' >"$WORK/drift-target/pyproject.toml"
if "$CLI" template scaffold --selection "$WORK/drift-selection.json" --destination "$WORK/stale-scaffold" >/dev/null 2>&1; then fail "stale capability selection survived target drift"; fi

# Greenfield selection and scaffold use non-default, disjoint layouts. Each generated
# runner executes a target-independent test and writes the same result schema.
mkdir -p "$WORK/targets/typescript" "$WORK/targets/java" "$WORK/targets/python"
"$CLI" template select --target "$WORK/targets/typescript" --runtime typescript --package-manager npm --test-root quality/specs --harness-root quality/support --ci github-actions --output "$WORK/typescript-selection.json" >/dev/null
"$CLI" template select --target "$WORK/targets/java" --runtime java --package-manager maven --test-root quality/java-tests --harness-root quality/java-support --ci github-actions --output "$WORK/java-selection.json" >/dev/null
"$CLI" template select --target "$WORK/targets/python" --runtime python --package-manager pip --test-root quality/python-tests --harness-root quality/python-support --ci github-actions --output "$WORK/python-selection.json" >/dev/null

for runtime in typescript java python; do
  "$CLI" template scaffold --selection "$WORK/$runtime-selection.json" --destination "$WORK/$runtime" >/dev/null
  jq -e --arg runtime "$runtime" '.runtime == $runtime and .action == "build" and .choiceSource == "explicit-user" and .unsupported == []' "$WORK/$runtime/ai_agents_internal/template-selection.json" >/dev/null || fail "$runtime scaffold omitted its selection record"
  jq -e '.sharedContract == "argus/template-contract@1" and (.extensionPoints | length) >= 4 and (.tagAdapter | has("contract-smoke")) and (.tagAdapter | has("quarantine")) and (.tagAdapter | has("regression"))' "$WORK/$runtime/argus-template.json" >/dev/null || fail "$runtime extension or tag contract is missing"
done
test -d "$WORK/typescript/quality/specs" && test -d "$WORK/typescript/quality/support" && test ! -e "$WORK/typescript/tests" && test ! -e "$WORK/typescript/src" || fail "TypeScript scaffold retained fixed layout assumptions"
test -d "$WORK/java/quality/java-tests" && test -d "$WORK/java/quality/java-support" && test ! -e "$WORK/java/src/test/java" || fail "Java scaffold retained fixed test-source assumptions"
test -d "$WORK/python/quality/python-tests" && test -d "$WORK/python/quality/python-support" && test ! -e "$WORK/python/tests" && test ! -e "$WORK/python/src" || fail "Python scaffold retained fixed layout assumptions"
if grep -Fq 'src/test/java' "$WORK/java/README.md"; then fail "Java generated instructions retained the placeholder source root"; fi
grep -Fq 'retries: 0' "$WORK/typescript/playwright.config.ts" || fail "TypeScript retries are not disabled"
grep -Fq '<rerunFailingTestsCount>0</rerunFailingTestsCount>' "$WORK/java/pom.xml" || fail "Java reruns are not disabled"
if grep -Eq '^[[:space:]]*"pytest-rerunfailures|^[[:space:]]*--reruns' "$WORK/python/requirements.txt" "$WORK/python/pyproject.toml"; then fail "Python template enables automatic reruns"; fi

run_logged typescript-install bash -c "cd '$WORK/typescript' && npm ci --ignore-scripts"
run_logged typescript-run bash -c "cd '$WORK/typescript' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline -- --grep @contract-smoke"
run_logged java-run bash -c "cd '$WORK/java' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline -- -Dtest=TemplateContractTest"
run_logged python-run bash -c "cd '$WORK/python' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline -- quality/python-tests/contract/test_template_contract.py"
for runtime in typescript java python; do
  jq -e '."$schema" == "argus/runner-result@1" and .mode == "baseline" and .status == "pass" and .exitCode == 0' "$WORK/$runtime/reports/argus-runner-result.json" >/dev/null || fail "$runtime clean-room runner result is invalid"
  test -d "$WORK/$runtime/reports/evidence" || fail "$runtime runner omitted the shared evidence root"
done

# Shared evaluators and quarantine semantics are byte-identical and fail closed.
cmp "$WORK/typescript/scripts/runner-contract.sh" "$WORK/java/scripts/runner-contract.sh" >/dev/null || fail "Java runner evaluator drifted"
cmp "$WORK/typescript/scripts/runner-contract.sh" "$WORK/python/scripts/runner-contract.sh" >/dev/null || fail "Python runner evaluator drifted"
cmp "$WORK/typescript/scripts/quarantine-contract.sh" "$WORK/java/scripts/quarantine-contract.sh" >/dev/null || fail "Java quarantine evaluator drifted"
cmp "$WORK/typescript/scripts/quarantine-contract.sh" "$WORK/python/scripts/quarantine-contract.sh" >/dev/null || fail "Python quarantine evaluator drifted"
printf 'case.one\tatlas\tflaky-clock\t2099-01-01\t#18\n' >"$WORK/quarantine.tsv"
: >"$WORK/quarantine-events.tsv"
"$WORK/typescript/scripts/quarantine-contract.sh" --events "$WORK/quarantine-events.tsv" --ledger "$WORK/quarantine.tsv" --tagged-count 1
"$WORK/typescript/scripts/runner-contract.sh" --mode baseline --events "$WORK/quarantine-events.tsv" --output "$WORK/quarantine-result.json" --runner-exit 0
jq -e '.exitCode == 0 and .categories.skip == 1 and .events[0].expected' "$WORK/quarantine-result.json" >/dev/null || fail "valid quarantine was not an approved skip"
printf 'case.one\tatlas\tflaky-clock\t2000-01-01\t#18\n' >"$WORK/quarantine.tsv"
: >"$WORK/quarantine-events.tsv"
if "$WORK/typescript/scripts/quarantine-contract.sh" --events "$WORK/quarantine-events.tsv" --ledger "$WORK/quarantine.tsv" --tagged-count 1; then fail "expired quarantine unexpectedly passed"; fi
set +e
"$WORK/typescript/scripts/runner-contract.sh" --mode baseline --events "$WORK/quarantine-events.tsv" --output "$WORK/expired-result.json" --runner-exit 1
expired_code=$?
set -e
[ "$expired_code" -eq 13 ] && jq -e '.exitCode == 13 and .categories.policy == 1' "$WORK/expired-result.json" >/dev/null || fail "expired quarantine did not fail as policy exit 13"

printf 'PASS  Argus templates: detected ADAPT, explicit BUILD, arbitrary layouts, three clean-room runners, shared contract, and quarantine\n'
