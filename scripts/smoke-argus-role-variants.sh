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
import hashlib
import json
import pathlib
import re
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
files = sorted((root / "argus/codex").glob("*.toml"))
markdown_files = sorted((root / "argus/codex").glob("*.md"))
assert len(files) == 27, f"expected 27 Codex TOML roles, found {len(files)}"
assert len(markdown_files) == 27, f"expected 27 Codex provenance stubs, found {len(markdown_files)}"
allowed_keys = {"name", "description", "model", "sandbox_mode", "model_reasoning_effort", "developer_instructions"}
provenance_fields = [
    "schema", "slug", "display_name", "runtime_config", "runtime_config_sha256",
    "developer_instructions_sha256", "canonical_source", "canonical_source_sha256",
    "model", "model_reasoning_effort", "sandbox_mode", "doctrine_profiles",
    "technique_catalogs", "generated_by", "runtime_consumed",
]
capabilities = json.loads((root / "argus/capabilities/capability-matrix.json").read_text())
capabilities_by_slug = {agent["slug"]: agent for agent in capabilities["agents"]}
provenance_bytes = 0


def digest(value):
    return hashlib.sha256(value).hexdigest()


def contract_list(capability, fields, fallback):
    selected = next((field for field in fields if field in capability), None)
    values = capability[selected] if selected else fallback
    assert isinstance(values, list) and all(isinstance(value, str) and value and value.strip() == value for value in values), \
        f"{capability['slug']}: invalid {selected or fields[0]} provenance list"
    assert len(values) == len(set(values)), f"{capability['slug']}: duplicate provenance list values"
    return values


def parse_provenance(path, slug):
    raw = path.read_text()
    assert raw.startswith("---\n"), f"{slug}: provenance frontmatter missing"
    frontmatter, body = raw[4:].split("\n---\n", 1)
    entries = []
    for line in frontmatter.splitlines():
        match = re.fullmatch(r"([a-z][a-z0-9_]*):\s*(.*)", line)
        assert match, f"{slug}: malformed provenance field: {line}"
        entries.append((match.group(1), match.group(2)))
    assert [field for field, _ in entries] == provenance_fields, f"{slug}: provenance fields or order drift"
    assert len({field for field, _ in entries}) == len(entries), f"{slug}: duplicate provenance field"
    values = dict(entries)
    for field in ("doctrine_profiles", "technique_catalogs"):
        values[field] = json.loads(values[field])
        assert isinstance(values[field], list) and all(isinstance(value, str) for value in values[field]), \
            f"{slug}: {field} is not a string array"
    expected_body = f"\n# {' '.join(part.capitalize() for part in slug.split('-'))} - Codex provenance\n\nGenerated metadata only. Codex loads `{slug}.toml`; this Markdown file is not runtime input.\n"
    assert body == expected_body, f"{slug}: provenance body drift"
    return raw, values


