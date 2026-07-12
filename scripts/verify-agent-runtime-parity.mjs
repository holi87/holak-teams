#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapping = {
  opus: { model: 'sol', effort: 'xhigh' },
  sonnet: { model: 'terra', effort: 'medium' },
  haiku: { model: 'luna', effort: 'medium' },
};
const expectedCounts = { hephaestus: 22, argus: 27 };
const ARGUS_PROVENANCE_FIELDS = Object.freeze([
  'schema',
  'slug',
  'display_name',
  'runtime_config',
  'runtime_config_sha256',
  'developer_instructions_sha256',
  'canonical_source',
  'canonical_source_sha256',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'doctrine_profiles',
  'technique_catalogs',
  'generated_by',
  'runtime_consumed',
]);
const MAX_ARGUS_PROVENANCE_BYTES = 1500;
const MAX_ARGUS_PROVENANCE_CORPUS_BYTES = 40000;
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const roster = readFileSync(join(ROOT, 'agents-roster.html'), 'utf8');
const parityReport = readFileSync(join(ROOT, 'AGENT-RUNTIME-PARITY.md'), 'utf8');
const adapters = JSON.parse(readFileSync(join(ROOT, 'argus', 'runtime-adapters.json'), 'utf8'));
const argusCapabilities = JSON.parse(readFileSync(join(ROOT, 'argus', 'capabilities', 'capability-matrix.json'), 'utf8'));
const argusCapabilitiesBySlug = new Map(argusCapabilities.agents.map((agent) => [agent.slug, agent]));
const odysseusSource = readFileSync(join(ROOT, 'argus', 'roles', 'odysseus.md'), 'utf8');
const allSlugs = new Set();
const totals = { opus: 0, sonnet: 0, haiku: 0, sol: 0, terra: 0, luna: 0 };
let argusProvenanceBytes = 0;

execFileSync('node', [join(ROOT, 'scripts/sync-hephaestus-codex-variants.mjs'), '--check'], { stdio: 'inherit' });
execFileSync('node', [join(ROOT, 'scripts/sync-argus-role-variants.mjs'), '--check'], { stdio: 'inherit' });

