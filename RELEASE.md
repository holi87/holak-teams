# Release validation

The repository has one local and CI release gate:

```bash
scripts/validate-release.sh
```

It installs lockfile dependencies, validates all plugin manifests and JSON Schemas, runs model, authorization, engagement, orchestration, runner, template, prompt, and generated-file regression suites, verifies package budgets, then installs the previous marketplace revision and updates it to the current release. A release is not ready until the complete gate passes.

## Argus 4.0 authenticated-launch boundary

Argus 4 replaces the public fixed-string launch claim with a signed, short-lived,
engagement-bound authorization and a verified receipt. The authorization covers exact
target/workspace/artifact coordinates, launcher and Claude executable hashes, mode, model,
effort, and native turn cap. A one-shot random capability whose digest is signed binds those
documents to the launched process tree, so public environment injection or copied files
cannot replay them.
The artifact root must be physically disjoint from a local target and free of symlink or
hard-link aliases. URL-only targets are first-class. The child starts from a documented
environment allowlist and can write only below the artifact root.

This is a major change because every launcher call now requires an engagement ID, public
trust store, runtime key ID, immutable request path, and external authorization path. The
release gate runs the real OS sandbox, denial/alias/environment/replay cases, URL and path
launches, exact turn-cap fixture, direct-preflight rejection, and installed lifecycle.

## Argus 3.0 retired-reader boundary

Argus 3 retires compatibility code whose migration window ended in Argus 2:

- `lane-plan`, `evidence-reference`, and `automation-status` accept only their current collection form at `@2`;
- preflight accepts only `schemaVersion: 2`;
- engagement state accepts only `schemaVersion: 2` and contains no migration surface;
- the `qa-doctrine` monolith and `SHARED-DOCTRINE.md` pointer are removed;
- active pre-v3 engagements must finish or be cleaned with their original runtime before upgrade.

Stable contracts that are still current at `@1` do not change merely because old readers were removed.

The marketplace lifecycle smoke installs the immediately previous release, updates to the current major, proves that the retired reader files are absent, verifies the installed native launcher and 27-agent roster, and completes a clean current two-lane engagement. It deliberately does not resume old state.

## Native execution contract

`argus-launch` is the only supported Claude entry point. The external runtime-attestation
signer authorizes the exact request; launch verification issues a receipt, and preflight
also requires the inherited private launch capability. The launcher binds Odysseus to the
reviewed `opus` / maximum-effort baseline, Claude's native 400-turn cap (96 before 5.0), no session
persistence, a minimal environment, and an OS filesystem sandbox. Direct `/argus:run`
preflight and authorization-file replay fail.

Codex model and effort mapping remains generated and validated, but Codex dispatch is fail-closed because the installed CLI has no native hard turn cap. Signed route-attestation metadata was removed because a claim cannot create missing enforcement.

The host trust bundle now pins the secure absolute trust-store path. Every request, route, allocation, retry, and telemetry operation reopens that store and blocks immediately when a pinned public key is revoked, missing, or replaced.

## Reproducible Argus release

Regenerate canonical outputs before the gate:

```bash
scripts/sync-argus-role-variants.mjs --write
scripts/sync-argus-runtime-assets.mjs --write
node scripts/sync-argus-raci.mjs --write
node scripts/sync-argus-model-policy.mjs --write
node scripts/sync-argus-technique-bundle.mjs --write
```

Bump all release declarations atomically:

```bash
node scripts/release-plugin.mjs --plugin argus --bump major --write
node scripts/release-plugin.mjs --plugin argus --check
```

The helper updates the Argus plugin version, its marketplace entry, and the top-level marketplace version together.

For Hephaestus agent changes, regenerate Codex variants from the flat Claude sources:

```bash
scripts/sync-hephaestus-codex-variants.mjs --write
```

## Prompt regression approval

