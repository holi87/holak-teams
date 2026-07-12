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

assert_tree_equal() {
  local source="$1" output="$2" label="$3"
  REPO_ROOT="$ROOT" SOURCE_TREE="$source" OUTPUT_TREE="$output" TREE_LABEL="$label" node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

function inventory(root, prefix = '', result = new Map()) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${process.env.TREE_LABEL}: symlink ${relative}`);
    if (stat.isDirectory()) {
      result.set(relative, { type: 'directory', mode: stat.mode & 0o777 });
      inventory(path, relative, result);
    } else if (stat.isFile()) {
      result.set(relative, {
        type: 'file',
        mode: stat.mode & 0o777,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    } else throw new Error(`${process.env.TREE_LABEL}: unsupported entry ${relative}`);
  }
  return result;
}

function trackableInventory(root) {
  const repo = process.env.REPO_ROOT;
  const sourcePrefix = `${relative(repo, root).split('\\').join('/')}/`;
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', sourcePrefix.slice(0, -1)], {
    cwd: repo,
    encoding: 'utf8',
  }).split('\n').filter((path) => path.startsWith(sourcePrefix)).sort();
  const result = new Map();
  for (const path of paths) {
    const relativePath = path.slice(sourcePrefix.length);
    const source = join(repo, path);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${process.env.TREE_LABEL}: invalid source ${relativePath}`);
    let parent = dirname(relativePath);
    while (parent !== '.') {
      if (!result.has(parent)) {
        const parentStat = lstatSync(join(root, parent));
        result.set(parent, { type: 'directory', mode: parentStat.mode & 0o777 });
      }
      parent = dirname(parent);
    }
    result.set(relativePath, {
      type: 'file',
      mode: stat.mode & 0o777,
      sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    });
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)));
}

const expected = trackableInventory(process.env.SOURCE_TREE);
const actual = inventory(process.env.OUTPUT_TREE);
const sortedActual = new Map([...actual].sort(([left], [right]) => left.localeCompare(right)));
if (JSON.stringify([...expected]) !== JSON.stringify([...sortedActual])) {
  const expectedPaths = [...expected.keys()];
  const actualPaths = [...actual.keys()];
  throw new Error(`${process.env.TREE_LABEL}: composed tree or mode mismatch\nexpected=${JSON.stringify(expectedPaths)}\nactual=${JSON.stringify(actualPaths)}`);
}
NODE
}

expect_copy_failure() {
  local label="$1" cli="$2" runtime="$3" destination="$4"
  if "$cli" copy-template "$runtime" "$destination" >"$WORK/$label.log" 2>&1; then
    fail "$label unexpectedly copied a template"
  fi
  [ ! -e "$destination" ] || fail "$label wrote output before validation completed"
}

expect_selection_failure() {
  local label="$1" test_root="$2" harness_root="$3"
  local target="$WORK/layout-target-$label" output="$WORK/layout-selection-$label.json"
  mkdir -p "$target"
  if "$CLI" template select --target "$target" --runtime typescript --package-manager npm \
    --test-root "$test_root" --harness-root "$harness_root" --output "$output" >"$WORK/$label.log" 2>&1; then
    fail "$label unexpectedly accepted a non-canonical layout"
  fi
  [ ! -e "$output" ] || fail "$label persisted an invalid layout selection"
}

# The supported materialisation interface composes common + runtime layers into a byte-
# and mode-exact copy of each complete maintainer source tree.
for runtime in typescript java python; do
  case "$runtime" in
    typescript) source="$ROOT/argus/framework-template" ;;
    java) source="$ROOT/argus/framework-template-java" ;;
    python) source="$ROOT/argus/framework-template-python" ;;
  esac
  "$CLI" copy-template "$runtime" "$WORK/raw-$runtime" >/dev/null
  assert_tree_equal "$source" "$WORK/raw-$runtime" "$runtime raw composition"
  test -x "$WORK/raw-$runtime/scripts/runner-contract.sh" || fail "$runtime composition lost executable mode"
