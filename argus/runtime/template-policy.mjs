import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const RUNTIMES = ['typescript', 'java', 'python'];
const IGNORED = new Set(['.git', '.venv', 'ai_agents_internal', 'node_modules', 'target', 'dist', 'build', 'coverage', 'reports']);

export function validateTemplateContract(contract) {
  const errors = [];
  if (!object(contract) || contract.schemaVersion !== 1 || contract.contractId !== 'argus/template-contract@1') return ['template contract identity is invalid'];
  const modes = ['baseline', 'defect-evidence', 'candidate-regression', 'full-suite'];
  if (!sameSet(contract.runner?.modes, modes) || contract.runner?.resultSchema !== 'argus/runner-result@1' || contract.runner?.result !== 'reports/argus-runner-result.json' || contract.runner?.events !== 'reports/outcomes.raw.tsv' || contract.runner?.evidenceRoot !== 'reports/evidence') errors.push('runner minimum contract is invalid');
  if (!sameSet(contract.runner?.categories, ['product', 'automation', 'infrastructure', 'skip', 'policy']) || !sameSet(contract.runner?.exitCodes, [0, 10, 11, 12, 13, 14, 15])) errors.push('runner categories or exit codes are invalid');
  if (contract.tags?.bugLinked !== 'regression' || contract.tags?.bugProvenance !== '@bug:<canonical-or-origin>') errors.push('regression selection or bug provenance contract is invalid');
  if (contract.retryPolicy?.maximumAttempts !== 1 || contract.retryPolicy?.automaticRetries !== false) errors.push('automatic retries must be disabled');
  if (contract.quarantine?.ledger !== 'solution/quarantine.tsv' || !sameSet(contract.quarantine?.columns, ['case_id', 'owner', 'reason', 'expires_on', 'issue'])) errors.push('quarantine contract is invalid');
  for (const runtime of RUNTIMES) {
    const template = contract.templates?.[runtime];
    if (!object(template) || !string(template.framework) || !string(template.runner) || !list(template.packageManagers) || !list(template.extensionPoints)) errors.push(`${runtime} template contract is invalid`);
  }
  return [...new Set(errors)];
}