assert(adapters.schemaVersion === 3, 'Argus runtime support contract must use schema v3');
assert(adapters.support?.claude?.level === 'host-launcher-required' && adapters.support.claude.launcher === 'bin/argus-launch', 'Claude support must require the native host launcher');
assert(adapters.support?.codex?.level === 'parent-runtime-dependent', 'Codex support must be parent-runtime-dependent');
assert(adapters.support?.codex?.parentRuntimeRequired === true, 'Codex support must require a parent runtime');
assert(adapters.support?.codex?.missingCapabilityOutcome === 'CAPABILITY_GAP', 'Codex missing capabilities must return CAPABILITY_GAP');
assert(adapters.configurationParity?.status === 'validated', 'generated configuration parity must be validated');
assert(adapters.configurationParity?.doesNotClaim?.includes('behavioral-equivalence'), 'configuration parity must explicitly exclude behavioral equivalence');
assert(!/## The Argus QA Team/.test(odysseusSource), 'Odysseus must not duplicate the machine-owned static roster');
assert(/machine orchestration plan/.test(odysseusSource), 'Odysseus must name the machine orchestration plan as authoritative');
assert(!/\|\s*(?:opus|sonnet|haiku|sol|terra|luna)\s*\|/i.test(odysseusSource), 'Odysseus contains a provider model roster row');
assert(/Configuration parity is not behavioral parity/.test(parityReport), 'parity report must bound the native config-load claim');

for (const team of Object.keys(expectedCounts)) {
  const claudeRoot = join(ROOT, team, 'claude', 'agents');
  const codexRoot = join(ROOT, team, 'codex');
  const files = readdirSync(claudeRoot).filter((file) => file.endsWith('.md')).sort();
  assert(files.length === expectedCounts[team], `${team}: expected ${expectedCounts[team]} Claude agents, found ${files.length}`);
  const codexToml = readdirSync(codexRoot).filter((file) => file.endsWith('.toml')).sort();
  const codexMarkdown = readdirSync(codexRoot).filter((file) => file.endsWith('.md')).sort();
  assert(codexToml.length === files.length && codexMarkdown.length === files.length, `${team}: Codex pair count differs from Claude`);

  for (const file of files) {
    const slug = file.slice(0, -3);
    assert(!allSlugs.has(`${team}:${slug}`), `${team}: duplicate slug ${slug}`);
    allSlugs.add(`${team}:${slug}`);
    assert(codexToml.includes(`${slug}.toml`) && codexMarkdown.includes(`${slug}.md`), `${team}/${slug}: missing Codex pair`);
    const claudeRaw = readFileSync(join(claudeRoot, file), 'utf8');
    const claude = parseClaude(claudeRaw);
    const tomlRaw = readFileSync(join(codexRoot, `${slug}.toml`), 'utf8');
    const markdownRaw = readFileSync(join(codexRoot, `${slug}.md`), 'utf8');
    const codex = parseCodexToml(tomlRaw);
    const expected = mapping[claude.model];
    assert(expected, `${team}/${slug}: unsupported Claude model ${claude.model}`);
    assert(codex.name === slug, `${team}/${slug}: Codex name mismatch`);
    assert(codex.description === claude.description, `${team}/${slug}: description drift`);
    assert(codex.model === expected.model, `${team}/${slug}: ${claude.model} must map to ${expected.model}, found ${codex.model}`);
    assert(codex.effort === expected.effort, `${team}/${slug}: ${claude.model} must use ${expected.effort}, found ${codex.effort}`);
    const expectedSandbox = claude.tools.includes('Write') ? 'workspace-write' : 'read-only';
    assert(codex.sandbox === expectedSandbox, `${team}/${slug}: sandbox drift`);
    if (team === 'hephaestus') {
      assert(markdownRaw.includes(`source_model_hint: ${claude.model}`), `${team}/${slug}: readable Codex provenance has stale tier`);
      assert(markdownRaw.includes(`model: ${expected.model}`) && markdownRaw.includes(`model_reasoning_effort: ${expected.effort}`), `${team}/${slug}: readable Codex model drift`);
      const sourcePath = markdownRaw.match(/^source:\s*(.+)$/m)?.[1];
      const sourceDigest = markdownRaw.match(/^source_sha256:\s*([0-9a-f]{64})$/m)?.[1];
      assert(sourcePath && sourceDigest, `${team}/${slug}: source provenance missing`);
      const absoluteSource = join(ROOT, sourcePath);
      assert(existsSync(absoluteSource), `${team}/${slug}: source path does not exist: ${sourcePath}`);
      assert(sha256(readFileSync(absoluteSource)) === sourceDigest, `${team}/${slug}: source SHA-256 drift`);
    } else {
      const provenance = parseArgusProvenance(markdownRaw, slug);
      const capability = argusCapabilitiesBySlug.get(slug);
      assert(capability, `${team}/${slug}: capability record missing`);
      const bytes = Buffer.byteLength(markdownRaw);
      assert(bytes < MAX_ARGUS_PROVENANCE_BYTES, `${team}/${slug}: provenance stub is ${bytes} bytes; must be < ${MAX_ARGUS_PROVENANCE_BYTES}`);
      argusProvenanceBytes += bytes;
      assert(provenance.schema === 'argus/codex-provenance@1', `${team}/${slug}: provenance schema mismatch`);
      assert(provenance.slug === slug, `${team}/${slug}: provenance slug mismatch`);
      assert(provenance.display_name === titleCase(slug), `${team}/${slug}: provenance display name mismatch`);
      assert(provenance.runtime_config === `argus/codex/${slug}.toml`, `${team}/${slug}: runtime config path mismatch`);
      assert(provenance.runtime_config_sha256 === sha256(tomlRaw), `${team}/${slug}: runtime config SHA-256 drift`);
      assert(provenance.developer_instructions_sha256 === sha256(codex.exactInstructions), `${team}/${slug}: developer_instructions SHA-256 drift`);
      assert(provenance.canonical_source === `argus/roles/${slug}.md`, `${team}/${slug}: canonical source path mismatch`);
      const absoluteSource = join(ROOT, provenance.canonical_source);
      assert(existsSync(absoluteSource), `${team}/${slug}: canonical source does not exist: ${provenance.canonical_source}`);
      assert(provenance.canonical_source_sha256 === sha256(readFileSync(absoluteSource)), `${team}/${slug}: canonical source SHA-256 drift`);
      assert(provenance.model === codex.model, `${team}/${slug}: provenance model drift`);
      assert(provenance.model_reasoning_effort === codex.effort, `${team}/${slug}: provenance reasoning effort drift`);
      assert(provenance.sandbox_mode === codex.sandbox, `${team}/${slug}: provenance sandbox drift`);
      assert(equal(provenance.doctrine_profiles, roleContractList(capability, ['doctrineProfiles', 'doctrine_profiles'], ['qa-core'])), `${team}/${slug}: doctrine profile provenance drift`);
      assert(equal(provenance.technique_catalogs, roleContractList(capability, ['techniqueCatalogs', 'technique_catalogs'], [])), `${team}/${slug}: technique catalog provenance drift`);
      assert(provenance.generated_by === 'scripts/sync-argus-role-variants.mjs', `${team}/${slug}: provenance generator mismatch`);
      assert(provenance.runtime_consumed === false, `${team}/${slug}: Markdown companion must be declared non-runtime`);
      assert(!/\b(?:Claude|opus|sonnet|haiku)\b/i.test(markdownRaw), `${team}/${slug}: provenance leaks an opposite-runtime model`);
      for (const forbidden of ['description:', 'tier:', 'maxTurns', 'developer_instructions =', '# Codex runtime adapter', '## Shared QA Doctrine', '## Role Instructions', '## Generated Semantic Contract']) {
        assert(!markdownRaw.includes(forbidden), `${team}/${slug}: provenance stub contains runtime content: ${forbidden}`);
      }
    }
    assert(/100% English/.test(codex.instructions), `${team}/${slug}: Codex artifact-language parity missing`);
    if (team === 'hephaestus') {
      assert(codex.instructions.endsWith(parseMarkdown(claudeRaw).body.trim()), `${team}/${slug}: role body differs between runtimes`);
    } else {
      for (const marker of ['# Runtime capability delta', '## Capability-selected doctrine', '## Role instructions']) {
        assert(codex.instructions.includes(marker), `${team}/${slug}: missing ${marker}`);
      }
    }
    const readmeRow = new RegExp(`^\\|[^\\n]*\\| \`${escapeRegex(slug)}\` \\|[^\\n]*\\| ${claude.model} \\| ${expected.model} · ${expected.effort} \\|$`, 'm');
    assert(readmeRow.test(readme), `${team}/${slug}: README model roster row is missing or stale`);
    const display = titleCase(slug);
    const htmlRow = new RegExp(`<tr><td class="name">${display}</td>[^\\n]*<span class="model m-${claude.model}">${claude.model}</span>`);
    assert(htmlRow.test(roster), `${team}/${slug}: HTML roster model is missing or stale`);
    totals[claude.model] += 1;
    totals[expected.model] += 1;
  }
}

assert(argusProvenanceBytes < MAX_ARGUS_PROVENANCE_CORPUS_BYTES, `Argus Codex provenance corpus is ${argusProvenanceBytes} bytes; must be < ${MAX_ARGUS_PROVENANCE_CORPUS_BYTES}`);
assert(/opus.*sol.*xhigh/.test(readme) && /sonnet.*terra.*medium/.test(readme) && /haiku.*luna.*medium/.test(readme), 'README mapping summary is incomplete');
console.log(`PASS  Generated configuration parity: 49 Claude agents = 49 Codex pairs; Argus provenance ${argusProvenanceBytes} bytes; models opus/sonnet/haiku ${totals.opus}/${totals.sonnet}/${totals.haiku} -> sol/terra/luna ${totals.sol}/${totals.terra}/${totals.luna}; support levels, README, and HTML roster aligned; behavioral equivalence not claimed`);

function parseClaude(raw) {
  const parsed = parseMarkdown(raw);
  const scalar = Object.fromEntries([...parsed.frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/gm)].map((match) => [match[1], match[2].trim()]));
  return { description: scalar.description, model: scalar.model, tools: scalar.tools.split(',').map((tool) => tool.trim()) };
}

