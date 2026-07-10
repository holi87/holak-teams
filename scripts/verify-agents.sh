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
#   e) the "## Artifact Language" section exists in every agent and contains
#      the "100% English" rule; wording drift against the team's first agent
#      is reported as a non-fatal WARN (role-specific variants are allowed)
#   f) the Argus plugin exposes a valid /argus:run main-thread entry point
#   g) every Argus runtime asset is packaged, synced, inventoried, and in budget
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

  # --- (e) Artifact Language: present + "100% English" rule; drift is WARN ----
  local e_ok=1 ref_file="" tmp_ref tmp_cur
  tmp_ref="$(mktemp)"
  tmp_cur="$(mktemp)"
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

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "FAILED CHECKS: $FAILURES"
  exit 1
fi