`argus/prompt-budgets.json` (schema v2) records absolute corpus and per-agent ceilings and one `approvedCorpus` bound by SHA-256 to the exact agent prompts and doctrine profiles; `node scripts/approve-argus-prompts.mjs` restamps it either with adjudicated discovery evidence that meets the `nonRegression` tolerances (`--benchmark`) or as a pending approval valid only for the Argus release it names (`--benchmark-pending <reason>`). Changes that intentionally alter a prompt still require regeneration, semantic duplicate review, and the full release gate.

## Release checklist

1. Regenerate changed canonical outputs.
2. Run `scripts/validate-release.sh`.
3. Confirm `git diff --check` and review generated changes.
4. Bump the correct semver level.
5. Commit on a dedicated branch, push, and open a pull request.
6. Confirm every required GitHub check passes before merge.

## Argus 4.9.1 finding-quality repair

This user-requested patch addresses #47–#53: conditional correctness oracles, canonical finding-proof reconciliation, required-case depth, browser-optional CLI security, mode-aware deliverables, independent reproduction limitations, and evidence-based deduplication. Kleio now merges coverage observations in every mode, including B without Atlas. New confirmed records require structured verification; old unproven records must remain suspected rather than receiving invented migration evidence.

The release gate includes `scripts/smoke-argus-quality.mjs` and the maintainer-only `scripts/eval/discovery/smoke.mjs`. The latter exercises 12 live application fixtures and 24 paired adapter-protocol runs. It establishes harness behavior, not an Argus model-quality score. See the evaluation README for isolated host adapters, repeated equal-budget comparisons, private verdicts, and measured usage. No numerical model-quality improvement or threshold is asserted by this release. Existing package and prompt limits are retained.

## Argus 4.9.2 documentation alignment

This user-requested patch changes no agent prompt, runtime library, schema, or budget; only the plugin version moves. It aligns the maintainer documentation with the 4.9.1 runtime and with current Claude Code guidance: `AGENTS.md` falls below the 200-line memory-file target and points to the canonical contracts; the frontier/standard split (12/15), the asset budgets (880,000 / 1,800,000 bytes), the six preflight dispositions, the `--unattested` launch opt-in, `plugin.json` version precedence, and the highest-plugin-version marketplace rule are now stated correctly. `INSTALL.md` resolves the newest cached Argus version instead of a hard-coded 4.0.0 path.

## Argus 5.0 effectiveness release

This major release acts on the owner's 23 effectiveness recommendations. Each recommendation was first checked against the code. It was then implemented as written, or in an adjusted variant where the literal proposal would have crossed a security boundary (see "Security boundaries" below). The full history is `git log --oneline d7fcef3..` (4.9.2 to 5.0.0); every commit subject names its subtask ID.

### What 5.0 delivers

