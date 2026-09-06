# Defect-discovery evaluation

This evaluator measures application defect discovery separately from the existing model marker-compliance smoke checks. It is maintainer-only and is not packaged into Argus.

## Application corpus and isolation

Three loopback-only applications exercise quantity boundaries, persisted order counts, bounded concurrent capacity claims, cross-owner authorization, and terminal workflow transitions. Each has a faulty and corrected variant. Correct-lookalike controls include intentional duplicate creates without idempotency guarantees, server-side validation returning 422, and documented case-preserving email behavior. Repeats vary published limits and opaque object IDs; use the optional private `corpusModule` configuration field for genuinely held-out families before drawing broad generalization claims. That evaluator-only ES module exports `families` and `startApplication({family, faulty, seed})`, returning `{url, truth, close}` with the same loopback contract as the built-in corpus; it is never passed to the adapter.

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

Tokens and cost are measured provider usage, not estimates or invented zeros. Adapters are revision-specific; review their checkout binding and isolation before running them. Both variants use the same family, faulty/corrected case, randomized limit, scope, and budget per repeat; execution order alternates.

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

## Baseline and release checks

`node scripts/eval/discovery/smoke.mjs` runs 12 live HTTP fixture executions across two input seeds, including faulty and corrected variants, then tests adjudication handling of false positives, unseeded findings, missing verdicts, and reproduction metrics. This is a deterministic harness baseline, **not an Argus model benchmark**. It runs in the release gate. No numerical improvement in Argus recall is claimed by 4.9.1; collect a complete adjudicated paired comparison before setting a model-quality release threshold.