for path in files:
    toml_bytes = path.read_bytes()
    with path.open("rb") as handle:
        role = tomllib.load(handle)
    slug = path.stem
    capability = capabilities_by_slug[slug]
    assert set(role) == allowed_keys, f"{slug}: unsupported or missing Codex keys: {set(role) ^ allowed_keys}"
    assert role["name"] == slug, f"{slug}: name mismatch"
    assert role["model"] in {"sol", "terra", "luna"}, f"{slug}: non-native model alias"
    assert role["model_reasoning_effort"] in {"medium", "xhigh"}, f"{slug}: invalid reasoning effort"
    expected_sandbox = "workspace-write" if "Write" in capability["requiredTools"] else "read-only"
    assert role["sandbox_mode"] == expected_sandbox, f"{slug}: sandbox does not follow capability write policy"
    instructions = role["developer_instructions"]
    for marker in ["# Runtime capability delta", "## Capability-selected doctrine", "## Role instructions", "100% English"]:
        assert marker in instructions, f"{slug}: missing semantic marker {marker}"
    assert "## Explicit runtime differences" not in instructions, f"{slug}: cross-runtime comparison remains active"
    assert f"argus/roles/{slug}.md" not in instructions, f"{slug}: provenance path leaked into active instructions"
    assert f"argus/claude/{slug}.md" not in instructions, f"{slug}: stale Claude source path survived"
    if slug != "odysseus":
        for provider_model in ["opus", "sonnet", "haiku", "sol", "terra", "luna"]:
            assert not re.search(rf"\b{provider_model}\b", instructions, re.IGNORECASE), f"{slug}: provider model token leaked into active instructions: {provider_model}"
        assert "Claude" not in instructions, f"{slug}: opposite runtime leaked into active instructions"
        assert "argus-assets model route" not in instructions, f"{slug}: worker can invoke model routing"
        assert "argus-assets model telemetry" not in instructions, f"{slug}: worker can invoke model telemetry"
        assert "MODEL_ESCALATION_REQUEST" in instructions, f"{slug}: worker escalation envelope missing"
    else:
        assert "argus-assets model route --manifest" in instructions, "odysseus: capability-bound route command missing"
        assert "argus-assets model telemetry --manifest" in instructions, "odysseus: decision-bound telemetry command missing"

    markdown_raw, provenance = parse_provenance(root / f"argus/codex/{slug}.md", slug)
    stub_bytes = len(markdown_raw.encode())
    assert stub_bytes < 1500, f"{slug}: provenance stub is {stub_bytes} bytes; must be < 1500"
    provenance_bytes += stub_bytes
    assert provenance["schema"] == "argus/codex-provenance@1", f"{slug}: provenance schema mismatch"
    assert provenance["slug"] == slug, f"{slug}: provenance slug mismatch"
    assert provenance["display_name"] == " ".join(part.capitalize() for part in slug.split("-")), f"{slug}: display name mismatch"
    assert provenance["runtime_config"] == f"argus/codex/{slug}.toml", f"{slug}: runtime config path mismatch"
    assert provenance["runtime_config_sha256"] == digest(toml_bytes), f"{slug}: TOML SHA-256 drift"
    assert provenance["developer_instructions_sha256"] == digest(instructions.encode()), f"{slug}: developer_instructions SHA-256 drift"
    source = root / f"argus/roles/{slug}.md"
    assert provenance["canonical_source"] == f"argus/roles/{slug}.md", f"{slug}: canonical source path mismatch"
    assert provenance["canonical_source_sha256"] == digest(source.read_bytes()), f"{slug}: canonical source SHA-256 drift"
    assert provenance["model"] == role["model"], f"{slug}: provenance model drift"
    assert provenance["model_reasoning_effort"] == role["model_reasoning_effort"], f"{slug}: provenance effort drift"
    assert provenance["sandbox_mode"] == role["sandbox_mode"], f"{slug}: provenance sandbox drift"
    assert provenance["doctrine_profiles"] == contract_list(capability, ["doctrineProfiles", "doctrine_profiles"], ["qa-core"]), f"{slug}: doctrine profile drift"
    assert provenance["technique_catalogs"] == contract_list(capability, ["techniqueCatalogs", "technique_catalogs"], []), f"{slug}: technique catalog drift"
    assert provenance["generated_by"] == "scripts/sync-argus-role-variants.mjs", f"{slug}: generator provenance drift"
    assert provenance["runtime_consumed"] == "false", f"{slug}: runtime_consumed must be false"
    assert not re.search(r"\b(?:Claude|opus|sonnet|haiku)\b", markdown_raw, re.IGNORECASE), f"{slug}: opposite-runtime model leaked into provenance"
    for forbidden in ["description:", "tier:", "maxTurns", "developer_instructions =", "# Codex runtime adapter", "## Shared QA Doctrine", "## Role Instructions", "## Generated Semantic Contract"]:
        assert forbidden not in markdown_raw, f"{slug}: runtime content leaked into provenance: {forbidden}"

assert provenance_bytes < 40000, f"Codex provenance corpus is {provenance_bytes} bytes; must be < 40000"
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