export function detectTemplateCapabilities(targetRoot) {
  const root = resolve(targetRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`target repo directory does not exist: ${root}`);
  const files = walk(root);
  const names = new Set(files.map((path) => relative(root, path).split(sep).join('/')));
  const signals = [];
  const values = {
    languages: new Set(), frameworks: new Set(), testRunners: new Set(), packageManagers: new Set(),
    sourceRoots: new Set(), testRoots: new Set(), ci: new Set(), unsupported: new Set(),
  };
  const add = (group, value, source) => {
    values[group].add(value);
    signals.push({ capability: `${group}:${value}`, source });
  };
  const has = (path) => names.has(path);
  const packageJson = has('package.json') ? json(join(root, 'package.json')) : null;
  const dependencies = packageJson ? { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) } : {};

  if (has('tsconfig.json') || dependencies.typescript || files.some((path) => /\.(?:ts|tsx|mts|cts)$/.test(path))) add('languages', 'typescript', has('tsconfig.json') ? 'tsconfig.json' : dependencies.typescript ? 'package.json:typescript' : 'file-extension:.ts');
  else if (files.some((path) => /\.(?:js|jsx|mjs|cjs)$/.test(path))) add('languages', 'javascript', 'file-extension:.js');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts') || files.some((path) => /\.java$/.test(path))) add('languages', 'java', has('pom.xml') ? 'pom.xml' : has('build.gradle') ? 'build.gradle' : 'file-extension:.java');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || files.some((path) => /\.py$/.test(path))) add('languages', 'python', has('pyproject.toml') ? 'pyproject.toml' : has('requirements.txt') ? 'requirements.txt' : 'file-extension:.py');
  for (const [file, language] of [['go.mod', 'go'], ['Gemfile', 'ruby'], ['Cargo.toml', 'rust']]) if (has(file)) add('languages', language, file);
  if (files.some((path) => /\.csproj$/.test(path))) add('languages', 'dotnet', 'file-extension:.csproj');

  for (const [file, manager] of [['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['pom.xml', 'maven'], ['mvnw', 'maven'], ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'], ['gradlew', 'gradle'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['requirements.txt', 'pip']]) if (has(file)) add('packageManagers', manager, file);

  for (const [dependency, framework, runner] of [['@playwright/test', 'playwright', 'playwright-test'], ['vitest', 'vitest', 'vitest'], ['jest', 'jest', 'jest'], ['mocha', 'mocha', 'mocha']]) if (dependencies[dependency]) { add('frameworks', framework, `package.json:${dependency}`); add('testRunners', runner, `package.json:${dependency}`); }
  const pom = has('pom.xml') ? read(join(root, 'pom.xml')) : '';
  const gradle = [has('build.gradle') && read(join(root, 'build.gradle')), has('build.gradle.kts') && read(join(root, 'build.gradle.kts'))].filter(Boolean).join('\n');
  if (/junit-jupiter|org\.junit\.jupiter|useJUnitPlatform/.test(`${pom}\n${gradle}`)) { add('frameworks', 'junit5', has('pom.xml') ? 'pom.xml:junit' : 'gradle:junit'); add('testRunners', 'junit5', has('pom.xml') ? 'pom.xml' : 'gradle'); }
  if (/testng/i.test(`${pom}\n${gradle}`)) { add('frameworks', 'testng', 'java-build:testng'); add('testRunners', 'testng', 'java-build:testng'); }
  const pythonConfig = [has('pyproject.toml') && read(join(root, 'pyproject.toml')), has('requirements.txt') && read(join(root, 'requirements.txt')), has('pytest.ini') && read(join(root, 'pytest.ini'))].filter(Boolean).join('\n');
  if (/\bpytest\b|\[tool\.pytest/.test(pythonConfig) || has('pytest.ini')) { add('frameworks', 'pytest', has('pytest.ini') ? 'pytest.ini' : 'python-config:pytest'); add('testRunners', 'pytest', has('pytest.ini') ? 'pytest.ini' : 'python-config:pytest'); }
  if (values.languages.has('python') && files.some((path) => /test.*\.py$/.test(path)) && !values.testRunners.size) { add('frameworks', 'unittest', 'python-test-files'); add('testRunners', 'unittest', 'python-test-files'); }

  for (const candidate of ['src', 'app', 'lib', 'packages', 'services', 'backend', 'frontend', 'src/main/java', 'src/main/kotlin']) if (directory(root, candidate)) add('sourceRoots', candidate, `directory:${candidate}`);
  for (const candidate of ['tests', 'test', 'e2e', 'qa', '__tests__', 'src/test', 'src/test/java', 'src/test/kotlin']) if (directory(root, candidate)) add('testRoots', candidate, `directory:${candidate}`);
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith('.') && !IGNORED.has(item.name))) {
    const prefix = `${entry.name}/`;
    const children = namesForPrefix(names, prefix);
    if (!children.length) continue;
    const containsTests = children.some((path) => /(?:^|\/)(?:test[^/]*|[^/]*\.test|[^/]*\.spec)[^/]*\.(?:ts|tsx|js|jsx|java|py)$/.test(path));
    const containsCode = children.some((path) => /\.(?:ts|tsx|js|jsx|java|py)$/.test(path));
    if (containsTests || /(?:test|spec|check|e2e|qa)/i.test(entry.name)) add('testRoots', entry.name, `inferred-test-directory:${entry.name}`);
    else if (containsCode) add('sourceRoots', entry.name, `inferred-source-directory:${entry.name}`);
  }

  if (directory(root, '.github/workflows')) add('ci', 'github-actions', '.github/workflows');
  for (const [file, ci] of [['.gitlab-ci.yml', 'gitlab-ci'], ['Jenkinsfile', 'jenkins'], ['azure-pipelines.yml', 'azure-pipelines'], ['.circleci/config.yml', 'circleci']]) if (has(file)) add('ci', ci, file);

  const runtimeCandidates = [];
  if (values.languages.has('typescript') || values.languages.has('javascript')) runtimeCandidates.push('typescript');
  if (values.languages.has('java')) runtimeCandidates.push('java');
  if (values.languages.has('python')) runtimeCandidates.push('python');
  for (const language of values.languages) if (!['typescript', 'javascript', 'java', 'python'].includes(language)) values.unsupported.add(`runtime-not-packaged:${language}`);
  for (const manager of values.packageManagers) if (!['npm', 'maven', 'pip'].includes(manager)) values.unsupported.add(`package-manager-adapter-required:${manager}`);
  for (const runner of values.testRunners) if (!['playwright-test', 'junit5', 'pytest'].includes(runner)) values.unsupported.add(`test-runner-adapter-required:${runner}`);

  return {
    $schema: 'argus/template-capabilities@1', schemaVersion: 1, targetRoot: root,
    languages: sorted(values.languages), frameworks: sorted(values.frameworks), testRunners: sorted(values.testRunners),
    packageManagers: sorted(values.packageManagers), sourceRoots: sorted(values.sourceRoots), testRoots: sorted(values.testRoots),
    ci: sorted(values.ci), existingSuite: values.testRunners.size > 0 || values.testRoots.size > 0,
    runtimeCandidates: [...new Set(runtimeCandidates)].sort(), signals: uniqueSignals(signals), unsupported: sorted(values.unsupported),
  };
}

