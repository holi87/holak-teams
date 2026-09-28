#!/usr/bin/env bash
# Prove every technique catalog the capability matrix registers is well-formed, digest-bound,
# bundled, wired into its owning role, and guarded by negative fixtures, then run the full
# catalog validator. The role list comes from the matrix; no catalog is named here.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MATRIX="$ROOT/argus/capabilities/capability-matrix.json"
FIXTURES="$ROOT/scripts/fixtures/argus-technique-catalogs/mutations.json"

catalog_files=()
while IFS= read -r role; do
  catalog_files+=("$ROOT/argus/technique-catalogs/$role.json")
done < <(jq -r '.techniqueCatalogs | keys_unsorted[]' "$MATRIX")
jq empty "$ROOT/argus/schemas/technique-catalog.schema.json" "$MATRIX" "$FIXTURES" "${catalog_files[@]}"

node "$ROOT/scripts/validate-argus-technique-catalogs.mjs"
node "$ROOT/scripts/sync-argus-technique-bundle.mjs" --check >/dev/null

node --input-type=module - "$ROOT" <<'NODE'
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const read = (path) => readFileSync(join(root, path));
const readJson = (path) => JSON.parse(read(path).toString('utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const matrixPath = 'argus/capabilities/capability-matrix.json';
const matrix = readJson(matrixPath);
const registry = matrix.techniqueCatalogs;
const roles = Object.keys(registry);
const fixtures = readJson('scripts/fixtures/argus-technique-catalogs/mutations.json').cases;

// The packaged plugin must carry byte-identical copies of the registry and the bundle, so an
// installed selector verifies the same digests this repository reviewed.
check(read(matrixPath).equals(read('argus/claude/capabilities/capability-matrix.json')),
  'packaged capability matrix differs from the source; run scripts/sync-argus-runtime-assets.mjs --write');
const bundleSource = read('argus/technique-catalogs.bundle.b64');
check(bundleSource.equals(read('argus/claude/capabilities/technique-catalogs.bundle.b64')),
  'packaged technique bundle differs from the source; run scripts/sync-argus-runtime-assets.mjs --write');
const bundle = JSON.parse(brotliDecompressSync(Buffer.from(bundleSource.toString('utf8').trim(), 'base64')).toString('utf8'));
const bundled = Object.keys(bundle.catalogs ?? {});
check(bundled.length === roles.length && roles.every((role) => bundled.includes(role)),
  `bundle catalogs (${[...bundled].sort().join(', ')}) differ from registered roles (${[...roles].sort().join(', ')})`);

for (const role of roles) {
  const declaration = registry[role];
  const source = read(`argus/technique-catalogs/${role}.json`);
  const digest = sha256(source);

  // Registration: the declared digest binds the reviewed catalog bytes, and the bundle
  // carries exactly those bytes under the same digest.
  check(declaration.sha256 === digest,
    `${role}: capability-matrix sha256 ${declaration.sha256} does not match argus/technique-catalogs/${role}.json (${digest})`);
  const record = bundle.catalogs?.[role];
  check(record?.sha256 === declaration.sha256 && record?.source === source.toString('utf8'),
    `${role}: bundled catalog is not the registered catalog; run scripts/sync-argus-technique-bundle.mjs --write`);

  // Role binding: exactly one agent owns the catalog, and it is the agent of the same slug.
  const owners = matrix.agents.filter((agent) => (agent.techniqueCatalogs ?? []).includes(role)).map((agent) => agent.slug);
  check(owners.length === 1 && owners[0] === role, `${role}: catalog must bind only to the ${role} agent; bound to [${owners.join(', ')}]`);

  // Lazy-load wiring: the canonical prompt carries the placeholder, and both generated
  // variants render the selector command with the registered digest.
  check(read(`argus/roles/${role}.md`).toString('utf8').includes('{{ARGUS_TECHNIQUE_CATALOGS}}'),
    `${role}: argus/roles/${role}.md lacks the {{ARGUS_TECHNIQUE_CATALOGS}} placeholder`);
  for (const generated of [`argus/claude/agents/${role}.md`, `argus/codex/${role}.toml`]) {
    const text = read(generated).toString('utf8');
    check(text.includes(`## Lazy technique catalog: ${declaration.catalogId}`)
      && text.includes(`argus-assets technique select --role ${role} --inventory`)
      && text.includes(declaration.sha256),
    `${role}: ${generated} does not render the lazy catalog block with the registered digest; run scripts/sync-argus-role-variants.mjs --write`);
  }

  // Negative fixtures: every catalog has at least one, and every hunter catalog pins its
  // registered entry count by removing its last entry.
  const own = fixtures.filter((fixture) => fixture.catalog === role);
  check(own.length > 0, `${role}: no negative fixture in scripts/fixtures/argus-technique-catalogs/mutations.json`);
  if (declaration.catalogType === 'hunter') {
    check(own.some((fixture) => fixture.operation === 'remove'
      && fixture.pointer === `/entries/${declaration.entryCount - 1}`
      && fixture.runtimeIncludes === `exactly ${declaration.entryCount} entries`),
    `${role}: no entry-count fixture removes /entries/${declaration.entryCount - 1} and expects "exactly ${declaration.entryCount} entries"`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}
console.log(`PASS  Argus technique catalog registration: ${roles.length} catalogs digest-bound, bundled, role-wired, and fixture-guarded`);
NODE
