# Pre-Engagement Checklist — run BEFORE you point the team at a target

Verify the machine and the toolchain are ready before the team starts (free ports, Git,
editor + AI assistant, a locally working test stack). Run this top to bottom; every box must
pass. Tip: dispatch `janus` (environment preflight, read-only) with this file as the
checklist — he verifies and reports, he does not fix.

## Machine & ports
- [ ] Ports free: `lsof -nP -i :3000 -i :3001 -i :3002 -i :5432` returns nothing (kill/stop whatever holds them).
- [ ] Docker daemon running: `docker ps` works; `docker compose version` ≥ v2.
- [ ] Disk: ≥ 10 GB free (images + node_modules + browsers + traces).

## Toolchain
- [ ] `git --version` and `gh auth status` OK (the delivery must be COMMITTED — broken git auth is fatal).
- [ ] Node ≥ 20 + npm: `node -v && npm -v`.
- [ ] **Playwright browsers downloaded NOW**: from this template dir run `npm install && npx playwright install --with-deps chromium` — hundreds of MB; pre-download them, never on first run against the target.
- [ ] Template healthy: `npx tsc --noEmit` green; `npx playwright test --list` enumerates tests.
- [ ] `./run-tests.sh` reaches `ENVIRONMENT NOT READY` (proves the readiness gate works; the target stack is not up yet — that is the expected output).
- [ ] `psql --version` available (or plan B verified: `docker compose exec <db> psql` once the stack exists) — Kalchas's read-only DB recon depends on it.

## Target & access
- [ ] Target reachable: the app under test starts locally (e.g. `docker compose up -d`) and its API/UI URLs respond, OR you know exactly how to bring it up.
- [ ] Seed accounts / roles available: the per-role credentials the suite and hunters will use exist (or you know how to create them).
- [ ] Docs located: requirements / OpenAPI spec / brief found and readable (`openapi.json` or equivalent) — the oracle source. If none, that is itself recorded as residual risk.
- [ ] Adopt-or-build decision made: does the target repo ship its own `run-tests.sh` / test harness / bug template? If so we merge into it, never blind-overwrite; if not we use this scaffold.

## AI assistant
- [ ] Claude Code logged in on the account you will use; `/usage` shows a fresh window. Account-switch plan ready if you run multiple plans (start on the big one, relog to the spare when limits bite — checkpoint boundaries are the cheap moment to switch).
- [ ] Agents installed: `find ~/.claude/agents/marcus-team/ -name "*.md" | wc -l` returns the full roster (trailing slash matters on macOS find).
- [ ] MCP plugins connected: playwright (browser tools) + context7 (`/mcp` or ask janus).
- [ ] `delivery-check` skill installed (`ls ~/.claude/skills/delivery-check/SKILL.md`) — the human-side completeness gate for the end of the engagement.

## Knowledge
- [ ] Re-read the agreed brief: deliverable paths (`solution/ARCHITECTURE.md` carries the strategy + summary sections), bug template rule (one file per bug), and whether `run-tests.sh` is the target's starter — we merge into it, never blind-overwrite.
