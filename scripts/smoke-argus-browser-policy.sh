#!/usr/bin/env bash
# Verify WCAG defaults, risk-derived browser coverage, managed profile ownership,
# crash recovery, sensitive-artifact cleanup, and privacy-safe evidence fixtures.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/argus/claude/bin/argus-assets"
FIXTURES="$ROOT/scripts/fixtures/argus-browser"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

init_target() {
  local name="$1"
  shift
  mkdir -p "$WORK/$name"
  "$CLI" engagement init --target "$WORK/$name" --artifact-root "$WORK/$name" \
    --mode A --engagement-id "$name" "$@" >/dev/null
}

# New engagements default to WCAG 2.2 AA and record conservative risk-derived coverage.
init_target default
DEFAULT="$WORK/default/ai_agents_internal/engagement.json"
jq -e '.accessibilityPolicy == {standard:"WCAG",version:"2.2",level:"AA",exception:null}' "$DEFAULT" >/dev/null || fail "default accessibility policy is not WCAG 2.2 AA"
jq -e '.browserPolicy.coverage.derivation == "target-support-and-risk" and .browserPolicy.coverage.supportSource == "conservative-unknown" and (.browserPolicy.coverage.matrix | length) > 0' "$DEFAULT" >/dev/null || fail "default browser coverage lacks risk derivation"

# Declared support expands deterministically into the exact browser x viewport matrix.
init_target supported --browser-support "$FIXTURES/browser-support.json"
SUPPORTED="$WORK/supported/ai_agents_internal/engagement.json"
jq -e '.browserPolicy.coverage.supportSource == "product-support-policy-2026" and (.browserPolicy.coverage.matrix | length) == 4 and ([.browserPolicy.coverage.matrix[].browser] | unique) == ["chromium","firefox"]' "$SUPPORTED" >/dev/null || fail "declared browser support was not converted to a four-cell matrix"

# Older WCAG versions require a complete, explicit project-requirement exception.
init_target legacy --accessibility-requirement "$FIXTURES/accessibility-legacy-requirement.json"
LEGACY="$WORK/legacy/ai_agents_internal/engagement.json"
jq -e '.accessibilityPolicy.version == "2.1" and .accessibilityPolicy.level == "AA" and .accessibilityPolicy.exception.requirementSource == "REQ-A11Y-LEGACY-001"' "$LEGACY" >/dev/null || fail "legacy accessibility exception was not recorded"
printf '%s\n' '{"version":"2.1","level":"AA","reason":"missing authority"}' >"$WORK/invalid-accessibility.json"
mkdir -p "$WORK/invalid"
if "$CLI" engagement init --target "$WORK/invalid" --artifact-root "$WORK/invalid" --mode A --accessibility-requirement "$WORK/invalid-accessibility.json" >/dev/null 2>&1; then
  fail "incomplete older-standard exception unexpectedly passed"
fi

