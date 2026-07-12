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
    'Current Argus QA policy: **10 opus / 17 sonnet / 0 haiku full roles**. The generated [model policy](argus/MODEL-POLICY.md) is the single cross-runtime view of native models, effort, maximum turns, escalation, fallback, downgrade guards, telemetry, and benchmark evidence. Worker prompts contain no opposite-runtime model narrative; the role-variant generator resolves each runtime from that policy. Colors by role type (cyan=core, red=hunter, green=automation, yellow=path-analyst, purple=cross) remain in `argus/COLOR-SCHEME.md`.',
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
    '- Frontier roles never fall back to a weaker model. Their declared escalation signals and model unavailability block the dispatch pending an explicit operator decision.',
    '- Before routing, the host trust store must contain two distinct active Ed25519 public anchors from one immutable snapshot: `runtime-attestation` for the enforcing dispatch wrapper and `operator-approval` for a human-controlled approval boundary. `model trust` selects both by stable ID and never accepts command- or target-supplied first-use keys. Neither private key nor a generic signing interface may be available to the controller, workers, or their OS user. Pinning changes the manifest, so preflight must run again and bind the exact digest and runtime.',
    '- The pinned trust store is a snapshot, not a live revocation feed. Revoking either source key after pinning requires aborting the current engagement and starting a new engagement that pins a current snapshot.',
    '- The controller persists a normal attempt-1 selected decision for Odysseus and every projection-selected worker whose current preflight record is `ready` or `degraded` with `dispatchAllowed=true` before any allocation. That exact dispatchable set is sealed into engagement state and becomes the immutable participant filter for phase barriers; deferred, skipped, and blocked roles cannot allocate or create false quorum. It allocates Odysseus first against its exact decision and retains that lane token as the controller token, then authenticates each exact decision-bound worker allocation with that token. Every Codex allocation additionally requires a fresh JIT dispatch authorization from the enforcing wrapper. Workers receive only their own lane token and public decision/resource coordinates. A missing or blocked selection in the sealed set stops, and a new normal attempt-1 dispatch after the first allocation is forbidden.',
    '- Claude enforces the complete reviewed baseline in native agent frontmatter. Its current dispatch adapter blocks an escalation because no verified per-dispatch effort override exists. A Codex route becomes executable only when the trusted wrapper emits `argus/model-runtime-attestation@1` proving that it can enforce the exact selected model, effort, and hard turn cap. This immutable route proof is checked at selection time; it is not a long-lived spawn capability.',
    '- Immediately before each Codex allocation, resume, or retry rebind, that same isolated wrapper emits a fresh `argus/model-dispatch-authorization@1` under `ai_agents_internal/operator-decisions/`. It expires within 15 minutes and binds the decision ID and integrity, selected-config digest, role, parent session, random allocation ID, and nonce. `engagement allocate` or `engagement start-attempt` verifies and persists the binding; an authorization consumed by one successful CLI operation cannot authorize another. Resume/retry retains the active allocation ID but requires a new nonce and later `issuedAt`; a released-lane replacement requires a never-before-consumed allocation ID. Bounded history rejects reuse of any allocation ID, MDA digest, or nonce across replacements and lanes. The CLI cannot observe an external process launch, so the wrapper must pair successful verification with the exact-config spawn. Route-attestation expiry therefore does not force every wave to start within one window. Missing/wrong-purpose keys, invalid signatures, stale/cross-decision reuse, or aliases fail closed.',
    '- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.',
    '- Worker prompts contain only their local turn cap, declared signals, agent binding, and the shared `argus/model-escalation-request@1` stop contract from `qa-core`. They never select a model, invoke routing, or write telemetry.',
    '- Odysseus and `/argus:run` alone persist and route escalation envelopes. `model request` requires the exact active lane token and binds a declared worker escalation to that allocation, original dispatch ID, current checkpoint, and prior immutable decision. After allocation begins, `model route` also requires the active Odysseus controller token. Before retry rebind, the controller emits telemetry for the completed decision. `engagement start-attempt` then consumes the current lane token, atomically rotates it on the same dispatch/allocation, and returns the next token once; the controller replaces the stale token before spawning the new thread.',
    '- Frontier declared-signal escalation first persists a blocked decision. Continuation or abort requires a human-authorized `argus/model-operator-decision@1` signed by the isolated `operator-approval` key; the controller and runtime wrapper cannot author, sign, or replace it.',
    '- `model-unavailable` is valid only after a selected prior attempt on the exact dispatch and an active allocation. When failure occurs before spawn it uses the immutable prior-decision/allocation availability binding and may have no checkpoint; a declared signal from a running worker always uses its authenticated checkpoint. A frontier route then blocks without weakening; an external operator may choose `retry-frontier` after availability recovery or `abort`, while a standard role may move only upward to frontier.',
    '- Preflight accepts `--model-runtime claude|codex`; a Codex preview reports `attestation-required` until the dispatch-specific parent document exists instead of silently presenting Claude readiness.',
    '- `argus-assets model route` validates signatures, bindings, and the trusted adapter snapshot, then permits at most one selected decision per engagement/agent/runtime/dispatch/attempt. An exact authenticated replay returns that immutable decision; a refreshed or otherwise different signed document for the same attempt conflicts and fails closed. `model telemetry` requires the matching current lane token, atomically accepts exactly one event per selected decision, and must be written before retry rebind or cleanup changes the active binding. It contains only sanitized lane-reported operational metrics and is not authoritative billing, benchmark, or outcome evidence.', '',
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
