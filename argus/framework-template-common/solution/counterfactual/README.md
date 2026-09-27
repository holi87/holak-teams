# solution/counterfactual

One fixture per confirmed bug, `BUG-NNNN.json` (`argus/counterfactual-fixture@1`,
TEMPLATE-CONTRACT.md SD-10). It proves, without contacting the target, that the bug's
regression is GREEN against the correct response (`cf-correct`) and RED against every
tamper (`cf-tamper-<k>`). Files named `*.example.json` are ignored; copy
`BUG-0000.example.json` to start. The inventory pass lists every expected bug in
`reports/counterfactual-plan.tsv` as `fixture`, `exempt`, `missing`, or `invalid`, and the
evidence gate fails a missing, invalid, or incomplete one.

- `bugId` equals the file name. Take the correct subject response from the cited oracle
  (`oracle.sourceRef`), never from observed target behaviour. With `contract`, it must have
  exactly `contract.status` and pass the strict schema oracle for `contract.operationId`;
  otherwise the plan reason is `correct-violates-contract`.
- `tampers` must include `observed-defect`: the defect as observed, minimized to what the
  regression asserts. Add one tamper per other way the defect can surface. A tamper
  replaces the subject response entirely; ids use `[a-z0-9-]` and `correct` is reserved.
- Redact before commit: run each observed response through
  `argus-assets redact --input <file> --output <safe-file>` and keep no tokens, personal
  data, or real hosts.
- Declare every request the regression makes, login included. Matching is exact on method
  and path (as the client sends it) plus the listed query parameters. An undeclared request
  gets `501 {"argusStub": "unmatched"}` and fails as `counterfactual-unmatched-request`.
- The harness API URL points at the stub in every lane (TypeScript non-ui lanes also get it
  as Playwright's `baseURL`), and ui-lane tests route browser requests matching
  `ARGUS_API_ROUTE_PATTERN` (default `<API_URL>/**`) to it.
- A regression reaches the API only through that URL, read at call time. In TypeScript a
  per-test `baseURL` override fails before its first request, and a test whose subject
  exchange the stub never served (a URL captured at module load, a hand-built client) fails
  as `counterfactual-subject-not-served`: its verdict came from somewhere else.
- Exemptions are a closed set: `front-end-logic`, `timing-or-load`, `data-layer`,
  `fault-injection`, `non-http-protocol`, with a 1-500 character justification:

```json
{ "$schema": "argus/counterfactual-fixture@1", "schemaVersion": 1, "bugId": "BUG-0007",
  "exemption": { "reason": "timing-or-load", "justification": "Reproduces only under concurrent load; see PERF-REPORT.md." } }
```

In a `cf-*` pass a test without a variant (no single bound bug, a missing or invalid
fixture, fewer tampers than the pass index, or an exemption) skips with a sentinel and
records nothing; an exempt bug records `counterfactual-exempt.<reason>` in `cf-correct`.
