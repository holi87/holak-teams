# Claude and Codex generated-configuration parity

This document describes the Argus 5.0.1 generated-configuration contract. Current
validation evidence comes from the release gate, not from the model allocation
alone. The authoritative regression command is:

```bash
scripts/smoke-agent-runtime-parity.sh
```

## Scope

The gate compares every Claude role definition with its generated Codex TOML and
Markdown companion. Hephaestus companions remain readable role copies; Argus
companions are compact non-runtime provenance stubs. Expected inventory:

| Team | Claude roles | Codex TOML | Codex Markdown |
|---|---:|---:|---:|
| Hephaestus | 22 | 22 | 22 |
| Argus | 27 | 27 | 27 |
| Total | 49 | 49 | 49 |

For each role, configuration validation covers the slug, description, complete TOML role
instructions, canonical-source path and SHA-256, sandbox mode, artifact-language contract,
model, and reasoning effort. Argus additionally validates the provenance stub's exact 15
fields, TOML and instruction SHA-256 values, assigned doctrine profiles and technique
catalogs, and strict size budgets. Runtime instructions remain solely in TOML.

Configuration parity is not behavioral parity. Claude Argus is `plugin-native`: its
main-thread entry point, packaged assets, skills, hooks, and specialist dispatch are
installed together. Codex Argus is `parent-runtime-dependent`: its TOML can load and its
role contract can align while orchestration, packaged assets, and equivalent tools still
must be supplied by the parent session. A missing requirement returns `CAPABILITY_GAP`.

## Model mapping

| Team | Claude model / effort | Roles | Codex model / effort |
|---|---|---:|---|
| Argus | `claude-opus-5-5` / `max` | 4 | `gpt-6-sol` / `xhigh` |
| Argus | `claude-opus-5-5` / `high` | 7 | `gpt-6-sol` / `high` |
| Argus | `claude-sonnet-5-5` / `high` | 9 | `gpt-6-sol` / `high` |
| Argus | `claude-sonnet-5-5` / `medium` | 7 | `gpt-6-sol` / `medium` |
| Hephaestus | `opus` / inherited | 7 | `sol` / `xhigh` |
| Hephaestus | `sonnet` / inherited | 12 | `terra` / `medium` |
| Hephaestus | `haiku` / inherited | 3 | `luna` / `medium` |

Argus has 11 frontier and 16 standard roles. Its execution profiles select models
and effort independently of quality responsibilities; Hephaestus retains its
existing mapping. `gpt-6-astra` / `high` is an Argus escalation profile, not a 28th
role. No full Argus role uses Haiku/Luna, and no Codex role uses an Anthropic ID.

## Generated checks and validation limits

- `scripts/sync-hephaestus-codex-variants.mjs --write` now generates all 22 Codex pairs
  from the flat Claude sources and records valid source paths plus SHA-256 values.
- `scripts/sync-argus-role-variants.mjs --check` continues to enforce all 27 Argus pairs.
- `scripts/verify-agent-runtime-parity.mjs` verifies the complete 49-role generated
  configuration inventory,
  exact model mapping, runtime role-body parity, source provenance, Argus TOML/provenance
  hashes and byte budgets, sandbox policy, README model rows, HTML roster, and
  machine-readable runtime support levels.
- The release gate loads both Claude plugins with `claude plugin validate --strict` and
  all 49 TOML files with an isolated native `codex doctor` config load.

Passing native checks establishes that the plugin manifests and TOML configuration
parse and load. It does not establish effective live model selection, delegation,
packaged-asset access, or equivalent target outcomes. Argus Codex dispatch remains
`CAPABILITY_DRIFT` without a verified native hard turn cap. Claude model-only
Sonnet/high to Opus/high escalation must preserve generated effort and the turn cap
with signed launcher proof of pinned aliases. Effort-changing routes
remain blocked. Configuring Astra does not unlock either missing capability.

The 5.0.1 allocation has no completed comparative quality/cost evaluation. Historical
synthetic marker checks are not evidence of discovery-quality equivalence; the
discovery baseline remains pending.

Runtime API names remain intentionally different. Claude tool frontmatter is provenance
for Codex; Codex uses equivalent tools actually supplied by its runtime and reports a
capability gap instead of claiming unavailable functionality. The generated contracts
preserve the intended mission, ownership, deliverables, quality gates, and safety rules;
behavioral support remains conditional on the declared parent-runtime capabilities.