| # | Recommendation | What ships in 5.0 | Subtasks |
|--:|---|---|---|
| 1 | Browser lanes that actually run | Sandbox policy `os-native-target-readonly@3` runs headless Chromium. Preflight resolves and functionally probes the Playwright runtime for path and URL targets. New launcher flags: `--provision-browser`, `--feature`, `--authorization`, `--environment`. `argus/capability-evidence@1` records recon proof, and `conditional` lanes are released once by `engagement resolve-gates` | P-01, P-03, P-04, P-05, P-06, P-07, P-08, P-12 |
| 2 | Controller turn budget | Native controller cap raised from 96 to 400, with the last 30 turns reserved for canonical merges and Kleio. Initial routing is batched and allocation is batched per wave. Telemetry, barrier arrival, and cleanup run as controller-authorized batches | M-2, M-5, M-6, M-7 |
| 3 | A return path for defects | Orchestration plan v2 adds a proof loop. Minos bounces a candidate to the filing lane with repair metadata (at most two repair rounds) and sends `needs-oracle` to Metis's oracle desk; surface reproducers reproduce independently. RACI gains `repair`, `reproduce`, and `source-oracle` routes. Read-only `argus-assets` queries pass the write guard | O-1, O-2, O-4, O-5, L-1, G-1 |
| 4 | No permanent block on frontier continuation | Automatic frontier continuation: checkpoint resume, at most one checkpoint-less fresh restart, and 60/180/300 s backoff when the model is unavailable. Continuation is bound to the observed outcome, and retries keep a three-way lineage | M-3, M-4, M-7 |
| 5 | Measure discovery quality | Discovery corpus v2 (22 seeds across six surfaces). Harness v2 extracts findings on the evaluator side, seals private state, and scans for contamination. Also: Mode A regression replay, `argus-launch --usage-json`, a reference unattested adapter, an Opus first-pass judge, a human spot-check, scoring v2 with precision, `score-against-key` adjudication, a recorded-baseline gate, and `argus/lane-outcomes@1` | E-1 to E-12, P-12 |
| 6 | Machine-readable runner outcomes | One outcome adapter per runtime (Playwright reporter, JUnit listener, pytest plugin), each with a collection inventory. Common `runner-lib.sh`, template contract v2, `copy-runner-kit` for the ADAPT path, and Java, Python, and Chromium toolchains in CI | T-01, T-02, T-03, T-04, T-07, T-10, T-13, T-16, T-19, T-22, T-23, CI-1 |
| 7 | Stronger models | All 27 roles are frontier (Claude `opus` / max, Codex `sol` / `xhigh`). Tier counts are derived and validated; a standard role needs a justified allowlist entry | M-1 |
| 8 | Realistic per-role turn budgets | Specialists get 80 to 200 turns (most hunters 140 to 160, Kalchas 120, Minos 200). The schema maximum is 500 | M-1 |
| 9 | Deeper hunting | Bounded passes `deep-hunt-1..3` and `deep-proof-1..3`. The runtime verifies a `converged` skip. A `controller-budget` skip is recorded as `deep-hunt-skipped:controller-budget` and keeps the final summary from claiming completion | O-1, O-2, O-5, S-7 |
| 10 | Authenticated recon | Kalchas walks each role through the managed hunt driver and writes capability evidence. Its Playwright MCP tools stay capped at two | P-09, P-04, P-06 |
| 11 | Technique coverage for more defect classes | Data-driven catalog registry. New catalogs for Perseus, Orion, Lynceus, Antigone (WCAG 2.2), and Charon. Ariadne gets side-effect-channel rows. Kalchas inventories uploads, redirects, downloads, and side-effect channels | C-01 to C-09, G-1 |
| 12 | A realistic confirmation rule | Confirmed means a sourced oracle, at least one captured occurrence whose evidence shows the violation, and honest attempts/occurrences counts. An intermittent or single-attempt confirmation needs independent reproduction or an explicit unavailable reason | H-2 |
| 13 | A status-complete ledger and report | `bug-ledger@2` has the statuses confirmed, suspected, needs-oracle, bounced, quarantined, duplicate, and rejected. Single-document contracts can be superseded only by their owner. The `final-summary@2` headline counts confirmed plus suspected, with per-status counts and a "Likely, unproven" section | L-1, S-3, S-5, S-7, S-8 |
| 14 | A merge that survives one bad entry | A per-bug reconciliation failure quarantines only that bug. Tampering signals stay hard merge failures. Minos runs in every mode | L-1, O-1, O-4, O-5 |
| 15 | Phases derived from the plan | The runtime phase engine is derived from the plan: standby membership, controller-only skips, and a proof-phase ledger gate. Engagement manifest v2 and state v3 strictly reject older engagements | O-1, O-2, O-4, O-5 |
| 16 | Declared lanes and environment | `solution/test-lanes.tsv`, `solution/environment.tsv`, and inventory-based quarantine. Environment reset and fault injection run only through `argus-assets authorization check` inside the exclusive window. Lanes get their own write roots | T-02, T-03, T-07, T-13, T-19, W-1, T-23 |
| 17 | Regressions that prove the fix | All three templates get loopback stub servers with strict contract oracles, counterfactual evidence passes (`cf-correct`, `cf-tamper-<k>`), and data and behaviour oracles | T-05, T-06, T-08, T-09, T-11, T-12, T-14, T-15, T-17, T-18, T-20, T-21 |
| 18 | A richer browser driver | hunt-driver v2: tabs, actors, client-side faults, opt-in redacted body capture, race clicks, clock advance, and `--plan`. A live smoke runs in the release gate, and the hunter prompts use the new techniques | H-3, H-4, H-5, CI-1 |
| 19 | Exploration discipline | A qa-core exploration loop: seeded variation, a differential oracle, cluster drill, and a 10/20-probe stop rule. Consistency evidence is filed as needs-oracle or suspected and never confirms on its own | H-7 |
| 20 | More evidence kinds | `evidence-reference@3` adds screenshot, video, dom-snapshot, har, and runner-result. Binary evidence must be reviewed by another lane and bound to the authorization audit; content is verified at merge | S-2, S-8 |
| 21 | Coverage and automation review that can be trusted | Coverage is derived from hash-checked evidence (`coverage-observations@2`, `coverage-result@2`), and runner cases map to surfaces. `argus/automation-review@1` rounds are persisted append-only, and a BLOCK verdict fails the runner with exit 13 | S-3, S-4, S-6, S-8, S-9 |
| 22 | Prompt budgets that allow needed growth | `prompt-budgets` v2 sets absolute ceilings and drops the 35% reduction rule. The corpus hash also covers the doctrine profiles. Approval comes from benchmark evidence or a pending record bound to one release | H-1, H-8 |
| 23 | Less launch friction | Preflight report v3: a blocked non-essential lane becomes `deferred` with a named residual risk. Essential lanes (Kalchas, Metis, Minos, Kleio, and Atlas outside Mode B) and the mode's mandatory hunters still stop the engagement | P-02 |

