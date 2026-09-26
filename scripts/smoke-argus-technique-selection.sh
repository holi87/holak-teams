#!/usr/bin/env bash
# Prove lazy catalog selection, integrity binding, and conservative full fallback.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
SOURCE="$ROOT/scripts/fixtures/argus-coverage/surface-inventory.json"
MATRIX="$ROOT/argus/claude/capabilities/capability-matrix.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node "$ROOT/scripts/sync-argus-technique-bundle.mjs" --check >/dev/null

"$CLI" technique scopes --role proteus >"$WORK/proteus-scopes.json"
jq -e '.schema == "argus/technique-scope-list@1" and (.scopes | index("proteus:graphql")) != null and (.scopes | index("proteus:websocket-sse")) != null' "$WORK/proteus-scopes.json" >/dev/null

"$CLI" technique select --role atalanta --inventory "$SOURCE" >"$WORK/atalanta-full.json"
jq -e '.disposition == "full-fallback" and .reason == "missing-role-scopes" and (.selectedIds | length) == 22 and (.catalog.entries | length) == 22' "$WORK/atalanta-full.json" >/dev/null

jq '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:["atalanta:validation"]}' "$SOURCE" >"$WORK/atalanta-inventory.json"
"$CLI" technique select --role atalanta --inventory "$WORK/atalanta-inventory.json" >"$WORK/atalanta-selected.json"
jq -e '.disposition == "selected" and (.selectedIds | length) < 22 and (.selectedIds | index("ATA-T01")) != null and (.catalog.entries | length) == (.selectedIds | length)' "$WORK/atalanta-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-EVENT-ORDER-CREATED")) += {techniqueScopes:["proteus:graphql"]}' "$SOURCE" >"$WORK/proteus-inventory.json"
"$CLI" technique select --role proteus --inventory "$WORK/proteus-inventory.json" >"$WORK/proteus-selected.json"
jq -e '.disposition == "selected" and .selectedIds == ["PRO-T01", "PRO-T02", "PRO-T03", "PRO-T04"]' "$WORK/proteus-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-UI-CHECKOUT")) += {techniqueScopes:["metis:security"]}' "$SOURCE" >"$WORK/metis-inventory.json"
"$CLI" technique select --role metis --inventory "$WORK/metis-inventory.json" >"$WORK/metis-selected.json"
jq -e '.disposition == "selected" and .selectedIds == ["security"] and (.catalog.istqb.techniques | length) > 0 and .catalog.boundaryRegister.required == true' "$WORK/metis-selected.json" >/dev/null

jq '(.items[] | select(.id == "SRF-EVENT-ORDER-CREATED")) += {techniqueScopes:["proteus:unknown-scope"]}' "$SOURCE" >"$WORK/proteus-unknown.json"
"$CLI" technique select --role proteus --inventory "$WORK/proteus-unknown.json" >"$WORK/proteus-fallback.json"
jq -e '.disposition == "full-fallback" and (.reason | startswith("unknown-role-scopes:")) and (.selectedIds | length) == 15' "$WORK/proteus-fallback.json" >/dev/null

# Ariadne scopes select a subset instead of being rejected or falling back to the full catalog.
ARIADNE_COUNT="$(jq -r '.techniqueCatalogs.ariadne.entryCount' "$MATRIX")"
jq '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:["ariadne:authorization"]}' "$SOURCE" >"$WORK/ariadne-inventory.json"
"$CLI" technique select --role ariadne --inventory "$WORK/ariadne-inventory.json" >"$WORK/ariadne-selected.json"
jq -e --argjson count "$ARIADNE_COUNT" '.disposition == "selected" and .reason == "explicit-role-scopes" and .declaredScopes == ["authorization"]
  and (.selectedIds | index("ARI-T05")) != null and (.selectedIds | index("ARI-T13")) != null and (.selectedIds | index("ARI-T01")) == null
  and (.selectedIds | length) < $count and (.catalog.entries | length) == (.selectedIds | length)' "$WORK/ariadne-selected.json" >/dev/null

# One shared inventory carries every role's namespaced scopes; another role's scopes never
# invalidate the selection for this role.
jq '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:["atalanta:validation", "ariadne:authorization"]}' "$SOURCE" >"$WORK/shared-inventory.json"
"$CLI" technique select --role atalanta --inventory "$WORK/shared-inventory.json" >"$WORK/shared-atalanta.json"
jq -e '.disposition == "selected" and .declaredScopes == ["validation"]' "$WORK/shared-atalanta.json" >/dev/null

jq '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:["unregistered-role:probe"]}' "$SOURCE" >"$WORK/unregistered-inventory.json"
if "$CLI" technique select --role atalanta --inventory "$WORK/unregistered-inventory.json" >/dev/null 2>"$WORK/unregistered.err"; then
  printf 'FAIL  technique select accepted a scope namespace that the capability matrix does not register\n' >&2
  exit 1
fi
grep -q 'invalid techniqueScopes: unregistered-role:probe' "$WORK/unregistered.err"

