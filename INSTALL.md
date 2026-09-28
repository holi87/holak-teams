# Install holak-teams

This repository publishes two Claude Code plugins and also carries generated Codex custom-agent configurations:

- `hephaestus`: 22 software-delivery agents, entry point `marcus`;
- `argus`: 27 QA agents, supported entry point `argus-launch`.

## Claude Code marketplace

Add the marketplace and install both plugins:

```text
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

Update later with:

```text
/plugin marketplace update holak-teams
```

When the repository folder is trusted, `.claude/settings.json` registers the marketplace and enables both plugins automatically.

### Start Hephaestus

Use `marcus` in a normal Claude Code session:

```text
marcus, deliver the requested increment with tests and CI.
```

### Start Argus

Argus 5 requires its packaged authenticated launcher. A direct `/argus:run` session fails
preflight because it lacks the signed launch authorization, verified receipt, and inherited
one-shot OS capability. Every flag is listed by `argus-launch --help`.

#### Check the host

```bash
# Newest installed Argus version in the plugin cache
PLUGIN_ROOT="$(ls -d "$HOME"/.claude/plugins/cache/holak-teams/argus/* | sort -V | tail -n 1)"

"$PLUGIN_ROOT/bin/argus-launch" doctor --browser
```

`doctor` checks the reviewed Claude 2.x turn-cap contract, confirms that Claude reports a
login inside the launch's isolated config (see "Claude credentials"), and runs the OS
sandbox behavior probes. `--browser` then runs `argus-launch probe-browser`, which needs no
Claude CLI: it resolves a host Playwright package (`--module <absolute-dir>`, else `npm root -g`, then the
Homebrew and system global `node_modules`), starts its headless Chromium inside the launch
sandbox, and takes one screenshot. `probe-browser` exits 0 (PASS), 2 (FAIL), or 3 (SKIP: no
Playwright module). Under `doctor --browser`, a SKIP only warns and a FAIL fails doctor.

#### Claude credentials

The launch runs Claude with a fresh `CLAUDE_CONFIG_DIR` inside the artifact root, so a
keychain or claude.ai subscription login does not carry over. Export one credential variable
before `doctor` and every launch:

```bash
export ANTHROPIC_API_KEY='<api-key>'
# or, for a subscription: create a long-lived token once, then export it
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN='<token>'
```

A gateway can use `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`. The launcher passes each
variable through only when it is set and never copies a credential file. `doctor` and every
launch, dry runs included, first run `claude auth status` in the launch's isolated
environment and stop when it reports no login. Processes inside the sandbox run as your user
and can read the session environment, including this variable.

#### Launch

```bash
TARGET="$(cd /path/to/target && pwd -P)"
ARTIFACT_ROOT="$(cd /path/to/artifacts && pwd -P)"
OPERATOR_ROOT="$(cd /secure/operator && pwd -P)"
TRUST_STORE="$(cd /secure/trust && pwd -P)/model-trust.json"

"$PLUGIN_ROOT/bin/argus-launch" claude \
  --target "$TARGET" \
  --artifact-root "$ARTIFACT_ROOT" \
  --mode A \
  --engagement-id qa-001 \
  --trust-store "$TRUST_STORE" \
  --runtime-key-id runtime-2026 \
  --operator-key-id operator-2026 \
  --request-output "$OPERATOR_ROOT/qa-001.request.json" \
  --launch-authorization "$OPERATOR_ROOT/qa-001.authorization.json"
```

`--runtime-key-id` and `--operator-key-id` name the trust store's `runtime-attestation` and
`operator-approval` keys (see "Model trust and revocation"). The request signs both, and the
launch preflight pins both anchors when it creates the engagement.

The launcher writes the immutable request and waits up to five minutes (`--wait-seconds
<30..300>`). In the isolated runtime-attestation signer, review every request field, sign
the exact payload, and write the authorization atomically. The signer may hold the private
key; the launcher, controller, workers, and their sandbox must not. A signer built for
Argus 4 must be updated first: 5.0 authorizations and receipts require `maxTurns: 400` and
`sandboxPolicy: os-native-target-readonly@3`, and a 5.0 request carries the signed
`operatorKeyId` field, which a strict signer must accept.

```bash
"$PLUGIN_ROOT/bin/argus-assets" model payload \
  --document "$OPERATOR_ROOT/qa-001.request.json" >payload.txt
openssl pkeyutl -sign -rawin -inkey runtime-private.pem \
  -in payload.txt -out signature.bin
SIGNATURE="$(openssl base64 -A -in signature.bin)"
jq --arg signature "$SIGNATURE" \
  '.authentication.signatureBase64 = $signature' \
  "$OPERATOR_ROOT/qa-001.request.json" \
  >"$OPERATOR_ROOT/qa-001.authorization.json.tmp"
chmod 600 "$OPERATOR_ROOT/qa-001.authorization.json.tmp"
mv "$OPERATOR_ROOT/qa-001.authorization.json.tmp" \
  "$OPERATOR_ROOT/qa-001.authorization.json"
