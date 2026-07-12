#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$ROOT/argus/claude/bin/argus-launch"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/target" "$WORK/artifacts"
output="$($LAUNCHER claude --target "$WORK/target" --artifact-root "$WORK/artifacts" --mode B --dry-run)"
[[ "$output" == *'runtime=claude'* ]] || { printf 'FAIL  launcher omitted runtime\n' >&2; exit 1; }
[[ "$output" == *'model=opus effort=max maxTurns=96'* ]] || { printf 'FAIL  launcher omitted exact native baseline\n' >&2; exit 1; }
[[ "$output" == *'sandbox=os-native processInspection=denied inheritedBearerCapabilities=cleared'* ]] || { printf 'FAIL  launcher omitted isolation proof\n' >&2; exit 1; }
if "$LAUNCHER" codex >/dev/null 2>&1; then
  printf 'FAIL  launcher accepted Codex without a native turn cap\n' >&2
  exit 1
fi
if "$LAUNCHER" claude --target "$WORK/target" --artifact-root "$WORK/artifacts" --mode Z --dry-run >/dev/null 2>&1; then
  printf 'FAIL  launcher accepted an invalid mode\n' >&2
  exit 1
fi
if "$LAUNCHER" claude --target "$WORK/target" --artifact-root "$WORK/target" --mode A --dry-run >/dev/null 2>&1; then
  printf 'FAIL  launcher accepted an artifact root inside the target tree\n' >&2
  exit 1
fi
printf 'PASS  Argus native launcher enforces Claude and fails closed for Codex\n'
