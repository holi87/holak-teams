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

# A runner kit is exactly the composed-template files its contract entries select (a
# trailing '/' selects a directory's files) plus their ancestor directories, each byte- and
# mode-identical to the complete composition.
assert_runner_kit() {
  local runtime="$1" composed="$2" kit="$3"
  KIT_RUNTIME="$runtime" COMPOSED_TREE="$composed" KIT_TREE="$kit" \
    CONTRACT="$ROOT/argus/claude/capabilities/template-contract.json" node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function inventory(root, prefix = '', result = new Map()) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`runner kit: symlink ${relative}`);
    if (stat.isDirectory()) {
      result.set(relative, { type: 'directory', mode: stat.mode & 0o777 });
      inventory(path, relative, result);
    } else if (stat.isFile()) {
      result.set(relative, { type: 'file', mode: stat.mode & 0o777, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    } else throw new Error(`runner kit: unsupported entry ${relative}`);
  }
  return result;
}

const runtime = process.env.KIT_RUNTIME;
const kitEntries = JSON.parse(readFileSync(process.env.CONTRACT, 'utf8')).templates[runtime].runnerKit;
const composed = inventory(process.env.COMPOSED_TREE);
const actual = inventory(process.env.KIT_TREE);
const expected = new Map();
for (const entry of kitEntries) {
  const matches = [...composed].filter(([path, item]) => item.type === 'file' && (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
  if (!matches.length) throw new Error(`${runtime} runner kit entry selects no composed file: ${entry}`);
  for (const [path, item] of matches) {
    expected.set(path, item);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      expected.set(parent, composed.get(parent));
    }
  }
}
const order = (map) => JSON.stringify([...map].sort(([left], [right]) => left.localeCompare(right)));
if (order(expected) !== order(actual)) {
  throw new Error(`${runtime} runner kit differs from the composed template\nexpected=${JSON.stringify([...expected.keys()].sort())}\nactual=${JSON.stringify([...actual.keys()].sort())}`);
}
for (const outside of ['run-tests.sh', 'argus-template.json', 'README.md', 'solution/STATE_MODEL.md']) {
  if (actual.has(outside)) throw new Error(`${runtime} runner kit copied a non-kit file: ${outside}`);
}
NODE
}

expect_kit_failure() {
  local label="$1" cli="$2" runtime="$3" destination="$4" message="$5"
  if "$cli" copy-runner-kit "$runtime" "$destination" >"$WORK/$label.log" 2>&1; then
    fail "$label unexpectedly copied a runner kit"
  fi
  grep -Fq -- "$message" "$WORK/$label.log" || fail "$label failed for the wrong reason: $(<"$WORK/$label.log")"
}

