#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModelPolicy } from '../argus/runtime/model-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: sync-argus-model-policy.mjs [--check|--write]');

const policy = readJson('argus/model-policy.json');
const raci = readJson('argus/raci.json');
const slugs = raci.agents.map((agent) => agent.slug).sort();
const errors = validateModelPolicy(policy, slugs);
if (errors.length) fail(errors.join('; '));

const expectedFrontier = ['ariadne', 'aristarchus', 'atlas', 'kalchas', 'metis', 'minos', 'odysseus', 'perseus', 'tiresias', 'tyche'];
assert(equal(policy.roles.filter((role) => role.tier === 'frontier').map((role) => role.slug).sort(), expectedFrontier), 'frontier roster differs from the adopted 10-role baseline');

syncGenerated('argus/MODEL-POLICY.md', renderPolicy(policy));
syncFile('README.md', updateRootReadme);
syncFile('agents-roster.html', updateRosterHtml);

const counts = Object.fromEntries(['frontier', 'standard'].map((tier) => [tier, policy.roles.filter((role) => role.tier === tier).length]));
console.log(`PASS  Argus model policy: ${policy.roles.length} roles, ${counts.frontier} frontier, ${counts.standard} standard, 0 mechanical full roles`);

function updateRootReadme(content) {
  for (const role of policy.roles) {
    const tier = policy.tiers[role.tier];
    const pattern = new RegExp('^(\\|[^\\n]*\\| `' + role.slug + '` \\|[^\\n]*\\| )(opus|sonnet|haiku)( \\| )(sol|terra|luna)( · )(low|medium|high|xhigh)( \\|)$', 'm');
    assert(pattern.test(content), `${role.slug}: root README model row missing`);
    content = content.replace(pattern, `$1${tier.claude.model}$3${tier.codex.model}$5${tier.codex.reasoningEffort}$7`);
  }
  content = content.replace(
    /The above is the \*\*main team \(22\)\*\*\. \*\*Argus QA \(27\)\*\* is a separate, permanent QA team with mixed model tiers from the frontmatter \([^\n]+\)\./,
    'The above is the **main team (22)**. **Argus QA (27)** is a separate, permanent QA team with a generated 10 frontier / 17 standard policy from `argus/model-policy.json`.',
  );
  content = content.replace('**Tiers:** 19 opus · 8 sonnet.', '**Tiers:** 10 opus · 17 sonnet · 0 haiku full roles.');
  content = content.replace(
    /Current Argus QA (?:frontmatter models|policy):[^\n]+/,
    'Current Argus QA policy: **10 opus / 17 sonnet / 0 haiku full roles**. The generated [model policy](argus/MODEL-POLICY.md) records Claude/Codex models, effort, maximum turns, escalation, fallback, downgrade guards, telemetry, and benchmark evidence. Colors by role type (cyan=core, red=hunter, green=automation, yellow=path-analyst, purple=cross) remain in `argus/COLOR-SCHEME.md`. The role-variant generator consumes the same policy for all 27 Codex `*.toml` + `*.md` variants.',
  );
  return content;
}

function updateRosterHtml(content) {
  for (const role of policy.roles) {
    const name = `${role.slug[0].toUpperCase()}${role.slug.slice(1)}`;
    const model = policy.tiers[role.tier].claude.model;
    const pattern = new RegExp(`(<tr><td class="name">${name}</td>[^\\n]*?<span class="model m-)(opus|sonnet|haiku)(">)(opus|sonnet|haiku)(</span>)`);
    assert(pattern.test(content), `${role.slug}: visual roster model row missing`);
    content = content.replace(pattern, `$1${model}$3${model}$5`);
  }
  return content.replace('Argus QA: 19 opus / 8 sonnet', 'Argus QA: 10 opus / 17 sonnet / 0 haiku full roles');
}

function renderPolicy(data) {
  const lines = [
    '# Argus Runtime Model Policy', '',
    `Policy ID: \`${data.policyId}\`. The machine-readable source is [\`model-policy.json\`](model-policy.json).`, '',
    'The adopted baseline assigns 10 high-consequence roles to frontier reasoning and 17 bounded execution roles to standard reasoning. No complete role uses the mechanical tier.', '',
    '| Agent | Tier | Claude | Effort | Codex | Effort | Max turns | Escalation | Fallback |',
    '|---|---|---|---|---|---|---:|---|---|',
  ];
  for (const role of data.roles) {
    const tier = data.tiers[role.tier];
    lines.push(`| ${role.slug} | ${role.tier} | ${tier.claude.model} | ${tier.claude.effort} | ${tier.codex.model} | ${tier.codex.reasoningEffort} | ${role.maxTurns} | ${role.escalationProfile} | ${role.fallbackPolicy} |`);
  }
  lines.push('', '## Routing rules', '',
    '- Standard roles escalate upward to frontier on their declared ambiguity, safety, cross-lane, evidence, failure, or turn-limit signals.',
    '- Frontier roles never fall back to a weaker model. Unavailability blocks the dispatch and escalates to the operator.',
    '- Claude enforces the complete reviewed baseline in native agent frontmatter. Its current dispatch adapter blocks an escalation because no verified per-dispatch effort override exists. Codex native config enforces model and effort but blocks until the parent can also enforce max turns. Every runtime fails closed when model, effort, and turn cap cannot be honored together.',
    '- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.',
    '- Worker prompts contain only their turn cap, declared signals, and the `argus/model-escalation-request@1` stop envelope. They never select a model, invoke routing, or write telemetry.',
    '- Odysseus and `/argus:run` alone validate escalation envelopes, increment attempts, create a fresh thread for a selected decision, and bind telemetry to that immutable decision.',
    '- `argus-assets model route` validates the engagement and trusted adapter snapshot, then atomically persists a selected or blocked immutable decision under `ai_agents_internal/model-decisions/`. `argus-assets model telemetry` accepts only that exact decision and writes sanitized usage metrics bound to its ID and hashes.', '',
    '## Benchmark', '',
    'The committed `model-policy.benchmark.json` compares representative synthesis, judgment, and schema-bound work on quality markers, latency, input/output tokens, and provider-reported cost without storing prompts, completions, targets, accounts, or evidence.', '');
  return lines.join('\n');
}

function syncFile(path, transform) {
  const absolute = join(ROOT, path);
  const current = readFileSync(absolute, 'utf8');
  const expected = transform(current);
  if (mode === '--write') writeFileSync(absolute, expected);
  else assert(current === expected, `${path} is stale; run sync-argus-model-policy.mjs --write`);
}

function syncGenerated(path, expected) {
  const absolute = join(ROOT, path);
  if (mode === '--write') writeFileSync(absolute, `${expected.trimEnd()}\n`);
  else assert(readFileSync(absolute, 'utf8') === `${expected.trimEnd()}\n`, `${path} is stale; run sync-argus-model-policy.mjs --write`);
}

function readJson(path) { return JSON.parse(readFileSync(join(ROOT, path), 'utf8')); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assert(value, message) { if (!value) fail(message); }
function fail(message) { console.error(`FAIL  ${message}`); process.exit(1); }