# Every role the capability matrix registers is accepted by the selector without a code list.
while IFS= read -r role; do
  "$CLI" technique scopes --role "$role" >"$WORK/$role-registered-scopes.json"
  scope="$(jq -r '.scopes[0]' "$WORK/$role-registered-scopes.json")"
  jq --arg scope "$scope" '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:[$scope]}' "$SOURCE" >"$WORK/$role-registered-inventory.json"
  "$CLI" technique select --role "$role" --inventory "$WORK/$role-registered-inventory.json" >"$WORK/$role-registered-selected.json"
  jq -e --arg scope "${scope#"$role":}" '.disposition == "selected" and .declaredScopes == [$scope]' "$WORK/$role-registered-selected.json" >/dev/null
done < <(jq -r '.techniqueCatalogs | keys_unsorted[]' "$MATRIX")

# Registration proof on an installed copy: a matrix declaration plus the catalog JSON in the
# hash-bound bundle is enough for a new role; the selector code is not edited.
cp -R "$ROOT/argus/claude" "$WORK/plugin"
PROBE_ROLE="$(node --input-type=module - "$WORK/plugin" <<'NODE'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const plugin = process.argv[2];
const matrixPath = join(plugin, 'capabilities', 'capability-matrix.json');
const bundlePath = join(plugin, 'capabilities', 'technique-catalogs.bundle.b64');
const manifestPath = join(plugin, 'runtime-assets.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const agent = matrix.agents
  .filter((candidate) => !Object.hasOwn(matrix.techniqueCatalogs, candidate.slug))
  .sort((left, right) => left.slug.localeCompare(right.slug))[0];
const role = agent.slug;
const catalog = {
  $schema: 'argus/technique-catalog@1',
  schemaVersion: 1,
  catalogId: `argus/technique-catalog/${role}@1`,
  role,
  catalogType: 'hunter',
  valuePolicy: 'discover-never-assume',
  executionRule: 'each-applicable-entry-covered-or-gap',
  absentSurfaceDisposition: 'not-applicable-with-evidence',
  entries: ['alpha', 'beta'].map((name, index) => ({
    id: `ZZZ-T0${index + 1}`,
    title: `Registration probe ${name}`,
    scope: [`probe-${name}`],
    techniques: ['equivalence-partitioning'],
    appliesWhen: 'surface-present',
    construct: [`Construct the ${name} probe request.`],
    oracles: ['The documented probe invariant holds after the request.'],
    routes: ['api'],
  })),
};
const source = `${JSON.stringify(catalog, null, 2)}\n`;
const sha256 = createHash('sha256').update(source).digest('hex');
matrix.techniqueCatalogs[role] = {
  catalogId: catalog.catalogId,
  catalogType: 'hunter',
  idPrefix: 'ZZZ',
  entryCount: catalog.entries.length,
  sha256,
  delivery: 'lazy',
  requiredAsset: 'technique-catalogs-bundle',
  selectionInput: 'argus/surface-inventory@1',
  fallback: 'full-catalog',
};
agent.techniqueCatalogs.push(role);
writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
const bundle = JSON.parse(brotliDecompressSync(Buffer.from(readFileSync(bundlePath, 'utf8').trim(), 'base64')).toString('utf8'));
bundle.catalogs[role] = { sha256, source };
writeFileSync(bundlePath, `${brotliCompressSync(Buffer.from(JSON.stringify(bundle))).toString('base64')}\n`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const asset of manifest.assets.filter((item) => ['capability-matrix', 'technique-catalogs-bundle'].includes(item.id))) {
  const path = join(plugin, asset.destination);
  const content = readFileSync(path);
  const hash = createHash('sha256');
  for (const part of ['file\0', basename(path), '\0', statSync(path).mode & 0o111 ? 'x' : '-', '\0']) hash.update(part);
  hash.update(content);
  Object.assign(asset, { files: 1, bytes: content.length, sha256: hash.digest('hex') });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(role);
NODE
)"
PROBE_CLI="$WORK/plugin/bin/argus-assets"
"$PROBE_CLI" technique scopes --role "$PROBE_ROLE" >"$WORK/probe-scopes.json"
jq -e --arg role "$PROBE_ROLE" '.scopes == [($role + ":probe-alpha"), ($role + ":probe-beta")]' "$WORK/probe-scopes.json" >/dev/null
jq --arg scope "$PROBE_ROLE:probe-beta" '(.items[] | select(.id == "SRF-API-ORDERS-POST")) += {techniqueScopes:[$scope]}' "$SOURCE" >"$WORK/probe-inventory.json"
"$PROBE_CLI" technique select --role "$PROBE_ROLE" --inventory "$WORK/probe-inventory.json" >"$WORK/probe-selected.json"
jq -e '.disposition == "selected" and .selectedIds == ["ZZZ-T02"]' "$WORK/probe-selected.json" >/dev/null

printf 'PASS  Argus lazy technique selection: scoped Atalanta/Ariadne/Proteus/Metis, every registered namespace, matrix-only registration probe (%s), plus full fallback\n' "$PROBE_ROLE"
