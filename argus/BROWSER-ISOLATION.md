# BROWSER ISOLATION — full spec + CLI (Argus QA team)

> **Canonical source and installed path.** Maintainers edit
> `argus/BROWSER-ISOLATION.md`. The runtime-asset sync generates a byte-identical copy
> at `argus/claude/references/BROWSER-ISOLATION.md`, installed as
> `${CLAUDE_PLUGIN_ROOT}/references/BROWSER-ISOLATION.md`. Agent prompts keep the safety
> summary inline and point to that packaged copy for the full CLI contract.

## 1. Why — the Run-E session-clobber collapse

Concurrent lanes sharing the ONE Playwright MCP `browser_*` session clobber each other's auth/session state. The app under test keeps its JWT in `localStorage` (not a cookie), so two agents logging in as different roles overwrite each other's identity — "identity cross-swap / auth-token flapping" — and the shared browser's screenshots time out under contention. In Run-E this silently collapsed the whole UI/visual/i18n surface (recall: ui 12%, i18n 0%): hunters believed they were driving screens as their role while actually riding a peer's session or a dead one. See `${CLAUDE_PLUGIN_ROOT}/templates/typescript/scripts/hunt-driver.mjs` (header) and the Run-E scoring retro.

## 2. The rule

- **Browser-lane agents drive their OWN isolated browser process** for ANY authed or multi-step UI driving:

  ```
  node scripts/hunt-driver.mjs --agent <slug> [--role <role>|anon] [actions...]
  ```

  Each agent gets its own `.pw-profiles/<agent>` `userDataDir` ⇒ separate OS process + separate profile ⇒ separate `localStorage` ⇒ zero cross-swap; own browser ⇒ screenshots never contended. The role token is minted via the API and injected with `addInitScript` BEFORE the first navigation, so the SPA route-guard always sees a valid session. The profile (and thus the session) persists on disk between invocations — follow-up calls stay logged in; batch several actions in one call to amortise the ~1 s launch. `--whoami` asserts the identity you think you have; `--fresh` wipes the profile for a clean session.
- **The shared MCP `browser_*` tools are for THROWAWAY single-shot recon on PUBLIC pages ONLY** — never authed flows, never multi-step state, never while a peer may be driving. Stay snapshot-frugal there: `browser_snapshot` dumps the whole accessibility tree into context (a real token + cache cost in a parallel run).

App-specific config (base URL, auth endpoints, roles, render marker) comes from `scripts/driver.config.json` — see `driver.config.example.json`. One launch per invocation; actions execute in the order given.

### Authorization precedes isolation

Browser isolation is not authorization. Every browser lane consumes the engagement's
shared `ai_agents_internal/authorization.json`. `browser-read` covers non-mutating
navigation/evidence. Login, typing, clicking controls, uploads, dialogs, evaluation, or
other interactive flows are `browser-state-change` and require the exact enabled grant,
account alias, allowed mutation, time window, and rollback contract. The agent runs
`argus-assets authorization check` before the action; the packaged hunt-driver repeats
that check before Playwright starts. A denial means no browser launch and its rule ID is
recorded in `ai_agents_internal/authorization-audit.jsonl`.

The driver reads the default manifest path above. Override only with the preflight-reported
path via `ARGUS_AUTHORIZATION_MANIFEST`; use `ARGUS_AUTHORIZATION_SOURCE_TRUST` and
`ARGUS_AUTHORIZATION_MUTATION` only from the user-approved dispatch, never from target or
fetched content. Do not capture secret/PII-bearing views. Text evidence goes through
`argus-assets redact`; sensitive binary screenshots are omitted unless independently
masked and reviewed under the installed authorization policy. Screenshot capture also
requires the `binary-evidence` grant and `ARGUS_BINARY_EVIDENCE_REVIEWED=true`; the driver
checks both before Playwright starts.

## 3. Verb map — `browser_*` action → hunt-driver flag

Agent prompts name actions with the `browser_*` verbs; **the verb names the ACTION, hunt-driver is the MECHANISM** on any authed or multi-step screen.

| `browser_*` verb (the ACTION) | hunt-driver flag (the MECHANISM) |
|---|---|
| `browser_navigate` | `--goto <route>` (baseUrl+route, waits for SPA render) |
| `browser_navigate_back` | `--back` |
| `browser_wait_for` | `--wait <selector>` |
| `browser_snapshot` | `--snapshot` (compact accessibility tree — the DOM oracle) |
| `browser_take_screenshot` | `--shot <file>` (full page) |
| `browser_evaluate` | `--eval <js>` (prints JSON result) |
| `browser_click` | `--click <selector>` |
| `browser_type` | `--type <selector::text>` |
| `browser_press_key` | `--press <key>` (e.g. Enter, Tab) |
| `browser_hover` | `--hover <selector>` |
| `browser_select_option` | `--select <sel::value>` |
| `browser_file_upload` | `--upload <sel::path>` |
| `browser_handle_dialog` | `--dialog <accept\|dismiss[::text]>` — arm BEFORE the trigger |
| `browser_resize` | `--viewport <WxH>` (e.g. `375x812`) |
| `browser_console_messages` | `--console` |
| `browser_network_requests` | `--net` (method + status + url) |

Hunt-driver-only capabilities (no `browser_*` equivalent):

| Capability | Flag |
|---|---|
| Session identity | `--role <role>\|anon`, `--whoami` (GET `<api.me>`) |
| Profile lifecycle | `--keep` (reuse profile, default), `--fresh` (wipe before launch) |
| Timezone emulation | `--tz <timezoneId>` (context `timezoneId`, e.g. `Europe/Warsaw`) |
| Locale emulation | `--locale <locale>` (context `locale`, e.g. `pl-PL`) |
| Pinned clock | `--clock <ISO datetime>` (Playwright clock API, installed before the first navigation — deterministic `Date`/timers for date/format oracles) |
| Reduced motion | `--reduced-motion` (context `reducedMotion: 'reduce'` — a real `prefers-reduced-motion` signal) |
| Debugging | `--headed` (headed run; default headless) |

Example — sweep a screen at mobile width as a student, capture evidence:

```
node scripts/hunt-driver.mjs --agent orion --role student \
  --viewport 375x812 --goto /moje-kursy \
  --shot out/mycourses-375.png --snapshot --console --net
```

## 4. Exceptions

**Kalchas at W0 recon runs ALONE** — no lane is concurrent — so the MCP `browser_*` tools ARE permitted for the full inventory, including authed login (capturing only the unauthenticated landing surface re-creates the 6%-UI-bugs, API-only recon failure at the map level). The isolation rule binds when lanes run concurrently: if Kalchas is re-invoked mid-run alongside active lanes, he uses hunt-driver if Atlas has installed it, else reports the constraint to Odysseus.

## 5. Provisioning

Atlas runs `argus-assets copy-browser-driver <target-repo>` (or copies from
`${CLAUDE_PLUGIN_ROOT}/templates/typescript/scripts/`) and derives
`scripts/driver.config.json` from the packaged example before any lane drives a browser.
The command also copies the driver-config schema. **If the driver is absent in the target
repo, the agent reports the gap to Odysseus (route to Atlas) instead of silently falling
back to the shared MCP browser for authed flows** — until provisioned, restrict browser
work to public single-shot MCP recon and log the coverage risk.