# The v2 template contract pins the runner kit, lane vocabulary, lane plan,
# environment, counterfactual, and per-runtime adapter/marker values. Each targeted
# drift must fail validation; the source and installed contracts must both pass.
REPO_ROOT="$ROOT" node --input-type=module <<'NODE' || fail "template contract v2 validation regressed"
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.REPO_ROOT;
const { validateTemplateContract } = await import(pathToFileURL(join(root, 'argus', 'runtime', 'template-policy.mjs')).href);
const source = JSON.parse(readFileSync(join(root, 'argus', 'template-contract.json'), 'utf8'));
const installed = JSON.parse(readFileSync(join(root, 'argus', 'claude', 'capabilities', 'template-contract.json'), 'utf8'));
const problems = [];
for (const [label, contract] of [['source', source], ['installed', installed]]) {
  const errors = validateTemplateContract(contract);
  if (errors.length) problems.push(`${label} contract rejected: ${errors.join('; ')}`);
}
const mutations = [
  ['schema version 1', (c) => { c.schemaVersion = 1; }, 'template contract identity is invalid'],
  ['contract id @1', (c) => { c.contractId = 'argus/template-contract@1'; }, 'template contract identity is invalid'],
  ['runner library', (c) => { c.runner.library = 'scripts/runner.sh'; }, 'runner library, inventory, or evidence-pass contract is invalid'],
  ['runner activation', (c) => { delete c.runner.activation; }, 'runner library, inventory, or evidence-pass contract is invalid'],
  ['evidence passes', (c) => { c.runner.evidencePasses = ['live', 'repeat', 'cf-correct']; }, 'runner library, inventory, or evidence-pass contract is invalid'],
  ['resilience lane', (c) => { c.tags.lanes = c.tags.lanes.filter((lane) => lane !== 'resilience'); }, 'lane tag contract is invalid'],
  ['harness lanes', (c) => { c.tags.harnessLanes = ['contract-smoke']; }, 'lane tag contract is invalid'],
  ['quarantine forbiddenFor', (c) => { c.quarantine.forbiddenFor = []; }, 'quarantine must be forbidden for regression tests'],
  ['lane plan missing', (c) => { delete c.lanePlan; }, 'lane plan contract is invalid'],
  ['lane plan states', (c) => { c.lanePlan.states = ['enabled', 'disabled', 'skipped']; }, 'lane plan contract is invalid'],
  ['environment reset action', (c) => { c.environment.resetAuthorizationAction = 'read'; }, 'environment contract is invalid'],
  ['environment kinds', (c) => { c.environment.kinds = ['reset']; }, 'environment contract is invalid'],
  ['counterfactual tamper', (c) => { c.counterfactual.requiredTamper = 'any'; }, 'counterfactual contract is invalid'],
  ['counterfactual exemptions', (c) => { c.counterfactual.exemptions.push('other'); }, 'counterfactual contract is invalid'],
  ['java lane marker', (c) => { delete c.templates.java.laneMarker; }, 'java template adapter or marker contract is invalid'],
  ['python adapter', (c) => { c.templates.python.adapter = ' '; }, 'python template adapter or marker contract is invalid'],
  ['typescript provenance', (c) => { c.templates.typescript.provenanceMarker = null; }, 'typescript template adapter or marker contract is invalid'],
];
for (const [label, mutate, expected] of mutations) {
  const contract = structuredClone(source);
  mutate(contract);
  const errors = validateTemplateContract(contract);
  if (!errors.includes(expected)) problems.push(`${label}: expected "${expected}", got ${JSON.stringify(errors)}`);
}
// Runner-kit entries are canonical relative paths with an optional trailing '/' and no
// globs. The JSON Schema rejects the same malformed entries as the runtime validator; only
// the runtime validator also requires the shared declarations in every runtime's kit.
const { compileJsonSchema } = await import(pathToFileURL(join(root, 'argus', 'runtime', 'json-schema.mjs')).href);
const validateSchema = compileJsonSchema(JSON.parse(readFileSync(join(root, 'argus', 'schemas', 'template-contract.schema.json'), 'utf8')));
const sourceSchemaErrors = validateSchema(source);
if (sourceSchemaErrors.length) problems.push(`source contract rejected by its schema: ${JSON.stringify(sourceSchemaErrors)}`);
const kitMutations = [
  ['runner kit missing', 'java', (kit, template) => { delete template.runnerKit; }, true],
  ['runner kit empty', 'python', (kit, template) => { template.runnerKit = []; }, true],
  ['runner kit glob', 'typescript', (kit) => { kit.push('src/**/*.ts'); }, true],
  ['runner kit traversal', 'java', (kit) => { kit.push('../outside.sh'); }, true],
  ['runner kit dot segment', 'python', (kit) => { kit.push('src/./qa/'); }, true],
  ['runner kit absolute', 'typescript', (kit) => { kit.push('/etc/passwd'); }, true],
  ['runner kit double separator', 'java', (kit) => { kit.push('src//test/'); }, true],
  ['runner kit backslash', 'python', (kit) => { kit.push('src\\qa\\argus_plugin.py'); }, true],
  ['runner kit duplicate', 'typescript', (kit) => { kit.push('scripts/runner-lib.sh'); }, true],
  ['runner kit shared library', 'java', (kit) => { kit.splice(kit.indexOf('scripts/runner-lib.sh'), 1); }, false],
  ['runner kit counterfactual prefix', 'python', (kit) => { kit[kit.indexOf('solution/counterfactual/')] = 'solution/counterfactual'; }, false],
];
for (const [label, runtime, mutate, schemaRejects] of kitMutations) {
  const contract = structuredClone(source);
  mutate(contract.templates[runtime].runnerKit, contract.templates[runtime]);
  const expected = `${runtime} template runner kit contract is invalid`;
  const errors = validateTemplateContract(contract);
  if (!errors.includes(expected)) problems.push(`${label}: expected "${expected}", got ${JSON.stringify(errors)}`);
  if (schemaRejects && !validateSchema(contract).length) problems.push(`${label}: the JSON Schema accepted a malformed runner kit`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
NODE

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

# ADAPT path: copy-runner-kit hands an existing suite only the contract-declared runner
# kit, byte- and mode-identical to the composition above, and says it is not runnable.
for runtime in typescript java python; do
  "$CLI" copy-runner-kit "$runtime" "$WORK/kit-$runtime" >"$WORK/kit-$runtime.log" 2>&1 || { cat "$WORK/kit-$runtime.log" >&2; fail "$runtime runner kit copy failed"; }
  grep -Fxq "COPIED  $runtime runner kit -> $WORK/kit-$runtime" "$WORK/kit-$runtime.log" || fail "$runtime runner kit copy did not report its destination"
  grep -Fxq 'Integrate into the existing suite; the kit is not a runnable framework.' "$WORK/kit-$runtime.log" || fail "$runtime runner kit copy did not warn that the kit is not runnable"
  assert_runner_kit "$runtime" "$WORK/raw-$runtime" "$WORK/kit-$runtime" || fail "$runtime runner kit is not an exact subset of the composed template"
  test -x "$WORK/kit-$runtime/scripts/runner-contract.sh" || fail "$runtime runner kit lost executable mode"
done
test -f "$WORK/kit-java/src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener" || fail "Java runner kit omitted the listener registration"
test -f "$WORK/kit-python/src/qa/argus_plugin.py" && test ! -e "$WORK/kit-python/src/qa/config.py" || fail "Python runner kit selected the wrong files"
# The TypeScript kit ships its counterfactual activation (the suite's `test` extends
# counterfactualTest, clients resolve the API URL through counterfactualApiURL), and every
# relative import in the kit resolves inside the kit: no seam dangles on src/fixtures or
# src/config, which stay ADAPT-ME files of the scaffold.
grep -Fq 'export const counterfactualTest' "$WORK/kit-typescript/src/argus/playwright-fixtures.ts" &&
  grep -Fq 'export function counterfactualApiURL' "$WORK/kit-typescript/src/argus/api-url.ts" ||
  fail "TypeScript runner kit omitted the counterfactual activation"
KIT_TREE="$WORK/kit-typescript" node --input-type=module <<'NODE' || fail "TypeScript runner kit imports a file it does not ship"
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.env.KIT_TREE;
const files = [];
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|mjs)$/.test(name)) files.push(path);
  }
};
walk(root);
const dangling = [];
for (const file of files) {
  for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), specifier);
    if (![target, `${target}.ts`, join(target, 'index.ts')].some((candidate) => existsSync(candidate) && statSync(candidate).isFile())) {
      dangling.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
}
if (dangling.length) {
  console.error(`dangling kit imports: ${dangling.join(', ')}`);
  process.exit(1);
}
NODE