The release tail after the version bump finished the list. T-24 added the strict template evaluator, removed the legacy paths, and set the final asset budgets (items 6 and 16). H-8 restamped the prompt corpus for 5.0.0 (item 22). D-1 wrote the operator documentation for the new launch flags, sandbox policy, dispositions, and gate resolution (items 1, 10, and 23).

### Breaking contract versions

Every overridden canonical contract now accepts only its current version, and retired versions fail closed.

- **Canonical engagement contracts:** `bug-ledger` 1 → 2, `coverage-observations` 1 → 2, `coverage-result` 1 → 2, `final-summary` 1 → 2, `evidence-reference` 2 → 3, `preflight-report` 2 → 3. `policies/schema-compatibility.json` moves from schemaVersion 3 to 4. `lane-plan@2` and `automation-status@2` keep their versions: lane-plan only widens its phase enum with the proof and deep-hunt phases, and automation-status only gains optional `caseIds` and `surfaceIds`.
- **Engagement runtime:** `engagement-manifest` 1 → 2 and `engagement-state` 2 → 3, with no migration path. An active 4.x engagement must finish, or be cleaned with its original runtime, before the upgrade.
- **Plan, model, and template contracts:** `orchestration-plan` 1 → 2, `model-policy` 1 → 2, `model-decision` 2 → 3, `model-telemetry-event` 2 → 3, `template-contract` 1 → 2. The maintainer-side `prompt-budgets` moves 1 → 2.
- **Launch signer:** `native-launch-authorization` and `native-launch-receipt` stay at schemaVersion 1 but now require `maxTurns: 400` and `sandboxPolicy: os-native-target-readonly@3`. `native-launch-authorization@1` also gains the optional signed `operatorKeyId`, which every attested `argus-launch` request now carries because `--operator-key-id` is required; preflight pins that operator-approval anchor with the runtime key when it creates the engagement, so no `model trust` step or preflight rerun follows. An isolated runtime-attestation signer built for 4.x must be updated before it can authorize a 5.0 launch, and a strict signer must accept `operatorKeyId`.
- **Tightened at v1:** `raci` now requires a `reproduce` route for every surface and adds the `repair`, `reproduce`, `source-oracle`, and `review-evidence` activities. `capability-matrix`, `surface-inventory`, and `technique-catalog` only widen, to cover the new catalogs.
- **New at @1:** `automation-review`, `browser-runtime`, `capability-evidence`, `counterfactual-fixture`, `lane-outcomes`, plus the controller batch documents `model-route-batch`, `engagement-allocation-batch`, `engagement-barrier-batch`, and `engagement-cleanup-batch`.
- **Maintainer evaluation protocol:** now `argus-eval/comparison-config@2`, `hunt-request@2`, `adapter-result@2`, and `private-runs@2`, so an adapter written for the 4.9.x harness must be updated. New at @1: `discovery-baseline`, `discovery-summary`, `final-verdicts`, `judge-verdicts`, `spot-check`, `replay-request`, and `replay-result`.

