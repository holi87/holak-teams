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

The evaluator retains private truth in its own process and writes it only to the separate, private output directory. Hunters receive only a URL, public contract, artifact directory, and equal budgets. Do not give hunters the repository, evaluator sources, private result directory, answer keys, or verdicts. Host adapters **must launch the normal Argus isolated runtime** and keep those locations outside its readable boundary; a temporary working directory alone is not an OS sandbox. Keep the host's runtime/operator signers isolated as in normal engagements. The adapter must enforce the token budget, report measured tokens/cost, and preserve reports and redacted probe evidence. The evaluator independently enforces elapsed time and rejects missing, failed, or over-budget results. Never run an untrusted adapter.

## Paired, repeated comparison

Write a host-local configuration with two immutable revisions and executable argument arrays:

```json
{
  "variants": [
    {"name":"baseline","revision":"<full-baseline-commit>","command":["/secure/argus-eval-baseline-adapter"]},
    {"name":"candidate","revision":"<full-candidate-commit>","command":["/secure/argus-eval-candidate-adapter"]}
  ],
  "repeats": 3,
  "seconds": 600,
  "tokens": 50000
}
```

The host adapter receives the absolute public request JSON path as its final argument. It starts the chosen revision with the normal authenticated launcher, using the target, mode B, and artifact root from that request. Do not bypass launcher authorization to make an evaluation pass. Write `result.json` at the requested path:

```json
{"findings":[{"id":"ATA-001","report":"bugs/ATA-001.md"}],"tokens":1234,"cost":0.05}
```

Tokens and cost are measured provider usage, not estimates or invented zeros. Adapters are revision-specific; review their checkout binding and isolation before running them. Both variants use the same faulty or corrected build, repeat seed, scope, and budget per repeat; execution order alternates.

```bash
node scripts/eval/discovery/run.mjs /secure/comparison.json /secure/new-comparison-output
```

All runs initially remain `UNSCORED`. Read each report, acceptance criterion, and evidence, then independently reproduce findings. Write a verdict array per run, in recorded run order:

```json
[[{"findingId":"ATA-001","outcome":"real","seedId":"quantity-boundary","reason":"The above-maximum quantity was persisted","evidenceRef":"reports/independent-repro.txt","independentlyReproduced":true,"confirmedAtMs":12000}]]
```

Use `real`, `false-positive`, or `duplicate`. Legitimate unseeded findings use `real` without `seedId`; never penalize them merely for being absent from the private key. Confirmation time is elapsed milliseconds from run start, established by recorded evidence. Verdict evidence must exist inside the run's artifact boundary. The one-row example illustrates the format, not a complete comparison.

```bash
node scripts/eval/discovery/adjudicate.mjs /secure/new-comparison-output/private-runs.json /secure/verdicts.json
```

The result includes per-run recall, critical recall, precision, independent reproduction, first-confirmation time, measured tokens/cost, and cost per real finding, plus per-revision repeated-run means. Missing verdicts or invalid runs block the comparative score. Do not interpret a zero-finding corrected run as perfect precision (precision is undefined there); inspect reported counts and false positives too. Archive raw per-run results alongside means so instability stays visible.

## Approving a prompt corpus with benchmark evidence

A scored comparison is the evidence that lets a changed Argus prompt corpus pass `node scripts/check-argus-prompts.mjs` without a pending approval. Save the adjudication output, check out the candidate revision, and re-stamp `argus/prompt-budgets.json`:

```bash
node scripts/eval/discovery/adjudicate.mjs /secure/new-comparison-output/private-runs.json /secure/verdicts.json >/secure/adjudication.json
node scripts/approve-argus-prompts.mjs --approved-for "<release and reason>" \
  --benchmark /secure/adjudication.json --baseline-variant baseline --candidate-variant candidate --write
```

The tool accepts only a `scored` adjudication and reads the `revision`, `runs`, `meanRecall`, `meanCriticalRecall`, and `meanPrecision` of the two named comparison rows. It refuses when `argus/claude/agents` or `argus/shared-skills` differ from the candidate revision, hashes both revisions' agent prompts and doctrine profiles from git with the gate's own encoding, and records the SHA-256 of the adjudication file. It refuses to write a regressed approval: each variant needs at least `nonRegression.minRepeats` runs, and every candidate mean must reach the baseline mean minus its tolerance (critical recall only when both sides have one). Without `--write` it prints the proposed `approvedCorpus`. Without a scored comparison, `--benchmark-pending <reason>` records a pending approval that the gate accepts, with a warning, only while the Argus plugin version equals its `releaseVersion`.

## Baseline and release checks

`node scripts/eval/discovery/smoke-corpus.mjs` runs the corpus probe matrix for three input seeds (all seeds enabled, none enabled, and each seed alone): every seed probe must be true exactly when its seed is enabled, and every control must hold. It asserts exactly 22 seeds with the per-surface counts above and at least 12 controls. It also checks the public endpoints and UI pages for private data and test IDs, contract determinism across restarts and builds, same-port restarts that replay derived IDs, the loopback-only bind, and that `corpus/` imports only `node:` builtins. Because probes run sequentially and the report and latency probes wait on real time, the suite takes about two and a half minutes. `node scripts/eval/discovery/smoke.mjs` tests adjudication handling of false positives, unseeded findings, missing verdicts, and reproduction metrics, then runs 8 paired protocol runs with a stub adapter. These are deterministic harness baselines, **not an Argus model benchmark**. The release gate runs `node scripts/eval/run-smokes.mjs`, which executes every `smoke*.mjs` under `scripts/eval`. No numerical improvement in Argus recall is claimed by 4.9.1; collect a complete adjudicated paired comparison before setting a model-quality release threshold.