function parseCodexToml(raw) {
  const value = (field) => raw.match(new RegExp(`^${field} = "([^"]*)"$`, 'm'))?.[1];
  const instructions = raw.match(/developer_instructions = '''\n([\s\S]*?)\n'''\n?$/)?.[1];
  assert(instructions, 'Codex TOML developer_instructions missing');
  return { name: value('name'), description: value('description'), model: value('model'), sandbox: value('sandbox_mode'), effort: value('model_reasoning_effort'), instructions, exactInstructions: `${instructions}\n` };
}

function parseArgusProvenance(raw, slug) {
  const parsed = parseMarkdown(raw);
  const entries = parsed.frontmatter.split('\n').map((line) => {
    const match = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
    assert(match, `argus/${slug}: invalid provenance field: ${line}`);
    return [match[1], match[2]];
  });
  assert(new Set(entries.map(([field]) => field)).size === entries.length, `argus/${slug}: duplicate provenance field`);
  assert(equal(entries.map(([field]) => field), ARGUS_PROVENANCE_FIELDS), `argus/${slug}: provenance fields or order differ from schema`);
  const values = Object.fromEntries(entries);
  for (const field of ['doctrine_profiles', 'technique_catalogs']) {
    try { values[field] = JSON.parse(values[field]); }
    catch { assert(false, `argus/${slug}: ${field} is not a JSON array`); }
    assert(Array.isArray(values[field]) && values[field].every((value) => typeof value === 'string'), `argus/${slug}: ${field} is not a string array`);
  }
  assert(values.runtime_consumed === 'false', `argus/${slug}: runtime_consumed must be false`);
  values.runtime_consumed = false;
  const expectedBody = `\n# ${titleCase(slug)} - Codex provenance\n\nGenerated metadata only. Codex loads \`${slug}.toml\`; this Markdown file is not runtime input.\n`;
  assert(parsed.body === expectedBody, `argus/${slug}: provenance body drift`);
  return values;
}

function roleContractList(capability, fields, fallback) {
  const selected = fields.find((field) => capability[field] !== undefined);
  const values = selected ? capability[selected] : fallback;
  assert(Array.isArray(values), `${capability.slug}: ${selected ?? fields[0]} must be an array`);
  assert(values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0), `${capability.slug}: provenance contract list contains an invalid value`);
  assert(new Set(values).size === values.length, `${capability.slug}: provenance contract list contains duplicates`);
  return values;
}

function parseMarkdown(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert(match, 'Markdown frontmatter is invalid');
  return { frontmatter: match[1], body: match[2] };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function titleCase(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(value, message) {
  if (!value) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}
