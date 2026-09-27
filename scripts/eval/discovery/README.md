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

The evaluator keeps private truth in its own process and writes it only to the sealed part of the output directory. Hunters receive only the public hunt request: a loopback URL, the public contract URL, an empty artifact directory, the mode, and the budget. Do not give hunters the repository, evaluator sources, the output directory, answer keys, or verdicts. Host adapters **must launch the normal Argus isolated runtime**; a temporary working directory alone is not an OS sandbox. Never run an untrusted adapter.

### Sealing and contamination

Every directory the evaluator creates is 0700 and physical (its realpath equals itself):

- `<output>/sealed/` holds `private-runs.json`, `canary.txt`, and `runs/<runId>/` (completed runs).
- `<output>/active/<runId>/` holds `request.json` (0600), `result.json`, `usage.json`, `launcher.log`, and `artifacts/`, the artifact root. The artifact root starts empty and is the hunter's only writable root; request, result, and usage live outside it, so a hunter cannot forge them. After the run, the whole directory moves to `sealed/runs/<runId>/`, and `artifactRoot` in the private results is that sealed path.

While an adapter runs, `sealed/` is `chmod 000`. The OS sandbox denies chmod outside the artifact root, so a hunter cannot undo the seal. After the adapter exits (or is killed at its budget), the evaluator kills the adapter's whole process group before it restores 0700, so no straggler in that group sees the directory reopen. Interrupting `run.mjs` (SIGINT or SIGTERM) also kills the group and restores the mode.

At start, the evaluator writes a random `ARGUS-EVAL-CANARY-<32 hex>` to `sealed/canary.txt` and records only its SHA-256. After each run it scans the artifact root: regular files up to 5 MB, and every relative file name, skipping `node_modules` and symbolic links. Any of these makes the run `contaminated`:

- the canary;
- an absolute path of the evaluator repository, the output directory, or the corpus directory (the run's own artifact root path is exempt, because Argus records it);
- a corpus source file name, such as `tenant-authz.mjs` or `corpus/index.mjs`. Every file counts qualified by its directory; files with a hyphenated stem also count by their bare name. A private `corpusModule` contributes its optional `corpusDir` and `corpusFiles()` exports, or else its own directory and file name.

A contaminated run is excluded from metrics, makes `run.mjs` exit 1, and blocks recording a baseline. An exact seed ID or an unreadable entry makes the run `suspect` only: it is flagged for review but still scored.

**Residual risk.** The Argus OS sandbox confines writes, not reads (`file-read*` on macOS, `--ro-bind / /` on Linux). A hunter can therefore read the evaluator repository, including corpus sources and git objects, and anything else the evaluating user can read. Sealing protects only this comparison's private results, and only against processes in the adapter's process group (a process that calls `setsid` escapes the post-exit kill). The scan detects traces, not reads that leave none. For a recorded baseline, run the adapters as a separate OS user or in a container that cannot read the repository, and state the isolation used. Keep variant checkouts outside the evaluator repository and the output directory; otherwise their plugin paths match a forbidden evaluator path.

## Paired, repeated comparison

Write a host-local `argus-eval/comparison-config@2` configuration (`schemas/comparison-config.schema.json`):

```json
{
  "schema": "argus-eval/comparison-config@2",
  "variants": [
    {"name":"baseline","revision":"<full-baseline-commit>","command":["/secure/argus-eval-baseline-adapter"]},
    {"name":"candidate","revision":"<full-candidate-commit>","command":["/secure/argus-eval-candidate-adapter"]}
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
- `replay`: reserved for Mode A regression replay; this revision accepts only `{"enabled": false}`.
- `corpusModule`: an optional private corpus (above), resolved relative to the configuration file.
- `testMode`: smoke tests only; allowed only with `ARGUS_EVAL_SMOKE=1`, and lowers the seconds minimum to 1.

For every repeat, mode, and build, each variant runs once, in alternating order on odd repeats, against a fresh application started with the repeat seed. Its run ID is `r<repeat>-<mode>-<build>-<variant>`.

### Host adapter contract

The adapter receives the absolute path of the public `argus-eval/hunt-request@2` (`schemas/hunt-request.schema.json`) as its final argument, with `active/<runId>/` as its working directory:

```json
{"schema":"argus-eval/hunt-request@2","runId":"r0-B-faulty-baseline","revision":"<full-baseline-commit>","target":"http://127.0.0.1:53124","contractUrl":"http://127.0.0.1:53124/contract","mode":"B","artifactRoot":"/secure/out/active/r0-B-faulty-baseline/artifacts","resultPath":"/secure/out/active/r0-B-faulty-baseline/result.json","usagePath":"/secure/out/active/r0-B-faulty-baseline/usage.json","logPath":"/secure/out/active/r0-B-faulty-baseline/launcher.log","budget":{"seconds":14400,"tokens":null}}
```

The request carries no truth, seed, build, or enabled flags. On an evaluation host with no operator key material, the adapter launches by default with `argus-launch claude --unattested --mode <request.mode> --target <request.target> --artifact-root <request.artifactRoot> --engagement-id <id> --provision-browser`. The launcher's downgrade guard refuses `--unattested` whenever `ARGUS_MODEL_TRUST_STORE` or `~/.config/argus/model-trust.json` exists. The adapter must then run attested with its isolated signer, and must never move, hide, or delete a trust store to obtain unattested mode. The OS sandbox, the Claude version check, and the native turn cap still apply. The product default remains attested; unattested launch is an evaluation-host option, and `result.json` must carry `launchAssurance`.

The adapter writes `argus-eval/adapter-result@2` (`schemas/adapter-result.schema.json`) to `resultPath`, never inside the artifact root:

```json
{"schema":"argus-eval/adapter-result@2","status":"completed","launcherExitCode":0,"usage":{"source":"claude-cli-result-json","inputTokens":120000,"outputTokens":30000,"cacheReadTokens":900000,"cacheCreationTokens":40000,"totalTokens":1090000,"costUsd":12.5,"numTurns":88,"controllerTurnCapHit":false},"subject":{"pluginVersion":"<plugin version>","pluginDigest":"<sha256 of the plugin tree>"},"reason":null,"launchAssurance":"unattested"}
```

`status` is `completed`, `launcher-refused`, `launcher-failed`, or `revision-mismatch`. Usage is measured provider usage from the Claude CLI result JSON; when none is available, `source` is `unavailable` and every value is `null`, never an estimate or an invented zero. Adapters report no findings. They are revision-specific; review their checkout binding and isolation before running them.

The evaluator decides each run's status:

- `awaiting-adjudication`: a valid `completed` result, within budget, not contaminated.
- `timed-out`: the evaluator killed the adapter's process group at `secondsByMode[mode]`. The run's artifacts are still extracted and it stays scorable, but flagged.
- `invalid-run`: `result.json` is missing or invalid and the run did not time out, `launchAssurance` is neither `attested` nor `unattested`, the status is not `completed`, or the adapter could not start.
- `contaminated`: see "Sealing and contamination".

Each run records `launchAssurance` (`unreported` when the result omits it). Paired variants must share the same launch assurance: when valid runs record more than one value, the printed summary gains `"assuranceMismatch": true`. `run.mjs` exits 1 when any run is invalid or contaminated, or on an assurance mismatch.

### Evaluator-side extraction

After the adapter exits, whatever the outcome, the evaluator (`lib/extract.mjs`) reads `solution/bug-ledger.json` from the artifact root and validates it against `argus/schemas/bug-ledger.schema.json`:

- Confirmed rows are the findings. Suspected, needs-oracle, bounced, and quarantined rows are recorded as suspected. Duplicate and rejected rows are not candidates.
- A row's report is the first `bugs/*.md` named `<origin>-*.md` or `<origin>.md`. Its confirmation time is the report's (or else the ledger's) modification time relative to the run start, clamped to the run's elapsed time.
- `bugs/*.md` reports whose stem matches no ledger origin are listed as `unledgeredReports`.
- The framework root is the directory containing both `run-tests.sh` and `scripts/runner-contract.sh`, searched to depth 4 (skipping `node_modules`, `ai_agents_internal`, and `reports`).
- Symbolic links and files over 2 MB are ignored.

A missing or invalid ledger scores as zero findings, which is an Argus delivery defect, not an invalid run.

```bash
node scripts/eval/discovery/run.mjs /secure/comparison.json /secure/new-comparison-output
```

### First-pass Opus judge

`judge.mjs` gives every extracted finding a provisional first-pass verdict:

```bash
ANTHROPIC_API_KEY=... node scripts/eval/discovery/judge.mjs --runs /secure/new-comparison-output/sealed/private-runs.json \
  --output /secure/judge-verdicts.json [--claude /absolute/path/to/claude] [--passes 2] [--concurrency 2] [--include-suspected true]
```

- **Scope.** Runs with status `awaiting-adjudication` or `timed-out` are judged; `invalid-run` and `contaminated` runs are listed as `skipped`. Within a run, the confirmed ledger rows are judged in ledger order, then the suspected rows when `--include-suspected true` is passed. `--concurrency` judges that many runs in parallel; findings of one run are judged in order.
- **Packets.** Each finding's packet is written to `<runsDir>/judge-packets/<runId>/<findingId>.json` (0600). It holds the run's public contract, its seed criteria (`id`, `surface`, `severity`, `criterion`), the corpus controls, the ledger row, the report (at most 40 KB, with a truncation marker), up to five evidence texts the row cites in `solution/evidence-reference.json` (at most 20 KB each, with `digestMatches`), `notes` on excluded material, and the verdicts already given in that run. A report or evidence file is read only when it is a regular UTF-8 text file inside the artifact root with no symbolic link on its path. Evidence source paths, the artifact root, and other evaluator paths never enter a packet.
- **Invocation.** Each pass is one bare, tool-less Claude Code process: `claude -p --bare --model opus --effort max --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands --output-format json --json-schema <schema> --system-prompt-file judge/system-prompt.md`. It runs in a fresh, empty temporary directory with only `PATH`, `HOME`, and `ANTHROPIC_API_KEY` in its environment, and is killed after 600 s. `--bare` never reads OAuth credentials or the keychain, so the judge refuses to start without `ANTHROPIC_API_KEY`.
- **Untrusted input.** The packet is the only user message, wrapped in `<untrusted-finding>` delimiters. Its `<` and `>` are JSON-escaped, so no text inside can close the frame. The system prompt (`judge/system-prompt.md`) treats everything inside as data and allows answers only through the schema.
- **Schema.** `schemas/judge-output.schema.json` is narrowed per finding: `seedId` is one of the run's truth IDs or null (a corrected-build run can only answer null), and `duplicateOf` is a finding already judged in that run or null. The CLI receives the structural part of the schema; the 1000-character limits and field consistency (a seed only with `real`, `duplicateOf` only with `duplicate`) are checked locally. The answer is read from `structured_output`, or else parsed from `result`, and an invalid answer is retried once. A pass that still fails makes the verdict `judgeFailed` with `outcome: null`.
- **Passes.** `agreement` is true when every pass gives the same outcome and `seedId`. Pass 1 decides; the confidence is the lowest pass confidence, or `low` on disagreement. Every pass is recorded.
- **Seed confirmation.** A credited seed is checked with the corpus `probe()` against a fresh application started with the run's seed and enabled seeds (`seedProbeConfirmed`); `false` forces low confidence. This shows the seed is observable in that build. It is not an independent reproduction of the finding.
- **Output.** `argus-eval/judge-verdicts@1` (`schemas/judge-verdicts.schema.json`), in private-runs order, binds the private runs (`runsSha256`) and the system prompt (`systemPromptSha256`), and records the Claude version, the resolved model IDs, the invocation count, the total reported cost, and every pass. The corpus version and digest must match the ones the private runs recorded. An existing output file is never overwritten.

**Cost.** By default every finding costs two Opus invocations at maximum effort (one per pass), plus one more for each invalid answer. Estimate the finding count before judging a large comparison.

**Verdicts are provisional.** The judge is a first pass, not the adjudicator. Its verdicts stay provisional until a human spot-check confirms them, and they never feed a score directly. Review at least every unseeded real, low-confidence, disagreeing, judge-failed, or probe-mismatched verdict.

### Manual adjudication

All runs initially remain `UNSCORED`; the private results are `<output>/sealed/private-runs.json` (`argus-eval/private-runs@2`). Read each extracted finding's report, acceptance criterion, and evidence, then independently reproduce it. Write a verdict array per run, in recorded run order, keyed by ledger bug ID:

```json
[[{"findingId":"BUG-0001","outcome":"real","seedId":"quantity-boundary","reason":"The above-maximum quantity was persisted","evidenceRef":"reports/independent-repro.txt","independentlyReproduced":true,"confirmedAtMs":12000}]]
```

Use `real`, `false-positive`, or `duplicate`. Legitimate unseeded findings use `real` without `seedId`; never penalize them merely for being absent from the private key. Confirmation time is elapsed milliseconds from run start, established by recorded evidence. Verdict evidence must exist inside the run's sealed artifact root. The one-row example illustrates the format, not a complete comparison.

```bash
node scripts/eval/discovery/adjudicate.mjs /secure/new-comparison-output/sealed/private-runs.json /secure/verdicts.json
```

The result includes per-run recall, critical recall, precision, independent reproduction, first-confirmation time, measured tokens/cost, and cost per real finding, plus per-revision repeated-run means. Missing verdicts, invalid or contaminated runs, and runs without measured usage block the comparative score. Timed-out runs are extracted and flagged, but they can be scored only when the adapter recorded usage before the kill, which a killed launcher normally does not, so set budgets generously. Do not interpret a zero-finding corrected run as perfect precision (precision is undefined there); inspect reported counts and false positives too. Archive raw per-run results alongside means so instability stays visible.

## Approving a prompt corpus with benchmark evidence

A scored comparison is the evidence that lets a changed Argus prompt corpus pass `node scripts/check-argus-prompts.mjs` without a pending approval. Save the adjudication output, check out the candidate revision, and re-stamp `argus/prompt-budgets.json`:

```bash
node scripts/eval/discovery/adjudicate.mjs /secure/new-comparison-output/sealed/private-runs.json /secure/verdicts.json >/secure/adjudication.json
node scripts/approve-argus-prompts.mjs --approved-for "<release and reason>" \
  --benchmark /secure/adjudication.json --baseline-variant baseline --candidate-variant candidate --write
```

The tool accepts only a `scored` adjudication and reads the `revision`, `runs`, `meanRecall`, `meanCriticalRecall`, and `meanPrecision` of the two named comparison rows. It refuses when `argus/claude/agents` or `argus/shared-skills` differ from the candidate revision, hashes both revisions' agent prompts and doctrine profiles from git with the gate's own encoding, and records the SHA-256 of the adjudication file. It refuses to write a regressed approval: each variant needs at least `nonRegression.minRepeats` runs, and every candidate mean must reach the baseline mean minus its tolerance (critical recall only when both sides have one). Without `--write` it prints the proposed `approvedCorpus`. Without a scored comparison, `--benchmark-pending <reason>` records a pending approval that the gate accepts, with a warning, only while the Argus plugin version equals its `releaseVersion`.

## Baseline and release checks

`node scripts/eval/discovery/smoke-corpus.mjs` runs the corpus probe matrix for three input seeds (all seeds enabled, none enabled, and each seed alone): every seed probe must be true exactly when its seed is enabled, and every control must hold. It asserts exactly 22 seeds with the per-surface counts above and at least 12 controls. It also checks the public endpoints and UI pages for private data and test IDs, contract determinism across restarts and builds, same-port restarts that replay derived IDs, the loopback-only bind, and that `corpus/` imports only `node:` builtins. Because probes run sequentially and the report and latency probes wait on real time, the suite takes about two and a half minutes. `node scripts/eval/discovery/smoke.mjs` tests adjudication handling of false positives, unseeded findings, missing verdicts, and reproduction metrics and the configuration rules, then runs 16 paired protocol runs (modes A and B, both builds, pinned seeds) with a stub adapter, plus stub cases for a forged `result.json` inside the artifact root, contamination, a timed-out budget, the sealed directory, launch assurance, and the token cap. `node scripts/eval/discovery/smoke-extract.mjs` covers evaluator-side extraction: valid, invalid, and missing ledgers, symbolic links, unledgered reports, framework detection, and oversize files. `node scripts/eval/discovery/smoke-judge.mjs` covers the judge with the stub CLI `scripts/fixtures/argus-eval/claude-judge`, which asserts the bare, tool-less flags: seed credit and probe confirmation, the corrected-run seed enum, duplicates, pass disagreement, retries and judge failures, evidence containment, untrusted-content framing, and that no packet carries the private-runs path or the canary. These are deterministic harness baselines, **not an Argus model benchmark**. The release gate runs `node scripts/eval/run-smokes.mjs`, which executes every `smoke*.mjs` under `scripts/eval`. No numerical improvement in Argus recall is claimed by 4.9.1; collect a complete adjudicated paired comparison before setting a model-quality release threshold.
