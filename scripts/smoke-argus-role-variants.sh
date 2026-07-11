#!/usr/bin/env bash
# Validate generated Claude and Codex roles with both native runtimes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v claude >/dev/null 2>&1 || { printf 'FAIL  Claude Code CLI is required\n' >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { printf 'FAIL  Codex CLI is required\n' >&2; exit 1; }

node "$ROOT/scripts/sync-argus-role-variants.mjs" --check
claude plugin validate --strict "$ROOT/argus/claude" >/dev/null

python3 - "$ROOT" <<'PY'
import pathlib
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
files = sorted((root / "argus/codex").glob("*.toml"))
assert len(files) == 27, f"expected 27 Codex TOML roles, found {len(files)}"
allowed_keys = {"name", "description", "model", "sandbox_mode", "model_reasoning_effort", "developer_instructions"}
read_only = {"aristarchus", "tiresias"}
for path in files:
    with path.open("rb") as handle:
        role = tomllib.load(handle)
    slug = path.stem
    assert set(role) == allowed_keys, f"{slug}: unsupported or missing Codex keys: {set(role) ^ allowed_keys}"
    assert role["name"] == slug, f"{slug}: name mismatch"
    assert role["model"] in {"sol", "terra", "luna"}, f"{slug}: non-native model alias"
    assert role["model_reasoning_effort"] in {"medium", "xhigh"}, f"{slug}: invalid reasoning effort"
    expected_sandbox = "read-only" if slug in read_only else "workspace-write"
    assert role["sandbox_mode"] == expected_sandbox, f"{slug}: sandbox does not follow capability write policy"
    instructions = role["developer_instructions"]
    for marker in ["## Generated Semantic Contract", "## Explicit runtime differences", "## Shared QA Doctrine", "## Role Instructions", "Artifact language: 100% English"]:
        assert marker in instructions, f"{slug}: missing semantic marker {marker}"
    assert f"argus/roles/{slug}.md" in instructions, f"{slug}: canonical source provenance missing"
    assert f"argus/claude/{slug}.md" not in instructions, f"{slug}: stale Claude source path survived"
PY

mkdir "$WORK/agents"
cp "$ROOT"/argus/codex/*.toml "$WORK/agents/"
CODEX_HOME="$WORK" codex doctor --json >"$WORK/doctor.json" || true
jq -e '.checks["config.load"].status == "ok" and ((.checks["config.load"].details["startup warnings"] // "0") == "0")' "$WORK/doctor.json" >/dev/null || {
  jq '.checks["config.load"]' "$WORK/doctor.json" >&2
  printf 'FAIL  Codex native config loader rejected generated agents\n' >&2
  exit 1
}

printf 'PASS  Native role validation: Claude plugin + 27 Codex TOML agents loaded without warnings\n'