export function selectTemplate({ capabilities, contract, runtime, packageManager, testRoot, harnessRoot, ci }) {
  const errors = validateTemplateContract(contract);
  if (errors.length) throw new Error(`template contract invalid: ${errors.join('; ')}`);
  if (!RUNTIMES.includes(runtime)) throw new Error('explicit --runtime must be typescript, java, or python');
  if (!string(packageManager)) throw new Error('explicit or uniquely detected package manager is required');
  const action = capabilities.existingSuite ? 'adapt' : 'build';
  if (!safeRelative(testRoot) || !safeRelative(harnessRoot)) throw new Error('explicit safe relative test-root and harness-root are required');
  if (testRoot === harnessRoot || (action === 'build' && (withinPath(testRoot, harnessRoot) || withinPath(harnessRoot, testRoot)))) throw new Error('build test-root and harness-root must be disjoint');
  if (capabilities.existingSuite && capabilities.runtimeCandidates.length && !capabilities.runtimeCandidates.includes(runtime)) throw new Error(`runtime ${runtime} conflicts with detected candidates: ${capabilities.runtimeCandidates.join(', ')}`);
  const template = contract.templates[runtime];
  if (action === 'adapt' && capabilities.packageManagers.length && !capabilities.packageManagers.includes(packageManager)) throw new Error(`package manager ${packageManager} conflicts with detected managers: ${capabilities.packageManagers.join(', ')}`);
  if (action === 'adapt' && capabilities.testRoots.length && !capabilities.testRoots.includes(testRoot)) throw new Error(`test root ${testRoot} conflicts with detected roots: ${capabilities.testRoots.join(', ')}`);
  if (action === 'adapt' && capabilities.sourceRoots.length && !capabilities.sourceRoots.includes(harnessRoot)) throw new Error(`harness root ${harnessRoot} conflicts with detected roots: ${capabilities.sourceRoots.join(', ')}`);
  const unsupported = [...capabilities.unsupported];
  if (!template.packageManagers.includes(packageManager)) unsupported.push(`selected-package-manager-adapter-required:${packageManager}`);
  if (action === 'build' && unsupported.some((item) => item.startsWith('selected-package-manager'))) throw new Error(`build adapter unavailable for ${packageManager}; choose ${template.packageManagers.join(', ')} or adapt explicitly`);
  const detectedFramework = capabilities.frameworks[0];
  const detectedRunner = capabilities.testRunners[0];
  return {
    $schema: 'argus/template-selection@1', schemaVersion: 1, contractId: 'argus/template-selection@1',
    targetRoot: capabilities.targetRoot, runtime, packageManager,
    framework: action === 'adapt' && detectedFramework ? detectedFramework : template.framework,
    testRunner: action === 'adapt' && detectedRunner ? detectedRunner : template.runner,
    testRoot, harnessRoot, ci: [...new Set([...capabilities.ci, ...(ci ?? [])])].sort(), action,
    choiceSource: 'explicit-user', capabilitiesSha256: sha256(stable(capabilities)),
    unsupported: [...new Set(unsupported)].sort(), extensionPoints: [...template.extensionPoints],
  };
}

