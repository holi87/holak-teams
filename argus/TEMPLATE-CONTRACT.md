# Argus Capability-Based Template Contract

This is the human view of `template-contract.json`. The JSON contract is authoritative;
the installed copy is `${CLAUDE_PLUGIN_ROOT}/capabilities/template-contract.json`.

## Detect, select, then scaffold

Run `argus-assets template detect --target <repo>` before any framework write. Detection
records languages, frameworks, test runners, package managers, existing source/test roots,
CI systems, confidence-bearing signals, and unsupported capabilities. It never invents a
`src/`, `tests/`, package-manager, or runner convention.

Selection requires an explicit operator choice:

```bash
argus-assets template select --target <repo> --runtime <typescript|java|python> \
  --package-manager <npm|maven|pip> --test-root <path> --harness-root <path> \
  --output <repo>/ai_agents_internal/template-selection.json
```

Detected existing suites produce `action: adapt`; the target's framework, paths, package
manager, and CI entry point win, and `template scaffold` refuses to create a competing
harness. A greenfield target produces `action: build` only after runtime, package manager,
test root, and harness root are explicit and compatible. Scaffold consumes that selection,
copies into a new empty destination, and records the selection inside the generated framework.
Every shipped runner fails with policy exit 13 when that explicit selection record is
missing or names an incompatible runtime/package manager; low-level template copies are
not runnable engagement frameworks.

The installed template is a manifest-declared composition: one canonical common layer
(`templates/common`) plus exactly one runtime layer. Runtime layers never duplicate a
common file. `template scaffold` is the supported engagement interface and validates both
layer hashes before writing; it rejects symlinks, unsafe or case-colliding paths,
file/file and file/ancestor collisions, and non-empty destinations. The copy preserves
file and directory modes and creates each file exclusively. Maintainers edit
`framework-template-common/` for shared files, then run
`scripts/sync-argus-runtime-assets.mjs --write`; direct edits to generated common copies
inside the three complete source templates are drift.

## Shared minimum contract

All three templates implement the same four modes, `argus/runner-result@1`, seven-field
outcome events, category-specific exit codes, `reports/evidence/`, lane/regression/
quarantine/contract-smoke tags, no automatic retries, and an expiring quarantine ledger.
Framework-native selectors differ, but semantics do not. The native `regression` marker
is the only defect-test selection signal. A separate `@bug:<canonical-or-origin>` token
records provenance and lets the coverage gate join the test to
`solution/bug-ledger.json`; it never selects a runner mode. Every defect regression must
carry both markers.

`solution/quarantine.tsv` has five tab-separated fields with no header:
`case_id`, `owner`, safe reason token, ISO `expires_on`, and issue token. A quarantined
test is excluded only while a matching non-expired record exists; every valid entry emits
an approved skip. Missing, malformed, unowned, or expired entries are policy failures.

## Supported and unsupported capabilities

The shipped build adapters are intentionally finite: Playwright/TypeScript with npm,
JUnit 5 with Maven, and pytest with pip/venv. Detection still recognizes pnpm, Yarn, Bun,
Gradle, uv, Poetry, Jest, Vitest, TestNG, unittest, and other languages. Those are reported
as explicit adaptation requirements, never silently converted to a supported tool. Add a
template-specific adapter at the named extension point; do not duplicate shared doctrine.
