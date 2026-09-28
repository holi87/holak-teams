#!/usr/bin/env bash
# Read-only baseline verify declared in the e2e fixture's solution/environment.tsv. The faulty
# target holds no state, so it is always at its baseline; a real verify checks seeded data
# without changing it. scripts/environment-gate.sh runs it without arguments.
exit 0