### Security boundaries

Where a recommendation would have weakened a boundary, 5.0 ships the safe variant:

- **Sandbox `os-native-target-readonly@3`** is @2 plus exactly one IOKit user client, `RootDomainUserClient`, and the `org.chromium.*` mach-register and mach-lookup names. `probe-browser` found these under sandbox denial reporting. There is no unscoped `iokit-open`, and the GPU user clients stay denied (Chromium falls back to software compositing). File writes stay confined to the artifact root, and the existing write-denial probes still pass.
- **Browser provisioning is host-side and opt-in.** `argus-launch --provision-browser` runs `argus-assets browser provision` before the sandbox starts. It reuses a host Playwright that already launches headless Chromium, or installs the pinned release into `~/.cache/argus/browser-runtime/<x.y.z>`, which is outside the artifact root and read-only to the sandbox. Provisioning is not part of the signed request, preflight re-probes the runtime inside the sandbox, and `argus-assets browser` is refused inside an active engagement.
- **Operator authorization and environment are set at launch.** `--authorization <absolute-path>` must be a physical regular file outside the target and artifact roots. It must be schema-valid and bound to the engagement. Alternatively, `--environment` installs the packaged default-deny manifest. The launcher copies the result to `ai_agents_internal/authorization.json` (mode 0600) before the sandbox starts. Neither flag is signed or widens anything: the evaluator still enforces every action, and staging and production stay read-only without an override.
- **Frontier auto-continuation relaxes operator approval behind an explicit flag.** The flag is `fallbackPolicies["frontier-fail-closed"].autoContinue.enabled` in `argus/model-policy.json`, and the packaged policy **ships it enabled**. Continuation always stays on the same frontier baseline, never uses a weaker model, and excludes Odysseus. Each dispatch gets at most three continuations and one checkpoint-less restart. Setting the flag to `false` restores fail-closed operator escalation; both states are tested.
- **The controller token is the batch authority, and it is never persisted.** Batch verbs take the active controller token on argv and exactly one inline single-line `--json` object. Files, stdin, heredocs, and pipes are refused, and no batch entry may carry a token. There is no token vault, so a controller that hits its turn limit cannot resume. Workers still receive only their own lane token.
- **Kalchas keeps its MCP cap.** It has two read-only Playwright MCP tools, and the prompt gate still enforces `maxPlaywrightMcpEntries = 2`. Authenticated recon uses the managed hunt driver, with a profile and an authorization check per role.
- **Recon releases only gates the runtime can re-check itself:** the browser-runtime probe, the source-access and existing-suite path checks, and non-rest-surface against the validated surface inventory. `db-access` and `multi-service` are released only by an operator `--feature` at launch. `resolve-gates` runs once and only with the controller token.
- **The existing launch guards are unchanged** (the login check below is added). The Claude version and strings check still requires 2.x with minor ≥ 1 and the `--max-turns` and `error_max_turns` markers. The `--unattested` downgrade guard still refuses when `ARGUS_MODEL_TRUST_STORE` is set or `~/.config/argus/model-trust.json` exists. The 400-turn cap is bound in the signed launch document. Unattested launches remain opt-in, and the reference evaluation adapter never alters HOME, the trust store, or PATH.
- **The headless session grants tools explicitly and never bypasses permissions.** `argus-launch` starts Claude with `--permission-mode dontAsk` and an `--allowedTools` list equal to the union of the tools the packaged agents declare, so workers can write and run commands in `-p` mode; every other tool is denied. There is no `bypassPermissions` mode and no skip-permissions flag. The packaged PreToolUse write guard still denies each granted call it rejects, the OS sandbox confines writes to the artifact root, the signed `launcherSha256` binds the posture, and `scripts/smoke-argus-launcher.sh` fails on drift from the agents' tools and shows that granted target and canonical writes are still denied.
- **Claude authenticates only through a pass-through credential variable.** The launch's fresh `CLAUDE_CONFIG_DIR` holds no stored, keychain, or claude.ai subscription login. The environment allowlist passes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or a gateway's `ANTHROPIC_AUTH_TOKEN` only when set, and the launcher never copies a credential file into the artifact root, which workers can read. `doctor` and every launch, dry runs included, run `claude auth status` in that isolated shape first and stop when it reports no login. Residual risk: every process in the sandbox runs as the operator's user and can read the session environment, including that credential; use a scoped, revocable key or token per engagement.
- **Binary evidence is denied unless reviewed.** A lane other than the collector must review it, and the review is bound to an authorization-audit allow event. `authorization check --at` is refused while an engagement is active.
- **Runner-side target actions fail closed.** Inside an engagement, environment reset and fault injection need an `argus-assets authorization check` grant and the exclusive reset/fault window. Counterfactual stubs bind to loopback and never proxy to the real target.