export function resolveDetectedPackageManager(capabilities, runtime, contract) {
  const supported = new Set(contract.templates?.[runtime]?.packageManagers ?? []);
  const matches = capabilities.packageManagers.filter((item) => supported.has(item));
  return matches.length === 1 ? matches[0] : null;
}

export function validateTemplateSelection(selection, contract) {
  const errors = [];
  if (!object(selection) || selection.schemaVersion !== 1 || selection.contractId !== 'argus/template-selection@1' || selection.$schema !== 'argus/template-selection@1') return ['template selection identity is invalid'];
  if (!RUNTIMES.includes(selection.runtime) || !string(selection.packageManager) || !string(selection.framework) || !string(selection.testRunner)) errors.push('runtime, package manager, framework, or runner is invalid');
  if (!safeRelative(selection.testRoot) || !safeRelative(selection.harnessRoot) || selection.testRoot === selection.harnessRoot || (selection.action === 'build' && (withinPath(selection.testRoot, selection.harnessRoot) || withinPath(selection.harnessRoot, selection.testRoot)))) errors.push('selection layout roots are invalid');
  if (!['build', 'adapt'].includes(selection.action) || selection.choiceSource !== 'explicit-user') errors.push('selection action or explicit choice source is invalid');
  if (!/^[a-f0-9]{64}$/.test(selection.capabilitiesSha256 ?? '') || !Array.isArray(selection.ci) || !Array.isArray(selection.unsupported) || !Array.isArray(selection.extensionPoints)) errors.push('selection digest or capability lists are invalid');
  const expected = contract.templates?.[selection.runtime];
  if (!expected || !sameSet(selection.extensionPoints, expected.extensionPoints)) errors.push('selection extension points differ from the shared contract');
  if (selection.action === 'build' && (!expected?.packageManagers.includes(selection.packageManager) || selection.unsupported.length)) errors.push('build selection contains unsupported capabilities');
  return [...new Set(errors)];
}

export function materializeTemplateLayout(destination, selection) {
  if (selection.action !== 'build') throw new Error('scaffold is forbidden for action=adapt; extend the detected suite in place');
  const root = resolve(destination);
  const testRoot = safeDestination(root, selection.testRoot);
  const harnessRoot = safeDestination(root, selection.harnessRoot);
  if (selection.runtime === 'typescript') materializeTypeScript(root, testRoot, harnessRoot, selection);
  else if (selection.runtime === 'java') materializeJava(root, testRoot, harnessRoot, selection);
  else if (selection.runtime === 'python') materializePython(root, testRoot, harnessRoot, selection);
  else throw new Error(`unsupported runtime layout: ${selection.runtime}`);
  rewriteDocs(root, selection);
}

