# Supply-chain notes — `npm audit` exceptions

Last reviewed: **2026-06-25** · Owner: **Grzegorz Holak** · Revisit by: **2026-09-25**

## Current state

`npm audit` reports **4 vulnerabilities (3 moderate, 1 high)**. All originate from
**dev-only** dependencies — there are **zero production dependencies** in this template
(`"dependencies": {}`), so:

```bash
npm audit --omit=dev   # → found 0 vulnerabilities
```

The framework is a **test harness**, not a shipped runtime. Nothing here is deployed to
a product; the advisories live in tooling that runs locally against a dev stack.

## Why not auto-fixed

| Package | Sev | Chain | Why no clean fix |
| --- | --- | --- | --- |
| `autocannon` (direct devDep, perf tool) | moderate | `autocannon → hyperid → uuid` | npm's only offered fix is a **breaking downgrade to `autocannon@2.0.1`** (from `^8`), which would regress the perf probe. No patched 8.x line ships the fixed `uuid`/`hyperid` yet. |
| `hyperid`, `uuid` | moderate | transitive of `autocannon` | Same root — resolves only when `autocannon` republishes. |
| `form-data` | high | dev/transitive | Not present in the installed prod tree (`npm ls form-data` → empty); dev-only. |

`autocannon` powers `src/perf/run-perf.mjs` (p50/p97.5/p99 latency characterisation).
Replacing it with a hand-rolled concurrent-request probe would trade a maintained,
accurate tool for custom percentile code — **more** risk than a dev-only advisory.

## Decision

**Accepted as a dev-only, time-boxed exception.** Rationale: zero production exposure
(`--omit=dev` = 0), no non-breaking forward fix, and the perf tool is intentionally not
swapped. Re-evaluate by the revisit date above or when `autocannon` publishes a release
that pulls a patched `hyperid`/`uuid`.

**Do NOT run `npm audit fix --force`** here — it downgrades `autocannon` and breaks the
perf probe. If a CI gate flags this, scope it to production deps: `npm audit --omit=dev`.
