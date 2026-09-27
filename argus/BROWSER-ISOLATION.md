# BROWSER ISOLATION — full spec + CLI (Argus QA team)

> **Canonical source and installed path.** Maintainers edit
> `argus/BROWSER-ISOLATION.md`. The runtime-asset sync generates a byte-identical copy
> at `argus/claude/references/BROWSER-ISOLATION.md`, installed as
> `${CLAUDE_PLUGIN_ROOT}/references/BROWSER-ISOLATION.md`. Agent prompts keep the safety
> summary inline and point to that packaged copy for the full CLI contract.

## 1. Why — the Run-E session-clobber collapse

Concurrent lanes sharing the ONE Playwright MCP `browser_*` session clobber each other's auth/session state. The app under test keeps its JWT in `localStorage` (not a cookie), so two agents logging in as different roles overwrite each other's identity — "identity cross-swap / auth-token flapping" — and the shared browser's screenshots time out under contention. In Run-E this silently collapsed the whole UI/visual/i18n surface (recall: ui 12%, i18n 0%): hunters believed they were driving screens as their role while actually riding a peer's session or a dead one. See `${CLAUDE_PLUGIN_ROOT}/templates/typescript/scripts/hunt-driver.mjs` (header) and the Run-E scoring retro.

## 2. The rule

