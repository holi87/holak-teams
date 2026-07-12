#!/usr/bin/env node

import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTechniqueCatalogSet } from '../argus/runtime/technique-catalogs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_ROOT = join(ROOT, 'argus', 'technique-catalogs');
const OUTPUT = join(ROOT, 'argus', 'technique-catalogs.bundle.b64');
const ROLES = ['atalanta', 'proteus', 'metis'];
const mode = process.argv[2] ?? '--check';
if (!['--write', '--check'].includes(mode)) fail('usage: scripts/sync-argus-technique-bundle.mjs [--write|--check]');

const records = {};
const documents = [];
for (const role of ROLES) {
  const source = readFileSync(join(CATALOG_ROOT, `${role}.json`), 'utf8');
  const document = JSON.parse(source);
  documents.push(document);
  records[role] = {
    sha256: createHash('sha256').update(source).digest('hex'),
    source,
  };
}
const errors = validateTechniqueCatalogSet(documents);
if (errors.length) fail(`canonical technique catalogs are invalid: ${errors.join('; ')}`);

const payload = JSON.stringify({
  schema: 'argus/technique-catalog-bundle@1',
  schemaVersion: 1,
  catalogs: records,
});
const encoded = `${brotliCompressSync(Buffer.from(payload), {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
  },
}).toString('base64')}\n`;

if (mode === '--write') writeFileSync(OUTPUT, encoded, 'utf8');
else {
  if (!existsSync(OUTPUT)) fail('technique catalog bundle is missing; run --write');
  if (readFileSync(OUTPUT, 'utf8') !== encoded) fail('technique catalog bundle is stale; run --write');
}

console.log(`PASS  Argus lazy technique bundle: ${ROLES.length} catalogs, ${Buffer.byteLength(encoded)} bytes (${mode.slice(2)})`);

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