done

# Every layer is fully inspected before the destination is created. Corruption,
# symlinks, duplicate files, case-fold collisions, file/ancestor collisions, and
# platform-unsafe names all fail closed.
cp -R "$ROOT/argus/claude" "$WORK/plugin-corrupt"
printf '\ncorrupt\n' >>"$WORK/plugin-corrupt/templates/common/solution/STATE_MODEL.md"
expect_copy_failure corrupt-layer "$WORK/plugin-corrupt/bin/argus-assets" typescript "$WORK/rejected-corrupt"

cp -R "$ROOT/argus/claude" "$WORK/plugin-directory-mode"
chmod 700 "$WORK/plugin-directory-mode/templates/common/bugs"
expect_copy_failure directory-mode-drift "$WORK/plugin-directory-mode/bin/argus-assets" python "$WORK/rejected-directory-mode"

cp -R "$ROOT/argus/claude" "$WORK/plugin-symlink"
rm "$WORK/plugin-symlink/templates/common/bugs/_TEMPLATE.md"
ln -s ../solution/STATE_MODEL.md "$WORK/plugin-symlink/templates/common/bugs/_TEMPLATE.md"
expect_copy_failure symlink-layer "$WORK/plugin-symlink/bin/argus-assets" java "$WORK/rejected-symlink"

cp -R "$ROOT/argus/claude" "$WORK/plugin-file-collision"
cp "$WORK/plugin-file-collision/templates/common/solution/STATE_MODEL.md" \
  "$WORK/plugin-file-collision/templates/python/solution/STATE_MODEL.md"
expect_copy_failure file-collision "$WORK/plugin-file-collision/bin/argus-assets" python "$WORK/rejected-file-collision"

cp -R "$ROOT/argus/claude" "$WORK/plugin-case-collision"
mkdir "$WORK/plugin-case-collision/templates/java/Bugs"
cp "$WORK/plugin-case-collision/templates/common/bugs/_TEMPLATE.md" \
  "$WORK/plugin-case-collision/templates/java/Bugs/_template.md"
expect_copy_failure case-collision "$WORK/plugin-case-collision/bin/argus-assets" java "$WORK/rejected-case-collision"

cp -R "$ROOT/argus/claude" "$WORK/plugin-ancestor-collision"
printf 'parent file\n' >"$WORK/plugin-ancestor-collision/templates/common/collision-root"
mkdir "$WORK/plugin-ancestor-collision/templates/typescript/collision-root"
printf 'child file\n' >"$WORK/plugin-ancestor-collision/templates/typescript/collision-root/child"
expect_copy_failure ancestor-collision "$WORK/plugin-ancestor-collision/bin/argus-assets" typescript "$WORK/rejected-ancestor-collision"

cp -R "$ROOT/argus/claude" "$WORK/plugin-unsafe-path"
printf 'unsafe\n' >"$WORK/plugin-unsafe-path/templates/python/unsafe\\name"
expect_copy_failure unsafe-path "$WORK/plugin-unsafe-path/bin/argus-assets" python "$WORK/rejected-unsafe"

mkdir "$WORK/output-real"
ln -s "$WORK/output-real" "$WORK/output-link"
if "$CLI" copy-template typescript "$WORK/output-link" >"$WORK/output-symlink.log" 2>&1; then
  fail "output symlink unexpectedly accepted a template"
fi
[ -z "$(find "$WORK/output-real" -mindepth 1 -print -quit)" ] || fail "output symlink received files"

# Layout roots are canonical portable relative paths. Equivalent spellings, dot
# segments, trailing separators, absolute paths, and traversal all fail before a
# selection or requested scaffold destination is written.
expect_selection_failure dot-root . quality/support
expect_selection_failure double-separator quality//shared quality/shared
expect_selection_failure dot-segment quality/./specs quality/support
expect_selection_failure leading-dot ./quality/specs quality/support
expect_selection_failure trailing-separator quality/specs/ quality/support
expect_selection_failure absolute-root /quality/specs quality/support
expect_selection_failure windows-absolute C:/quality/specs quality/support
expect_selection_failure traversal quality/../specs quality/support
expect_selection_failure backslash 'quality\specs' quality/support

