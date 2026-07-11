# Release validation

The repository has one release gate for local development and CI:

```bash
scripts/validate-release.sh
```

It installs locked validation dependencies, validates both plugin manifests, rejects
representative marketplace drift, compiles every canonical Argus JSON Schema, runs the
contract suites, verifies generated-document synchronization and prompt regressions,
then clean-installs the previous Argus release and updates it to the current release.
The installed smoke exercises two specialist leases without depending on third-party
services. A release is not ready until this command passes.

For Argus role changes, regenerate both runtimes before the release gate:

```bash
scripts/sync-argus-role-variants.mjs --write
```

CI runs the same command in check mode and loads the generated files through both Claude
Code's strict plugin validator and Codex's native config loader.

For Hephaestus role changes, regenerate Codex from the flat Claude sources:

```bash
scripts/sync-hephaestus-codex-variants.mjs --write
```

The release gate validates exact model mapping, descriptions, source hashes, full runtime
role bodies, sandbox policy, README rows, and the HTML roster for all 49 agents. Argus also
enforces the exact 15-field provenance schema, source/config/instruction hashes, and strict
per-file and corpus byte budgets for its non-runtime Codex Markdown stubs.

## Reproducible version bump

Prepare a semver release with the repository helper:

```bash
node scripts/release-plugin.mjs --plugin argus --bump minor --write
```

Use `patch`, `minor`, or `major` according to `AGENTS.md`. The helper changes the plugin
manifest, its marketplace entry, and the marketplace's top-level release version as one
operation. Verify the synchronized result with:

```bash
node scripts/release-plugin.mjs --plugin argus --check
claude plugin tag --dry-run argus/claude
```

## Prompt regression approval

`argus/prompt-budgets.json` records the approved total and per-agent prompt corpus. Any
agent increase fails validation even when the broad maximum remains satisfied. A deliberate
increase requires a reviewed `regressionApproval` object containing the exact current corpus
SHA-256, issue number, approver, reason, and exact per-agent increases. After approval lands,
replace `approvedCorpus` with the reviewed corpus and remove the one-release approval.
