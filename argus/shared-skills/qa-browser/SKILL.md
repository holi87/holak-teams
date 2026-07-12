---
name: qa-browser
description: Shared browser isolation, UI evidence, and accessibility contract for Argus roles
user-invocable: false
---

# Argus Browser QA

Use this profile only for roles assigned browser-facing work.

The complete installed isolation contract is
`${CLAUDE_PLUGIN_ROOT}/references/BROWSER-ISOLATION.md`.

- Use the engagement's leased browser profile, account, namespace, viewport, and artifact
  directory. Never reuse another lane's state. A shared session is valid only when the
  authorization names every participating lane and its expiry.
- Use the managed hunt driver for stateful or multi-step work. Reserve a shared public
  browser for bounded, stateless recon. Assert identity before mutation and after recovery.
- Derive browser, device, viewport, locale, and assistive-technology coverage from declared
  support and risk. Execute each funded matrix entry or record the exact residual risk;
  never replace the matrix with a fixed browser quota.
- Prove UI outcomes, not element presence: observe the user-visible state, persisted
  business effect, console/network failure where relevant, and cross-view consistency.
  Stable semantic selectors are preferred over layout-coupled selectors.
- Accessibility uses the engagement's declared standard and level. Combine automation with
  keyboard, focus, semantics, reflow, target-size, dragging, and assistive-technology
  judgment. State tools, manual checks, limitations, and coverage without claiming target
  conformance from a partial scan.
- Keep cookies, tokens, downloads, screenshots, traces, videos, and profiles inside the
  engagement boundary. Persist only authorized, reviewed, redacted evidence and verify
  sensitive state is removed during cleanup.
