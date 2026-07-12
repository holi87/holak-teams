# Install — Hephaestus + Argus agent teams

This repo is a **Claude Code plugin marketplace** (`holak-teams`) and also supports manual symlink/copy installs plus Codex.

The agents live in this repo (`~/Desktop/GenAI/my_agents/`), split into two teams. Each team's **Claude Code** agent defs live under `<team>/claude/agents/` (the plugin root is `<team>/claude/`); its **Codex** custom-agent variant lives under `<team>/codex/`:

- **Hephaestus** (delivery) — `hephaestus/claude/agents/` — 22 agents, entry point `marcus`
- **Argus** (QA) — `argus/claude/` — `/argus:run` main-thread skill + 27 agents, orchestration policy `odysseus`
- **Hephaestus for Codex** — `hephaestus/codex/` — the same 22 agents as paired `*.toml` + `*.md` files, entry point `marcus`
- **Argus for Codex** — `argus/codex/` — the same 27 agents as paired `*.toml` + `*.md` files, entry point `odysseus`

Hephaestus Codex files are generated from the flat Claude sources with
`scripts/sync-hephaestus-codex-variants.mjs --write`. Argus uses its canonical
`argus/roles/` sources. CI rejects body, metadata, provenance, sandbox, or model drift
across the complete 49-agent roster.

For Argus, this is generated-configuration parity, not a claim of standalone behavioral
parity. Claude support is `plugin-native`; Codex support is
`parent-runtime-dependent`. A Codex parent session must provide orchestration, packaged
Argus assets, and contract-equivalent tools, or the role returns `CAPABILITY_GAP`.

Codex model mapping for both teams: Claude `opus` source roles use `model = "sol"` with `model_reasoning_effort = "xhigh"`; Claude `sonnet` source roles use `model = "terra"` with `model_reasoning_effort = "medium"`; Claude `haiku` source roles use `model = "luna"` with `model_reasoning_effort = "medium"`.

Argus does not infer tiers from that mapping. `argus/model-policy.json` explicitly assigns
10 roles to `opus`/`sol`, 17 to `sonnet`/`terra`, and no full role to Haiku/Luna. The same
source generates Claude effort and `maxTurns`, Codex reasoning effort, escalation and
fallback blocks, and [`argus/MODEL-POLICY.md`](argus/MODEL-POLICY.md). Installed routing
uses `argus-assets model route`; sanitized usage is appended with
`argus-assets model telemetry` under `ai_agents_internal/`.
Those commands belong only to Odysseus and `/argus:run`. Each worker sees its own turn
cap and declared signals, checkpoints safely, then stops with an
`argus/model-escalation-request@1` envelope. The controller validates the envelope and
routes a new selected decision, explicitly rebinds the active lane with `engagement
start-attempt`, replaces the consumed lane token with the one returned by that command,
and only then starts the retry thread; the stale attempt token is revoked and workers never
choose or override models. Emit the completed attempt's telemetry before rebind or cleanup,
while that exact decision still owns the active lane capability.

`codex/` is the Codex-format variant. The canonical Argus framework and reference sources
remain under `argus/`; the Claude plugin ships hash-checked runtime assets, a shared
template layer plus one runtime-specific layer, capability-selected skills, and schemas.
`argus/COLOR-SCHEME.md`, the legacy monolithic doctrine, and the team graphs remain
maintainer-only.

## Claude Code — plugin marketplace (recommended)

Install the teams as plugins straight from this marketplace repo:

```
/plugin marketplace add holi87/holak-teams
/plugin install hephaestus@holak-teams
/plugin install argus@holak-teams
```

Update later with `/plugin marketplace update holak-teams`. Installed agents are namespaced (`hephaestus:marcus`, `argus:odysseus`). Opening this repo and trusting the folder auto-enables both plugins via `.claude/settings.json`.

Start Argus from an existing Claude Code conversation:

```
/argus:run <target URL, running stack, or repo path — and QA scope>
```

This is the recommended path: orchestration remains in the main thread, which dispatches
the installed `argus:<slug>` specialists and collects their results. A missing target,
denied `Agent` tool, or unavailable Argus specialist returns an `ARGUS_PREFLIGHT_ERROR`
instead of a plan that pretends execution happened.

