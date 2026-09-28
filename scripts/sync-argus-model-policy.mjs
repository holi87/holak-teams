#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_CONTINUE_FORBIDDEN, FRONTIER_FLOOR_ROLES, controllerTurnBudget, roleModelConfig, validateModelPolicy } from '../argus/runtime/model-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: sync-argus-model-policy.mjs [--check|--write]');

const policy = readJson('argus/model-policy.json');
const raci = readJson('argus/raci.json');
const slugs = raci.agents.map((agent) => agent.slug).sort();
const errors = validateModelPolicy(policy, slugs);
if (errors.length) fail(errors.join('; '));

const counts = Object.fromEntries(['frontier', 'standard'].map((tier) => [tier, policy.roles.filter((role) => role.tier === tier).length]));

syncGenerated('argus/MODEL-POLICY.md', renderPolicy(policy));
syncFile('README.md', updateRootReadme);
syncFile('agents-roster.html', updateRosterHtml);

console.log(`PASS  Argus model policy: ${policy.roles.length} roles, ${counts.frontier} frontier, ${counts.standard} standard, 0 mechanical full roles; explicit role execution profiles`);

function updateRootReadme(content) {
  for (const role of policy.roles) {
    const claude = roleModelConfig(policy, role, 'claude');
    const codex = roleModelConfig(policy, role, 'codex');
    const row = content.split('\n').find((line) => line.includes('`' + role.slug + '`') && line.startsWith('|'));
    assert(row, `${role.slug}: root README model row missing`);
    const fields = row.split('|');
    assert(fields.length === 7, `${role.slug}: unexpected README roster columns`);
    fields[4] = ` ${claude.model} · ${claude.effort} `;
    fields[5] = ` ${codex.model} · ${codex.effort} `;
    content = content.replace(row, fields.join('|'));
  }
  content = replaceCount(content, 'README.md', /(generated )\d+( frontier \/ )\d+( standard policy from `argus\/model-policy\.json`)/, `$1${counts.frontier}$2${counts.standard}$3`);
  content = replaceCount(content, 'README.md', /(\*\*Tiers:\*\* )\d+( opus \u00b7 )\d+( sonnet \u00b7 0 haiku full roles\.)/, `$1${counts.frontier}$2${counts.standard}$3`);
  content = replaceCount(content, 'README.md', /(Current Argus QA policy: \*\*)\d+( opus \/ )\d+( sonnet \/ 0 haiku full roles\*\*)/, `$1${counts.frontier}$2${counts.standard}$3`);
  return content;
}

function updateRosterHtml(content) {
  for (const role of policy.roles) {
    const name = `${role.slug[0].toUpperCase()}${role.slug.slice(1)}`;
    const config = roleModelConfig(policy, role, 'claude');
    const family = config.model.includes('opus') ? 'opus' : 'sonnet';
    const row = content.split('\n').find((line) => line.trimStart().startsWith(`<tr><td class="name">${name}</td>`));
    assert(row, `${role.slug}: visual roster model row missing`);
    const pattern = /<span class="model m-(?:opus|sonnet|haiku)"[^>]*>[^<]*<\/span>/;
    assert(pattern.test(row), `${role.slug}: visual roster model cell missing`);
    content = content.replace(row, row.replace(pattern, `<span class="model m-${family}" title="${config.model}">${family} · ${config.effort}</span>`));
  }
  return replaceCount(content, 'agents-roster.html', /(Argus QA: )\d+( opus \/ )\d+( sonnet \/ 0 haiku full roles)/, `$1${counts.frontier}$2${counts.standard}$3`);
}

// Every derived-count target must exist exactly where the generator expects it; a
// missing anchor fails instead of silently leaving a stale count behind.
function replaceCount(content, path, pattern, replacement) {
  assert(pattern.test(content), `${path}: derived model-tier count anchor missing (${pattern.source})`);
  return content.replace(pattern, replacement);
}