# The kit copy fails closed before writing: a non-empty or symlinked destination, an
# unknown runtime, and a contract entry that selects no composed file leave nothing behind.
mkdir "$WORK/kit-non-empty"
printf 'preserve\n' >"$WORK/kit-non-empty/sentinel.txt"
expect_kit_failure kit-non-empty "$CLI" python "$WORK/kit-non-empty" 'refusing to copy into non-empty destination'
[ "$(find "$WORK/kit-non-empty" -mindepth 1 | wc -l | tr -d ' ')" = 1 ] && grep -Fxq preserve "$WORK/kit-non-empty/sentinel.txt" || fail "non-empty runner kit destination was modified"
mkdir "$WORK/kit-output-real"
ln -s "$WORK/kit-output-real" "$WORK/kit-output-link"
expect_kit_failure kit-symlink "$CLI" java "$WORK/kit-output-link" 'destination cannot be a symbolic link'
[ -z "$(find "$WORK/kit-output-real" -mindepth 1 -print -quit)" ] || fail "symlinked runner kit destination received files"
expect_kit_failure kit-unknown-runtime "$CLI" ruby "$WORK/kit-ruby" 'copy-runner-kit runtime must be typescript, java, or python'
[ ! -e "$WORK/kit-ruby" ] || fail "unknown runtime created a runner kit destination"
expect_kit_failure kit-missing-destination "$CLI" typescript '' 'copy-runner-kit requires an empty destination path'
cp -R "$ROOT/argus/claude" "$WORK/plugin-kit-missing"
jq '.templates.python.runnerKit += ["src/qa/missing_helper.py", "src/qa/oracles"]' \
  "$ROOT/argus/claude/capabilities/template-contract.json" >"$WORK/plugin-kit-missing/capabilities/template-contract.json"