rm -f payload.txt signature.bin
```

The launcher binds Odysseus to Claude `opus`, maximum effort, and the native 400-turn cap;
the controller reserves the last 30 turns for canonical merges and the final report.
It supports local paths and normalized HTTP(S) URLs, requires target and artifact roots to
be physically disjoint, disables session persistence, starts from an environment allowlist,
and uses `sandbox-exec` on macOS or Bubblewrap on Linux. Claude runs headless with
`--permission-mode dontAsk` and an explicit `--allowedTools` list of the tools the packaged
agents declare, so workers can write and run commands without a prompt. Permissions are never
bypassed: the packaged write guard and the sandbox still enforce every call. Only the
alias-free artifact root is writable; Claude config and temporary files stay inside it. If the reviewed Claude 2.x
turn-cap contract or OS sandbox is unavailable, launch stops.

The sandbox policy is `os-native-target-readonly@3`. It adds to @2 only the
`RootDomainUserClient` IOKit user client and the `org.chromium.*` mach names that headless
Chromium needs; file writes stay confined to the artifact root. Headless Chromium under
Linux Bubblewrap is unverified: treat browser lanes there as unavailable until
`argus-launch probe-browser` passes on that host.

Modes are:

- `A`: full QA team;
- `B`: black-box hunting;
- `C`: regression automation;
- `D`: targeted capability-selected run.

#### Optional launch flags

These flags work for attested and unattested launches alike. None is part of the signed
launch request, and none widens what the authorization evaluator allows. `--dry-run`
validates them and reports the choice without installing anything.

- `--provision-browser` prepares the host before the sandbox starts. It runs
  `argus-assets browser provision`, which reuses a host Playwright that already launches
  headless Chromium, or installs the pinned release into
  `~/.cache/argus/browser-runtime/<x.y.z>` (outside the artifact root, read-only to the
  sandbox) and Chromium into Playwright's host default cache. A provisioning failure stops
  the launch. Preflight still re-probes the runtime inside the sandbox and records the result
  in `ai_agents_internal/browser-runtime.json`; it never installs a runtime itself.
- `--authorization <absolute-path>` supplies your authorization manifest. It must be a
  physical regular file outside the target and artifact roots, satisfy the packaged
  authorization-manifest schema, carry this `--engagement-id`, and allow the preflight read
  of this `--target`. The launcher copies it to `ai_agents_internal/authorization.json`
  (mode 0600) and refuses when a different manifest is already there.
- `--environment <local|test|staging|production>` without `--authorization` installs the
  packaged default-deny manifest for that environment (`local` maps to `development`). With
  `--authorization`, the manifest's `target.environment` must match. Without either flag,
  preflight creates the default-deny manifest with environment `unknown`. Staging and
  production stay read-only without an explicit production override.
- `--feature <capability-id>` (repeatable) declares a target capability that the sandbox's
  cleared environment cannot reveal, for example `db-access`, `source-access`,
  `non-rest-surface`, or `multi-service`. Each id must be a key of the packaged
  `capabilities/capability-matrix.json`. Features only widen which lanes preflight marks
  available. `db-access` and `multi-service` can come only from this flag; recon never
  releases them.
- `--usage-json <absolute-path>` writes Claude's final JSON result (usage, cost, turn count,
  and a subtype such as `error_max_turns`) to a new file outside the artifact root. Its
  parent must be a physical directory owned by you and not group- or world-writable.

#### Preflight and lane dispositions

Preflight creates its control files below `ai_agents_internal/` before probing the target
and writes `ai_agents_internal/preflight.json` (report schemaVersion 3). Every role gets one
of `not-selected`, `ready`, `degraded`, `conditional`, `deferred`, `skipped`, or `blocked`:

- A blocked Odysseus, Kalchas, Metis, Minos, Kleio, Atlas (outside Mode B), or mandatory
  hunter of Mode A or B stops the engagement before target execution.
- Any other blocked lane becomes `deferred` with `downgradedFrom=blocked`. It is never
  dispatched, and `residualRisks` names what its absence leaves uncovered.
- A `conditional` lane waits only on target or browser gates listed in `pendingGates`. After
  Kalchas's recon writes `solution/discovery/capability-evidence.json`, the controller runs
  `argus-assets engagement resolve-gates` once. The runtime re-checks each gate itself and
  releases the lane or omits it with the unmet gate recorded.

The first allocation seals `preflight.json`; preflight is never rerun after that. Review
the authorization and engagement manifests before allowing target-affecting actions.

#### Upgrading from Argus 4

Argus 5 writes engagement manifest v2, engagement state v3, and preflight report v3, and
rejects older versions with no migration. A 4.x artifact root cannot be resumed: finish or
clean an active 4.x engagement with its original runtime, then start 5.0 in a fresh
artifact root.

#### Unattested launch

Hosts that cannot provision Ed25519 keys can opt in to an unattested launch. Replace the five
signer flags (`--trust-store`, `--runtime-key-id`, `--operator-key-id`, `--request-output`,
`--launch-authorization`) with `--unattested`; combining it with any of them is refused. It
skips only the cryptographic launch attestation; the OS sandbox still runs, and every report
names the engagement UNATTESTED.
The launcher refuses `--unattested` while `ARGUS_MODEL_TRUST_STORE` is set or
`~/.config/argus/model-trust.json` exists. See `argus/ENGAGEMENT-POLICY.md` for the
residual risk.

## Manual Claude plugin install

Marketplace installation is recommended. For a local development checkout, Claude Code can load either plugin root directly:

```bash
claude --plugin-dir /path/to/holak-teams/hephaestus/claude
```

Argus must still be started through `argus/claude/bin/argus-launch`; loading its plugin directory directly does not satisfy the execution contract.

Validate a checkout before use:

```bash
claude plugin validate --strict .
claude plugin validate --strict hephaestus/claude
claude plugin validate --strict argus/claude
scripts/validate-release.sh
```

## Model trust and revocation

Argus requires two distinct Ed25519 public anchors:

- `runtime-attestation`: runtime-control authorization;
- `operator-approval`: human frontier continuation or abort.

Private keys and generic signing services must remain outside the controller and workers. Store only public keys in a real, single-link, current-user-owned file whose directory and file are not group/world writable:

```bash
TRUST_DIR="$HOME/.config/argus"
TRUST_STORE="$TRUST_DIR/model-trust.json"
mkdir -p "$TRUST_DIR"
chmod 700 "$TRUST_DIR"