# A failure after the complete template composition has been copied into the
# private staging directory leaves neither a partial destination nor staging debris.
mkdir -p "$WORK/atomic-target"
"$CLI" template select --target "$WORK/atomic-target" --runtime typescript --package-manager npm \
  --test-root scripts --harness-root quality/support --output "$WORK/atomic-failure-selection.json" >/dev/null
if "$CLI" template scaffold --selection "$WORK/atomic-failure-selection.json" \
  --destination "$WORK/atomic-failure" >"$WORK/atomic-failure.log" 2>&1; then
  fail "materialization collision unexpectedly produced a scaffold"
fi
[ ! -e "$WORK/atomic-failure" ] || fail "failed materialization left a partial scaffold destination"
[ -z "$(find "$WORK" -maxdepth 1 -name '.atomic-failure.argus-scaffold-*' -print -quit)" ] || fail "failed materialization left a private staging directory"

# Persisted selections receive the same canonical-path validation and fail before
# the atomic destination exists.
"$CLI" template select --target "$WORK/atomic-target" --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support --output "$WORK/canonical-selection.json" >/dev/null
jq '.testRoot = "quality//shared" | .harnessRoot = "quality/shared"' \
  "$WORK/canonical-selection.json" >"$WORK/mutated-alias-selection.json"
if "$CLI" template scaffold --selection "$WORK/mutated-alias-selection.json" \
  --destination "$WORK/mutated-alias-scaffold" >"$WORK/mutated-alias.log" 2>&1; then
  fail "persisted layout alias unexpectedly produced a scaffold"
fi
[ ! -e "$WORK/mutated-alias-scaffold" ] || fail "invalid persisted layout left a scaffold destination"

# Existing empty destinations remain supported and retain their root mode; a
# non-empty destination remains exclusive and is never modified.
mkdir "$WORK/existing-empty-scaffold"
chmod 711 "$WORK/existing-empty-scaffold"
"$CLI" template scaffold --selection "$WORK/canonical-selection.json" \
  --destination "$WORK/existing-empty-scaffold" >/dev/null
node -e 'const fs=require("fs"); if ((fs.statSync(process.argv[1]).mode & 0o777) !== 0o711) process.exit(1)' \
  "$WORK/existing-empty-scaffold" || fail "atomic publication changed the existing destination mode"
test -f "$WORK/existing-empty-scaffold/argus-template.json" || fail "existing empty destination did not receive the complete scaffold"
mkdir "$WORK/non-empty-scaffold"
printf 'preserve\n' >"$WORK/non-empty-scaffold/sentinel.txt"
if "$CLI" template scaffold --selection "$WORK/canonical-selection.json" \
  --destination "$WORK/non-empty-scaffold" >"$WORK/non-empty.log" 2>&1; then
  fail "non-empty destination unexpectedly accepted a scaffold"
fi
grep -Fxq preserve "$WORK/non-empty-scaffold/sentinel.txt" || fail "non-empty destination was modified"
[ -z "$(find "$WORK" -maxdepth 1 -name '.non-empty-scaffold.argus-scaffold-*' -print -quit)" ] || fail "non-empty rejection left a private staging directory"

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
  jq -e '.sharedContract == "argus/template-contract@1" and (.extensionPoints | length) >= 4 and (.tagAdapter | has("contract-smoke")) and (.tagAdapter | has("quarantine")) and (.tagAdapter | has("regression")) and .tagAdapter["bug-provenance"] == "@bug:<canonical-or-origin>"' "$WORK/$runtime/argus-template.json" >/dev/null || fail "$runtime extension or tag contract is missing"
  test -f "$WORK/$runtime/solution/bug-ledger.example.json" || fail "$runtime scaffold omitted the canonical bug-ledger example"
  "$CLI" schema validate --kind bug-ledger --input "$WORK/$runtime/solution/bug-ledger.example.json" >/dev/null || fail "$runtime bug-ledger example is schema-invalid"
