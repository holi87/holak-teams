#!/usr/bin/env bash
# verify-agents.sh — consistency checks for the holak-teams plugin marketplace.
#
# Checks, per team (hephaestus: 22 agents, argus: 27 agents):
#   a) number of <team>/claude/agents/*.md files matches the expected count
#   b) frontmatter `name:` equals the file slug for every agent
#   c) Codex parity: every Claude slug has <team>/codex/<slug>.toml + <slug>.md,
#      and every Codex file maps back to a Claude agent (no orphans)
#   d) version in <team>/claude/.claude-plugin/plugin.json equals the plugin's
#      entry version in .claude-plugin/marketplace.json
#   e) Hephaestus keeps its inline Artifact Language contract; every Argus agent
#      preloads the single packaged qa-doctrine skill containing that contract
#   f) the Argus plugin exposes a valid /argus:run main-thread entry point
#   g) every Argus runtime asset is packaged, synced, inventoried, and in budget
#   h) every Argus frontmatter and runtime lane has a validated capability contract
#   i) risky lanes share one deny-by-default authorization, audit, and redaction policy
#   j) every lane shares the packaged immutability, ownership, barrier, and cleanup runtime
#   k) canonical QA contracts reject malformed fixtures and render a source-versioned summary
#   l) all framework templates share explicit runner modes, lifecycle, categories, and exits
#   m) coverage is derived from discovered target surfaces and defects cannot improve it
#   n) all agent, artifact, transition, and routing ownership comes from one RACI source
#   o) shared doctrine is preloaded once and prompt size/duplication budgets hold
#   p) one model source controls Claude/Codex tiers, effort, turns, escalation, and telemetry
#
# Exit code: 0 when every check passes, 1 otherwise.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE="$ROOT/.claude-plugin/marketplace.json"
FAILURES=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# Extract the first `"version": "x.y.z"` value found in a file.
json_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# Extract the version of a plugin's entry in marketplace.json:
# the first "version" that appears after the `"name": "<team>"` line.
marketplace_plugin_version() {
  awk -v team="\"$1\"" '
    index($0, "\"name\": " team) { found = 1 }
    found && /"version"/ {
      line = $0
      sub(/.*"version"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
  ' "$MARKETPLACE"
}

# Extract the frontmatter `name:` value (first block delimited by --- lines).
frontmatter_name() {
  awk '
    /^---[[:space:]]*$/ { blocks++; next }
    blocks == 1 && /^name:[[:space:]]*/ {
      sub(/^name:[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit
    }
    blocks >= 2 { exit }
  ' "$1"
}

# Extract the "## Artifact Language" section (heading included, up to the
# next "## " heading or EOF).
artifact_language_section() {
  awk '
    /^## Artifact Language/ { p = 1 }
    p && /^## / && !/^## Artifact Language/ { exit }
    p { print }
  ' "$1"
}

check_team() {
  local team="$1" expected="$2"
  local agents_dir="$ROOT/$team/claude/agents"
  local codex_dir="$ROOT/$team/codex"
  local plugin_json="$ROOT/$team/claude/.claude-plugin/plugin.json"

  echo ""
  echo "=== Team: $team (expected agents: $expected) ==="

  # --- (a) agent file count -------------------------------------------------
  local count
  count=$(ls "$agents_dir"/*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -eq "$expected" ]; then
    pass "[$team] (a) agent count: $count == $expected"
  else
    fail "[$team] (a) agent count: found $count, expected $expected"
  fi

  # --- (b) frontmatter name == slug ------------------------------------------
  local b_ok=1 file slug fm_name
  for file in "$agents_dir"/*.md; do
    slug="$(basename "$file" .md)"
    fm_name="$(frontmatter_name "$file")"
    if [ "$fm_name" != "$slug" ]; then
      fail "[$team] (b) frontmatter name mismatch: $slug.md has name '${fm_name}' (expected '$slug')"
      b_ok=0
    fi
  done
  [ "$b_ok" -eq 1 ] && pass "[$team] (b) frontmatter name == slug for all agents"

  # --- (c) Codex parity -------------------------------------------------------
  local c_ok=1
  for file in "$agents_dir"/*.md; do
    slug="$(basename "$file" .md)"
    if [ ! -f "$codex_dir/$slug.toml" ]; then
      fail "[$team] (c) missing Codex file: $team/codex/$slug.toml"
      c_ok=0
    fi
    if [ ! -f "$codex_dir/$slug.md" ]; then
      fail "[$team] (c) missing Codex file: $team/codex/$slug.md"
      c_ok=0
    fi
  done
  # Reverse direction: no orphan Codex files without a Claude agent.
  local codex_file
  for codex_file in "$codex_dir"/*.toml "$codex_dir"/*.md; do
    [ -e "$codex_file" ] || continue
    slug="$(basename "$codex_file")"
    slug="${slug%.*}"
    if [ ! -f "$agents_dir/$slug.md" ]; then
      fail "[$team] (c) orphan Codex file (no Claude agent): $team/codex/$(basename "$codex_file")"
      c_ok=0
    fi
  done
  [ "$c_ok" -eq 1 ] && pass "[$team] (c) Codex parity: every slug has .toml + .md, no orphans"

  # --- (d) plugin.json version == marketplace.json entry version -------------
  local plugin_ver market_ver
  plugin_ver="$(json_version "$plugin_json")"
  market_ver="$(marketplace_plugin_version "$team")"
  if [ -n "$plugin_ver" ] && [ "$plugin_ver" = "$market_ver" ]; then
    pass "[$team] (d) version match: plugin.json ($plugin_ver) == marketplace.json ($market_ver)"
  else
    fail "[$team] (d) version mismatch: plugin.json '$plugin_ver' != marketplace.json '$market_ver'"
  fi

  # --- (e) Artifact Language: inline for Hephaestus, preloaded for Argus -------
  local e_ok=1 ref_file="" tmp_ref tmp_cur
  tmp_ref="$(mktemp)"
  tmp_cur="$(mktemp)"
  if [ "$team" = "argus" ]; then
    local doctrine="$ROOT/argus/claude/skills/qa-doctrine/SKILL.md"
    if [ ! -f "$doctrine" ] || ! grep -q '100% English' "$doctrine"; then
      fail "[argus] (e) packaged qa-doctrine is missing the '100% English' contract"
      e_ok=0
    fi
    for file in "$agents_dir"/*.md; do
      slug="$(basename "$file" .md)"
      if ! awk '
        /^---[[:space:]]*$/ { blocks++; next }
        blocks == 1 && /^skills:[[:space:]]*$/ { skills = 1; next }
        blocks == 1 && skills && /^[[:space:]]*-[[:space:]]*qa-doctrine[[:space:]]*$/ { found = 1 }
        blocks == 1 && skills && !/^[[:space:]]*-/ && !/^[[:space:]]*$/ { skills = 0 }
        blocks >= 2 { exit(found ? 0 : 1) }
        END { if (blocks < 2) exit 1 }
      ' "$file"; then
        fail "[argus] (e) $slug.md does not preload qa-doctrine"
        e_ok=0
      fi
    done
    rm -f "$tmp_ref" "$tmp_cur"
    [ "$e_ok" -eq 1 ] && pass "[argus] (e) all agents preload packaged qa-doctrine with the '100% English' contract"
    return
  fi
  for file in "$agents_dir"/*.md; do
    slug="$(basename "$file" .md)"
    artifact_language_section "$file" > "$tmp_cur"
    if [ ! -s "$tmp_cur" ]; then
      fail "[$team] (e) missing '## Artifact Language' section in $slug.md"
      e_ok=0
      continue
    fi
    if ! grep -q '100% English' "$tmp_cur"; then
      fail "[$team] (e) Artifact Language section in $slug.md lacks the '100% English' rule"
      e_ok=0
      continue
    fi
    if [ -z "$ref_file" ]; then
      ref_file="$slug.md"
      cp "$tmp_cur" "$tmp_ref"
      continue
    fi
    # Role-specific additions (e.g. automation framework rules) are allowed.
    if ! diff -q "$tmp_ref" "$tmp_cur" > /dev/null; then
      warn "[$team] (e) Artifact Language wording differs from $ref_file in $slug.md (role-specific variant)"
    fi
  done
  rm -f "$tmp_ref" "$tmp_cur"
  [ "$e_ok" -eq 1 ] && pass "[$team] (e) Artifact Language present with '100% English' rule in all agents"
}

check_team "hephaestus" 22
check_team "argus" 27

echo ""
echo "=== Argus main-thread orchestration ==="
if "$ROOT/scripts/smoke-argus-run.sh" --static; then
  pass "[argus] (f) /argus:run skill, preflight, and Odysseus runtime contract"
else
  fail "[argus] (f) /argus:run main-thread orchestration contract"
fi

if "$ROOT/scripts/smoke-argus-assets.sh" --static; then
  pass "[argus] (g) runtime assets packaged, synced, inventoried, and in budget"
else
  fail "[argus] (g) runtime asset packaging contract"
fi

if "$ROOT/scripts/smoke-argus-preflight.sh"; then
  pass "[argus] (h) supported tool vocabulary and full/partial/insufficient preflight contract"
else
  fail "[argus] (h) capability-based runtime preflight contract"
fi

if "$ROOT/scripts/smoke-argus-authorization.sh"; then
  pass "[argus] (i) authorization, production safety, audit, injection boundary, and redaction"
else
  fail "[argus] (i) shared authorization and redaction policy"
fi

if "$ROOT/scripts/smoke-argus-engagement.sh"; then
  pass "[argus] (j) target immutability, single-writer ownership, deterministic parallel state, and cleanup"
else
  fail "[argus] (j) engagement immutability and concurrency contract"
fi

if "$ROOT/scripts/smoke-argus-browser-policy.sh"; then
  pass "[argus] (j2) WCAG 2.2 defaults, risk-derived browser coverage, managed sessions, and privacy-safe evidence"
else
  fail "[argus] (j2) accessibility and managed browser-session policy"
fi

if "$ROOT/scripts/smoke-argus-schemas.sh"; then
  pass "[argus] (k) canonical schemas, fixtures, fragment compatibility, and source-versioned summary"
else
  fail "[argus] (k) canonical QA contract"
fi

if "$ROOT/scripts/smoke-argus-runner-contract.sh"; then
  pass "[argus] (l) runner modes, defect lifecycle, outcome categories, and exit codes"
else
  fail "[argus] (l) runner outcome contract"
fi

if "$ROOT/scripts/smoke-argus-templates.sh"; then
  pass "[argus] (l2) capability detection, explicit selection, path adapters, shared semantics, and clean-room templates"
else
  fail "[argus] (l2) capability-based template contract"
fi

if "$ROOT/scripts/smoke-argus-coverage.sh"; then
  pass "[argus] (m) target-derived, risk-weighted coverage and defect-neutral quality metrics"
else
  fail "[argus] (m) surface-derived coverage contract"
fi

if "$ROOT/scripts/smoke-argus-raci.sh"; then
  pass "[argus] (n) 27-agent RACI, single-owner artifacts/transitions, prompt descriptions, and runtime routing"
else
  fail "[argus] (n) RACI ownership and routing contract"
fi

if node "$ROOT/scripts/check-argus-prompts.mjs"; then
  pass "[argus] (o) preloaded doctrine, prompt budgets, duplicate detection, and engagement regression contract"
else
  fail "[argus] (o) compact prompt and shared-doctrine contract"
fi

if "$ROOT/scripts/smoke-argus-model-policy.sh" && node "$ROOT/scripts/benchmark-argus-model-policy.mjs" --check; then
  pass "[argus] (p) 10/17 model tiers, effort/turns, escalation/fallback, sanitized telemetry, and benchmark"
else
  fail "[argus] (p) runtime model policy contract"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "FAILED CHECKS: $FAILURES"
  exit 1
fi