- **Browser-lane agents drive their OWN isolated browser process** for ANY authed or multi-step UI driving.
  In a managed engagement run the packaged driver IN PLACE from the plugin; nothing is
  copied into the target. First print the template directory, then invoke the driver with
  that literal path (the write guard rejects `$(...)` composition around `argus-assets`):

  ```
  argus-assets path typescript-template
  ARGUS_ENGAGEMENT_MANIFEST=<artifact-root>/ai_agents_internal/engagement.json \
  ARGUS_BROWSER_PROFILE=<allocated-browserProfile> \
  ARGUS_BROWSER_ARTIFACTS=<allocated-browserArtifactsDirectory> \
  node <printed-path>/scripts/hunt-driver.mjs --agent <slug> [--role <role>|anon] [actions...]
  ```

  `ARGUS_ENGAGEMENT_MANIFEST` selects the managed defaults, all in its directory: the recon
  config `recon/driver.config.json`, the authorization manifest `authorization.json`, and the
  Playwright module recorded in `browser-runtime.json`. The driver recomputes that module's
  package and module-tree digests immediately before importing it; on any mismatch it stops
  with `browser runtime changed since preflight`, and it never imports a module whose tree
  lies inside the worker-writable artifact root. Gate resolution runs once, so the lane then
  reports a browser-runtime residual to Odysseus (see "If `browser-runtime.json` is not
  `available`" below). `ARGUS_BROWSER_PROFILE` is mandatory there. A framework that vendors the driver
  runs the same flags as `node scripts/hunt-driver.mjs ...` with `scripts/driver.config.json`.

  The engagement controller gives each worker a unique managed `browserProfile` and
  `browserArtifactsDirectory`; pass them as `ARGUS_BROWSER_PROFILE` and
  `ARGUS_BROWSER_ARTIFACTS`. The driver uses that exact `userDataDir` and confines
  downloads, traces, videos, and screenshots to the allocated artifact directory. Outside a managed
  engagement it falls back to `.pw-profiles/<agent>`. Separate OS process + separate
  profile ⇒ separate `localStorage` ⇒ zero cross-swap; own browser ⇒ screenshots never
  contended. The role token is minted via the API and injected with `addInitScript` BEFORE
  the first navigation, so the SPA route-guard always sees a valid session. The profile
  (and thus the session) persists between invocations until mandatory engagement cleanup;
  batch several actions in one call to amortise the ~1 s launch. Cross-lane profile reuse
  is prohibited unless `browserPolicy.sessionMode=shared-authorized` and the manifest has
  an unexpired operator-authored authorization naming every sharing lane, shared account alias, approver, reason,
  authorization rule, and expiry. The controller then assigns one named profile owner and
  retains it until the final authorized lane cleans up. `--whoami` asserts the
  identity you think you have; `--fresh` wipes only that allocated profile.
- **The shared MCP `browser_*` tools are for THROWAWAY single-shot recon on PUBLIC pages ONLY** — never authed flows, never multi-step state, never while a peer may be driving. Stay snapshot-frugal there: `browser_snapshot` dumps the whole accessibility tree into context (a real token + cache cost in a parallel run).

App-specific config (base URL, auth endpoints, roles, render marker) comes from `ai_agents_internal/recon/driver.config.json` in a managed engagement, otherwise from `scripts/driver.config.json` — see `driver.config.example.json`. One launch per invocation; actions execute in the order given.

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
  checks both before Playwright starts. `ARGUS_CAPTURE_TRACE=true` and
  `ARGUS_CAPTURE_VIDEO=true` are permitted only after the same binary-evidence decision.

Browser evidence registers under these `argus/evidence-reference@3` kinds:

| Capture | Kind | Media type | Registration |
|---|---|---|---|
| Masked screenshot | `screenshot` | `image/png`, `image/jpeg`, or `image/webp` | Binary: reviewer's own fragment, `review` block, audited `binary-evidence` allow |
| Masked video | `video` | `video/webm` or `video/mp4` | Binary: reviewer's own fragment, `review` block, audited `binary-evidence` allow |
| Playwright trace archive | `trace` | `application/zip` | Binary: reviewer's own fragment, `review` block, audited `binary-evidence` allow |
| DOM or accessibility snapshot | `dom-snapshot` | `text/html`, `application/xhtml+xml`, or `text/yaml` | Text: run it through `argus-assets redact`; no password input may keep a value |
| Network capture | `har` | `application/json` | Text: run it through `argus-assets redact`, then mask every credential header, cookie value, and token query parameter with a `[REDACTED]` placeholder |

The merge re-checks each kind's content and the binary review binding; see
`AUTHORIZATION-POLICY.md` section 5.

### Profile and sensitive-artifact lifecycle

- Profiles, cookies, local/session storage, auth files, downloads, traces, videos, and
  screenshots live only below the allocated engagement worker root; durable reports may
  contain only independently reviewed, redacted evidence references.
- Same-lane reuse is allowed only during the active engagement. A missing lease file is
  treated as crash recovery: the controller removes stale profile/auth/browser artifacts,
  releases held locks, and issues a new lease before reuse.
- Every terminal path calls `engagement cleanup --outcome success|failure|interrupted`.
  Cleanup is idempotent and removes profiles, auth, temporary browser artifacts, leases,
  and locks. For authorized sharing, the final active member removes shared state.

### Risk-derived browser coverage

`browserPolicy.coverage` in `ai_agents_internal/engagement.json` is the executable coverage
contract. Preflight derives its browser/device/viewport matrix from declared target support
and risks such as accessibility, responsive layout, touch input, locale, and engine-specific
behavior. If support is unknown, the manifest records that uncertainty and a conservative
representative matrix. Fixed browser counts are not a quality target: execute every recorded
combination or name the missing combination and residual risk in the final report.

## 3. Verb map — `browser_*` action → hunt-driver flag

Agent prompts name actions with the `browser_*` verbs; **the verb names the ACTION, hunt-driver is the MECHANISM** on any authed or multi-step screen.

| `browser_*` verb (the ACTION) | hunt-driver flag (the MECHANISM) |
|---|---|
| `browser_navigate` | `--goto <route>` (baseUrl+route, waits for SPA render) |
| `browser_navigate_back` | `--back` |
| `browser_wait_for` | `--wait <selector>` |
| `browser_snapshot` | `--snapshot` (aria snapshot YAML — the DOM oracle) |
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
| `browser_network_requests` | `--net` (label, method, status or FAILED, duration, resource type, url) |

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
| Tabs | `--tab <name>` (switch to or open a named tab in the current actor's browser; the first tab is `main`, popups are `popup-<n>`) |
| Actors | `--actor <name>=<role\|anon>` (repeatable; declares an extra actor with its own browser process), `--as <actor>` (switch to `primary` or a declared actor's current tab) |
| Client-side faults | `--fail-next <glob>[::<status>[::<count>]]` (default 503, empty JSON body), `--abort-next <glob>[::<count>]`, `--delay-next <glob>::<ms>[::<count>]`, `--unroute`, `--offline`/`--online` — section 3a |
| Payloads | `--capture-bodies <glob>` (repeatable session option), `--bodies` (print captured bodies as JSON lines) — section 3a |
| UI races | `--race-arm <[actor/]tab>::<selector>` (arm one click target; repeat per target), `--race-fire` (click every armed target concurrently and report each outcome) |
| Timing | `--wait-ms <0-60000>`, `--advance <ms>` (fast-forward the installed clock; requires `--clock`) |
| Dry run | `--plan` (print the parsed actions and authorization checks as one JSON line; no config load, no browser) |
| Version | `--version` (print the driver version) |

Example — sweep a screen at mobile width as a student, capture evidence:

```
ARGUS_BROWSER_PROFILE=<allocated-browserProfile> \
ARGUS_BROWSER_ARTIFACTS=<allocated-browserArtifactsDirectory> \
node scripts/hunt-driver.mjs --agent orion --role argus-orion \
  --viewport 375x812 --goto /moje-kursy \
  --shot <allocated-browserArtifactsDirectory>/screenshots/mycourses-375.png \
  --snapshot --console --net
```

### 3a. Client-side controls and their authorization

- **Faults stay in the lane's own browser.** `--fail-next`, `--abort-next`, and
  `--delay-next` install `context.route` handlers on the current actor's browser context;
  `--offline`/`--online` call `context.setOffline`. The target server and its dependencies
  never receive an altered request, so a client-side fault is not `chaos` and takes no
  exclusive reset/fault window. `--unroute` removes the current actor's driver routes.
- **Faults need two decisions.** Every fault verb is interactive and therefore needs
  `browser-state-change` for the lane's account. `--fail-next`, `--abort-next`,
  `--delay-next`, and `--offline` additionally need a separate audited
  `argus-assets authorization check` with the mutation `browser:client-fault`. The driver
  runs both checks before Playwright starts and takes that mutation only from its own plan,
  never from `ARGUS_AUTHORIZATION_MUTATION`. A denial means no browser launch.
- **Bodies are opt-in and redacted.** Only responses whose absolute URL matches a
  `--capture-bodies` glob are recorded, and only textual bodies (text, XML, JSON), each
  capped at the recon config's `maxCapturedBodyBytes` (default 64 KiB) with its byte count
  and SHA-256. `--bodies` prints them through `argus-assets redact` to stdout only; nothing
  is written to disk. Bodies and request bodies of the configured auth endpoints
  (`api.login`, `api.me`, `api.refresh`) and of every `bodyCaptureExclude` glob are
  omitted. No header is kept except `content-type`.
- **Each actor is its own browser.** Every `--actor` runs a separate persistent browser
  process whose profile lives under the lane's allocated
  `<browserArtifactsDirectory>/actor-profiles/<name>`, so engagement cleanup and crash
  recovery remove it with the rest of the lane's browser artifacts; `--fresh` wipes it
  too. Every non-anonymous actor account is authorized separately with its own
  `browser-state-change` check.
- **Same semantics as the automation helpers.** `--fail-next`, `--delay-next`, and
  `--abort-next` behave like the TypeScript template's `failNext`, `delayNext`, and
  `abortNext` route mocks (status with an empty JSON body, delay then continue, abort with
  `failed`), so a hunt that finds a defect through a fault converts to a RED regression
  without changing the fault. Record the fulfilled status in the repro: the driver
  defaults to 503, `failNext` to 500.

## 4. The shared MCP browser: public, single-shot, read-only

The shared MCP `browser_navigate` and `browser_snapshot` tools are public, single-shot, and
read-only for EVERY role, Kalchas included, at W0 recon and on every later pass. Never log
in, type, click through a flow, or carry state from one call to the next there.
Authenticated or multi-step recon uses the managed hunt driver (section 2), exactly like
every other authed or multi-step flow; Kalchas recons each role through it.

Why there are no exceptions: an MCP browser call bypasses the driver's
`argus-assets authorization check` and the PreToolUse write guard, and its cookies, storage,
and session live in a browser process outside the engagement boundary, where mandatory
engagement cleanup can neither see nor remove them.

## 5. Provisioning

- **Host, before launch.** The operator runs `argus-launch claude ... --provision-browser`, or
  `argus-assets browser provision --artifact-root <root>` on the host before the launch. It
  reuses a host Playwright outside the artifact root that already launches headless Chromium,
  or installs the pinned release (the TypeScript template lockfile version) into
  `~/.cache/argus/browser-runtime/<x.y.z>` and Chromium into Playwright's host default cache.
  That directory lies outside the artifact root, so sandboxed lanes can read the module but
  never modify it. The command is host/operator-only: it refuses whenever launch-attestation
  or engagement lease variables are set, and the PreToolUse guard denies it inside every
  engagement.
- **Preflight.** Preflight (and controller gate resolution) functionally probes the runtime
  inside the sandbox and records the winner in `ai_agents_internal/browser-runtime.json` with
  its package and module-tree digests (`references/ENGAGEMENT-POLICY.md`, "Browser runtime
  record"). The managed driver imports only that module.
- **Recon config.** Kalchas writes `ai_agents_internal/recon/driver.config.json` from the
  packaged `driver.config.example.json`. It contains only user-supplied synthetic
  credentials, never secrets found in the target or in fetched content.
- **Vendored drivers.** `argus-assets copy-browser-driver <target-repo>` remains only for
  frameworks that vendor the driver into their test code; it copies the driver, the example
  config, and the driver-config schema. Managed lanes never need it.

**If `browser-runtime.json` is not `available` or the recon config is missing, the lane
reports the gap to Odysseus instead of silently falling back to the shared MCP browser for
authed flows.** Until it is resolved, browser work stays limited to public single-shot MCP
reads (section 4) and the lane logs the coverage risk.