done
jq -e '.tagAdapter.regression == "@regression" and .tagAdapter["bug-provenance"] == "@bug:<canonical-or-origin>"' "$WORK/typescript/argus-template.json" >/dev/null || fail "TypeScript regression selection still depends on the bug provenance tag"
grep -Fq 'funded, risk-derived UI lane' "$WORK/typescript/solution/ARCHITECTURE.md" || fail 'TypeScript architecture still underfunds the UI lane'
if rg -qi 'thin (UI |e2e )?smoke' "$WORK/typescript/solution/ARCHITECTURE.md"; then
  fail 'TypeScript architecture still prescribes a thin UI smoke lane'
fi
cmp "$WORK/typescript/solution/bug-ledger.example.json" "$WORK/java/solution/bug-ledger.example.json" >/dev/null || fail "Java bug-ledger example drifted from TypeScript"
cmp "$WORK/typescript/solution/bug-ledger.example.json" "$WORK/python/solution/bug-ledger.example.json" >/dev/null || fail "Python bug-ledger example drifted from TypeScript"
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

# TypeScript uses the same native regression-selection contract as Java and Python.
# The separate @bug token remains provenance and may join through a stable origin alias.
cp "$FIXTURES/regression-selection.spec.ts" "$WORK/typescript/quality/specs/contract/regression-selection.spec.ts"
cp "$FIXTURES/bug-ledger-origin.json" "$WORK/typescript/solution/bug-ledger.json"
selection_marker="$WORK/typescript-regression-selected.log"
rm -f "$selection_marker"
run_logged typescript-selection-baseline bash -c "cd '$WORK/typescript' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ARGUS_SELECTION_MARKER='$selection_marker' ./run-tests.sh --mode baseline -- --grep '@contract-smoke|@regression'"
test ! -e "$selection_marker" || fail "TypeScript baseline selected an @regression test"

run_logged typescript-selection-candidate bash -c "cd '$WORK/typescript' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ARGUS_SELECTION_MARKER='$selection_marker' ARGUS_SELECTION_EXPECT=candidate-regression ./run-tests.sh --mode candidate-regression"
grep -Fxq 'candidate-regression' "$selection_marker" || fail "TypeScript candidate-regression did not select @regression"
rm -f "$selection_marker"

run_logged typescript-selection-evidence bash -c "cd '$WORK/typescript' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ARGUS_SELECTION_MARKER='$selection_marker' ARGUS_SELECTION_EXPECT=defect-evidence ARGUS_OUTCOME_FILE='$WORK/typescript/reports/outcomes.raw.tsv' ./run-tests.sh --mode defect-evidence"
grep -Fxq 'defect-evidence' "$selection_marker" || fail "TypeScript defect-evidence did not select @regression"
jq -e '.mode == "defect-evidence" and .status == "pass" and .exitCode == 0 and (.events | any(.bugId == "BUG-0001" and .expected and .lifecycle == "reproduced"))' "$WORK/typescript/reports/argus-runner-result.json" >/dev/null || fail "TypeScript expected-RED evidence contract failed"

run_logged typescript-origin-join bash -c "cd '$WORK/typescript' && node scripts/bug-coverage.mjs"
jq -e '.bug_coverage.total_confirmed == 1 and .bug_coverage.wired_confirmed == 1 and .bug_coverage.uncovered == []' "$WORK/typescript/reports/summary.json" >/dev/null || fail "@bug origin alias did not join the canonical ledger"

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

printf 'PASS  Argus templates: detected ADAPT, explicit BUILD, arbitrary layouts, three clean-room runners, regression selection, origin-ledger join, shared contract, and quarantine\n'
