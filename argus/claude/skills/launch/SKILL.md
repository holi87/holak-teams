---
name: launch
description: Start an Argus QA engagement from an interactive Claude Code session ("run argus", "argus qa", "test <url> with argus"). Detects attestation keys and credentials, asks before an UNATTESTED run, prepares operator files, and starts argus-launch in the background. It never runs preflight or dispatches Argus agents itself.
argument-hint: "<target URL or path> [mode A|B|C|D] [requirements file]"
allowed-tools: Read, Write, AskUserQuestion, Bash(argus-assets launch detect *), Bash(argus-assets template select *), Bash(argus-launch *), Bash(mkdir -m 700 -p *)
---

# Launch Argus from an interactive session

You are the operator's assistant, not the Argus controller. The controller runs only inside
`argus-launch`, which exports the launcher context the dispatch guard checks and applies the
OS sandbox. Never run `argus-assets preflight`, `/argus:run`, or an `argus:*` agent here;
never set `ARGUS_LAUNCH_*` or model pins yourself; never read, print, or pass a credential.

1. **Scope.** From `$ARGUMENTS`, take the target (HTTP(S) URL or existing absolute path),
   mode, and requirement files. Ask with `AskUserQuestion` for anything missing. Modes:
   `A` full audit, `B` deep bug hunt, `C` greenfield suite, `D` brownfield extension.
2. **Detect.** Run `argus-assets launch detect --json` and branch on `assurance`:
   - `mixed`: stop. Show `detail`; partial key material forbids an unattested run.
   - `attested-required`: keys exist, so the run must be attested through the external
     signer. Show the attested `argus-launch claude` form from `argus-launch --help` with
     the listed key IDs, and stop. Never offer unattested here.
   - `unattested-eligible`: ask with `AskUserQuestion` before anything else: "No attestation
     keys on this host. Run UNATTESTED?" Options: run unattested (OS sandbox and turn caps
     still enforced; no cryptographic proof of launch integrity; model and operator
     escalations blocked; every report names the engagement UNATTESTED), or cancel. Continue
     only on an explicit yes.
3. **Credential.** `credential` from the same detection:
   - `environment:<NAME>`: nothing to do.
   - `keychain:<service>`: pass `--credential-keychain-service <service>` at launch.
   - `missing`: stop and give the operator two commands to run with the `!` prefix:
     `claude setup-token`, then `security add-generic-password -U -s argus-claude-oauth -a "$USER" -w`
     (macOS asks for the token, so it stays out of the transcript). Then detect again.
4. **Paths.** Engagement ID `<target-host-or-dir>-<mode>-<yyyymmdd>` (lowercase, `[a-z0-9-]`).
   Artifact root `$HOME/argus-runs/<engagement-id>`; operator directory
   `$HOME/.cache/argus-operator/<engagement-id>`. Both must be new, outside the target, and
   outside every directory holding `ai_agents_internal/engagement.json`. Confirm them with the
   operator, then create both with `mkdir -m 700 -p`.
5. **Requirements.** Copy each requirement or acceptance-criteria file into
   `<artifact-root>/docs/` with `Read` and `Write`, unchanged. Recon reads them as the oracle.
6. **Authorization.** Ask the target environment (`development`, `test`, `staging`,
   `production`) and, with a multi-select, which high-risk grants the operator approves
   (`browser-state-change`, `persistent-mutation`, `binary-evidence`, `security-active`,
   `load`, `chaos`, `database-write`, `destructive`). With no grant, skip this step and launch
   with `--environment <env>` (default-deny). Otherwise `Read`
   `${CLAUDE_PLUGIN_ROOT}/policies/authorization.template.json`, fill it, and `Write`
   `<operator-dir>/authorization.json`: the engagement ID; the target; the environment;
   `productionLike: false` only for development/test; account aliases `anon`, the operator's
   role names, and `argus-*`; namespaces `synthetic` and `argus_*`; each approved grant
   enabled with the operator as `approvedBy`, now as `approvedAt`, an `expiresAt` the operator
   accepts (default 48 h), and the operator's reason; one matching `timeWindows` entry; and a
   concrete rollback `procedure` and `verification`. Set `productionOverride: true` only on a
   grant the operator explicitly approves for a production-like target. The policy is
   `${CLAUDE_PLUGIN_ROOT}/references/AUTHORIZATION-POLICY.md`.
7. **Framework (modes A, C, D).** Ask the runtime (`typescript`, `java`, `python`). Run
   `argus-assets template select --target <local target, else artifact root> --runtime <rt>
   --package-manager <npm|maven|pip> --test-root tests --harness-root src --output
   <operator-dir>/template-selection.json`. Mode B needs none.
8. **Dry run.** Run the launch command below with `--dry-run` and show the `ARGUS_LAUNCH`
   line. Fix any refusal before going on.
9. **Launch** with Bash `run_in_background: true`:
   `argus-launch claude --target <target> --artifact-root <artifact-root> --mode <mode>
   --engagement-id <id> --unattested --authorization <operator-dir>/authorization.json`
   (or `--environment <env>`) `[--template-selection <operator-dir>/template-selection.json]
   --usage-json <operator-dir>/usage.json --provision-browser
   [--credential-keychain-service <service>]`.
10. **Report.** Give the artifact root, operator directory, the background task ID, and
    that the run is UNATTESTED. When the task completes, report its exit status, the
    `subtype` in `usage.json`, and `<artifact-root>/solution/final-summary.json` if present.
    Claim nothing the launcher output does not show.
