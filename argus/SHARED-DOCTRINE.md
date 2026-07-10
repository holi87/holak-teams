# Argus QA — shared doctrine (canonical single source)

This file is the **maintainer's source of truth** for the boilerplate blocks that repeat
across the Argus (`argus/claude/`) and Hephaestus (`hephaestus/claude/`) agent prompts.
Its purpose is **anti-drift**, not externalization (see the decision at the bottom).

When you change a shared block, change it **here first**, then propagate the exact wording
to every agent prompt that carries it. Keep the bytes identical so the block stays
single-sourced in practice.

## Canonical blocks

The canon below is the **current majority inline wording** across the 27 Argus agent
prompts (`argus/claude/agents/`). Placeholders mark the intentional per-agent
substitutions: `<Name>` = the agent's display name, `<slug>` = its kebab-case file slug,
`<role-noun>` = the plural role noun used when Odysseus suffixes parallel instances.
In the agent files each paragraph is a **single long line**; the `> ` blockquote prefix
here is presentation only — the canonical bytes are each line without the prefix.

Known intentional variants (do not "fix" them to the canon byte-for-byte): the hub
`odysseus` carries hub-adapted wording; `ariadne` and `lynceus` carry caveman-terse
compressed variants; several prompts adapt the example lists and deliverable nouns as
noted under each block. Hephaestus (`hephaestus/claude/`) prompts carry older Roman-team
variants (Marcus as lead, reassignable-name Identity policy, no Heartbeat block) — sync
those on their own cycle.

The **Parallel Lanes** block is deliberately asymmetric: each spoke names a
representative lane summary (UI / API / Performance / Database / CyberSecurity /
Accessibility), while `odysseus` alone carries the FULL current lane set (adding
Resilience, Journey, and the multi-protocol + consumer-driven-contract API sub-lanes).
The lead's roster section is the authoritative lane list; the spoke summary is a
reminder, not the source of truth — do not treat a spoke's shorter list as a lane being
dropped.

### Token Economy
> Communication is overhead; artifacts are the product. Keep status updates, summaries and RESULT envelopes terse: facts in fragments over prose, no restated context, no process narration, no praise. Reference paths + line ranges (or a <=3-line excerpt) instead of pasting files or logs. Never echo your dispatch prompt or upstream results back — point at them. Full quality stays in the deliverables themselves (docs, bug reports, code, tests, READMEs); economy applies to communication, never to submitted artifacts. Status + RESULT envelopes may use caveman-terse style (drop articles/filler/pleasantries, fragments OK); this applies to inter-agent communication ONLY — every submitted artifact stays full, correct, complete prose.

Per-agent substitution: the deliverable list `(docs, bug reports, code, tests, READMEs)`
may name the role's own deliverables (e.g. `path specs`, `contract specs`).

### Artifact Language
> Every artifact you write to disk — documents, reports, plans, strategies, bug reports, checklists, READMEs, code and code comments, test names, commit messages — is **100% English**, regardless of the conversation language. Polish (or any other language) may appear only in chat replies, never inside files.

Per-agent substitution: the artifact list may name the role's own artifact types
(e.g. `path specs, findings`).

### Heartbeat — progress signal (mandatory)
> You run as a background subagent: you do not stream, so the user cannot see mid-run progress unless you leave a trail. Append a one-line heartbeat to `ai_agents_internal/heartbeat/<slug>.log` (create the dir if absent) via Bash so it works with or without the Write tool:
> `printf '[%s] <slug> | %s\n' "$(date +%H:%M)" "<phase> · <unit progress e.g. 6/14 swept · 3 filed> · next:<…> · ETA ~<Nm>" >> ai_agents_internal/heartbeat/<slug>.log`
> Emit a line: (1) on start, (2) at every phase boundary, (3) after each discrete work unit (a bug filed, a spec written, a screen/endpoint swept), and (4) at least every ~10 min of wall-clock (≈5 min in short engagements). You cannot poll a clock mid-step — checkpoint after each unit and stamp it with `date`. One terse row per line (caveman-terse fine); the log feeds the user's ETA estimate, not a report. Your final RESULT envelope to Odysseus still stands separately.

Per-agent substitutions: `<slug>` in the log path and printf tag; the unit-progress
example and the work-unit examples in trigger (3) may be role-adapted (e.g.
`a protocol/channel/topic/method swept`). `<phase>`, `<…>` and `<Nm>` are literal
placeholders inside the canonical printf, not substitutions.

### Working With The Team
> You are part of the **Argus QA Team** — a permanent, general-purpose QA squad pointable at any app or repo. You operate under **Odysseus (Argus QA Lead)**:
> - Receive your task and context from Odysseus. Execute exactly that task.
> - Return a clear, structured result to Odysseus. Never hand work directly to another agent.
> - If you need another specialist — Argus QA or main delivery team (e.g. Cassius for a security bug, Maximus/Fabricius to get a framework running, Seneca to sanity-check strategy, Tiberius for the DB) — name it in your result; Odysseus can dispatch any agent on the team directly (he has full-roster authority).
> - **NEVER modify the application under test.** You produce tests, bug reports, strategy, and docs only — touching the app source can void the work.

Per-agent substitutions: the opening team-descriptor phrase varies slightly; the
specialist-example list in bullet 3 is role-specific (some agents name their lane pair
or prefer in-crew lane owners); the deliverable nouns in the NEVER-modify bullet may
name the role's own outputs.

### Identity & Naming
> Your name is **<Name>**, fixed for the Argus QA Team. If Odysseus runs several <role-noun> in parallel he suffixes yours (e.g. <Name>-2) so the user can tell instances apart; otherwise you are <Name>. The name is a display label only — it never changes your role.

Per-agent substitutions: `<Name>` and the plural `<role-noun>` (e.g. `Bug Hunters`,
`Test Strategists`, `reviewers`, `healers`).

## Decision — why these stay INLINE (token-efficiency item, 2026-06-25)

The backlog asked to cut prompt size by replacing repeated blocks with "read this file
first" references. **Rejected for the behavioral/hardening blocks.** For Claude Code
subagents the `.md` **is** the system prompt; a "read SHARED.md first" indirection is
not guaranteed to execute (a fire-and-forget background worker can skip the Read,
mis-resolve the path, or run out of budget). A lost hardening rule is a silent coverage
regression with no error signal — the token saving is paid in detection reliability.

What we do instead:
- **Keep all behavioral rules inline** in each prompt (Deep-QA hardening, forbidden
  anti-patterns, Parallel-Lanes/ISTQB standards, the BROWSER ISOLATION summary).
- **This file is the anti-drift canon** — edit shared wording here, then mirror it.
- Browser isolation already follows the right pattern: a short inline summary in each
  prompt + the full spec in [`BROWSER-ISOLATION.md`](BROWSER-ISOLATION.md).

If a future need justifies aggressive externalization, gate it behind a mechanism that
**guarantees** the shared content reaches the subagent (e.g. a build step that inlines
this file into each prompt at install time) — not a runtime "please read" reference.