export function stable(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function materializeTypeScript(root, testRoot, harnessRoot, selection) {
  const oldTests = join(root, 'tests');
  const oldHarness = join(root, 'src');
  moveDirectory(oldTests, testRoot);
  moveDirectory(oldHarness, harnessRoot);
  for (const file of walk(root).filter((path) => ['.ts', '.tsx', '.mts', '.cts'].includes(extname(path)))) {
    const oldFile = remapNewToOld(file, testRoot, oldTests, harnessRoot, oldHarness);
    const updated = read(file).replace(/((?:from\s+|import\s*)['"])(\.[^'"]+)(['"])/g, (whole, prefix, specifier, suffix) => {
      const oldTarget = resolve(dirname(oldFile), specifier);
      const newTarget = remapOldToNew(oldTarget, oldTests, testRoot, oldHarness, harnessRoot);
      let next = relative(dirname(file), newTarget).split(sep).join('/');
      if (!next.startsWith('.')) next = `./${next}`;
      return `${prefix}${next}${suffix}`;
    });
    writeFileSync(file, updated);
  }
  const playwrightPath = join(root, 'playwright.config.ts');
  writeFileSync(playwrightPath, read(playwrightPath).replaceAll('./tests', `./${selection.testRoot}`));
  const tsconfigPath = join(root, 'tsconfig.json');
  const tsconfig = JSON.parse(read(tsconfigPath));
  tsconfig.include = [selection.harnessRoot, selection.testRoot, 'playwright.config.ts'];
  writeFileSync(tsconfigPath, stable(tsconfig));
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(read(packagePath));
  if (packageJson.scripts?.perf) packageJson.scripts.perf = packageJson.scripts.perf.replace('src/', `${selection.harnessRoot}/`);
  writeFileSync(packagePath, stable(packageJson));
  replaceIn(join(root, 'scripts', 'bug-coverage.mjs'), "join(ROOT, 'tests')", `join(ROOT, ${JSON.stringify(selection.testRoot)})`);
  replaceIn(join(root, 'scripts', 'app-source-guard.mjs'), "  'tests/',", `  ${JSON.stringify(`${selection.testRoot}/`)},`);
  replaceIn(join(root, 'scripts', 'app-source-guard.mjs'), "  'src/',", `  ${JSON.stringify(`${selection.harnessRoot}/`)},`);
  replaceIn(join(root, 'run-tests.sh'), 'TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"', `TEST_ROOT="\${ARGUS_TEST_ROOT:-${selection.testRoot}}"`);
}

function materializeJava(root, testRoot, harnessRoot, selection) {
  const javaRoot = join(root, 'src', 'test', 'java');
  const support = join(javaRoot, 'qa', 'support');
  moveDirectory(support, join(harnessRoot, 'qa', 'support'));
  moveDirectory(javaRoot, testRoot);
  const resources = join(root, 'src', 'test', 'resources');
  if (existsSync(resources)) moveDirectory(resources, join(harnessRoot, 'resources'));
  const pomPath = join(root, 'pom.xml');
  let pom = read(pomPath);
  const helper = `\n      <plugin>\n        <groupId>org.codehaus.mojo</groupId>\n        <artifactId>build-helper-maven-plugin</artifactId>\n        <version>3.5.0</version>\n        <executions><execution><id>argus-test-roots</id><phase>generate-test-sources</phase><goals><goal>add-test-source</goal></goals><configuration><sources><source>\${project.basedir}/${selection.testRoot}</source><source>\${project.basedir}/${selection.harnessRoot}</source></sources></configuration></execution></executions>\n      </plugin>`;
  if (!pom.includes('build-helper-maven-plugin')) pom = pom.replace(/\n\s*<\/plugins>/, `${helper}\n    </plugins>`);
  const resourcesBlock = `\n    <testResources><testResource><directory>\${project.basedir}/${selection.harnessRoot}/resources</directory></testResource></testResources>`;
  if (!pom.includes('<testResources>')) pom = pom.replace(/\n\s*<plugins>/, `${resourcesBlock}\n    <plugins>`);
  writeFileSync(pomPath, pom);
  replaceIn(join(root, 'run-tests.sh'), 'TEST_ROOT="${ARGUS_TEST_ROOT:-src/test/java}"', `TEST_ROOT="\${ARGUS_TEST_ROOT:-${selection.testRoot}}"`);
}

function materializePython(root, testRoot, harnessRoot, selection) {
  moveDirectory(join(root, 'tests'), testRoot);
  moveDirectory(join(root, 'src'), harnessRoot);
  replaceIn(join(root, 'pyproject.toml'), 'testpaths = ["tests"]', `testpaths = [${JSON.stringify(selection.testRoot)}]`);
  replaceIn(join(root, 'pyproject.toml'), 'pythonpath = ["src"]', `pythonpath = [${JSON.stringify(selection.harnessRoot)}]`);
  replaceIn(join(root, 'conftest.py'), '_ROOT / "src"', `_ROOT / ${JSON.stringify(selection.harnessRoot)}`);
  replaceIn(join(root, 'conftest.py'), '_ROOT / "tests" / "setup"', `_ROOT / ${JSON.stringify(selection.testRoot)} / "setup"`);
  replaceIn(join(root, 'run-tests.sh'), 'TEST_ROOT="${ARGUS_TEST_ROOT:-tests}"', `TEST_ROOT="\${ARGUS_TEST_ROOT:-${selection.testRoot}}"`);
}

function rewriteDocs(root, selection) {
  for (const file of walk(root).filter((path) => extname(path) === '.md')) {
    let content = read(file);
    if (selection.runtime === 'java') {
      content = content
        .replaceAll('src/test/java/qa/support/', `${selection.harnessRoot}/qa/support/`)
        .replaceAll('src/test/java/qa/support', `${selection.harnessRoot}/qa/support`)
        .replaceAll('src/test/java/', `${selection.testRoot}/`)
        .replaceAll('src/test/resources/', `${selection.harnessRoot}/resources/`)
        .replaceAll('src/test/java', selection.testRoot)
        .replaceAll('src/test/resources', `${selection.harnessRoot}/resources`);
    } else {
      content = content.replaceAll('tests/', `${selection.testRoot}/`).replaceAll('src/', `${selection.harnessRoot}/`);
      content = content.replaceAll('`tests`', `\`${selection.testRoot}\``).replaceAll('`src`', `\`${selection.harnessRoot}\``);
    }
    writeFileSync(file, content);
  }
}

function moveDirectory(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) throw new Error(`layout destination already exists: ${destination}`);
  renameSync(source, destination);
}
function replaceIn(path, from, to) { const content = read(path); if (!content.includes(from)) throw new Error(`layout adapter anchor missing: ${path}: ${from}`); writeFileSync(path, content.replaceAll(from, to)); }
function remapNewToOld(path, newTests, oldTests, newHarness, oldHarness) { if (inside(newTests, path)) return resolve(oldTests, relative(newTests, path)); if (inside(newHarness, path)) return resolve(oldHarness, relative(newHarness, path)); return path; }
function remapOldToNew(path, oldTests, newTests, oldHarness, newHarness) { if (inside(oldTests, path)) return resolve(newTests, relative(oldTests, path)); if (inside(oldHarness, path)) return resolve(newHarness, relative(oldHarness, path)); return path; }
function safeDestination(root, path) { const candidate = resolve(root, path); if (!inside(root, candidate) || candidate === root) throw new Error(`layout path escapes scaffold: ${path}`); return candidate; }
function inside(root, candidate) { const rel = relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.startsWith('/')); }

function walk(root, cursor = root, output = []) {
  for (const entry of readdirSync(cursor, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const path = join(cursor, entry.name);
    if (entry.isDirectory()) walk(root, path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}
function read(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }
function json(path) { try { return JSON.parse(read(path)); } catch { return null; } }
function directory(root, path) { const candidate = join(root, path); return existsSync(candidate) && statSync(candidate).isDirectory(); }
function namesForPrefix(names, prefix) { return [...names].filter((name) => name.startsWith(prefix)); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function list(value) { return Array.isArray(value) && value.length > 0 && value.every(string) && new Set(value).size === value.length; }
function sorted(value) { return [...value].sort(); }
function sameSet(actual, expected) { return Array.isArray(actual) && actual.length === expected.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]); }
function uniqueSignals(signals) { return [...new Map(signals.map((item) => [`${item.capability}\0${item.source}`, item])).values()].sort((a, b) => a.capability.localeCompare(b.capability) || a.source.localeCompare(b.source)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeRelative(value) { return string(value) && !value.startsWith('/') && !value.split(/[\\/]/).includes('..'); }
function withinPath(parent, child) { return child.startsWith(`${parent.replace(/\/$/, '')}/`); }