To start a separate session with Odysseus itself as the main agent:

```bash
claude --agent argus:odysseus
```

Verify and inspect the self-contained runtime package from any Bash-capable Claude Code
session:

```bash
TARGET="$(cd /path/to/target-repo && pwd -P)"
ARTIFACT_ROOT="$TARGET"
MANIFEST="$ARTIFACT_ROOT/ai_agents_internal/engagement.json"
AUTHORIZATION="$ARTIFACT_ROOT/ai_agents_internal/authorization.json"

argus-assets verify
argus-assets list
argus-assets path browser-isolation
argus-assets preflight --target "$TARGET" --mode D --artifact-root "$ARTIFACT_ROOT"
argus-assets authorization check --manifest "$AUTHORIZATION" \
  --lane hermes --action read --target "$TARGET" --source-trust manifest
argus-assets engagement status --manifest "$MANIFEST"
argus-assets redact --input "$ARTIFACT_ROOT/reports/raw.json" \
  --output "$ARTIFACT_ROOT/reports/safe.json"
```

These variables make the commands independent of the shell's current directory. Allocation
is intentionally absent from this inspection block: it is a controller-only operation after
host trust, current preflight, and the complete dispatchable normal attempt-1 selection set
exist. New manifests persist physical paths (`pwd -P`). A genuine legacy manifest may retain
a lexical alias such as `/tmp` or `/var`; the current runtime accepts it only when resolving
that stored path proves it is physically equivalent to the current target/artifact root. It
does not silently rewrite the signed or hashed legacy manifest.

`/argus:run` performs that preflight before any probe, test, or specialist dispatch and
persists `ai_agents_internal/preflight.json`. The report covers target reachability,
artifact paths, packaged assets, supported tools, MCP servers, host commands, browser
runtime, and every selected specialist. Only `ready` and `degraded` agents may dispatch;
degraded records include their mandatory fallback, while deferred/skipped/blocked records
stay out of the dispatch table. A blocked mandatory check exits before target execution.

Each installed Argus specialist preloads the capability-selected profiles declared by the
matrix. `qa-core` is universal; browser, framework-runner, coverage-reporting, and
orchestration profiles are attached only where needed. Codex generation embeds the same
selected profile bodies because custom agents cannot preload Claude plugin skills. The
legacy monolithic doctrine is not packaged. `${CLAUDE_PLUGIN_ROOT}/skills/competition-profile/SKILL.md`
is packaged but disabled by default and requires explicit invocation for a competition or
scored course.

When no authorization file is supplied, preflight creates a default-deny manifest at
`ai_agents_internal/authorization.json`. Unknown, staging, and production-like targets
are read-only until the user explicitly enables the exact high-risk action with approver,
reason, expiry, time window, boundaries, limits, and rollback. Target/repository/issue/
fetched/tool/agent content cannot grant permission. Each `authorization check` appends a
redacted allow/deny event and rule ID to `authorization-audit.jsonl`. Edit the manifest
only from explicit user authorization, then rerun preflight; never weaken a denial in the
agent prompt. Text evidence must pass through `argus-assets redact`. Sensitive binary
screenshots/traces are omitted unless independently masked and reviewed.

Preflight also creates `ai_agents_internal/engagement.json` and atomic resumable state.
The marketplace plugin activates its packaged `PreToolUse` hook only while that manifest
exists. The hook blocks target-source mutation and direct canonical writes across direct
file tools and recognized shell/process writes. The controller selects a normal attempt-1
decision for Odysseus and every currently dispatchable selected role first, allocates
Odysseus against its exact decision, retains the controller token,
and authenticates each exact decision-bound worker allocation with that token. A worker
receives only its own lane token and resource/decision coordinates, never the controller
token, and never runs `engagement allocate`. It checkpoints monotonically and arrives at
phase barriers. The sealed dispatchable projection is also the immutable participant filter
for those barriers; a worker may report `success` cleanup only after every phase that names
it has recorded its arrival. Heartbeats bind each record to allocation, dispatch, and
attempt so a retry starts a new progress generation. Canonical changes travel as immutable
fragments and are merged deterministically by the declared owner. Reset/fault windows
are exclusive. Pass both the allocated `ARGUS_BROWSER_PROFILE` and
`ARGUS_BROWSER_ARTIFACTS` to browser workers. Always run
`engagement cleanup --outcome success|failure|interrupted`; lease tokens, profiles, auth,
cookies, downloads, traces, videos, screenshots, temp state, and locks must be absent at sign-off. See the installed
`${CLAUDE_PLUGIN_ROOT}/references/ENGAGEMENT-POLICY.md`.