expect_kit_failure kit-missing-entry "$WORK/plugin-kit-missing/bin/argus-assets" python "$WORK/kit-missing-entry" \
  'runner kit entry missing: src/qa/missing_helper.py, src/qa/oracles'
[ ! -e "$WORK/kit-missing-entry" ] || fail "missing runner kit entry created a destination"

# Every layer is fully inspected before the destination is created. Corruption,
# symlinks, duplicate files, case-fold collisions, file/ancestor collisions, and
# platform-unsafe names all fail closed.
cp -R "$ROOT/argus/claude" "$WORK/plugin-corrupt"
printf '\ncorrupt\n' >>"$WORK/plugin-corrupt/templates/common/solution/STATE_MODEL.md"
expect_copy_failure corrupt-layer "$WORK/plugin-corrupt/bin/argus-assets" typescript "$WORK/rejected-corrupt"

cp -R "$ROOT/argus/claude" "$WORK/plugin-directory-mode"
chmod 700 "$WORK/plugin-directory-mode/templates/common/bugs"
"$WORK/plugin-directory-mode/bin/argus-assets" copy-template python "$WORK/portable-directory-mode" >/dev/null
test -f "$WORK/portable-directory-mode/bugs/_TEMPLATE.md" || fail "directory permission normalization changed template content"

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
  case "$runtime" in
    typescript) provenance='@bug:<canonical-or-origin>' ;;
    java) provenance='@Tag("bug:<canonical-or-origin>")' ;;
    python) provenance='@pytest.mark.bug("<canonical-or-origin>")' ;;
  esac
  jq -e --arg provenance "$provenance" --arg runtime "$runtime" --slurpfile contract "$ROOT/argus/template-contract.json" '.sharedContract == "argus/template-contract@2" and (.extensionPoints | length) >= 4 and (.tagAdapter | has("contract-smoke")) and (.tagAdapter | has("quarantine")) and (.tagAdapter | has("regression")) and ((.tagAdapter.lane // "") | length) > 0 and .tagAdapter["bug-provenance"] == $provenance and .tagAdapter["bug-provenance"] == $contract[0].templates[$runtime].provenanceMarker and .tagAdapter.lane == $contract[0].templates[$runtime].laneMarker and .adapter == $contract[0].templates[$runtime].adapter' "$WORK/$runtime/argus-template.json" >/dev/null || fail "$runtime extension or tag contract is missing"
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
# The Java stack table names the contract oracle the pom pins (networknt, draft 2020-12), never
# REST Assured's draft-04 schema module, which cannot express the strict oracle.
grep -Fq '<groupId>com.networknt</groupId>' "$WORK/java/pom.xml" && grep -Fq '**networknt `json-schema-validator`** (draft 2020-12)' "$WORK/java/README.md" &&
  ! grep -Fq 'REST Assured `json-schema-validator`' "$WORK/java/README.md" || fail "Java README names a contract oracle the template does not ship"
if grep -Eq '^[[:space:]]*"pytest-rerunfailures|^[[:space:]]*--reruns' "$WORK/python/requirements.txt" "$WORK/python/pyproject.toml"; then fail "Python template enables automatic reruns"; fi

run_logged typescript-install bash -c "cd '$WORK/typescript' && npm ci --ignore-scripts"
run_logged typescript-run bash -c "cd '$WORK/typescript' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline"
run_logged java-run bash -c "cd '$WORK/java' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline"
run_logged python-run bash -c "cd '$WORK/python' && ARGUS_CONTRACT_SMOKE=1 PLAYWRIGHT_INSTALL=0 ./run-tests.sh --mode baseline"
for runtime in typescript java python; do
  jq -e '."$schema" == "argus/runner-result@1" and .mode == "baseline" and .status == "pass" and .exitCode == 0' "$WORK/$runtime/reports/argus-runner-result.json" >/dev/null || fail "$runtime clean-room runner result is invalid"
  test -d "$WORK/$runtime/reports/evidence" || fail "$runtime runner omitted the shared evidence root"
