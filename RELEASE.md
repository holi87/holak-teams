# Release validation

The repository has one local and CI release gate:

```bash
scripts/validate-release.sh
```

It installs lockfile dependencies, validates all plugin manifests and JSON Schemas, runs model, authorization, engagement, orchestration, runner, template, prompt, and generated-file regression suites, verifies package budgets, then installs the previous marketplace revision and updates it to the current release. A release is not ready until the complete gate passes.

## Argus 3.0 breaking boundary

Argus 3 retires compatibility code whose migration window ended in Argus 2:

- `lane-plan`, `evidence-reference`, and `automation-status` accept only their current collection form at `@2`;
- preflight accepts only `schemaVersion: 2`;
- engagement state accepts only `schemaVersion: 2` and contains no migration surface;
- the `qa-doctrine` monolith and `SHARED-DOCTRINE.md` pointer are removed;
- active pre-v3 engagements must finish or be cleaned with their original runtime before upgrade.

Stable contracts that are still current at `@1` do not change merely because old readers were removed.

The marketplace lifecycle smoke installs the immediately previous release, updates to the current major, proves that the retired reader files are absent, verifies the installed native launcher and 27-agent roster, and completes a clean current two-lane engagement. It deliberately does not resume old state.

## Native execution contract

`argus-launch` is the only supported Claude entry point. It binds Odysseus to the reviewed `opus` / maximum-effort controller baseline, Claude's native 96-turn cap, no session persistence, cleared inherited Argus bearer variables, and an OS filesystem sandbox. Direct `/argus:run` preflight fails.

Codex model and effort mapping remains generated and validated, but Codex dispatch is fail-closed because the installed CLI has no native hard turn cap. Signed route-attestation metadata was removed because a claim cannot create missing enforcement.

The host trust bundle now pins the secure absolute trust-store path. Every request, route, allocation, retry, and telemetry operation reopens that store and blocks immediately when a pinned public key is revoked, missing, or replaced.

## Reproducible Argus release

Regenerate canonical outputs before the gate:

```bash
scripts/sync-argus-role-variants.mjs --write
scripts/sync-argus-runtime-assets.mjs --write
node scripts/sync-argus-raci.mjs --write
node scripts/sync-argus-model-policy.mjs --write
node scripts/sync-argus-technique-bundle.mjs --write
```

Bump all release declarations atomically:

```bash
node scripts/release-plugin.mjs --plugin argus --bump major --write
node scripts/release-plugin.mjs --plugin argus --check
```

The helper updates the Argus plugin version, its marketplace entry, and the top-level marketplace version together.

For Hephaestus agent changes, regenerate Codex variants from the flat Claude sources:

```bash
scripts/sync-hephaestus-codex-variants.mjs --write
```

## Prompt regression approval

`argus/prompt-budgets.json` records approved corpus and per-agent budgets. Changes that intentionally alter a prompt require regeneration, semantic duplicate review, and the full release gate. Budget increases without a reviewed contract change should be rejected.

## Release checklist

1. Regenerate changed canonical outputs.
2. Run `scripts/validate-release.sh`.
3. Confirm `git diff --check` and review generated changes.
4. Bump the correct semver level.
5. Commit on a dedicated branch, push, and open a pull request.
6. Confirm every required GitHub check passes before merge.