### Known limits

- **The discovery baseline is not recorded.** `scripts/eval/discovery/baseline.json` has status `not-recorded`, so `node scripts/eval/discovery/gate.mjs --check` prints SKIP. The model-quality gate stays inactive until the owner adjudicates a real engagement and runs `record-baseline.mjs --write`. This release claims no measured improvement in discovery quality.
- **Prompt corpus approval is pending.** `argus/prompt-budgets.json` carries a pending `approvedCorpus` with no benchmark evidence. The shipped corpus `122e986fc87c` is 81,397 raw and 140,670 effective Claude words, and an estimated 252,705 Codex tokens. A pending approval is valid only for the Argus release it names, so each release restamps it with `approve-argus-prompts.mjs --benchmark-pending`. It stays pending until the owner runs the paired discovery evaluation (`run.mjs`, judge, spot-check, `adjudicate.mjs`) and records the result with `approve-argus-prompts.mjs --benchmark`.
- **Headless Chromium under the Linux bubblewrap sandbox is unverified.** `scripts/smoke-argus-launcher.sh` requires the browser probe on macOS. On Linux it only warns unless `REQUIRE_BROWSER_PROBE=1`, which makes the probe mandatory and forbids a skip.
- **Codex dispatch still fails closed,** because the Codex CLI has no native hard turn cap.
- **M3 — The canonical lane plan is not produced.** `solution/lane-plan.json` is declared but the controller does not yet submit or merge it. Planned for 5.0.1.
- **M4 — Launcher scope and live orchestration smoke are unavailable.** `argus-launch` has no `--scope`; engagements cover the full target, and the live orchestration smoke cannot run through the launcher. Planned for 5.0.1.
- **M5 — The independent automation-blocklist fallback is undefined.** In Modes A/C, Kleio records that row as NO-GO when Severus cannot be dispatched. Defining and recording the Argus fallback is planned for 5.0.1.
- **M6 — Long runner waits and first runs can exceed the default Bash timeout.** Lanes may need a retry, and `report-facts` may request Atlas's final full-suite again. Timeout guidance and final-run scheduling are planned for 5.0.1.
