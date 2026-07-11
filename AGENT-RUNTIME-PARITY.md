# Claude and Codex generated-configuration parity

This report records the full-roster audit completed on 2026-07-11. The authoritative
regression command is:

```bash
scripts/smoke-agent-runtime-parity.sh
```

## Scope and result

The audit compared every Claude role definition with its generated Codex TOML and
readable Markdown variant:

| Team | Claude roles | Codex TOML | Codex Markdown | Result |
|---|---:|---:|---:|---|
| Hephaestus | 22 | 22 | 22 | aligned |
| Argus | 27 | 27 | 27 | aligned |
| Total | 49 | 49 | 49 | aligned |

For each role, configuration validation covers the slug, description, complete role instructions,
canonical-source path and SHA-256, sandbox mode, artifact-language contract, model, and
reasoning effort. Argus additionally validates generated inputs, outputs, ownership,
safety doctrine, and runtime-adapter differences against its canonical contracts.

Configuration parity is not behavioral parity. Claude Argus is `plugin-native`: its
main-thread entry point, packaged assets, skills, hooks, and specialist dispatch are
installed together. Codex Argus is `parent-runtime-dependent`: its TOML can load and its
role contract can align while orchestration, packaged assets, and equivalent tools still
must be supplied by the parent session. A missing requirement returns `CAPABILITY_GAP`.

## Model mapping

| Claude tier | Claude roles | Codex model | Codex roles | Reasoning effort |
|---|---:|---|---:|---|
| `opus` | 17 | `sol` | 17 | `xhigh` |
| `sonnet` | 29 | `terra` | 29 | `medium` |
| `haiku` | 3 | `luna` | 3 | `medium` |

No Codex role uses an Anthropic model identifier. No Claude/Codex model or effort mismatch
was found. The generator now makes the mapping executable rather than documentation-only.

## Findings and remediation

The role bodies and model assignments were already semantically aligned at audit start.
The material drift was in Hephaestus maintenance metadata: 21 Codex companions referenced
removed pre-flattening paths such as `claude/dev/`, `claude/QA/`, `claude/ba/`, or
`claude/management/`. Hephaestus also lacked a deterministic generation gate, so future
Claude edits could silently leave Codex stale.

Remediation:

- `scripts/sync-hephaestus-codex-variants.mjs --write` now generates all 22 Codex pairs
  from the flat Claude sources and records valid source paths plus SHA-256 values.
- `scripts/sync-argus-role-variants.mjs --check` continues to enforce all 27 Argus pairs.
- `scripts/verify-agent-runtime-parity.mjs` verifies the complete 49-role generated
  configuration inventory,
  exact model mapping, role-body parity, source provenance, sandbox policy, README model
  rows, HTML roster, and machine-readable runtime support levels.
- The release gate loads both Claude plugins with `claude plugin validate --strict` and
  all 49 TOML files with an isolated native `codex doctor` config load.

The native checks prove that the plugin manifests and TOML configuration parse and load
without warnings. They do not execute representative engagements and therefore do not
prove tool availability, delegation, packaged-asset access, or equivalent target outcomes.

Runtime API names remain intentionally different. Claude tool frontmatter is provenance
for Codex; Codex uses equivalent tools actually supplied by its runtime and reports a
capability gap instead of claiming unavailable functionality. The generated contracts
preserve the intended mission, ownership, deliverables, quality gates, and safety rules;
behavioral support remains conditional on the declared parent-runtime capabilities.
