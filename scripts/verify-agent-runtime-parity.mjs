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
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const roster = readFileSync(join(ROOT, 'agents-roster.html'), 'utf8');
const parityReport = readFileSync(join(ROOT, 'AGENT-RUNTIME-PARITY.md'), 'utf8');
const adapters = JSON.parse(readFileSync(join(ROOT, 'argus', 'runtime-adapters.json'), 'utf8'));
const odysseusSource = readFileSync(join(ROOT, 'argus', 'roles', 'odysseus.md'), 'utf8');
const allSlugs = new Set();
const totals = { opus: 0, sonnet: 0, haiku: 0, sol: 0, terra: 0, luna: 0 };

execFileSync('node', [join(ROOT, 'scripts/sync-hephaestus-codex-variants.mjs'), '--check'], { stdio: 'inherit' });
execFileSync('node', [join(ROOT, 'scripts/sync-argus-role-variants.mjs'), '--check'], { stdio: 'inherit' });

assert(adapters.schemaVersion === 3, 'Argus runtime support contract must use schema v3');
assert(adapters.support?.claude?.level === 'plugin-native', 'Claude support must be plugin-native');
assert(adapters.support?.codex?.level === 'parent-runtime-dependent', 'Codex support must be parent-runtime-dependent');
assert(adapters.support?.codex?.parentRuntimeRequired === true, 'Codex support must require a parent runtime');
assert(adapters.support?.codex?.missingCapabilityOutcome === 'CAPABILITY_GAP', 'Codex missing capabilities must return CAPABILITY_GAP');
assert(adapters.configurationParity?.status === 'validated', 'generated configuration parity must be validated');
assert(adapters.configurationParity?.doesNotClaim?.includes('behavioral-equivalence'), 'configuration parity must explicitly exclude behavioral equivalence');
const staticRoster = odysseusSource.match(/## The Argus QA Team[\s\S]*?\*\*Lane map/)?.[0] ?? '';
assert(staticRoster && !/\|\s*Model\s*\|/.test(staticRoster), 'Odysseus static roster must not duplicate model assignments');
assert(!/\|\s*(?:opus|sonnet|haiku|sol|terra|luna)\s*\|/i.test(staticRoster), 'Odysseus static roster contains a provider model token');
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
    } else {
      assert(!/Claude\s+`(?:opus|sonnet|haiku)\//.test(markdownRaw), `${team}/${slug}: readable Codex companion leaks cross-runtime model mapping`);
    }
    assert(markdownRaw.includes(`model: ${expected.model}`) && markdownRaw.includes(`model_reasoning_effort: ${expected.effort}`), `${team}/${slug}: readable Codex model drift`);
    const sourcePath = markdownRaw.match(/^source:\s*(.+)$/m)?.[1];
    const sourceDigest = markdownRaw.match(/^source_sha256:\s*([0-9a-f]{64})$/m)?.[1];
    assert(sourcePath && sourceDigest, `${team}/${slug}: source provenance missing`);
    const absoluteSource = join(ROOT, sourcePath);
    assert(existsSync(absoluteSource), `${team}/${slug}: source path does not exist: ${sourcePath}`);
    assert(sha256(readFileSync(absoluteSource, 'utf8')) === sourceDigest, `${team}/${slug}: source SHA-256 drift`);
    assert(/100% English/.test(codex.instructions), `${team}/${slug}: Codex artifact-language parity missing`);
    if (team === 'hephaestus') {
      assert(codex.instructions.endsWith(parseMarkdown(claudeRaw).body.trim()), `${team}/${slug}: role body differs between runtimes`);
    } else {
      for (const marker of ['## Generated Semantic Contract', '## Shared QA Doctrine', '## Role Instructions']) {
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

assert(/opus.*sol.*xhigh/.test(readme) && /sonnet.*terra.*medium/.test(readme) && /haiku.*luna.*medium/.test(readme), 'README mapping summary is incomplete');
console.log(`PASS  Generated configuration parity: 49 Claude agents = 49 Codex pairs; models opus/sonnet/haiku ${totals.opus}/${totals.sonnet}/${totals.haiku} -> sol/terra/luna ${totals.sol}/${totals.terra}/${totals.luna}; support levels, README, and HTML roster aligned; behavioral equivalence not claimed`);

function parseClaude(raw) {
  const parsed = parseMarkdown(raw);
  const scalar = Object.fromEntries([...parsed.frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/gm)].map((match) => [match[1], match[2].trim()]));
  return { description: scalar.description, model: scalar.model, tools: scalar.tools.split(',').map((tool) => tool.trim()) };
}

function parseCodexToml(raw) {
  const value = (field) => raw.match(new RegExp(`^${field} = "([^"]*)"$`, 'm'))?.[1];
  const instructions = raw.match(/developer_instructions = '''\n([\s\S]*?)\n'''\n?$/)?.[1];
  assert(instructions, 'Codex TOML developer_instructions missing');
  return { name: value('name'), description: value('description'), model: value('model'), sandbox: value('sandbox_mode'), effort: value('model_reasoning_effort'), instructions };
}

function parseMarkdown(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert(match, 'Markdown frontmatter is invalid');
  return { frontmatter: match[1], body: match[2] };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