function renderPolicy(data) {
  const controller = controllerTurnBudget(data);
  const lines = [
    '# Argus Runtime Model Policy', '',
    `Policy ID: \`${data.policyId}\`. The machine-readable source is [\`model-policy.json\`](model-policy.json).`, '',
    `The adopted baseline (\`${data.baseline.decision}\`) assigns ${counts.frontier} roles to frontier reasoning and ${counts.standard} roles to standard reasoning. Both counts are derived from the role tiers below, and validation rejects a baseline whose counts or decision string differ from them. No complete role uses the mechanical tier.`, '',
    `- Frontier floor: ${FRONTIER_FLOOR_ROLES.map((slug) => `\`${slug}\``).join(', ')}. Every role retains its evidence, authorization and quality obligations regardless of execution profile.`,
    '- Each role selects a validated `executionProfile`; model family and reasoning effort are explicit per runtime, rather than inferred from an escalation category.',
    '- A standard role is valid only with a matching `baseline.standardAllowlist` entry that names it and states a justification of at least 20 characters; an allowlist entry for a role that is not standard is rejected.', '',
    '| Agent | Tier | Claude | Effort | Codex | Effort | Max turns | Escalation | Fallback |',
    '|---|---|---|---|---|---|---:|---|---|',
  ];
  for (const role of data.roles) {
    const claude = roleModelConfig(data, role, 'claude');
    const codex = roleModelConfig(data, role, 'codex');
    lines.push(`| ${role.slug} | ${role.tier} | ${claude.model} | ${claude.effort} | ${codex.model} | ${codex.effort} | ${role.maxTurns} | ${role.escalationProfile} | ${role.fallbackPolicy} |`);
  }
  const auto = data.fallbackPolicies['frontier-fail-closed'].autoContinue;
  const codes = (items) => items.map((item) => `\`${item}\``).join(', ');
  const alternatives = (items) => (items.length > 1 ? `${codes(items.slice(0, -1))} or ${codes(items.slice(-1))}` : codes(items));
  const restarts = auto.maxCheckpointlessRetries === 1 ? 'restart runs' : 'restarts run';
  const checkpointlessWorker = auto.checkpointlessSignals.filter((signal) => !auto.outcomeSignals.includes(signal));
  lines.push('', '## Routing rules', '',
    '- Standard roles request one upward frontier route per dispatch on declared signals. A high-effort Claude role can change only its model to pinned Opus/high while preserving its native effort and turn cap; later retries block with `AUTO_CONTINUATION_EXHAUSTED`. A medium-effort role requesting higher effort remains `CAPABILITY_DRIFT` because Claude Agent cannot override effort.',
    '- Codex difficult-reasoning escalation uses the reserved `astra-reasoning` profile only for declared, checkpoint-bound ambiguity, cross-lane, conflicting-evidence or oracle-ambiguity signals. It is capped at 80 turns and preserves frontier operator approval. It never replaces baseline, safety, unavailability or routine continuation routes, and remains blocked until the adapter can enforce the complete model/effort/turn envelope.',
    `- Frontier roles never fall back to a weaker model (\`allowWeakerModel=false\`). Automatic frontier continuation is governed by the explicit \`fallbackPolicies.frontier-fail-closed.autoContinue.enabled\` flag, currently \`${auto.enabled}\`. With the flag on, three bounded paths select the unchanged frontier baseline without an operator decision, so the adapter mode stays \`baseline\` and the decision records its \`continuation\`:`,
    `  - Checkpoint resume (\`AUTO_CONTINUE_SELECTED\`, kind \`checkpoint-resume\`): a worker ${alternatives(auto.workerSignals)} envelope with its authenticated checkpoint, while the continuation number (attempt - 1) is at most ${auto.maxAutoContinuations}.`,
    `  - Fresh restart (\`AUTO_CONTINUE_SELECTED\`, kind \`fresh-restart\`): a controller-observed ${alternatives(auto.outcomeSignals)} outcome${checkpointlessWorker.length ? `, or a checkpoint-less ${alternatives(checkpointlessWorker)}` : ''}, bound to the prior decision and active allocation instead of a checkpoint. At most ${auto.maxCheckpointlessRetries} checkpoint-less ${restarts} per dispatch, within the same continuation ceiling. \`zero-candidates\` applies only to ${codes(auto.zeroCandidatesRoles)} and is refused when the lane has filed a candidate; \`no-artifact\` is refused when any lane output is observed (an accountable artifact, filed candidate, sole-owned artifact file, or submitted fragment); a \`turn-limit\` with a resumable checkpoint must take the checkpoint-resume path. Exhaustion blocks with \`AUTO_CONTINUATION_EXHAUSTED\`, which records a coverage gap instead of an operator escalation.`,
    `  - Backoff retry (\`BACKOFF_RETRY_SELECTED\`, kind \`backoff-retry\`): \`model-unavailable\` retries the same frontier model after ${auto.unavailableBackoffSeconds.join(', ')} seconds. Once those ${auto.unavailableBackoffSeconds.length} retries are spent, the route blocks with \`FRONTIER_UNAVAILABLE\` pending an operator decision.`,
    '- Every continuation is a new worker thread with a fresh native cap equal to the role `maxTurns` (`perAttemptMaxTurns`); `cumulativeTurnBudget` records `maxTurns` times the attempt number. Claude cannot raise a subagent cap per dispatch, so no continuation claims a larger cap.',
    `- Operator-gated signals: ${codes(AUTO_CONTINUE_FORBIDDEN)} never continue automatically, and validation rejects them in every \`autoContinue\` list. They, a worker signal past the continuation ceiling, and every escalation of an excluded agent (${codes(auto.excludedAgents)}) first persist a blocked \`OPERATOR_ESCALATION_REQUIRED\` decision.`,
    '- Unattested engagements have no operator-approval anchor. The automatic paths are their only continuation, and every operator-gated block is terminal for them.',
    '- Setting the flag to `false` restores the 4.x behaviour: every frontier declared signal and every model unavailability blocks pending an explicit operator decision.',
    `- Decisions persist as \`${data.routing.decisionSchema}\` and telemetry as \`${data.telemetry.schema}\`; both carry the automatic reason codes.`,
    '- Before routing, the host trust store must contain distinct active Ed25519 anchors for runtime control and human operator approval. An attested launch signs both key IDs (`argus-launch --runtime-key-id` and `--operator-key-id`), and preflight pins their identities and the secure absolute host-store path when it creates the engagement; inside an engagement the guard denies `model trust`, which stays a host-side verb for a manifest pinned outside a signed launch. Every request, route, allocation, retry, and telemetry operation reopens that live store and rejects a revoked, replaced, or missing key immediately. Private keys and generic signing services remain outside the controller and worker boundary.',
    '- The controller persists a normal attempt-1 selected decision for Odysseus and every projection-selected worker whose current preflight record is `ready` or `degraded` with `dispatchAllowed=true` before any allocation. That exact dispatchable set is sealed into engagement state and becomes the immutable participant filter for phase barriers; deferred, skipped, and blocked roles cannot allocate or create false quorum. It allocates Odysseus first against its exact decision and retains that lane token as the controller token, then authenticates each exact decision-bound worker allocation with that token. Workers receive only their own lane token and public decision/resource coordinates. A missing or blocked selection in the sealed set stops, and a new normal attempt-1 dispatch after the first allocation is forbidden.',
    `- \`argus-launch\` is the only supported Claude entry point. An isolated runtime-attestation signer authorizes the exact short-lived engagement, arguments, executable hashes, and native \`--max-turns ${controller.maxTurns}\` envelope. A one-shot random inherited capability whose digest is signed prevents public-string or file-only replay. Odysseus starts in print mode with exact \`claude-opus-5-5\` / maximum effort, no session persistence, an explicit environment allowlist, and an OS sandbox whose only writable root is the alias-free artifact boundary. Preflight blocks direct or replayed \`/argus:run\` sessions.`,
    `- Controller turn budget: \`controllerBudget\` names \`${controller.agent}\`, whose policy \`maxTurns\` (${controller.maxTurns}) is the native controller cap. The launcher constant, the \`maxTurns\` const in both native-launch schemas, and the cap \`argus-assets\` signs into launch requests must equal it; the launcher and \`launch verify\` reject a signed authorization with any other cap. The final ${controller.closeoutReserveTurns} turns (\`closeoutReserveTurns\`) are reserved for canonical merges and Kleio. Validation requires a controller cap of at least 300 turns and a reserve from 10 to a quarter of the cap.`,
    '- The installed Codex CLI can enforce model and reasoning effort but exposes no native hard turn cap. Codex routing therefore remains `CAPABILITY_DRIFT` and cannot be unlocked by a signed claim or approximate wrapper counter. Generated Codex agents remain configuration-parity artifacts for a future runtime that can enforce the complete envelope.',
    '- Haiku/Luna is reserved for a future bounded subrole with no quality judgment, a deterministic output schema, and a validator that passes before merge.',
    '- Worker prompts contain only their local turn cap, declared signals, agent binding, and the shared `argus/model-escalation-request@1` stop contract from `qa-core`. They never select a model, invoke routing, or write telemetry.',
    '- Odysseus and `/argus:run` alone persist and route escalation envelopes. `model request` requires the exact active lane token and binds a declared worker escalation to that allocation, original dispatch ID, current checkpoint, and prior immutable decision. After allocation begins, `model route` also requires the active Odysseus controller token. Before retry rebind, the controller emits telemetry for the completed decision. `engagement start-attempt` then consumes the current lane token, atomically rotates it on the same dispatch/allocation, and returns the next token once; the controller replaces the stale token before spawning the new thread.',
    '- An operator-gated frontier block (`OPERATOR_ESCALATION_REQUIRED` or `FRONTIER_UNAVAILABLE`) continues or aborts only with a human-authorized `argus/model-operator-decision@1` signed by the isolated `operator-approval` key; the controller and runtime wrapper cannot author, sign, or replace it. An outcome-bound restart never carries an operator decision.',
    '- `model-unavailable` is valid only after a selected prior attempt on the exact dispatch and an active allocation. When failure occurs before spawn it uses the immutable prior-decision/allocation availability binding and may have no checkpoint; a declared signal from a running worker always uses its authenticated checkpoint. The availability binding records `priorUnavailableRetries`, the selected `model-unavailable` retries that earlier attempts of the same agent, runtime, and dispatch consumed. While backoff retries remain, the frontier route selects the backoff path; afterwards it blocks without weakening, and an external operator may choose `retry-frontier` after availability recovery or `abort`. A standard role may move only upward to frontier.',
    '- Preflight accepts `--model-runtime claude|codex`; Claude requires the signed launch authorization, verified receipt, public trust store, and inherited private launch capability. Codex is blocked with the exact missing capability instead of silently presenting Claude readiness.',
    '- `argus-assets model route` validates signatures, bindings, and the trusted adapter snapshot, then permits at most one selected decision per engagement/agent/runtime/dispatch/attempt. An exact authenticated replay returns that immutable decision; a refreshed or otherwise different signed document for the same attempt conflicts and fails closed. `model telemetry` requires the matching current lane token, atomically accepts exactly one event per selected decision, and must be written before retry rebind or cleanup changes the active binding. It contains only sanitized lane-reported operational metrics and is not authoritative billing, benchmark, or outcome evidence.', '',
    '## Benchmark', '',
    'The committed `model-policy.benchmark.json` is a historical, three-scenario synthetic marker-copying check with invocation metrics; it does not establish defect-discovery effectiveness or savings for the current model mix.',
    'The benchmark is historical: it was recorded under an earlier baseline, and its `decision`, `policyId`, and per-scenario tiers keep the values that were in force when the runs were recorded. It measures three work classes, not individual roles, and it is never the evidence for a particular role-to-tier assignment. The current profile assignment requires a fresh adjudicated discovery comparison; the discovery baseline is not yet recorded.',
    '`node scripts/benchmark-argus-model-policy.mjs --check` validates the recorded evidence and prints non-fatal NOTE lines when the current policy identity, baseline decision, or a scenario role tier has drifted from the recorded values. Re-record with `--record` when fresh comparative evidence is wanted; the recorded timestamp shows when a stamp was last earned.', '');
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
function assert(value, message) { if (!value) fail(message); }
function fail(message) { console.error(`FAIL  ${message}`); process.exit(1); }
