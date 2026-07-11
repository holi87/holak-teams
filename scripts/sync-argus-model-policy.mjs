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

const roles = new Map(policy.roles.map((role) => [role.slug, role]));
const expectedFrontier = ['ariadne', 'aristarchus', 'atlas', 'kalchas', 'metis', 'minos', 'odysseus', 'perseus', 'tiresias', 'tyche'];
assert(equal(policy.roles.filter((role) => role.tier === 'frontier').map((role) => role.slug).sort(), expectedFrontier), 'frontier roster differs from the adopted 10-role baseline');

for (const slug of slugs) {
  const role = roles.get(slug);
  syncFile(`argus/claude/agents/${slug}.md`, (content) => updateClaude(content, role));
  syncFile(`argus/codex/${slug}.md`, (content) => updateCodexMarkdown(content, role));
  syncFile(`argus/codex/${slug}.toml`, (content) => updateCodexToml(content, role));
}

for (const path of ['argus/claude/agents/odysseus.md', 'argus/codex/odysseus.md', 'argus/codex/odysseus.toml']) {
  syncFile(path, updateOdysseusRouting);
}
syncGenerated('argus/MODEL-POLICY.md', renderPolicy(policy));
syncFile('README.md', updateRootReadme);
syncFile('agents-roster.html', updateRosterHtml);

const counts = Object.fromEntries(['frontier', 'standard'].map((tier) => [tier, policy.roles.filter((role) => role.tier === tier).length]));
console.log(`PASS  Argus model policy: ${policy.roles.length} roles, ${counts.frontier} frontier, ${counts.standard} standard, 0 mechanical full roles`);

function updateClaude(content, role) {
  const tier = policy.tiers[role.tier].claude;
  assert(/^model:\s*\S+$/m.test(content), `${role.slug}: Claude model field missing`);
  content = content.replace(/^model:\s*\S+$/m, `model: ${tier.model}`);
  content = content.replace(/^effort:\s*\S+\n?/m, '').replace(/^maxTurns:\s*\d+\n?/m, '');
  content = content.replace(`model: ${tier.model}\n`, `model: ${tier.model}\neffort: ${tier.effort}\nmaxTurns: ${role.maxTurns}\n`);
  return insertBlock(content, role);
}

function updateCodexMarkdown(content, role) {
  const claude = policy.tiers[role.tier].claude;
  content = content.replace(/source_model_hint:\s*(?:opus|sonnet|haiku)/g, `source_model_hint: ${claude.model}`);
  return insertBlock(content, role);
}

function updateCodexToml(content, role) {
  const tier = policy.tiers[role.tier].codex;
  assert(/^model = ".+"$/m.test(content), `${role.slug}: Codex model field missing`);
  assert(/^model_reasoning_effort = ".+"$/m.test(content), `${role.slug}: Codex reasoning effort missing`);
  content = content.replace(/^model = ".+"$/m, `model = ${JSON.stringify(tier.model)}`);
  content = content.replace(/^model_reasoning_effort = ".+"$/m, `model_reasoning_effort = ${JSON.stringify(tier.reasoningEffort)}`);
  content = content.replace(/source_model_hint:\s*(?:opus|sonnet|haiku)/g, `source_model_hint: ${policy.tiers[role.tier].claude.model}`);
  return insertBlock(content, role);
}

function insertBlock(content, role) {
  const block = renderAgentBlock(role);
  const pattern = /<!-- MODEL_POLICY_START -->[\s\S]*?<!-- MODEL_POLICY_END -->\n*/;
  if (pattern.test(content)) return content.replace(pattern, `${block}\n`);
  if (content.includes('<!-- RACI_CONTRACT_START -->')) return content.replace('<!-- RACI_CONTRACT_START -->', `${block}\n<!-- RACI_CONTRACT_START -->`);
  assert(content.includes('<!-- Author:'), `${role.slug}: no generated-block anchor`);
  return content.replace('<!-- Author:', `${block}\n<!-- Author:`);
}

function renderAgentBlock(role) {
  const tier = policy.tiers[role.tier];
  const triggers = `${role.slug}: ${policy.escalationProfiles[role.escalationProfile].join(', ')}`;
  return `<!-- MODEL_POLICY_START -->\n## Runtime Model Policy\n\n- Source: \`${policy.policyId}\`; baseline tier: \`${role.tier}\`; maximum turns: \`${role.maxTurns}\`.\n- Claude: \`${tier.claude.model}\` / \`${tier.claude.effort}\`; Codex: \`${tier.codex.model}\` / \`${tier.codex.reasoningEffort}\`.\n- Escalation profile \`${role.escalationProfile}\`: ${triggers}. Route every trigger through \`argus-assets model route\`; standard roles escalate upward, frontier roles retain frontier and escalate the decision.\n- Fallback: \`${role.fallbackPolicy}\`; weaker-model fallback is forbidden. Full-role mechanical downgrade is denied; only a bounded subrole with deterministic schema validation may qualify. If the runtime cannot honor the selected model, effort, and turn cap together, block as capability drift instead of silently approximating.\n- Record only model, token, latency, cost, success, and routing metadata with \`argus-assets model telemetry\`; never record prompts, completions, targets, accounts, or evidence.\n<!-- MODEL_POLICY_END -->`;
}

function updateOdysseusRouting(content) {
  const replacement = '**Model routing:** before dispatch, resolve the role with `argus-assets model route --agent <slug> --runtime <claude|codex> --signal normal`. On ambiguity, safety, cross-lane conflict, repeated failure, turn limit, or model unavailability, rerun routing with the exact signal and obey its `selected` or `blocked` decision. Standard roles may escalate only upward to frontier; frontier unavailability fails closed and requires operator escalation. Never silently choose a weaker model. Record every override and sanitized usage with `argus-assets model telemetry`.';
  const pattern = /\*\*Model failover:\*\*[\s\S]*?(?=\n\n\*\*Parallel-instance naming)/;
  assert(pattern.test(content) || content.includes('**Model routing:**'), 'Odysseus model-routing paragraph missing');
  return pattern.test(content) ? content.replace(pattern, replacement) : content;
}

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
    /Current Argus QA frontmatter models:[^\n]+/,
    'Current Argus QA policy: **10 opus / 17 sonnet / 0 haiku full roles**. The generated [model policy](argus/MODEL-POLICY.md) records Claude/Codex models, effort, maximum turns, escalation, fallback, downgrade guards, telemetry, and benchmark evidence. Colors by role type (cyan=core, red=hunter, green=automation, yellow=path-analyst, purple=cross) remain in `argus/COLOR-SCHEME.md`. The same source updates all 27 Codex `*.toml` + `*.md` variants.',
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
    '- Claude enforces baseline effort and turns in native agent frontmatter. Codex carries the same turn budget in its generated policy block for parent-orchestrator enforcement. An escalation runs only when the runtime can honor model, effort, and turn cap together; otherwise it blocks as capability drift.',
    '- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.',
    '- `argus-assets model route` is the installed decision interface. `argus-assets model telemetry` writes only sanitized usage metrics.', '',
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