Before framework work, detect capabilities and persist an explicit operator selection:

```bash
argus-assets template detect --target /path/to/target-repo \
  --output /tmp/template-capabilities.json
argus-assets template select --target /path/to/target-repo \
  --runtime typescript --package-manager npm \
  --test-root quality/specs --harness-root quality/support \
  --output /tmp/template-selection.json
argus-assets template scaffold --selection /tmp/template-selection.json \
  --destination /tmp/argus-framework
argus-assets copy-browser-driver /path/to/target-repo
```

Selection records language, framework, runner, package manager, source/test layout, CI,
and unsupported adapters. Existing suites produce `action=adapt`; scaffold refuses them,
so Atlas extends their existing paths and runner. Greenfield `action=build` requires an
explicit compatible runtime/package manager and disjoint test/harness roots. Scaffold
refuses a non-empty destination and relocates all internal placeholders to those roots.
`copy-template` remains a low-level maintainer command, not the engagement workflow.

## Claude Code — manual symlink / copy (alternative)

Without the marketplace, Claude Code also reads sub-agents from:

- **globally:** `~/.claude/agents/`
- **per-project:** `<repo>/.claude/agents/`

This alternative installs agent definitions only. It does **not** install `/argus:run`,
`argus-assets`, references, schemas, or templates; use the marketplace path for the full
self-contained Argus runtime.

### Option A — symlink (auto-update)

One link per team. Editing a file here = it works globally right away.

```bash
ln -s ~/Desktop/GenAI/my_agents/hephaestus/claude/agents ~/.claude/agents/hephaestus
ln -s ~/Desktop/GenAI/my_agents/argus/claude/agents      ~/.claude/agents/argus
```

> Claude Code scans subdirectories recursively, so each symlink shows up as its own group, alongside anything else you have (e.g. an `awesome-claude-agents` link).

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.claude/agents/hephaestus ~/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/agents/ ~/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/agents/      ~/.claude/agents/argus/
```

### Name collisions — check before installing

Slugs are persona names (`maximus`, not `backend-developer`), so they **do not collide** with `awesome-claude-agents` (`backend-developer`, `frontend-developer`, `code-reviewer`, `tech-lead-orchestrator`). Quick duplicate audit:

```bash
# no slug from these teams should already exist in ~/.claude/agents
for f in $(find ~/Desktop/GenAI/my_agents/hephaestus/claude/agents ~/Desktop/GenAI/my_agents/argus/claude/agents -name "*.md"); do
  n=$(basename "$f" .md)
  found=$(find ~/.claude/agents -name "$n.md" 2>/dev/null | grep -v "GenAI/my_agents" | head -1)
  [ -n "$found" ] && echo "COLLISION: $n → $found"
done
echo "audit complete"
```

### Verification after installing

```bash
# count the loaded agent files (trailing slash required, otherwise find won't follow the symlink)
find ~/.claude/agents/hephaestus/ ~/.claude/agents/argus/ -name "*.md" 2>/dev/null | wc -l   # → 49 (22 Hephaestus + 27 Argus)

