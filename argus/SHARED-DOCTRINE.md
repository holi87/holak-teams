# Argus Shared Doctrine Compatibility Pointer

The former monolithic doctrine is retained only as a maintainer comparison source. It is
not packaged or loaded at runtime. Executable policy is split into the capability-scoped
[`qa-core`](shared-skills/qa-core/SKILL.md),
[`qa-browser`](shared-skills/qa-browser/SKILL.md),
[`qa-framework-runner`](shared-skills/qa-framework-runner/SKILL.md),
[`qa-coverage-reporting`](shared-skills/qa-coverage-reporting/SKILL.md), and
[`orchestration-core`](shared-skills/orchestration-core/SKILL.md) skills. The capability
matrix selects the exact set for each role; Claude preloads it and Codex generation embeds
the same selected bodies.

The optional competition adapter is
[`shared-skills/competition-profile/SKILL.md`](shared-skills/competition-profile/SKILL.md).
It is never preloaded and requires explicit user opt-in.

Run `node scripts/check-argus-prompts.mjs` to verify profile coverage, corpus and
duplication budgets, default-profile isolation, and the representative engagement
contract. Run `scripts/sync-argus-runtime-assets.mjs --write` to refresh installed copies.
