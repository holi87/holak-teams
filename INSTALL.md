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

Argus 3 requires its packaged launcher. A direct `/argus:run` session fails preflight because it cannot prove the native turn cap or the OS sandbox.

```bash
PLUGIN_ROOT="$HOME/.claude/plugins/cache/holak-teams/argus/3.0.0"
TARGET="$(cd /path/to/target && pwd -P)"
ARTIFACT_ROOT="$(cd /path/to/artifacts && pwd -P)"

"$PLUGIN_ROOT/bin/argus-launch" doctor
"$PLUGIN_ROOT/bin/argus-launch" claude \
  --target "$TARGET" \
  --artifact-root "$ARTIFACT_ROOT" \
  --mode A
```

The launcher binds Odysseus to Claude `opus`, maximum effort, and the native 96-turn cap. It disables session persistence, clears inherited Argus bearer variables, and uses `sandbox-exec` on macOS or Bubblewrap on Linux. If the native turn option or OS sandbox is unavailable, launch stops.

Modes are:

- `A`: full QA team;
- `B`: black-box hunting;
- `C`: regression automation;
- `D`: targeted capability-selected run.

The preflight creates its control files below `ai_agents_internal/` before probing the target. Review authorization and engagement manifests before allowing target-affecting actions.

## Manual Claude plugin install

Marketplace installation is recommended. For a local development checkout, Claude Code can load either plugin root directly:

```bash
claude --plugin-dir "$HOME/Desktop/GenAI/my_agents/hephaestus/claude"
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

Pin the two identities before decisions, rerun preflight because the manifest digest changed, and keep the same host-store path available:

```bash
export ARGUS_MODEL_TRUST_STORE="$TRUST_STORE"
argus-assets model trust \
  --manifest "$ARTIFACT_ROOT/ai_agents_internal/engagement.json" \
  --runtime-key-id argus-runtime-2026-01 \
  --operator-key-id argus-operator-2026-01
```

Every model request, route, allocation, retry, and telemetry operation securely reopens that live store. Changing a pinned key to `revoked`, removing it, or replacing its identity blocks the next sensitive operation immediately. No engagement restart is required merely to detect revocation; cleanup should follow the fail-closed result.

## Codex custom agents

Install the generated TOML files globally by symlink:

```bash
mkdir -p ~/.codex/agents
for dir in "$HOME/Desktop/GenAI/my_agents/hephaestus/codex" "$HOME/Desktop/GenAI/my_agents/argus/codex"; do
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

The Argus Codex roster preserves the reviewed mapping (`sol`/`xhigh` for frontier roles and `terra`/`medium` for standard roles), but full Argus dispatch is intentionally unavailable today. The installed Codex CLI can bind model and reasoning effort but exposes no native hard turn cap. Argus therefore reports `CAPABILITY_DRIFT`; a signed claim or approximate wrapper counter cannot unlock it. The TOMLs remain configuration-parity artifacts for a future native runtime capability.

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
cp /path/to/my_agents/hephaestus/codex/*.toml "$CODEX_HOME/agents/"
cp /path/to/my_agents/argus/codex/*.toml "$CODEX_HOME/agents/"
```

## Uninstall

Remove Claude plugins through `/plugin uninstall`, then remove the marketplace if no plugin uses it. Remove copied or symlinked Codex files explicitly:

```bash
rm -f ~/.codex/agents/{marcus,odysseus}.toml
```

For a complete Codex cleanup, remove only filenames that belong to the two rosters; do not delete unrelated custom agents.