# Isolated allocations own unique profiles and browser-artifact roots inside the boundary.
ODYSSEUS="$($CLI engagement allocate --manifest "$DEFAULT" --lane odysseus)"
KALCHAS="$($CLI engagement allocate --manifest "$DEFAULT" --lane kalchas)"
[ "$(jq -r .browserProfile <<<"$ODYSSEUS")" != "$(jq -r .browserProfile <<<"$KALCHAS")" ] || fail "isolated lanes share a profile"
[ "$(jq -r .browserArtifactsDirectory <<<"$ODYSSEUS")" != "$(jq -r .browserArtifactsDirectory <<<"$KALCHAS")" ] || fail "isolated lanes share browser artifacts"
for allocation in "$ODYSSEUS" "$KALCHAS"; do
  root="$(jq -r .browserArtifactsDirectory <<<"$allocation")"
  case "$root" in "$WORK/default"/*) ;; *) fail "browser artifacts escaped the engagement boundary" ;; esac
  for child in downloads traces videos screenshots; do [ -d "$root/$child" ] || fail "missing managed $child directory"; done
done

# Missing lease means an interrupted process: stale sensitive state is removed before reallocation.
ODYSSEUS_ROOT="$WORK/default/ai_agents_internal/workers/odysseus"
touch "$ODYSSEUS_ROOT/browser-profile/stale-cookie" "$ODYSSEUS_ROOT/auth/stale-token" \
  "$ODYSSEUS_ROOT/browser-artifacts/downloads/stale-download" "$ODYSSEUS_ROOT/tmp/stale-state"
rm "$ODYSSEUS_ROOT/.lease"
RECOVERED="$($CLI engagement allocate --manifest "$DEFAULT" --lane odysseus)"
[ "$(jq -r .recoveredFromCrash <<<"$RECOVERED")" = true ] || fail "crash recovery was not reported"
for stale in browser-profile/stale-cookie auth/stale-token browser-artifacts/downloads/stale-download tmp/stale-state; do
  [ ! -e "$ODYSSEUS_ROOT/$stale" ] || fail "crash recovery retained $stale"
done

# Success, failure, and interruption all remove browser-sensitive state.
for spec in "odysseus:success:$RECOVERED" "kalchas:interrupted:$KALCHAS"; do
  lane="${spec%%:*}"; rest="${spec#*:}"; outcome="${rest%%:*}"; allocation="${rest#*:}"
  token="$(jq -r .token <<<"$allocation")"
  root="$WORK/default/ai_agents_internal/workers/$lane"
  touch "$root/browser-profile/session" "$root/auth/token" "$root/browser-artifacts/traces/trace.zip" "$root/browser-artifacts/videos/video.webm" "$root/browser-artifacts/screenshots/shot.png" "$root/tmp/transient"
  "$CLI" engagement cleanup --manifest "$DEFAULT" --lane "$lane" --token "$token" --outcome "$outcome" >/dev/null
  for child in browser-profile browser-artifacts auth tmp .lease; do [ ! -e "$root/$child" ] || fail "$outcome cleanup retained $lane/$child"; done
done

# Explicit shared-session mode names all lanes and keeps shared state until the final cleanup.
init_target shared
SHARED="$WORK/shared/ai_agents_internal/engagement.json"
node - "$SHARED" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.browserPolicy.sessionMode = 'shared-authorized';
manifest.browserPolicy.sharedSessionAuthorization = {
  id: 'review-session',
  lanes: ['odysseus', 'kalchas'],
  accountAlias: 'support-reviewer',
  approvedBy: 'engagement-owner',
  reason: 'Observe one explicitly shared customer-support session.',
  authorizationRuleId: 'AUTH-BROWSER-SHARED-001',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
"$CLI" engagement validate --manifest "$SHARED" >/dev/null
SHARED_O="$($CLI engagement allocate --manifest "$SHARED" --lane odysseus)"
SHARED_K="$($CLI engagement allocate --manifest "$SHARED" --lane kalchas)"
SHARED_PROFILE="$(jq -r .browserProfile <<<"$SHARED_O")"
[ "$SHARED_PROFILE" = "$(jq -r .browserProfile <<<"$SHARED_K")" ] || fail "authorized lanes did not receive the shared profile"
[ "$(jq -r .browserProfileOwner <<<"$SHARED_O")" = "shared-session:review-session" ] || fail "shared profile owner is not explicit"
[ "$(jq -r .accountAlias <<<"$SHARED_O")" = "support-reviewer" ] && [ "$(jq -r .accountAlias <<<"$SHARED_K")" = "support-reviewer" ] || fail "shared session does not use its authorized account"
"$CLI" engagement cleanup --manifest "$SHARED" --lane odysseus --token "$(jq -r .token <<<"$SHARED_O")" --outcome interrupted >/dev/null
[ -d "$SHARED_PROFILE" ] || fail "first shared-lane cleanup removed an active peer profile"
"$CLI" engagement cleanup --manifest "$SHARED" --lane kalchas --token "$(jq -r .token <<<"$SHARED_K")" --outcome failure >/dev/null
[ ! -e "$SHARED_PROFILE" ] || fail "final shared-lane cleanup retained the shared profile"

# Text evidence is redacted from a browser-specific fixture; binary evidence fails closed.
"$CLI" redact --input "$FIXTURES/sensitive-evidence.txt" --output "$WORK/safe-evidence.txt" >/dev/null
for secret in eyJaaaaaa.bbbbbb.cccccc raw-browser-cookie person@example.com super-secret-password; do
  if grep -Fq "$secret" "$WORK/safe-evidence.txt"; then fail "redaction fixture leaked $secret"; fi
done
grep -Eq '\[REDACTED:(TOKEN|COOKIE|EMAIL|PASSWORD)\]' "$WORK/safe-evidence.txt" || fail "redaction fixture emitted no redaction markers"
printf '\211PNG\r\n\032\n\000browser-secret' >"$WORK/sensitive.png"
if "$CLI" redact --input "$WORK/sensitive.png" --output "$WORK/safe.png" >/dev/null 2>&1; then fail "binary browser evidence unexpectedly passed redaction"; fi
[ ! -e "$WORK/safe.png" ] || fail "binary browser evidence produced an unreviewed output"

# Every shipped framework carries the report contract and WCAG 2.2 automation tags.
for runtime in framework-template framework-template-java framework-template-python; do
  report="$ROOT/argus/$runtime/solution/ACCESSIBILITY-REPORT.md"
  for required in 'Standard: `WCAG 2.2`' 'Level: `AA`' 'Tools and automated checks' 'Manual checks' 'Findings and limitations' 'privacy-safe evidence'; do
    grep -Fq "$required" "$report" || fail "$runtime accessibility report is missing: $required"
  done
done
grep -Fq "'wcag22aa'" "$ROOT/argus/framework-template/tests/ui/a11y.smoke.spec.ts" || fail "TypeScript accessibility scan does not request WCAG 2.2 AA tags"
grep -Fq 'ARGUS_BROWSER_ARTIFACTS' "$ROOT/argus/framework-template/scripts/hunt-driver.mjs" || fail "browser driver does not require the managed artifact boundary"
grep -Fq "isWithin(join(browserArtifactsDir, 'screenshots'), output)" "$ROOT/argus/framework-template/scripts/hunt-driver.mjs" || fail "browser driver does not confine screenshots"

printf 'PASS  Argus browser policy: WCAG 2.2 AA, risk-derived coverage, managed profiles, cleanup, and redaction fixtures\n'