# in a new Claude Code session:
/agents        # marcus, odysseus and the rest should be on the list
```

Then in any session:

```
> Marcus, <your task>
```

## Codex Install — Hephaestus + Argus

A Codex subagent is configured by a **single self-contained `*.toml`** (the persona prompt lives inside it,
in `developer_instructions`). Codex does **not** read the matching `*.md`, so install only
the `*.toml`. Hephaestus keeps a readable generated companion; each Argus `*.md` is instead
a compact, hash-bound provenance stub and deliberately contains no runtime instructions.
Argus variants are generated from
`argus/roles/manifest.json` + `argus/roles/*.md` and their referenced contracts; direct
edits under `argus/claude/agents/` or `argus/codex/` are rejected by CI. Only
`scripts/sync-argus-role-variants.mjs` writes those runtime variants. Codex has no
marketplace/git install for subagents (Codex plugins ship
skills / MCP / apps / hooks, not subagents), so installation is a copy or symlink into
`~/.codex/agents/`. Slugs stay the bare first names (`marcus`, `fabricius`, `odysseus`,
`talos`, ...).

Loading these TOML files validates configuration only. In particular, Codex does not
install the Claude `/argus:run` skill or the Argus plugin runtime. Odysseus can execute
the full contract only when the parent session supplies the required orchestration and
packaged assets; otherwise it must report `CAPABILITY_GAP` rather than simulate work.
The packaged Codex routing snapshot intentionally reports `maxTurns=false`; its full-role
routes fail closed unless the external Codex parent proves the missing dispatch control.
The supported route proof is a signed `argus/model-runtime-attestation@1`, bound to the
exact engagement, dispatch, attempt, role, adapter, selected model/effort, and hard turn cap.
A trusted Codex dispatch wrapper emits it only for a configuration that the wrapper can
enforce; it must not expose a generic sign-payload API. The signed document is delivered
outside the agent write boundary
as a real, single-link file directly under `ai_agents_internal/operator-decisions/`. Its
`runtime-attestation` key is distinct from the human-controlled `operator-approval` key.
Only their public anchors enter the host trust store; neither private key may be available
to the controller, workers, or the OS user that runs them. The CLI rejects first-use keys,
wrong-purpose or duplicate anchors, arbitrary capability flags, partial/expired claims,
cross-dispatch reuse, aliases, and invalid signatures. It is checked when the immutable
route is selected, not reused as a later spawn capability. Immediately before each actual
Codex allocation, resume, or retry rebind, the wrapper must also issue a fresh,
allocation-bound `argus/model-dispatch-authorization@1`; this keeps later waves independent
of the earlier route-proof window. `argus-assets` verifies and persists that authorization,
but cannot prove that an external process actually spawned the agent. The trusted wrapper
must pair a successful CLI operation with the exact-config spawn as one controlled dispatch
operation.

### Option A — symlink (recommended, auto-update)

```bash
mkdir -p ~/.codex/agents
for dir in ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex; do
  for f in "$dir"/*.toml; do
    ln -sf "$f" ~/.codex/agents/"$(basename "$f")"
  done
done
```

### Option B — copy the files (snapshot, no link)

```bash
mkdir -p ~/.codex/agents
cp ~/Desktop/GenAI/my_agents/hephaestus/codex/*.toml ~/.codex/agents/
cp ~/Desktop/GenAI/my_agents/argus/codex/*.toml      ~/.codex/agents/
```

### Verification after installing

```bash
ls ~/.codex/agents/*.toml | wc -l   # → 49 (22 Hephaestus + 27 Argus)
ls ~/.codex/agents/marcus.toml ~/.codex/agents/odysseus.toml
```

Then in Codex, use `marcus` as the delivery entry point and `odysseus` as the Argus QA / testing / bug-hunt entry point. `/argus:run` is a Claude Code plugin skill and is not installed into Codex.

### Full Argus runtime for a Codex parent

The TOMLs alone are configuration-only. Install the hash-checked Argus runtime beside
them when the Codex parent will execute the complete controller contract:

Provision two independent signer identities outside the Argus/Codex host security boundary
before any agent execution:

- a `runtime-attestation` signer owned by the trusted dispatch wrapper. Its interface must
  issue only exact route proofs and JIT allocation authorizations for configurations that
  the same wrapper enforces; it must not offer generic payload signing;
- an `operator-approval` signer behind a separate human-interactive approval boundary for
  frontier continuation, retry, or abort.

Use a separate service account, HSM/key service, or comparably isolated boundary for each
private key. Export only their public keys to the Argus host. A setup is invalid when the
agent/controller OS user can read either private key or invoke either signer as a generic
signing oracle; purpose labels alone do not create isolation.

```bash
mkdir -p ~/.codex/argus-runtime ~/.local/bin
rsync -a --delete ~/Desktop/GenAI/my_agents/argus/claude/ ~/.codex/argus-runtime/
ln -sfn ~/.codex/argus-runtime/bin/argus-assets ~/.local/bin/argus-assets
argus-assets verify

TARGET="$(cd /path/to/target-repo && pwd -P)"
ARTIFACT_ROOT="$TARGET"
MANIFEST="$ARTIFACT_ROOT/ai_agents_internal/engagement.json"
TRUST_DIR="$HOME/.config/argus"
TRUST_STORE="$TRUST_DIR/model-trust.json"
RUNTIME_KEY_ID="argus-runtime-wrapper-2026-01"
RUNTIME_SUBJECT_ID="codex-dispatch-wrapper"
RUNTIME_PUBLIC_KEY="/secure-provisioning/runtime-attestation.pub.pem"
OPERATOR_KEY_ID="argus-human-approval-2026-01"
OPERATOR_SUBJECT_ID="operator@example"
OPERATOR_PUBLIC_KEY="/secure-provisioning/operator-approval.pub.pem"

mkdir -p "$TRUST_DIR"
chmod 700 "$TRUST_DIR"
test -s "$RUNTIME_PUBLIC_KEY"
test -s "$OPERATOR_PUBLIC_KEY"
jq -n \
  --arg runtimeKeyId "$RUNTIME_KEY_ID" \
  --arg runtimeSubjectId "$RUNTIME_SUBJECT_ID" \
  --rawfile runtimePublicKeyPem "$RUNTIME_PUBLIC_KEY" \
  --arg operatorKeyId "$OPERATOR_KEY_ID" \
  --arg operatorSubjectId "$OPERATOR_SUBJECT_ID" \
  --rawfile operatorPublicKeyPem "$OPERATOR_PUBLIC_KEY" \
  '{schema:"argus/model-trust-store@1",schemaVersion:1,keys:[
    {keyId:$runtimeKeyId,purpose:"runtime-attestation",subjectId:$runtimeSubjectId,algorithm:"Ed25519",publicKeyPem:$runtimePublicKeyPem,status:"active"},
    {keyId:$operatorKeyId,purpose:"operator-approval",subjectId:$operatorSubjectId,algorithm:"Ed25519",publicKeyPem:$operatorPublicKeyPem,status:"active"}
  ]}' \
  > "$TRUST_STORE.tmp"
chmod 600 "$TRUST_STORE.tmp"
mv "$TRUST_STORE.tmp" "$TRUST_STORE"

argus-assets preflight --target "$TARGET" --mode D \
  --artifact-root "$ARTIFACT_ROOT" --model-runtime codex
argus-assets model trust --manifest "$MANIFEST" \
  --runtime-key-id "$RUNTIME_KEY_ID" --operator-key-id "$OPERATOR_KEY_ID"
argus-assets preflight --target "$TARGET" --mode D \
  --artifact-root "$ARTIFACT_ROOT" --model-runtime codex
```

The trust-store file and its directory must remain real (not symlinked), single-link,
current-user-owned, and non-writable by group or world. The second preflight is mandatory
because pinning changes the manifest digest; every route and allocation rejects a stale
report. Pinning copies a purpose-separated public bundle and the trust-store digest into
the manifest as an immutable snapshot; it is not a live revocation check. If either source
key is revoked, abort and clean the current engagement, then create a new engagement and
pin a current snapshot.

Before allocation, the controller reads `argus-assets model list` and asks the trusted
dispatch wrapper for exact Codex route proofs. The wrapper returns a signed attestation
only for a model, effort, and hard turn cap that it can enforce at spawn time. A
standard Aegis baseline has this shape (timestamps, IDs, `maxTurns`, fingerprint, and
signature must be live values, not copied placeholders):

```json
{
  "schema": "argus/model-runtime-attestation@1",
  "kind": "MODEL_RUNTIME_ATTESTATION",
  "engagementId": "<engagement-id>",
  "dispatchId": "<dispatch-id>",
  "attempt": 1,
  "agent": "aegis",
  "runtime": "codex",
  "parentRuntime": "codex",
  "parentSessionId": "<stable-parent-session-id>",
  "adapterContractId": "argus/runtime-adapters@3",
  "adapterId": "codex-custom-agent@1",
  "selectedConfig": { "tier": "standard", "model": "terra", "effort": "medium", "maxTurns": 48 },
  "enforcements": { "model": true, "effort": true, "maxTurns": true },
  "issuedBy": "codex-dispatch-wrapper",
  "issuedAt": "<RFC3339-now>",
  "expiresAt": "<RFC3339-within-15-minutes>",
  "reason": "The trusted wrapper can enforce the exact generated configuration and hard dispatch turn cap.",
  "authentication": {
    "algorithm": "Ed25519",
    "keyId": "argus-runtime-wrapper-2026-01",
    "purpose": "runtime-attestation",
    "keyFingerprintSha256": "<manifest-runtimeAttestation-fingerprint>",
    "signatureBase64": "<Ed25519-signature-from-dispatch-wrapper>"
  }
}
```

Do not generate a private PEM or run a generic signing command in the controller/worker
account. The dispatch-wrapper integration must deliver the already signed, purpose-bound
file. Operator decisions use a different document kind, key ID, `purpose: "operator-approval"`,
and `approvedBy` equal to the pinned human subject; the human approval service returns
those signed documents after an explicit decision.

Obtain an equivalent runtime attestation for Odysseus and every other projection-selected
role whose current preflight disposition is `ready` or `degraded` with
`dispatchAllowed=true`.
Assign one stable dispatch ID per role, then route every normal attempt 1 before allocating
anything. Only persisted `status=selected` decisions may run. The two captures below are
representative; do not continue until this exact dispatchable set has one persisted decision
per agent. Deferred, skipped, and blocked roles are not part of the sealed decision set and
must not allocate.

```bash
ODYSSEUS_ATTESTATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/odysseus-attempt-1.signed.json"
AEGIS_ATTESTATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/aegis-attempt-1.signed.json"

ODYSSEUS_DECISION_JSON="$(argus-assets model route \
  --manifest "$MANIFEST" \
  --agent odysseus --runtime codex --signal normal \
  --dispatch-id odysseus-main --attempt 1 \
  --runtime-attestation "$ODYSSEUS_ATTESTATION")"
ODYSSEUS_DECISION="$ARTIFACT_ROOT/$(printf '%s\n' "$ODYSSEUS_DECISION_JSON" | jq -r '.relativePath')"

AEGIS_DECISION_JSON="$(argus-assets model route \
  --manifest "$MANIFEST" \
  --agent aegis --runtime codex --signal normal \
  --dispatch-id aegis-main --attempt 1 \
  --runtime-attestation "$AEGIS_ATTESTATION")"
AEGIS_DECISION="$ARTIFACT_ROOT/$(printf '%s\n' "$AEGIS_DECISION_JSON" | jq -r '.relativePath')"

# Persist and verify every other dispatchable selected normal attempt-1 decision here.
```

After the complete dispatchable set exists, the trusted wrapper prepares the exact spawn configuration,
chooses a fresh 24-hex allocation ID, and returns a signed
`argus/model-dispatch-authorization@1` immediately before the corresponding allocation and
real spawn. The authorization binds the immutable decision ID/integrity, selected-config
digest, parent session, allocation ID, and nonce; its validity window is at most 15 minutes.
Store it as a real single-link `MDA-<first-24-hex-of-file-sha256>.json` directly under
`ai_agents_internal/operator-decisions/`. An authorization consumed by a successful CLI
operation cannot authorize another one; a recovery or retry authorization for the same
active allocation must have a new nonce and later `issuedAt`. Resume and retry keep that
active allocation ID. After release, a replacement allocation must use a fresh allocation ID;
the lane's bounded history preserves prior allocation IDs, MDA digests, and nonces so none can
be reused by a replacement. The CLI verifies and persists the binding. The wrapper, not the
CLI or an agent, must pair successful allocation with the actual exact-config spawn.

Allocate Odysseus first against its exact decision and fresh authorization. Retain its lane
token inside the controller and use it to authenticate every worker allocation. The
controller passes Aegis only `AEGIS_TOKEN`, Aegis's public resource
coordinates, and the decision coordinates from `AEGIS_DECISION_JSON`; it never passes
`CONTROLLER_TOKEN`. Workers never invoke `engagement allocate`.

```bash
# These are the absolute MDA paths returned by the wrapper's purpose-bound JIT operation;
# replace the illustrative suffixes with the wrapper's actual returned filenames.
ODYSSEUS_DISPATCH_AUTHORIZATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/MDA-<odysseus-file-sha-prefix>.json"
AEGIS_DISPATCH_AUTHORIZATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/MDA-<aegis-file-sha-prefix>.json"
test -s "$ODYSSEUS_DISPATCH_AUTHORIZATION"
test -s "$AEGIS_DISPATCH_AUTHORIZATION"

ODYSSEUS_ALLOCATION_JSON="$(argus-assets engagement allocate \
  --manifest "$MANIFEST" --lane odysseus --decision "$ODYSSEUS_DECISION" \
  --dispatch-authorization "$ODYSSEUS_DISPATCH_AUTHORIZATION")"
CONTROLLER_TOKEN="$(printf '%s\n' "$ODYSSEUS_ALLOCATION_JSON" | jq -r '.token')"

AEGIS_ALLOCATION_JSON="$(argus-assets engagement allocate \
  --manifest "$MANIFEST" --lane aegis --decision "$AEGIS_DECISION" \
  --dispatch-authorization "$AEGIS_DISPATCH_AUTHORIZATION" \
  --controller-token "$CONTROLLER_TOKEN")"
AEGIS_TOKEN="$(printf '%s\n' "$AEGIS_ALLOCATION_JSON" | jq -r '.token')"
```

These shell variables demonstrate bindings, not guaranteed secrecy. Do not enable shell
tracing or persist them; run allocation from a protected controller process. The CLI cannot
hide bearer tokens from every process running as the same OS user, so use OS/process
isolation when same-UID inspection is in scope.

After the first allocation, any new normal attempt-1 dispatch is late and fails closed. If
the selected model cannot start, do not invent another dispatch or allocation. Route
`model-unavailable` as the next attempt on the same dispatch and active allocation. The CLI
requires the exact prior selected decision; frontier work then waits for an external
`retry-frontier` or `abort` decision signed by the separate human `operator-approval` key
and never falls back to Terra or Luna. This pre-spawn availability retry is bound directly
to the prior decision and active allocation and may have no checkpoint because no worker
thread started. By contrast, a declared signal from a running worker must first authenticate
a checkpoint-bound request with that lane's token; every route after allocation
authenticates the controller. The example below creates and captures the exact checkpoint
path returned by the CLI; no `latest.json` alias exists:

```bash
AEGIS_CHECKPOINT_JSON="$(printf '%s\n' \
  '{"completed":["attempt-1"],"next":"retry-from-checkpoint"}' | \
  ARGUS_ENGAGEMENT_LEASE_TOKEN="$AEGIS_TOKEN" \
  argus-assets engagement checkpoint --manifest "$MANIFEST" --lane aegis \
    --phase hunting --sequence 1 --dispatch-id aegis-main --attempt 1 --input -)"
AEGIS_CHECKPOINT_REF="$(printf '%s\n' "$AEGIS_CHECKPOINT_JSON" | jq -r '.path')"

AEGIS_REQUEST_RECORD="$(ARGUS_ENGAGEMENT_LEASE_TOKEN="$AEGIS_TOKEN" \
  argus-assets model request --manifest "$MANIFEST" \
    --agent aegis --runtime codex --signal repeated-failure \
    --dispatch-id aegis-main --attempt 2 \
    --checkpoint-ref "$AEGIS_CHECKPOINT_REF")"
AEGIS_REQUEST="$(printf '%s\n' "$AEGIS_REQUEST_RECORD" | \
  sed -nE 's/^MODEL_REQUEST  persisted path=(.*) sha256=[a-f0-9]{64}$/\1/p')"
test -s "$AEGIS_REQUEST"
AEGIS_RETRY_ATTESTATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/aegis-attempt-2.signed.json"
AEGIS_RETRY_DECISION_JSON="$(ARGUS_ENGAGEMENT_CONTROLLER_TOKEN="$CONTROLLER_TOKEN" \
  argus-assets model route --manifest "$MANIFEST" \
    --agent aegis --runtime codex --signal repeated-failure \
    --dispatch-id aegis-main --attempt 2 --request "$AEGIS_REQUEST" \
    --runtime-attestation "$AEGIS_RETRY_ATTESTATION")"
AEGIS_RETRY_DECISION="$ARTIFACT_ROOT/$(printf '%s\n' "$AEGIS_RETRY_DECISION_JSON" | jq -r '.relativePath')"

# Record attempt 1 before start-attempt changes the active decision/token binding.
ARGUS_ENGAGEMENT_LEASE_TOKEN="$AEGIS_TOKEN" \
  argus-assets model telemetry --manifest "$MANIFEST" \
    --decision "$AEGIS_DECISION" --input-tokens 1100 --output-tokens 220 \
    --duration-ms 1700 --success false

# The wrapper returns a fresh MDA bound to AEGIS_RETRY_DECISION and the existing allocation.
AEGIS_RETRY_DISPATCH_AUTHORIZATION="$ARTIFACT_ROOT/ai_agents_internal/operator-decisions/MDA-<retry-file-sha-prefix>.json"
AEGIS_REBIND_JSON="$(argus-assets engagement start-attempt \
  --manifest "$MANIFEST" --lane aegis \
  --decision "$AEGIS_RETRY_DECISION" --token "$AEGIS_TOKEN" \
  --controller-token "$CONTROLLER_TOKEN" \
  --dispatch-authorization "$AEGIS_RETRY_DISPATCH_AUTHORIZATION")"
AEGIS_TOKEN="$(printf '%s\n' "$AEGIS_REBIND_JSON" | jq -r '.token')"
```

`engagement start-attempt` atomically rebinds the existing lane/allocation to the next
selected decision and rotates its capability token without minting a replacement allocation
or lane. It returns the new token once; the controller must replace `AEGIS_TOKEN` before the
external wrapper starts the exact-config thread from `AEGIS_CHECKPOINT_REF`, and the old
attempt token must never be retried or passed onward. The CLI verifies the decision,
lineage, lane/controller capabilities, and JIT authorization, but it cannot prove that
external spawn coupling by itself.

After the selected retry completes, record at most one sanitized telemetry event for that
exact decision using the rotated token, before another rebind or cleanup. A second event for
the same decision fails:

```bash
ARGUS_ENGAGEMENT_LEASE_TOKEN="$AEGIS_TOKEN" \
  argus-assets model telemetry --manifest "$MANIFEST" \
    --decision "$AEGIS_RETRY_DECISION" --input-tokens 1200 --output-tokens 240 \
    --duration-ms 1800 --success true
```

## Per-project instead of global

If you want the teams in just one repo:

```bash
mkdir -p <repo>/.claude/agents/hephaestus <repo>/.claude/agents/argus
cp -R ~/Desktop/GenAI/my_agents/hephaestus/claude/agents/ <repo>/.claude/agents/hephaestus/
cp -R ~/Desktop/GenAI/my_agents/argus/claude/agents/      <repo>/.claude/agents/argus/
```

## Uninstall

```bash
rm ~/.claude/agents/hephaestus ~/.claude/agents/argus        # symlinks (delete ONLY the links, sources stay in the repo)
# or for the copy:
rm -rf ~/.claude/agents/hephaestus ~/.claude/agents/argus    # the whole copied directories (only when NOT symlinks — check `ls -la ~/.claude/agents/`)

# Codex Hephaestus + Argus files:
for dir in ~/Desktop/GenAI/my_agents/hephaestus/codex ~/Desktop/GenAI/my_agents/argus/codex; do
  for f in "$dir"/*.{toml,md}; do
    rm -f ~/.codex/agents/"$(basename "$f")"
  done
done
```
