#!/usr/bin/env bash
# Complete local and CI release gate for the holak-teams marketplace.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { printf 'FAIL  Node.js is required\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'FAIL  jq is required\n' >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { printf 'FAIL  Claude Code CLI is required\n' >&2; exit 1; }

npm ci --ignore-scripts >/dev/null
scripts/smoke-marketplace-contracts.sh
scripts/smoke-prompt-regression.sh
node scripts/validate-argus-technique-catalogs.mjs
node scripts/sync-argus-technique-bundle.mjs --check
node scripts/release-plugin.mjs --plugin argus --check
claude plugin validate --strict . >/dev/null
claude plugin validate --strict argus/claude >/dev/null
claude plugin validate --strict hephaestus/claude >/dev/null
scripts/sync-argus-runtime-assets.mjs --check
scripts/smoke-argus-launcher.sh
scripts/smoke-argus-technique-selection.sh
node scripts/sync-argus-raci.mjs --check
node scripts/sync-argus-model-policy.mjs --check
scripts/smoke-argus-generator-ownership.sh
scripts/smoke-agent-runtime-parity.sh
node scripts/benchmark-argus-model-policy.mjs --check
scripts/verify-agents.sh
scripts/smoke-marketplace-lifecycle.sh

printf 'PASS  Full marketplace release validation completed\n'