done

# Shared evaluators and quarantine semantics are byte-identical and fail closed.
cmp "$WORK/typescript/scripts/runner-contract.sh" "$WORK/java/scripts/runner-contract.sh" >/dev/null || fail "Java runner evaluator drifted"
cmp "$WORK/typescript/scripts/runner-contract.sh" "$WORK/python/scripts/runner-contract.sh" >/dev/null || fail "Python runner evaluator drifted"
cmp "$WORK/typescript/scripts/quarantine-contract.sh" "$WORK/java/scripts/quarantine-contract.sh" >/dev/null || fail "Java quarantine evaluator drifted"
cmp "$WORK/typescript/scripts/quarantine-contract.sh" "$WORK/python/scripts/quarantine-contract.sh" >/dev/null || fail "Python quarantine evaluator drifted"
# The evaluator joins the register to the inventory (SD-3): one quarantined, non-regression
# contract-smoke case. The retired tag-count basis and a missing inventory are usage errors.
printf 'case.one\tcontract-smoke\tfalse\ttrue\t-\t-\t-\t-\n' >"$WORK/quarantine-inventory.tsv"
printf 'case.one\tatlas\tflaky-clock\t2099-01-01\t#18\n' >"$WORK/quarantine.tsv"
for arguments in "--tagged-count 1" "--inventory $WORK/quarantine-inventory.tsv --tagged-count 1" "--inventory $WORK/absent-inventory.tsv" ""; do
  set +e
  # shellcheck disable=SC2086 # Each case is a deliberately word-split argument list.
  "$WORK/typescript/scripts/quarantine-contract.sh" --events "$WORK/quarantine-usage.tsv" --ledger "$WORK/quarantine.tsv" $arguments >/dev/null 2>&1
  usage_code=$?
  set -e
  [ "$usage_code" -eq 14 ] || fail "quarantine evaluator accepted '$arguments' with exit $usage_code instead of 14"
done
test ! -s "$WORK/quarantine-usage.tsv" || fail "quarantine evaluator emitted events for a usage error"
: >"$WORK/quarantine-events.tsv"
"$WORK/typescript/scripts/quarantine-contract.sh" --events "$WORK/quarantine-events.tsv" --ledger "$WORK/quarantine.tsv" --inventory "$WORK/quarantine-inventory.tsv"
# The register is what approves the skip, so it is passed in: without it the same event
# is an unapproved skip, which is the point of the check below.
"$WORK/typescript/scripts/runner-contract.sh" --mode baseline --events "$WORK/quarantine-events.tsv" --output "$WORK/quarantine-result.json" --runner-exit 0 --quarantine "$WORK/quarantine.tsv"
jq -e '.exitCode == 0 and .categories.skip == 1 and .events[0].expected' "$WORK/quarantine-result.json" >/dev/null || fail "valid quarantine was not an approved skip"
set +e
"$WORK/typescript/scripts/runner-contract.sh" --mode baseline --events "$WORK/quarantine-events.tsv" --output "$WORK/unregistered-skip.json" --runner-exit 0
unregistered_code=$?
set -e
[ "$unregistered_code" -eq 15 ] || fail "a skip with no quarantine row was accepted as approved"
printf 'case.one\tatlas\tflaky-clock\t2000-01-01\t#18\n' >"$WORK/quarantine.tsv"
: >"$WORK/quarantine-events.tsv"
if "$WORK/typescript/scripts/quarantine-contract.sh" --events "$WORK/quarantine-events.tsv" --ledger "$WORK/quarantine.tsv" --inventory "$WORK/quarantine-inventory.tsv"; then fail "expired quarantine unexpectedly passed"; fi
set +e
"$WORK/typescript/scripts/runner-contract.sh" --mode baseline --events "$WORK/quarantine-events.tsv" --output "$WORK/expired-result.json" --runner-exit 1
expired_code=$?
set -e
[ "$expired_code" -eq 13 ] && jq -e '.exitCode == 13 and .categories.policy == 1' "$WORK/expired-result.json" >/dev/null || fail "expired quarantine did not fail as policy exit 13"

printf 'PASS  Argus templates: detected ADAPT, explicit BUILD, arbitrary layouts, three clean-room runners, shared contract, and quarantine\n'
