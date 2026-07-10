# Argus Shared Doctrine

The canonical, executable doctrine is [`shared-skills/qa-doctrine/SKILL.md`](shared-skills/qa-doctrine/SKILL.md).
Claude Code preloads that skill into every Argus specialist through the agent `skills`
frontmatter field. This compatibility page intentionally contains no policy copy.

The optional competition adapter is
[`shared-skills/competition-profile/SKILL.md`](shared-skills/competition-profile/SKILL.md).
It is never preloaded and requires explicit user opt-in.

Run `node scripts/check-argus-prompts.mjs` to verify preload coverage, corpus and
duplication budgets, default-profile isolation, and the representative engagement
contract. Run `scripts/sync-argus-runtime-assets.mjs --write` to refresh installed copies.