jq -n \
  --arg runtimeKeyId 'argus-runtime-2026-01' \
  --arg runtimeSubjectId 'argus-runtime-broker' \
  --rawfile runtimePublicKeyPem '/secure/runtime-public.pem' \
  --arg operatorKeyId 'argus-operator-2026-01' \
  --arg operatorSubjectId 'operator@example' \
  --rawfile operatorPublicKeyPem '/secure/operator-public.pem' \
  '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
    {keyId:$runtimeKeyId,purpose:"runtime-attestation",subjectId:$runtimeSubjectId,algorithm:"Ed25519",publicKeyPem:$runtimePublicKeyPem,status:"active"},
    {keyId:$operatorKeyId,purpose:"operator-approval",subjectId:$operatorSubjectId,algorithm:"Ed25519",publicKeyPem:$operatorPublicKeyPem,status:"active"}
  ]}' >"$TRUST_STORE.tmp"
chmod 600 "$TRUST_STORE.tmp"
mv "$TRUST_STORE.tmp" "$TRUST_STORE"
```

Pass the store and both key IDs to the attested launch (`--trust-store "$TRUST_STORE"
--runtime-key-id argus-runtime-2026-01 --operator-key-id argus-operator-2026-01`). The signed
request binds both identities, and the single launch preflight pins them and the secure
host-store path when it creates the engagement. No `argus-assets model trust` step or preflight
rerun follows: inside an engagement the write guard denies `model trust`. Keep the same
host-store path available for the whole engagement.

Every model request, route, allocation, retry, and telemetry operation securely reopens that live store. Changing a pinned key to `revoked`, removing it, or replacing its identity blocks the next sensitive operation immediately. No engagement restart is required merely to detect revocation; cleanup should follow the fail-closed result.

## Codex custom agents

Install the generated TOML files globally by symlink:

```bash
mkdir -p ~/.codex/agents
REPO=/path/to/holak-teams
for dir in "$REPO/hephaestus/codex" "$REPO/argus/codex"; do
  for file in "$dir"/*.toml; do
    ln -sfn "$file" ~/.codex/agents/"$(basename "$file")"
  done
done
```

Or copy a snapshot:

```bash
mkdir -p ~/.codex/agents
cp hephaestus/codex/*.toml argus/codex/*.toml ~/.codex/agents/
```

Only `*.toml` files are runtime configurations. Matching Hephaestus Markdown is a readable companion; Argus Markdown is provenance only.

The Argus Codex roster preserves the reviewed mapping (`sol`/`xhigh` for frontier roles, which today are all 27, and `terra`/`medium` for any standard role), but full Argus dispatch is intentionally unavailable today. The installed Codex CLI can bind model and reasoning effort but exposes no native hard turn cap. Argus therefore reports `CAPABILITY_DRIFT`; a signed claim or approximate wrapper counter cannot unlock it. The TOMLs remain configuration-parity artifacts for a future native runtime capability.

Verify the expected global count:

```bash
ls ~/.codex/agents/*.toml | wc -l
# 49: 22 Hephaestus + 27 Argus
```

## Per-project Codex install

Use a project-local Codex home when global names would collide:

```bash
export CODEX_HOME="$PWD/.codex-home"
mkdir -p "$CODEX_HOME/agents"
cp /path/to/holak-teams/hephaestus/codex/*.toml "$CODEX_HOME/agents/"
cp /path/to/holak-teams/argus/codex/*.toml "$CODEX_HOME/agents/"
```

## Uninstall

Remove Claude plugins through `/plugin uninstall`, then remove the marketplace if no plugin uses it. Remove copied or symlinked Codex files explicitly:

```bash
rm -f ~/.codex/agents/{marcus,odysseus}.toml
```

For a complete Codex cleanup, remove only filenames that belong to the two rosters; do not delete unrelated custom agents.
