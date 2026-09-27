# Defect-discovery evaluation

This evaluator measures application defect discovery separately from the existing model marker-compliance smoke checks. It is maintainer-only and is not packaged into Argus.

## Application corpus and isolation

The built-in corpus v2 (`corpus/`, version `argus-eval-corpus@2`) is one loopback-only application, bound to 127.0.0.1 and composed of eight modules, registered in this order:

| Module | Base paths | Surface | Seeds | Controls | Seeded behavior |
|---|---|---|:--:|:--:|---|
| orders | `/api/orders` | api | 2 | 3 | quantity boundary, concurrent capacity claims |
| accounts | `/api/objects`, `/api/profile` | authz | 1 | 1 | cross-owner object read |
| workflow | `/api/workflow` | api | 1 | 1 | transition out of a terminal state |
| tenant-authz | `/api/invoices`, `/api/me`, `/api/admin` | authz | 4 | 2 | tenant list leak, cross-tenant delete, role mass assignment, unauthenticated export |
| order-events | `/api/shipments`, `/api/events` | events | 4 | 1 | duplicate, missing, out-of-sequence, and personal-data-carrying events |
| storefront-ui | `/shop` | ui | 3 | 1 | cart total ignoring quantities, double-submitted checkout, stale list after a delete |
| a11y-forms | `/account` | a11y | 4 | 2 | missing input label, unnamed icon button, low-contrast error text, unannounced validation errors |
| catalog-perf | `/api/catalog` | perf | 3 | 1 | slow multi-term search, unbounded page size, serialized item reads |

It seeds 22 defects across six surfaces: api 3, authz 5, events 4, ui 3, a11y 4, and perf 3. The 12 correct-lookalike controls include intentional duplicate creates without an Idempotency-Key, 422 validation, an inclusive quantity limit, case-preserving email, the documented 404 for foreign invoices, at-least-once event redelivery, a disabled sold-out button, a decorative image with empty alt text, a visually hidden label, and asynchronous report generation. Every seed and control has one deterministic probe. The UI modules serve server-rendered HTML5 pages (`lang`, charset, and title set; no test IDs or other hints); their probes read the markup with regex tag and attribute extraction and compute WCAG contrast from inline colors, with no DOM dependency. The perf module publishes a latency budget (p95 300 ms at up to 10 concurrent requests), and its probes measure it with sequential and concurrent requests, so they take several seconds when a perf seed is enabled. `GET /` links each module's entry pages, including `/shop`, `/account/signup`, and `/account/settings`, plus `/docs`.

The faulty build enables every seed; the corrected build enables none. Limits and object or created IDs are derived with HMAC-SHA256 from the repeat seed, so a restart with the same seed serves the same contract and IDs (needed for regression replay). `GET /contract`, `GET /`, `GET /docs`, and the UI pages publish only public rules and behavior: seed IDs, acceptance criteria, the corpus version, and enabled flags never appear in any hunter-visible endpoint. The corpus depends on `node:` builtins only.

Use the optional private `corpusModule` configuration field for genuinely held-out modules before drawing broad generalization claims. That evaluator-only ES module follows the corpus v2 contract: it exports `corpusVersion`, `seeds`, `seedIds`, `startApplication({seed, enabledSeeds, port})` returning `{url, port, contract, close}` on loopback, `truthFor(enabledSeeds)`, and optionally `probe(id, url, contract)` and `corpusDigest()`. It is never passed to the adapter.

The evaluator keeps private truth in its own process and writes it only to the sealed part of the output directory. Hunters receive only the public hunt request: a loopback URL, the public contract URL, an empty artifact directory, the mode, the budget, an opaque engagement ID, and the run's authorization manifest (see "Authorization"). Do not give hunters the repository, evaluator sources, the output directory, answer keys, or verdicts. Host adapters **must launch the normal Argus isolated runtime**; a temporary working directory alone is not an OS sandbox. Never run an untrusted adapter.

### Sealing and contamination

Every directory the evaluator creates is 0700 and physical (its realpath equals itself):

- `<output>/sealed/` holds `private-runs.json`, `canary.txt`, and `runs/<runId>/` (completed runs).
- `<output>/active/<publicId>/` holds `request.json` (0600), `authorization.json` (0600, see "Authorization"), `result.json`, `usage.json`, `launcher.log`, and `artifacts/`, the artifact root. The artifact root starts empty and is the hunter's only writable root; request, result, and usage live outside it, so a hunter cannot forge them. After the run, the whole directory moves to `sealed/runs/<runId>/`, and `artifactRoot` in the private results is that sealed path.

`<runId>` is the private run ID (see "Paired, repeated comparison"); `<publicId>` is the run's opaque public ID, 16 random hex digits.

While an adapter runs, `sealed/` is `chmod 000`. The OS sandbox denies chmod outside the artifact root, so a hunter cannot undo the seal. After the adapter exits (or is killed at its budget), the evaluator kills the adapter's whole process group before it restores 0700, so no straggler in that group sees the directory reopen. Interrupting `run.mjs` (SIGINT or SIGTERM) also kills the group and restores the mode.

At start, the evaluator writes a random `ARGUS-EVAL-CANARY-<32 hex>` to `sealed/canary.txt` and records only its SHA-256. After each run it scans the artifact root: regular files up to 5 MB, and every relative file name, skipping `node_modules` and symbolic links. Any of these makes the run `contaminated`:

- the canary;
- an absolute path of the evaluator repository, the output directory, or the corpus directory (the run's own artifact root path is exempt, because Argus records it);
- a corpus source file name, such as `tenant-authz.mjs` or `corpus/index.mjs`. Every file counts qualified by its directory; files with a hyphenated stem also count by their bare name. A private `corpusModule` contributes its optional `corpusDir` and `corpusFiles()` exports, or else its own directory and file name.

A contaminated run is excluded from metrics, makes `run.mjs` exit 1, makes `adjudicate.mjs` report UNSCORED unless `--exclude-contaminated` is passed, and blocks recording a baseline. An exact seed ID or an unreadable entry makes the run `suspect` only: it is flagged for review but still scored.

**Residual risk.** The Argus OS sandbox confines writes, not reads (`file-read*` on macOS, `--ro-bind / /` on Linux). A hunter can therefore read the evaluator repository, including corpus sources and git objects, and anything else the evaluating user can read. Sealing protects only this comparison's private results, and only against processes in the adapter's process group (a process that calls `setsid` escapes the post-exit kill). The scan detects traces, not reads that leave none. For a recorded baseline, run the adapters as a separate OS user or in a container that cannot read the repository, and state the isolation used. Keep variant checkouts outside the evaluator repository and the output directory; otherwise their plugin paths match a forbidden evaluator path.

## Paired, repeated comparison

Write a host-local `argus-eval/comparison-config@2` configuration (`schemas/comparison-config.schema.json`):

```json
{
  "schema": "argus-eval/comparison-config@2",
  "variants": [
    {"name":"baseline","revision":"<full-baseline-commit>","command":["/secure/argus-eval-adapters/<full-baseline-commit>"]},
    {"name":"candidate","revision":"<full-candidate-commit>","command":["/secure/argus-eval-adapters/<full-candidate-commit>"]}
  ],
  "modes": ["B"],
  "builds": ["faulty", "corrected"],
  "repeats": 3,
  "secondsByMode": {"A": 28800, "B": 14400},
  "tokens": null,
  "workRoot": "/secure/argus-eval-work",
  "adapterEnv": ["ANTHROPIC_API_KEY"]
}
```

- `variants`: one or two, each with a name (`^[a-z][a-z0-9-]{0,31}$`, distinct), an immutable 40-hex revision, and an argument array whose first element is an absolute executable path.
- `modes`: a non-empty subset of `A` (hunt plus regression automation) and `B` (hunt). Default `["B"]`.
- `builds`: `faulty` (every seed enabled) and/or `corrected` (none). Default both.
- `repeats`: 2 to 20.
- `seeds`: optional, one integer from 1 to 999999 per repeat. When absent, each repeat draws a random seed. Either way every run records its seed, so a comparison can be rerun with pinned seeds.
- `secondsByMode`: the wall-clock budget per run, 1800 to 86400 seconds. Defaults: A 8 h (28800), B 4 h (14400). These are deliberately generous starting values; calibrate them later to at least twice the observed p95 elapsed time.
- `tokens`: `null` (the default) means uncapped but measured. An integer cap marks a run that exceeds it `overBudget`; that is a flag, not an invalid run.
- `workRoot`: an absolute directory whose realpath equals itself. The default is the physical system temporary directory (on macOS `/private/var/folders/...`, never the `/var/folders/...` alias that `argus-launch` rejects as non-physical). A relative output directory is created under it. The output directory is always created at its physical location, so every path in a hunt request is physical.
- `adapterEnv`: extra environment variable names (`^[A-Z][A-Z0-9_]{0,63}$`) passed to the adapter with their values when present. `PATH`, `HOME`, and `TMPDIR` are always passed unchanged and may not be listed; nothing else is passed. The launcher isolates `CLAUDE_CONFIG_DIR` inside the artifact root, so the launched Claude has no stored login: list `ANTHROPIC_API_KEY`.
- `replay`: Mode A regression replay (see "Mode A regression replay"). `enabled` defaults to true when `modes` includes `A`, and may be true only then. `repeats` (1 to 5, default 2) repeats the all-on and all-off cases; `perSeedMatrix` (default true) adds one case per seed; `secondsPerRunner` (60 to 7200, default 1800) is the budget of one generated-suite run. A disabled replay is recorded as exactly `{"enabled": false}`.
- `authorization`: `{"grants": [...]}`, the high-risk actions every hunt's authorization manifest grants (see "Authorization"): any of `binary-evidence`, `browser-state-change`, `chaos`, `database-write`, `destructive`, `load`, `persistent-mutation`, and `security-active`. The default `["browser-state-change", "load", "persistent-mutation", "security-active"]` is what the built-in corpus needs; `[]` grants none, a read-only comparison. The private results record the grants sorted.
- `corpusModule`: an optional private corpus (above), resolved relative to the configuration file.
- `testMode`: smoke tests only; allowed only with `ARGUS_EVAL_SMOKE=1`, and lowers the `secondsByMode` and `secondsPerRunner` minimums to 1.

For every repeat, mode, and build, each variant runs once, in alternating order on odd repeats, against a fresh application started with the repeat seed. Its private run ID is `r<repeat>-<mode>-<build>-<variant>`: it names the run in `sealed/` and in every evaluator document (private runs, judge verdicts, spot-check sheets, final verdicts, and summaries). A hunter never sees it. Each run also draws an opaque public ID, 16 random hex digits, recorded as `publicId` in the private results; it is the only run identity in hunter-visible places: the `active/<publicId>/` directory and every path under it, the `runId` of the hunt and replay requests, and the engagement ID `eval-<publicId>`, which `argus-launch` writes into the controller prompt. So neither the build (`faulty` or `corrected`) nor the variant name nor a seed ID reaches the hunter through a run ID or an evaluator-created path. Paths the operator chooses must not name them either: `workRoot`, the output directory, adapter commands (the OS sandbox confines writes, not reads, so a hunter may see process argument lists), and adapter checkouts, whose plugin root `argus-launch` passes to Claude.

### Host adapter contract

The adapter receives the absolute path of the public `argus-eval/hunt-request@2` (`schemas/hunt-request.schema.json`) as its final argument, with `active/<publicId>/` as its working directory (a regression replay instead appends `replay <replay-request.json>`; see "Mode A regression replay"):

```json
{"schema":"argus-eval/hunt-request@2","runId":"3f9c2a7d10b4e865","engagementId":"eval-3f9c2a7d10b4e865","authorization":"/secure/out/active/3f9c2a7d10b4e865/authorization.json","revision":"<full-baseline-commit>","target":"http://127.0.0.1:53124","contractUrl":"http://127.0.0.1:53124/contract","mode":"B","artifactRoot":"/secure/out/active/3f9c2a7d10b4e865/artifacts","resultPath":"/secure/out/active/3f9c2a7d10b4e865/result.json","usagePath":"/secure/out/active/3f9c2a7d10b4e865/usage.json","logPath":"/secure/out/active/3f9c2a7d10b4e865/launcher.log","budget":{"seconds":14400,"tokens":null}}
```

The request carries no truth, seed, build, variant name, or enabled flags, neither as keys nor inside any value: `runId` is the opaque public ID and `engagementId` is `eval-<runId>`. The adapter must launch with exactly that engagement ID and pass `authorization`, the run's manifest, as `argus-launch --authorization`. On an evaluation host with no operator key material, the adapter launches by default with `argus-launch claude --unattested --mode <request.mode> --target <request.target> --artifact-root <request.artifactRoot> --engagement-id <request.engagementId> --provision-browser` (`--provision-browser` when that revision's launcher offers it; see "Reference adapter"). The launcher's downgrade guard refuses `--unattested` whenever `ARGUS_MODEL_TRUST_STORE` or `~/.config/argus/model-trust.json` exists. The adapter must then run attested with its isolated signer, and must never move, hide, or delete a trust store to obtain unattested mode. The OS sandbox, the Claude version check, and the native turn cap still apply. The product default remains attested; unattested launch is an evaluation-host option, and `result.json` must carry `launchAssurance`.

The adapter writes `argus-eval/adapter-result@2` (`schemas/adapter-result.schema.json`) to `resultPath`, never inside the artifact root:

```json
{"schema":"argus-eval/adapter-result@2","status":"completed","launcherExitCode":0,"usage":{"source":"claude-cli-result-json","inputTokens":120000,"outputTokens":30000,"cacheReadTokens":900000,"cacheCreationTokens":40000,"totalTokens":1090000,"costUsd":12.5,"numTurns":88,"controllerTurnCapHit":false},"subject":{"pluginVersion":"<plugin version>","pluginDigest":"<sha256 of the plugin tree>"},"reason":null,"launchAssurance":"unattested"}
```

`status` is `completed`, `launcher-refused`, `launcher-failed`, or `revision-mismatch`. Usage is measured provider usage from the Claude CLI result JSON; when none is available, `source` is `unavailable` and every value is `null`, never an estimate or an invented zero. Adapters report no findings. They are revision-specific; review their checkout binding and isolation before running them.

### Authorization

Without an operator manifest, `argus-launch` installs the default-deny manifest (environment `unknown`), under which the authorization evaluator denies every high-risk action (`AUTH-PRODUCTION-READ-ONLY`, or `AUTH-EXPLICIT-OPT-IN` in a lower environment), and even an account-scoped read (`AUTH-ACCOUNT-BOUNDARY`). A hunter that follows doctrine runs `argus-assets authorization check` before every target-affecting action, so it could not prove any seed that needs a write, a form submit, actor switching, or concurrent load, and the comparison would measure a read-only Argus.

The evaluator is the operator of its own synthetic, loopback-only corpus application, which it starts for one run and discards after it. Before each hunt it therefore writes `active/<publicId>/authorization.json` (0600, outside the artifact root; `lib/authorization.mjs`), an `argus/authorization-manifest` built from the packaged default-deny template, and names it in the hunt request. It differs from the template only where the evaluation needs it:

- `engagementId` is the request's `engagementId`; `target.identifiers` are the launch target and the paths under it (`<target>/` and `<target>/*`); `target.environment` is `development` and `productionLike` is false.
- `accounts.allowedAliases`, `dataBoundaries.allowedNamespaces`, and `allowedMutations` are `["*"]`: every account, namespace, and mutation of the corpus is synthetic (`syntheticOnly` stays true).
- `rateLimits` are per-action ceilings of 50 requests per second, 20 concurrent requests (the perf module's latency budget holds up to 10), 5000 requests, and 900 seconds.
- One time window, and for each configured grant (`authorization.grants`) a complete grant with `approvedAt` and `expiresAt`, cover the moment the manifest is written until the mode budget plus 600 seconds.
- The rollback procedure and verification name the evaluator's fresh application per run and replay case.

Everything else stays as packaged: the prohibited actions (for example `unbounded-load`) and data classifications, the redaction, rollback, and untrusted-content rules, and no production override. Every run gets the same grants, whatever its build or variant, and the manifest names neither. Before the hunt the manifest must satisfy the packaged schema and validator, allow the launcher's boundary read, and allow every granted action at its start; a target the evaluator treats as production-like (for example `http://[::1]:<port>`, which it does not recognize as loopback, from a private corpus) therefore stops `run.mjs` before any hunt instead of yielding a read-only one. In addition, `smoke-adapter.mjs` checks that the packaged `argus-assets authorization verify` and the real `argus-launch --authorization` accept it.

After the hunt the evaluator reads `ai_agents_internal/authorization.json` from the artifact root, where `argus-launch` copies the operator manifest, without following symbolic links, and compares its canonical SHA-256 with the manifest it wrote. Each run records `authorization: {sha256, installed}` with `installed` `match`, `missing`, `mismatch` (another manifest, such as the default-deny one a launcher that ignored `--authorization` leaves), or `invalid`. Anything but `match` makes the run `invalid-run`, even when it timed out, because it did not run under the protocol's grants.

The evaluator decides each run's status:

- `awaiting-adjudication`: a valid `completed` result, within budget, not contaminated.
- `timed-out`: the evaluator killed the adapter's process group at `secondsByMode[mode]`. The run's artifacts are still extracted and it stays scorable, but flagged.
- `invalid-run`: `result.json` is missing or invalid and the run did not time out, `launchAssurance` is neither `attested` nor `unattested`, the status is not `completed`, the adapter could not start, or the artifact root does not hold the evaluator's authorization manifest (see "Authorization").
- `contaminated`: see "Sealing and contamination".

Each run records `launchAssurance` (`unreported` when the result omits it). Paired variants must share the same launch assurance: when valid runs record more than one value, the printed summary gains `"assuranceMismatch": true`. When any run was replayed, the summary also gains `replays`, the count of runs per replay status. `run.mjs` exits 1 when any run is invalid or contaminated, or on an assurance mismatch; replay outcomes never change the exit code.

### Evaluator-side extraction

After the adapter exits, whatever the outcome, the evaluator (`lib/extract.mjs`) reads `solution/bug-ledger.json` from the artifact root and validates it against `argus/schemas/bug-ledger.schema.json`:

- Confirmed rows are the findings. Suspected, needs-oracle, bounced, and quarantined rows are recorded as suspected. Duplicate and rejected rows are not candidates.
- A row's report is the first `bugs/*.md` named `<origin>-*.md` or `<origin>.md`. Its confirmation time is the report's (or else the ledger's) modification time relative to the run start, clamped to the run's elapsed time.
- `bugs/*.md` reports whose stem matches no ledger origin are listed as `unledgeredReports`.
- The framework root is the directory containing both `run-tests.sh` and `scripts/runner-contract.sh`, searched to depth 4 (skipping `node_modules`, `ai_agents_internal`, and `reports`).
- `ai_agents_internal/lane-outcomes.json`, the controller's count-only `argus/lane-outcomes@1` report, is recorded as `extraction.laneOutcomes` (`present`, `missing`, or `invalid`, with its errors). A present report is validated against `argus/schemas/lane-outcomes.schema.json` and must name each lane once. It only annotates per-lane cost; it never feeds recall or precision.
- Symbolic links and files over 2 MB are ignored.

A missing or invalid ledger scores as zero findings, which is an Argus delivery defect, not an invalid run. A missing or invalid lane-outcomes report leaves the per-lane `turnLimit` and `totalTokens` null.

```bash
node scripts/eval/discovery/run.mjs /secure/comparison.json /secure/new-comparison-output
```

### Mode A regression replay

Regression replay measures whether the regressions Argus generated catch the seeded defects, and only those. The orchestration is evaluator-side; running the generated tests is delegated to the adapter's sandboxed `replay` phase. A run is replayed when `replay.enabled` is true, its mode is `A`, its build is `faulty`, its status is `awaiting-adjudication` or `timed-out`, and extraction found a framework root. The replay runs after extraction and the contamination scan, before the run directory moves to `sealed/`. Every other run records `"replay": null`.

The hunt application is closed first. Each case then starts a fresh application with the run's seed on the hunt's own port (`run.port`), so hard-coded URLs and derived IDs in the generated suite stay valid. A port still in use after five retries 200 ms apart makes that case `infrastructure`. Cases run in this order (`planReplayCases` in `lib/replay.mjs`):

| Case | Runs | Enabled seeds | Runner mode |
|---|:--:|---|---|
| `all-on` | `repeats` | every truth seed | `defect-evidence` |
| `all-off` | `repeats` | none | `candidate-regression` |
| `all-off-baseline` | 1 | none | `baseline` |
| `only-<seedId>` | 1 per truth seed, with `perSeedMatrix` | that seed | `candidate-regression` |

With the built-in corpus and the defaults, that is 27 cases per replayed run, so budget up to 27 times `secondsPerRunner` in the worst case. For each case `<case>-<k>` (`k` numbers the repeats from 0), the evaluator writes the public `argus-eval/replay-request@1` (`schemas/replay-request.schema.json`) to `active/<publicId>/replay-requests/<case>-<k>.json` (0600). It then calls the run's own adapter as `<command...> replay <request>` with the same environment allowlist and `sealed/` closed, and kills the adapter's process group `secondsPerRunner + 60` s later, and again after a normal exit:

```json
{"schema":"argus-eval/replay-request@1","runId":"3f9c2a7d10b4e865","case":"all-on","runnerMode":"defect-evidence","frameworkRoot":"/secure/out/active/3f9c2a7d10b4e865/artifacts/qa","replayRoot":"/secure/out/active/3f9c2a7d10b4e865/replay/all-on-0","target":"http://127.0.0.1:53124","seconds":1800,"resultPath":"/secure/out/active/3f9c2a7d10b4e865/replay/all-on-0.result.json"}
```

`frameworkRoot` is the physical framework directory inside the artifact root. `replayRoot` is a physical path outside the artifact root that does not exist yet, and `resultPath` lies outside the replay root. The request carries no truth, seed list, build, variant name, or enabled flags; its `runId` is the run's opaque public ID. The case label itself is not blind: `only-<seedId>` names the one enabled seed, and it appears in the request, its file name, and the replay root. The replayed suite was frozen when the hunt ended, and its artifact root was scanned for contamination before the replay began, but a suite that reads its own working directory can see the label.

The adapter copies the framework to `replayRoot`, runs `bash run-tests.sh --mode <runnerMode>` there inside its OS sandbox (only `replayRoot` writable), enforces `seconds` on the runner, and writes `argus-eval/replay-result@1` (`schemas/replay-result.schema.json`) to `resultPath`:

```json
{"schema":"argus-eval/replay-result@1","case":"all-on","runnerMode":"defect-evidence","exitCode":0,"timedOut":false,"sandbox":"macos-sandbox-exec","runnerResult":{"$schema":"argus/runner-result@1","...":"..."},"error":null}
```

`sandbox` is `macos-sandbox-exec` or `linux-bwrap`, or `null` with an `error` when no runner was started (for example on an unsupported platform). Only the smoke-test stub adapter reports `unsandboxed-test-stub`, and `run.mjs` accepts it only in `testMode`. `runnerResult` is the framework's `reports/argus-runner-result.json`, validated against `argus/schemas/runner-result.schema.json`, or `null`.

After the runner finishes, when the corpus exports `probe()`, the evaluator re-verifies on the same instance that every truth seed probes true exactly when the case enabled it. The probes run in the evaluator process after a bounded `GET /contract` warm-up, which drops keep-alive sockets left over from the previous instance on that port. Each case gets one status, in this precedence:

- `harness-error`: a seed probe disagreed with the enabled seeds, or failed.
- `timed-out`: the runner exceeded its budget, or the evaluator killed the adapter group.
- `adapter-error`: the adapter could not start or wrote no valid result; the result answers another case or runner mode; the runner result is missing, invalid, or for another mode; the reported exit code differs from the runner result's `exitCode`; the adapter reported an error; or the replay ran without an OS sandbox.
- `infrastructure`: the application could not listen on the hunt port again, so nothing was replayed.
- `completed`: none of the above.

Whenever a valid runner result for the case's mode comes back, it is classified per bug, over every ledger bug (confirmed and unproven) and every bug ID in its events:

- an event with a non-null `bugId` that failed with category `product` is `caught`;
- one that passed is `passed`;
- a failure in any other category (`automation`, `infrastructure`, `policy`) is `broken`;
- a `skipped` or `denied` event is `skipped`;
- a ledger bug without an event is `missing`.

When several events carry one bug, the strongest outcome wins: `caught` over `broken` over `skipped` over `passed`. `infrastructureFailures` counts the failed infrastructure events, bug-linked or not. The run records:

```json
{"status":"completed","frameworkRoot":"/secure/out/sealed/runs/r0-A-faulty-baseline/artifacts/qa","reason":null,"cases":[{"case":"all-on","k":0,"runnerMode":"defect-evidence","exitCode":0,"timedOut":false,"status":"completed","bugs":{"BUG-0001":"caught"},"infrastructureFailures":0,"sandbox":"macos-sandbox-exec","reason":null}]}
```

`status` is `completed` when every case completed, `partial` when some did, and `unavailable` when none did; `reason` then counts the incomplete cases by status. `frameworkRoot` is the sealed path. The requests, replay roots, and replay results move to `sealed/runs/<runId>/` with the run.

`summarizeReplay(run.replay)` in `lib/replay.mjs` reduces a replay to the per-bug facts that scoring uses, counting only `completed` cases:

- `failsOnFaulty`: `caught` in every `all-on` repeat, and every repeat completed.
- `passesOnFix`: `passed` in every `all-off` repeat, and every repeat completed.
- `flaky`: the outcome differs between completed repeats of one case.
- `specificTo`: the seed IDs whose completed `only-<seedId>` case caught it.
- `falseAlarm`: `caught` or `broken` in any completed `all-off` repeat.
- `baselineGreenOnFix` (per run): the `all-off-baseline` case completed with exit code 0.

A bug that no valid runner result named has no entry. Scoring maps bugs to seeds from the final verdicts: a fail-to-pass regression for a seed is a credited bug with `failsOnFaulty` and `passesOnFix` that is not `flaky`, and it is specific when its `specificTo` is exactly that seed.

**Residual risk.** The probes run on the instance the suite just exercised, so suite state can mask an enabled seed. For example, a suite that consumed the single capacity unit without racing leaves nothing for the concurrency probe to over-claim. Such a case is a `harness-error`: it never counts and needs review. Replay executes hunter-written code, so it is only as contained as the adapter's OS sandbox, which confines writes, not reads. Never replay through an unsandboxed adapter outside the smoke tests.

### Reference adapter

`adapters/argus-unattested.mjs` is a maintainer-only reference adapter for an evaluation host **without operator key material**. It is never packaged. Its variant command names Node, the adapter, and a checkout of the variant revision; `run.mjs` appends the request arguments:

```json
{"name":"candidate","revision":"<full-candidate-commit>","command":["/usr/local/bin/node","/secure/holak-teams/scripts/eval/discovery/adapters/argus-unattested.mjs","--checkout","/secure/checkouts/<full-candidate-commit>"]}
```

Keep the checkout outside the evaluator repository and the output directory, and name it neutrally (for example by its revision, which the hunt request already carries): `argus-launch` passes its plugin root to Claude, so a checkout named `candidate` would tell the controller which variant it is. `--plugin-root <absolute-dir>` replaces the default plugin root `<checkout>/argus/claude`; the checkout binding then still covers only the checkout. `--no-provision-browser` drops `--provision-browser`, for a private corpus without browser surfaces.

**ANTHROPIC_API_KEY.** The launcher isolates `CLAUDE_CONFIG_DIR` inside the artifact root, so the launched Claude has no stored login. List `ANTHROPIC_API_KEY` in `adapterEnv`; the launcher passes it (or `ANTHROPIC_AUTH_TOKEN`) through its environment allowlist. Without either, the adapter does not launch.

**Downgrade guard.** When `ARGUS_MODEL_TRUST_STORE` is set or `~/.config/argus/model-trust.json` exists, `argus-launch` refuses `--unattested`, and every run of this adapter ends `launcher-refused`. Such an attested host needs its own adapter that drives the isolated runtime-attestation signer. Never move, hide, or delete the trust store to make this adapter run; the adapter itself never touches it.

A hunt runs these steps:

1. It validates the hunt request. When the result path lies inside the artifact root or has no physical parent, the adapter writes no result at all and exits 2.
2. It binds to the checkout: the checkout must be its repository's top level, `git rev-parse HEAD` must equal the request revision, and `git status --porcelain -- argus/claude` must be empty. Otherwise it writes `revision-mismatch` and exits 2 without launching.
3. It checks the preconditions. The artifact root must be physical, empty, and mode 0700. The usage and log paths must have physical parents outside it, and the usage report must not exist yet. The request's authorization manifest must be a physical regular file (no symbolic link) outside the artifact root. The plugin manifest must name `argus`, `bin/argus-launch` must be executable, and its `--help` must list `--authorization`: a launcher without it would run the hunt under the default-deny manifest, so it is never started. A failed precondition writes `launcher-failed` with `launcherExitCode: null` and a reason that starts with `not launched:`, then exits 2.
4. It records the subject: `pluginVersion` from `.claude-plugin/plugin.json`, and `pluginDigest` from `lib/plugin-digest.mjs`. The digest is the SHA-256 over the bytewise-sorted lines `<relative path>\0<sha256 of the content>\n`, one per regular file, excluding `.claude-plugin/plugin.json`, every `node_modules/`, and `.DS_Store`. A symbolic link in the tree fails the digest. The recorded-baseline gate uses the same function.
5. It launches exactly once: `argus-launch claude --target <target> --artifact-root <artifactRoot> --mode <mode> --engagement-id <engagementId> --unattested --authorization <authorization>`, with the request's own opaque `engagementId` and its authorization manifest. It adds `--provision-browser` and `--usage-json <usagePath>` only when that revision's `argus-launch --help` lists them. The environment is the adapter's own, unchanged: the adapter never sets `HOME`, `ARGUS_MODEL_TRUST_STORE`, or `CLAUDE_CONFIG_DIR`, never puts a `claude` shim on `PATH`, and never retries with another environment. Launcher stdout and stderr are appended to `logPath` up to 20 MB, then a truncation marker. The launcher stays in the adapter's process group, so the evaluator's budget kill reaches it.
6. It maps the outcome to a status:
   - launcher exit 0: `completed`;
   - a usage report with subtype `error_max_turns`, whatever the exit code: `completed` with `controllerTurnCapHit: true`, a measured outcome of the native turn cap;
   - stderr containing `--unattested is for hosts with no key material`: `launcher-refused`, adapter exit 3;
   - any other failure: `launcher-failed`, adapter exit 4.
7. It reads usage from the report: the four token counts summed over its `modelUsage` entries (falling back to the snake_case `usage` fields), `totalTokens` as their sum, `costUsd` from `total_cost_usd`, and `numTurns` from `num_turns`, with source `claude-cli-result-json`. Without a report, for example from a launcher without `--usage-json`, every value is `null` and the source is `unavailable`.
8. It writes `adapter-result@2` atomically (a temporary file and a rename) to `resultPath`, never inside the artifact root. Every result carries `"launchAssurance": "unattested"`.

A replay runs these steps:

1. It validates the replay request. `frameworkRoot` must be physical, and `replayRoot` must not exist and must have a physical parent.
2. It copies the framework to `replayRoot`, keeping symbolic links verbatim, and creates `replayRoot/.tmp`.
3. It probes the sandbox once per process. Inside the sandbox, writing `<replay parent>/.argus-replay-probe-<pid>` must fail and writing `replayRoot/.tmp/probe` must succeed; otherwise the error is `sandbox-probe-failed` (exit 5).
4. It runs `bash run-tests.sh --mode <runnerMode>` in the replay root inside the sandbox (`lib/sandbox.mjs`):
   - macOS: `sandbox-exec` with the argus-launch `os-native-target-readonly@3` profile, whose only writable subpath is the replay root;
   - Linux: the argus-launch `bwrap` invocation, with the replay root as the only read-write bind;
   - any other OS: the error `unsupported-sandbox` (exit 5).

   `smoke-adapter.mjs` fails when the profile or the `bwrap` arguments drift from `argus/bin/argus-launch`. The runner's environment is exactly `PATH` (led by the adapter's own Node directory, so no version-manager shim needs to write outside the sandbox), `HOME`, `LANG`, `TMPDIR=<replayRoot>/.tmp`, `API_URL` and `UI_URL` set to the target, and `CI=1`, with no `ARGUS_*` variable. The runner runs as its own process group, which is killed at `seconds` (`timedOut`) and again when the runner exits. Its output goes to `<replayRoot>.log`, capped at 20 MB.
5. It writes `replay-result@1` to `resultPath`, outside the replay root. `runnerResult` is `reports/argus-runner-result.json` when that is a physical regular file within 5 MB that satisfies `runner-result@1`. Otherwise `error` is `runner-result-missing` or `runner-result-unusable`, unless the runner timed out.

**Residual risk.** The adapter enforces the runner budget itself, 60 s before the evaluator's group kill. An adapter that is killed instead (for example when `run.mjs` is interrupted) cannot kill the runner's separate process group. On Linux, `bwrap --die-with-parent` still ends the runner with the adapter; on macOS the runner keeps running until it exits, and it can still write only inside its replay root.

### First-pass Opus judge

`judge.mjs` gives every extracted finding a provisional first-pass verdict:

```bash
ANTHROPIC_API_KEY=... node scripts/eval/discovery/judge.mjs --runs /secure/new-comparison-output/sealed/private-runs.json \
  --output /secure/judge-verdicts.json [--claude /absolute/path/to/claude] [--passes 2] [--concurrency 2] [--include-suspected true]
```

- **Scope.** Runs with status `awaiting-adjudication` or `timed-out` are judged; `invalid-run` and `contaminated` runs are listed as `skipped`. Within a run, the confirmed ledger rows are judged in ledger order, then the suspected rows when `--include-suspected true` is passed. `--concurrency` judges that many runs in parallel; findings of one run are judged in order.
- **Packets.** Each finding's packet is written to `<runsDir>/judge-packets/<runId>/<findingId>.json` (0600). It holds the run's public contract, its seed criteria (`id`, `surface`, `severity`, `criterion`), the corpus controls, the ledger row, the report (at most 40 KB, with a truncation marker), up to five evidence texts the row cites in `solution/evidence-reference.json` (at most 20 KB each, with `digestMatches`), `notes` on excluded material, and the verdicts already given in that run. A report or evidence file is read only when it is a regular UTF-8 text file inside the artifact root with no symbolic link on its path. The evaluator adds no evidence source path, artifact root, or other evaluator path to a packet; hunter-written report and evidence text is passed as written.
- **Invocation.** Each pass is one bare, tool-less Claude Code process: `claude -p --bare --model opus --effort max --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands --output-format json --json-schema <schema> --system-prompt-file judge/system-prompt.md`. It runs in a fresh, empty temporary directory with only `PATH`, `HOME`, and `ANTHROPIC_API_KEY` in its environment, and is killed after 600 s. `--bare` never reads OAuth credentials or the keychain, so the judge refuses to start without `ANTHROPIC_API_KEY`. A key the API rejects (status 401 or 403; the CLI retries it for minutes first) stops the whole judgement with exit 1 and no output.
- **Untrusted input.** The packet is the only user message, wrapped in `<untrusted-finding>` delimiters. Its `<` and `>` are JSON-escaped, so no text inside can close the frame. The system prompt (`judge/system-prompt.md`) treats everything inside as data and allows answers only through the schema.
- **Schema.** `schemas/judge-output.schema.json` is narrowed per finding: `seedId` is one of the run's truth IDs or null (a corrected-build run can only answer null), and `duplicateOf` is a finding already judged in that run or null. The CLI receives the structural part of the schema; the 1000-character limits and field consistency (a seed only with `real`, `duplicateOf` only with `duplicate`) are checked locally. The answer is read from `structured_output`, or else parsed from `result`, and an invalid answer is retried once. A pass that still fails makes the verdict `judgeFailed` with `outcome: null`.
- **Passes.** `agreement` is true when every pass gives the same outcome and `seedId`. Pass 1 decides; the confidence is the lowest pass confidence, or `low` on disagreement. Every pass is recorded.
- **Seed confirmation.** A credited seed is checked with the corpus `probe()` against a fresh application started with the run's seed and enabled seeds (`seedProbeConfirmed`); `false` forces low confidence. This shows the seed is observable in that build. It is not an independent reproduction of the finding.
- **Output.** `argus-eval/judge-verdicts@1` (`schemas/judge-verdicts.schema.json`), in private-runs order, binds the private runs (`runsSha256`) and the system prompt (`systemPromptSha256`), and records the Claude version, the resolved model IDs, the invocation count, the total reported cost, and every pass. The corpus version and digest must match the ones the private runs recorded. An existing output file is never overwritten. The judge exits 0 once the verdicts are written, even when some are `judgeFailed`; its summary line counts failed, low-confidence, disagreeing, and probe-mismatched verdicts.

**Cost.** By default every finding costs two Opus invocations at maximum effort (one per pass), plus one more for each invalid answer. Estimate the finding count before judging a large comparison.

**Verdicts are provisional.** The judge is a first pass, not the adjudicator. Its verdicts stay provisional until a human spot-check confirms them, and they never feed a score directly. The spot-check below always puts every unseeded real, low-confidence, disagreeing, judge-failed, or probe-mismatched verdict under human review, plus a random sample that measures how often humans overturn the judge.

### Human spot-check

`spotcheck.mjs` turns the provisional judge verdicts into final verdicts in three steps: sample a review sheet, review it, and finalize it.

**1. Sample.**

```bash
node scripts/eval/discovery/spotcheck.mjs sample --runs /secure/new-comparison-output/sealed/private-runs.json \
  --judge /secure/judge-verdicts.json --output /secure/spot-check.json [--rate 0.2] [--minimum 5] [--seed <int>] [--all]
```

- **Binding.** The judge verdicts must bind these private runs (`runsSha256`) and cover exactly what the judge judges: every run in recorded order, with the non-scorable runs skipped; the confirmed rows in ledger order, then the suspected rows when the judge included them; seeds only from the run's truth; duplicates only of earlier findings.
- **Mandatory items.** Every judge-failed, disagreeing, probe-mismatched (`seedProbeConfirmed: false`), unseeded real, or low-confidence verdict is selected. Each item records one reason, the first that applies in the order `judge-failed`, `disagreement`, `probe-mismatch`, `unseeded-real`, `low-confidence`. A failed verdict also disagrees, and a disagreement or a probe mismatch forces low confidence, so the most specific reason comes first.
- **Random sample.** Every remaining verdict is real with a seed, false-positive, or duplicate. The sample size is `min(remaining, max(minimum, ceil(rate × remaining)))`, computed exactly. The rate is a decimal in (0, 1] with at most six decimal places; the defaults are 0.2 and 5. The size is split across the three outcome strata in proportion to their size (largest remainder, ties in that order), so every remaining verdict has the same chance of selection up to rounding. Each stratum is drawn uniformly without replacement, by a partial Fisher-Yates shuffle over one mulberry32 stream. The seed is `--seed`, or else a random 32-bit integer; either way it is recorded as `samplingSeed`, and the same inputs and seed always give the same sample.
- **`--all`** selects every verdict. The non-mandatory items are then a `census`, not a random sample, and the sheet records no seed, rate, or minimum; `--all` cannot be combined with `--seed`, `--rate`, or `--minimum`.
- **Sheet.** `argus-eval/spot-check@1` (`schemas/spot-check.schema.json`, mode 0600) records `runsSha256`, `judgeSha256`, the sampling parameters, and the population and per-stratum counts. Its items follow private-runs and verdict order: `{runId, findingId, reasonSelected, judge: {outcome, seedId, duplicateOf, reason}, packetPath, human: null}`. An existing output file is never overwritten, so a sheet holding reviews cannot be replaced by a new sample.

**2. Review.** For each item, read the judge packet at `packetPath` (contract, seed criteria, controls, ledger row, report, and evidence) and independently reproduce the finding where possible. Then replace `human: null` with a decision:

```json
{"outcome":"real","seedId":"quantity-boundary","duplicateOf":null,"reviewer":"<reviewer>","reviewedAt":"2026-01-02T09:30:00Z","reason":"Quantity 11 was accepted; the contract maximum is 10","reproduced":true,"evidenceRef":"/secure/new-comparison-output/sealed/repro/r0-B-faulty-baseline/BUG-0001.txt"}
```

- `outcome` is `real`, `false-positive`, or `duplicate`. `seedId` is one of the run's seeds or null, and only a `real` outcome may credit one; a corrected-build run has no seeds. `duplicateOf` is required with `duplicate` and forbidden otherwise; it names another judged finding of the same run, and following `duplicateOf` must end at a finding that is not a duplicate.
- `reproduced: true` requires an `evidenceRef`. An `evidenceRef` is absolute or relative to the run's artifact root, and must resolve, after following symbolic links, to a regular file inside the run's artifact root or inside `<runsDir>/repro/`. `<runsDir>` is the directory holding `private-runs.json`; `repro/` must be a real directory there, not a symbolic link, and holds the reviewers' own reproduction records.
- Edit only the `human` fields. `finalize` recomputes the whole selection from the judge verdicts and the recorded seed, rate, and minimum, and refuses a sheet whose items were dropped, added, reordered, or edited.

**3. Finalize.**

```bash
node scripts/eval/discovery/spotcheck.mjs finalize --runs /secure/new-comparison-output/sealed/private-runs.json \
  --judge /secure/judge-verdicts.json --sheet /secure/spot-check.json --output /secure/final-verdicts.json [--provisional]
```

- **Bindings.** The sheet must bind the same private runs and the same judge file (`runsSha256`, `judgeSha256`). A tampered judge or runs file is refused with exit 1.
- **Completeness.** An incomplete sheet exits 20 and writes nothing. With `--provisional` it writes a snapshot with status `provisional` instead, but every judge-failed item still needs a human decision, because there is no judge outcome to fall back on (otherwise exit 20).
- **Overturns.** An item is overturned when the human outcome or `seedId` differs from the judge's. A different duplicate target alone is not an overturn.
- **Judge reliability.** `reliability = {randomSampled, randomReviewed, randomOverturned, overturnRate, maxOverturnRate}` counts the `random` items only. The mandatory items are selected for being doubtful, so counting them would bias the estimate. When more than 10% of the random items are overturned, the status is `judge-unreliable` and the exit code 22; the output is still written with that status. The comparison is exact: 1 of 10 overturned stays reliable, 2 of 10 does not. An unreliable judge cannot stand in for the unreviewed verdicts, so run `sample --all` and review every verdict. A provisional snapshot reports `judge-unreliable` as soon as the overturned random items exceed 10% of the whole random sample, since no remaining review can recover. A census sheet has no random items, so once complete it is always `final`.
- **Final.** Otherwise the status is `final` and the exit code 0.
- **Output.** `argus-eval/final-verdicts@1` (`schemas/final-verdicts.schema.json`, mode 0600, never overwritten) binds `runsSha256`, `judgeSha256`, and `sheetSha256`. It copies the judge configuration (`model`, `effort`, `passes`, `claudeVersion`, `systemPromptSha256`, `includeSuspected`) and the spot-check parameters and counts. It lists every run in private-runs order, skipped runs with no verdicts. Each verdict carries `{findingId, status, outcome, seedId, duplicateOf, source, confidence, reason, evidenceRef, humanReproduced, reviewer, overturned}`. Reviewed findings take the human decision (`source: human`, the physical evidence path, no confidence); all others keep the judge's decision (`source: judge`, with its confidence).

Only a `final` document is a complete decision record. A `provisional` one is a progress snapshot whose results stay provisional, and a `judge-unreliable` one must not feed a score. `adjudicate.mjs` (next section) scores from this file: a provisional one gives `scored-provisional`, and a judge-unreliable one is refused.

### Adjudication and scoring

`adjudicate.mjs` scores a comparison from its private runs and the final verdicts that `spotcheck.mjs finalize` wrote for them. Legitimate unseeded findings are `real` without a seed and are never penalized for being absent from the private key.

```bash
node scripts/eval/discovery/adjudicate.mjs --runs /secure/new-comparison-output/sealed/private-runs.json \
  --verdicts /secure/final-verdicts.json --output /secure/discovery-summary.json [--isolation same-user|separate-user] [--exclude-contaminated]
```

- **Bindings.** The final verdicts must bind these private runs (`runsSha256`) and list every run in recorded order; invalid and contaminated runs carry no verdicts. Each verdict must name an extracted ledger row of its run with the same status, at most once. Only a `real` outcome may credit a seed, and only one of the run's truth seeds; a `duplicate` must cite another extracted row of the run.
- **Evidence.** Every non-null `evidenceRef` must still exist and resolve, after following symbolic links, to a regular file inside the run's sealed artifact root or the physical `<runsDir>/repro/` directory, the same roots `spotcheck.mjs` accepts.
- **Isolation.** `--isolation` records how the adapters were isolated from the evaluator: `same-user` or `separate-user` (see "Residual risk" under "Sealing and contamination"). Without it, `isolation.declared` is null.
- **Output.** `argus-eval/discovery-summary@1` (`schemas/discovery-summary.schema.json`, mode 0600, never overwritten): `{schema, status, reasons, createdAt, corpus {version, digest}, protocol, variants, runs, excludedRuns, isolation {declared}, sources}`. `protocol` holds the modes, builds, repeats, the seed each repeat ran with, `secondsByMode`, `tokens`, `replay`, `testMode`, the judge configuration (`model`, `effort`, `passes`, `systemPromptSha256`, `claudeVersion`, `includeSuspected`), and the spot-check parameters and counts. Each variant records its `revision`, its `subject {pluginVersion, pluginDigest}` (null when its runs disagree), and `perMode {A?, B?}`, the aggregates of each configured mode. `runs` keeps every raw per-run result in recorded order, each with `scoring` `scored`, `unscored` (a missing verdict), or `excluded` (an invalid or contaminated run) and `metrics` (null unless scored). `sources` holds the SHA-256 of the private runs and final verdicts and the judge and sheet digests the final verdicts carry. The summary holds IDs and counts only: no report text, verdict reasons, evidence, or paths. It is written whatever the status.

Status and exit code:

- `scored`, exit 0.
- `scored-provisional`, exit 23: the final verdicts are a `provisional` snapshot (`reasons` records `provisional-verdicts`). Results stay provisional.
- `UNSCORED`, exit 20, with one `reasons` entry per cause: `invalid-run`; `missing-verdict`, a confirmed finding without a final verdict (the entry lists the finding IDs); `contaminated-run`, unless `--exclude-contaminated` is passed, which lists contaminated runs in `excludedRuns` and leaves them out of every metric; and `mixed-plugin-digest`, a variant whose runs with a valid adapter result report different `subject.pluginDigest` values (a run that reports none counts as its own value). An UNSCORED summary keeps the per-run results, and every variant's `perMode` is null.
- Exit 1: invalid input, with no output: a schema violation, a broken binding, missing or escaping evidence, a verdict that contradicts its run, judge-unreliable final verdicts, or an existing output file. Exit 2: usage.

A timed-out run is extracted, flagged, and scored like any other; usage it did not measure (a killed launcher normally records none) is null and left out of the usage totals. Suspected rows count only when the judge included them (`--include-suspected true`); a suspected row without a verdict is not credited.

#### Metrics

Per run (`runs[].metrics`). Findings are a run's confirmed ledger rows; suspected rows are its suspected, needs-oracle, bounced, and quarantined rows.

| Metric | Definition |
|---|---|
| `seeded` | number of truth seeds (0 on a corrected build) |
| `detectedSeeds`, `detectedSeedIds` | the distinct seeds credited by confirmed findings with outcome `real` |
| `recall` | `detectedSeeds / seeded`; null when `seeded` is 0 |
| `criticalSeeded`, `criticalRecall` | the same over the Critical and Blocker seeds; null when there are none |
| `perSurface` | per truth surface, `{seeded, detected}` |
| `reported` | the number of confirmed findings |
| `real`, `realUnseeded`, `falsePositive`, `duplicate` | confirmed findings per final outcome; `realUnseeded` counts the real ones that credit no seed |
| `precision` | `real / reported`; null when nothing was reported |
| `suspected` | the number of suspected rows |
| `suspectedSeedHits` | the distinct seeds credited only through real suspected rows; never counted as recall |
| `perLane` | per ledger lane, `{reported, real, falsePositive, duplicate, seedsDetected}` over confirmed findings, plus `turnLimit` (turn-limit decisions) and `totalTokens` (telemetry tokens) from the lane-outcomes report, null when the run has no valid report or the lane is missing from it |
| `reproduction` | per real finding: `human` when the human decision reproduced it (`humanReproduced`), else `replay` when its bug's regression is fail-to-pass, else `none`; the three counts and `byFinding` |
| `independentReproduction` | `(human + replay) / real`; null when `real` is 0 |
| `deliveryDefects` | the ledger state (`present`, `missing`, `invalid`) and the number of unledgered reports |
| `usage` | measured `tokens`, `cost` (USD), `numTurns`, and `controllerTurnCapHit` (each null when unavailable), plus `elapsedMs`, `timedOut`, and `overBudget` |
| `regression` | for a faulty Mode A run with a replay, otherwise null (below) |

Regression fidelity uses `summarizeReplay(run.replay)` (see "Mode A regression replay"). For each detected seed S, over the real confirmed findings credited to S (`bugs`):

- `hasWiredRegression`: some credited finding's ledger row is `wired`;
- `failToPass`: some credited bug has `failsOnFaulty` and `passesOnFix` and is not `flaky`;
- `specific`: some fail-to-pass credited bug has `specificTo` exactly `[S]`;
- `flaky`: some credited bug is `flaky`.

The run also records `falseAlarms` (real findings whose bug is a `falseAlarm`), `baselineGreenOnFix`, and `replayStatus`.

Per variant and mode (`variants[].perMode.A` and `.B`), over the scored runs of that variant and mode:

| Aggregate | Definition |
|---|---|
| `runs`, `faultyRuns`, `correctedRuns` | scored runs |
| `seedsPerFaultyRun` | the mean `seeded` of the faulty runs |
| `meanDetectedSeeds`, `meanRecall`, `meanCriticalRecall` | means over the faulty runs, skipping null values |
| `perSurfaceRecall` | pooled over the faulty runs: summed `seeded` and `detected` per surface, and `recall = detected / seeded` |
| `reported`, `real`, `pooledPrecision` | summed over every scored run, faulty and corrected; `pooledPrecision = real / reported`, null when nothing was reported. Unlike a mean of per-run precision, it weighs every finding equally and cannot ignore a run's false positives because another run reported nothing |
| `falsePositivesOnCorrected` | false positives summed over the corrected runs |
| `meanRealUnseeded` | the mean `realUnseeded` of every scored run |
| `suspectedSeedHits` | summed |
| `independentReproduction` | pooled: summed `human + replay` over summed `real` |
| `regression` | Mode A only, otherwise null. `faultyRuns`, `replayedRuns`, `detectedSeeds` (summed over the replayed runs), the seed counts `withWiredRegression`, `failToPass`, `specific`, and `flaky`, the rates `failToPassRate`, `specificRate`, and `flakyRate` (each count over `detectedSeeds`; null when no seed was detected), summed `falseAlarms`, and `baselineGreenOnFixRate` (the share of replayed runs whose baseline was green on the fix). A faulty Mode A run without a replay (no framework was found) counts only in `faultyRuns` |
| `perLane` | per lane, summed counts plus `precision = real / reported`; `turnLimit` and `totalTokens` sum over the runs that measured them and stay null when none did |
| `deliveryDefects` | `ledgerMissing` and `ledgerInvalid` runs, and summed `unledgeredReports` |
| `usage` | `tokens`, `cost`, `numTurns`, and `elapsedMs`, each `{runs, total, mean}` over the runs that measured it |
| `timedOutRuns`, `overBudgetRuns`, `controllerTurnCapHits` | counts of scored runs |
| `invalidRuns`, `contaminatedRuns` | counts of recorded runs, excluded or not |
| `judgeReliability` | the final verdicts' `reliability`, copied |

Do not read a corrected run's null precision as perfect precision; inspect `reported` and `falsePositivesOnCorrected` too. Archive the summary with the private runs and final verdicts it binds, so the raw per-run results keep instability visible.

## Approving a prompt corpus with benchmark evidence

A scored comparison is the evidence that lets a changed Argus prompt corpus pass `node scripts/check-argus-prompts.mjs` without a pending approval. Check out the candidate revision and re-stamp `argus/prompt-budgets.json`:

```bash
node scripts/approve-argus-prompts.mjs --approved-for "<release and reason>" \
  --benchmark /secure/discovery-summary.json --baseline-variant baseline --candidate-variant candidate --write
```

The tool reads the `argus-eval/discovery-summary@1` that `adjudicate.mjs` writes and validates it against its schema; the pre-5.0 `comparison` shape is refused. The summary must be `scored` (`scored-provisional` and `UNSCORED` are refused) and must not be a `testMode` comparison. It selects the two named variants and uses their `revision`: it refuses when `argus/claude/agents` or `argus/shared-skills` differ from the candidate revision, hashes both revisions' agent prompts and doctrine profiles from git with the gate's own encoding, and records the SHA-256 of the summary file. It refuses to write a regressed approval: in every mode the comparison ran, each variant needs at least `nonRegression.minRepeats` scored faulty runs and numeric `meanRecall` and `pooledPrecision`, and every candidate figure must reach the baseline figure minus its tolerance (critical recall only when both sides have one); the refusal names the mode. The recorded evidence keeps one figure per side and metric, the minimum across modes: `runs` is the fewest scored faulty runs, `meanPrecision` is the pooled precision, and critical recall is taken over the modes where both sides have one, so the recorded figures pass the prompt gate's re-check whenever every mode passed. `adjudicatedAt` defaults to the summary's `createdAt` date (`--adjudicated-at` overrides it). Without `--write` it prints the proposed `approvedCorpus`. Without a scored comparison, `--benchmark-pending <reason>` records a pending approval that the gate accepts, with a warning, only while the Argus plugin version equals its `releaseVersion`.

## Baseline and release checks

`node scripts/eval/discovery/smoke-corpus.mjs` runs the corpus probe matrix for three input seeds (all seeds enabled, none enabled, and each seed alone): every seed probe must be true exactly when its seed is enabled, and every control must hold. It asserts exactly 22 seeds with the per-surface counts above and at least 12 controls. It also checks the public endpoints and UI pages for private data and test IDs, contract determinism across restarts and builds, same-port restarts that replay derived IDs, the loopback-only bind, and that `corpus/` imports only `node:` builtins. It also checks on a copy of `corpus/` that host and editor junk (`.DS_Store`, AppleDouble `._*` files, editor swap and backup files, `node_modules/`), which `corpusFiles()` and `corpusDigest()` skip, leaves the corpus digest unchanged, while a content change moves it. Because probes run sequentially and the report and latency probes wait on real time, the suite takes about two and a half minutes. `node scripts/eval/discovery/smoke.mjs` tests the configuration rules and the contamination scan, then runs 16 paired protocol runs (modes A and B, both builds, pinned seeds) with a stub adapter, asserts that no hunt request value or path names the build, a variant, the private run ID, or a seed ID, checks each run's authorization manifest (bound to its engagement ID and target, installed in its artifact root, its grants allowed from the start to the end of the budget while ungranted, foreign-target, over-ceiling, and prohibited actions stay denied), and scores them through `adjudicate.mjs`, plus stub cases for a forged `result.json` inside the artifact root, contamination, a timed-out budget, the sealed directory, launch assurance, the token cap, and a hunt whose artifact root holds no or another authorization manifest (`invalid-run`). `node scripts/eval/discovery/smoke-replay.mjs` covers regression replay with the test-only stub adapter `scripts/fixtures/argus-eval/stub-adapter.mjs`, which is unsandboxed and refuses to run without `ARGUS_EVAL_SMOKE=1`. It checks case planning, per-bug classification and precedence, case status precedence and consistency checks, the replay summary, the replay configuration rules, and the same-port retry. It then runs two faulty Mode A replays (54 same-port restarts): BUG-0001 fails on the faulty build, passes on the fix, and is specific to `quantity-boundary`, while BUG-0002 is a false alarm. It also asserts that corrected and Mode B runs are not replayed, that replay requests carry no private data and point outside the artifact root, that `sealed/` is closed during the replay, and that an adapter without a replay result and a disagreeing seed probe give `adapter-error` and `harness-error` cases. `node scripts/eval/discovery/smoke-extract.mjs` covers evaluator-side extraction: valid, invalid, and missing ledgers, symbolic links, unledgered reports, framework detection, oversize files, and valid, linked, malformed, and text-carrying lane-outcomes reports. `node scripts/eval/discovery/smoke-judge.mjs` covers the judge with the stub CLI `scripts/fixtures/argus-eval/claude-judge`, which asserts the bare, tool-less flags: seed credit and probe confirmation, the corrected-run seed enum, duplicates, pass disagreement, retries and judge failures, evidence containment, untrusted-content framing, and that no packet carries the private-runs path or the canary. `node scripts/eval/discovery/smoke-spotcheck.mjs` covers the spot-check with synthetic runs and judge verdicts: mandatory items, the sample size rule and stratum allocation, seed replay, census sheets, incomplete and provisional sheets, the reliability boundary (1 of 10 random items overturned is final, 2 of 10 is judge-unreliable), human decision checks, evidence containment, the SHA-256 bindings, and sheet integrity. `node scripts/eval/discovery/smoke-adjudicate.mjs` covers scoring with synthetic private runs and final verdicts: a real seeded finding, a real unseeded finding (not penalized), a false positive on a corrected run, a duplicate, a suspected seed hit excluded from recall, null precision for a zero-report run, pooled precision arithmetic, per-surface and per-lane counts (with lane-outcome turn-limit and token costs), and fail-to-pass, specific, flaky, and false-alarm regressions from a synthetic replay. It also checks the exit codes: provisional verdicts give 23; a missing verdict, an invalid or contaminated run, and mixed plugin digests give 20 (`--exclude-contaminated` gives 0); escaping or symbolically linked evidence, a tampered binding, and judge-unreliable verdicts give 1. `node scripts/eval/discovery/smoke-adapter.mjs` covers the reference adapter without an API: a stub plugin whose `argus-launch` records its argv and environment gives a completed run (exact unattested argv with the request engagement ID and `--authorization`, unchanged `HOME` and `PATH`, summed usage), no launch for a launcher without `--authorization` or a missing or symbolically linked manifest, a refusal, `error_max_turns`, a revision mismatch, a dirty checkout, and a symbolic-link artifact root; the real `argus-launch` refuses `--unattested` with a trust store in `HOME` and leaves it byte-identical, and without one accepts the evaluator manifest in a `--dry-run`; the packaged `argus-assets authorization verify` accepts that manifest only for its own engagement ID, and `authorization check` allows its granted actions and denies an ungranted `destructive` one; a sandboxed replay captures the runner result while writes outside the replay root fail (SKIP without `sandbox-exec` or `bwrap`). It also pins the plugin digest definition and the replay sandbox to `argus/bin/argus-launch`. `node scripts/eval/discovery/smoke-gate.mjs` covers the recorded-baseline gate below against temporary trees, with stub plugin roots and synthetic summaries: SKIP for a not-recorded baseline (including the committed one); invalid and loosened baselines (exit 1); `record-baseline.mjs` recording and its refusals of provisional, UNSCORED, contaminated, fewer than 3 repeats, `testMode`, undeclared isolation, an unreliable judge, and another plugin or corpus; the unchanged-plugin pass; exit 3 without an evaluation and WARN under a waiver; 1.5-seed, 0.06-precision, and Mode A 0.1 fail-to-pass drops (exit 4); exact 1.0-seed and 0.05-precision drops (exit 0); corpus, seed, and protocol mismatches (exit 2); hand-edited baselines; `--compare`; and usage and test-flag errors (exit 64). These are deterministic harness baselines, **not an Argus model benchmark**. The release gate runs `node scripts/eval/run-smokes.mjs` (also `make eval-smoke`), which executes every `smoke*.mjs` under `scripts/eval`, and then the discovery gate.

### Recorded baseline and the discovery gate

`baseline.json` (`argus-eval/discovery-baseline@1`, `schemas/discovery-baseline.schema.json`) is the reference of the model-quality release gate. `scripts/validate-release.sh` runs `node scripts/eval/discovery/gate.mjs --check` right after the smoke suites (also `make eval-gate`).

**Not recorded.** Argus 5.0.0 ships `baseline.json` with status `not-recorded` and a reason: no adjudicated Argus engagement has been recorded against `argus-eval-corpus@2` yet. The gate then prints `SKIP  discovery gate inactive: baseline not recorded (<reason>)` and exits 0. It never passes silently, and it claims nothing about Argus discovery quality.

**Recording.** A baseline is one variant of a scored discovery summary:

```bash
node scripts/eval/discovery/record-baseline.mjs --summary /secure/discovery-summary.json --variant candidate [--write]
```

It refuses with exit 1, listing every reason, unless:

- the summary is `scored`; `scored-provisional` and `UNSCORED` summaries are refused;
- the comparison ran at least 3 repeats, includes the `faulty` build, and is not a `testMode` run;
- the summary declares its isolation (`adjudicate.mjs --isolation`) and excludes no run, and the variant has no invalid or contaminated run in any mode;
- the judge is reliable: at least 5 random spot-check items with an overturn rate of at most 0.10, or a complete census (`spotcheck.mjs sample --all`, the remedy for an unreliable judge), which put every verdict under human review;
- the variant's `subject.pluginDigest` equals `pluginDigest('argus/claude')` of the working tree (`lib/plugin-digest.mjs`, the digest the reference adapter reports), and the summary's corpus digest equals the built-in `corpusDigest()`.

Without `--write` it prints the planned baseline. With `--write` it copies the summary byte for byte to `evaluations/argus-<version>-<digest12>.json` (the working tree's plugin version and the first 12 hex digits of its digest; a different existing file is never replaced) and rewrites `baseline.json` atomically with `recordedAt`, `subject {argusVersion, pluginDigest, revision}`, the summary's `corpus`, `protocol`, and `isolation`, `summary {path, sha256}`, and `metrics.perMode`: per mode `faultyRuns`, `seedsPerFaultyRun`, `meanDetectedSeeds`, `meanRecall`, `meanCriticalRecall`, `pooledPrecision`, and `perSurfaceRecall`, plus `regression {failToPassRate, specificRate, flakyRate}` for Mode A. It keeps the existing thresholds and drops the previous baseline's waivers. Commit the evaluation and `baseline.json` together; the summary holds IDs and counts only.

**Isolation.** The Argus OS sandbox confines writes, not reads, so a hunter can read anything the evaluating user can (see "Residual risk" under "Sealing and contamination"). Record a baseline only from a comparison whose adapters ran as a separate OS user or in a container that cannot read the evaluator repository, and adjudicate it with `--isolation separate-user`. `record-baseline.mjs` accepts `same-user` with a warning, so the recorded `isolation.declared` always states which one it was.

**Gate.** `gate.mjs --check` first validates `baseline.json` against its schema and refuses thresholds looser than the defaults (exit 1); a baseline may tighten them. For a recorded baseline it then checks, in order:

1. The committed summary at `summary.path` must still have the recorded SHA-256, and `baseline.json` must equal what `record-baseline.mjs` derives from it. Otherwise exit 1, so a hand edit of the recorded metrics cannot move the bar.
2. The recorded corpus digest must equal `corpusDigest()`. Otherwise exit 2: `corpus changed since baseline; re-record`.
3. When the working tree's plugin digest equals the baseline's, the gate passes: `plugin unchanged since baseline`.
4. Otherwise the candidate is the schema-valid, `scored` `evaluations/*.json` with a variant whose `subject.pluginDigest` equals the current digest, the newest by `createdAt` when several do; invalid or unscored files are named in a warning and ignored. Without a candidate, a waiver for the current digest passes with `WARN` (exit 0); otherwise exit 3: `Argus plugin content changed since the recorded baseline; run the discovery evaluation and commit its summary`.
5. The candidate must follow the baseline protocol: the same corpus digest, every baseline mode and build, at least the baseline's repeats with seeds that begin with the baseline's seeds (identical when the repeat counts are equal), identical `secondsByMode`, the same judge `model`, `passes`, and `systemPromptSha256`, and no `testMode`. Otherwise exit 2, `incomparable`, with one line per difference.
6. For every baseline mode it prints one delta line per gated metric, and fails with exit 4 when any metric dropped by more than its threshold. Improvements always pass. A null candidate value against a non-null baseline value counts as a drop; a null baseline value has nothing to regress from.

| Threshold | Default, the loosest allowed | Fails when, per baseline mode |
|---|:--:|---|
| `maxMeanDetectedSeedDrop` | 1 | baseline `meanDetectedSeeds` minus the candidate's exceeds it |
| `maxPrecisionDrop` | 0.05 | baseline `pooledPrecision` minus the candidate's exceeds it |
| `maxRegressionFailToPassDrop` | 0.05 | Mode A only: baseline `regression.failToPassRate` minus the candidate's exceeds it |

A drop of exactly the threshold passes. Drops are compared with a 1e-9 tolerance, because floating-point subtraction makes, for example, `0.75 - 0.7` slightly larger than 0.05.

`gate.mjs --compare <summary.json> [--variant <name>]` runs steps 1, 2, 5, and 6 against one scored summary, for example before committing it; `--variant` is required when the summary has two variants. A not-recorded baseline gives SKIP in both modes. Usage errors exit 64. The test-only flags `--root`, `--plugin-root`, and `--corpus-digest` of both scripts are honored only with `ARGUS_EVAL_SMOKE=1`.

**Waivers.** `waivers` holds `{pluginDigest, reason, approvedBy, createdAt}` entries, added to `baseline.json` by hand. A waiver lets exactly one plugin digest pass without an evaluation, with a warning that names the approver and the reason; it never overrides a failing or incomparable evaluation of that digest. Keep waivers for changes that cannot affect discovery, and run the evaluation for anything else. Recording a new baseline drops every waiver.
