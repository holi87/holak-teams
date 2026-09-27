.PHONY: validate eval eval-smoke eval-gate

# Full marketplace release gate (same script CI runs).
validate:
	scripts/validate-release.sh

# Score one Argus engagement against a PRIVATE answer key.
# The key never lives in this repository: point ARGUS_ANSWER_KEY at a file outside the tree.
#
#   make eval RUN=/path/to/engagement
#   make eval RUN=/path/to/engagement VERDICTS=/path/to/verdicts.json
#
# OVERRIDES=<path> is a deprecated alias of VERDICTS=<path>; VERDICTS wins when both are set.
eval:
	@test -n "$(RUN)" || { printf 'FAIL  set RUN=<engagement-root>\n' >&2; exit 1; }
	@test -n "$(ARGUS_ANSWER_KEY)" || { printf 'FAIL  set ARGUS_ANSWER_KEY=<path outside this repo>\n' >&2; exit 1; }
	@$(if $(OVERRIDES),printf 'WARN  OVERRIDES is deprecated; pass VERDICTS=<path>\n' >&2,true)
	node scripts/eval/score-against-key.mjs --run "$(RUN)" $(if $(or $(VERDICTS),$(OVERRIDES)),--verdicts "$(or $(VERDICTS),$(OVERRIDES))",)

# Every evaluation harness smoke suite (scripts/eval/**/smoke*.mjs); no model is called.
eval-smoke:
	node scripts/eval/run-smokes.mjs

# The recorded-baseline discovery gate, as the release gate runs it. It prints SKIP while
# scripts/eval/discovery/baseline.json is not recorded.
#
# Discovery evaluation flow (maintainer-only; see scripts/eval/discovery/README.md):
#   node scripts/eval/discovery/run.mjs <comparison.json> <output-dir>                   paired, repeated hunts
#   node scripts/eval/discovery/judge.mjs --runs <private-runs.json> --output <judge.json>  first-pass Opus judge
#   node scripts/eval/discovery/spotcheck.mjs sample ... then spotcheck.mjs finalize ...   human spot-check -> final verdicts
#   node scripts/eval/discovery/adjudicate.mjs --runs ... --verdicts ... --output <summary.json> --isolation separate-user
#   node scripts/eval/discovery/record-baseline.mjs --summary <summary.json> --variant <name> [--write]
eval-gate:
	node scripts/eval/discovery/gate.mjs --check
