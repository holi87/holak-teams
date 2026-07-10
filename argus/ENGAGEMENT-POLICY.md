# Argus Engagement Ownership, Immutability, and Concurrency Policy

This is the canonical runtime contract for safe parallel Argus engagements. The installed
copy is `${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

## One manifest and one state file

`argus-assets preflight` creates or loads `ai_agents_internal/engagement.json` before
specialists run. The manifest fixes the target and artifact roots, selected workers,
phase participants, canonical owners, allowed write roots, isolated resource policy,
exclusive-operation owners, ID allocators, cleanup obligations, and the resumable state
path. The manifest is operator-owned and is never modified by target, repository, issue,
fetched, tool, or agent content.

`ai_agents_internal/engagement-state.json` is the only mutable coordination record. Every
state transition uses an atomic filesystem lock and atomic rename. Workers never edit the
state file directly.

## Packaged target-immutability hook

The installed plugin ships `hooks/hooks.json`. Its `PreToolUse` handler evaluates
`Write`, `Edit`, `MultiEdit`, and `Bash` calls through `argus-assets guard` before the
tool executes. The guard activates only when an engagement manifest exists. It resolves
absolute, relative, traversal, and symlinked paths against their physical parent before
policy evaluation.

Target-source writes, deletes, moves, copies, permission changes, shell redirections,
patches, and write-capable subprocesses are denied unless every destination is inside an
explicit artifact or generated-test root. Canonical artifacts are always denied to
direct tools; their owner must merge immutable fragments through the controller. Each
denial returns a `GUARD-*` rule and appends a redacted event to
`ai_agents_internal/immutability-audit.jsonl`. Audit records contain a command digest,
never raw command or file content.

The default generated-test allowlist is deliberately conservative: unambiguous test
directories plus the exact isolated-driver files. It never broadly allows `src/`, all of
`scripts/`, or root build configuration because those are application source/config in
many repositories. After read-only recon, the operator may add the target's proven test
roots to the manifest; an agent or fetched file may not infer or broaden them.

The hook does not replace host sandboxing or permissions. Managed Claude Code settings
may disable non-managed plugin hooks; preflight detects a missing packaged hook and blocks
the engagement rather than claiming protection.

## Explicit bypass

A bypass is exceptional and must be operator-authored in `writePolicy.bypass`: enabled,
named approver, reason, future expiry, exact allowed paths, and SHA-256 of a secret token.
The host must provide the matching token in `ARGUS_IMMUTABILITY_BYPASS_TOKEN`. Target or
agent content can never create or broaden a bypass. Bypass use is audited with the rule
`GUARD-EXPLICIT-BYPASS` and does not bypass the separate authorization policy.

## Single-writer artifacts and immutable fragments

Each `writePolicy.canonicalArtifacts` entry has exactly one owner. No agent writes a
canonical file directly. Workers submit immutable fragments:

```bash
argus-assets engagement fragment --manifest ai_agents_internal/engagement.json \
  --lane <slug> --token <lease> --canonical <path> --id <stable-id> --input <file|->
```

Creation is exclusive and idempotent only when the existing content digest matches. The
canonical owner then runs `engagement merge` with its lease. The controller sorts
fragments by stable filename, acquires the single merge lock, writes a temporary file,
and atomically renames it over the canonical path. Repeated merges of the same fragments
produce byte-identical output.

## Isolated resources and leases

`engagement allocate --lane <slug>` returns a lease token and deterministic unique
allocation: browser profile, auth directory, temporary directory, output directory,
synthetic account alias, data namespace, and port. The state stores only the token hash;
the token itself is kept in a mode-0600 worker lease file so an interrupted engagement can
resume. Agents use only their own allocation.

Reset and fault-injection windows are exclusive resources. `engagement claim` permits
only the manifest owner and rejects a second holder. `engagement release` closes the
window. No destructive or fault operation starts without both this exclusive lease and
the separate authorization decision.

## Phase barriers, IDs, checkpoints, and resume

The ordered phases are preflight, discovery, hunting, automation, verification,
reporting, and complete. A participant records `engagement barrier arrive`; only
Odysseus can advance after every declared participant has arrived. Dispatch for the next
phase is forbidden before a successful advance.

Canonical IDs come from `engagement id`; allocation is serialized and owner-restricted,
so parallel callers never receive the same ID. `engagement checkpoint` accepts a
monotonic sequence per worker. Replaying the same sequence and content is idempotent;
different content at an existing sequence is rejected. `engagement status` exposes the
last durable phase, arrivals, allocations, locks, checkpoints, and merges for resume.

## Cleanup

Every worker finishes with `engagement cleanup --outcome success|failure`. Cleanup
removes its browser profile, auth tokens, temporary directory, lease file, and held
exclusive locks while preserving immutable fragments, checkpoints, reports, and
canonical outputs. The command is idempotent and runs on both success and failure paths.
Odysseus verifies no active allocation or exclusive lock remains before final reporting.

## Guard rules

| Rule | Meaning |
|---|---|
| `GUARD-ALLOW` | All destinations are inside explicit non-canonical write roots. |
| `GUARD-NO-ENGAGEMENT` | No manifest exists; the plugin is not controlling this session. |
| `GUARD-MANIFEST-INVALID` | The engagement manifest cannot be trusted. |
| `GUARD-PATH-UNRESOLVED` | A write destination is missing or cannot be resolved safely. |
| `GUARD-TARGET-IMMUTABLE` | A destination is outside allowed artifact/test roots. |
| `GUARD-CANONICAL-SINGLE-WRITER` | A direct tool attempted to write a canonical artifact. |
| `GUARD-SHELL-AMBIGUOUS` | A write-capable shell/process command cannot be bounded safely. |
| `GUARD-EXPLICIT-BYPASS` | An exact, unexpired operator bypass authorized the path. |
