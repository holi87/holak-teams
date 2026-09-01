.PHONY: validate eval

# Full marketplace release gate (same script CI runs).
validate:
	scripts/validate-release.sh

# Score one Argus engagement against a PRIVATE answer key.
# The key never lives in this repository: point ARGUS_ANSWER_KEY at a file outside the tree.
#
#   make eval RUN=/path/to/engagement
#   make eval RUN=/path/to/engagement OVERRIDES=/path/to/overrides.json
eval:
	@test -n "$(RUN)" || { printf 'FAIL  set RUN=<engagement-root>\n' >&2; exit 1; }
	@test -n "$(ARGUS_ANSWER_KEY)" || { printf 'FAIL  set ARGUS_ANSWER_KEY=<path outside this repo>\n' >&2; exit 1; }
	node scripts/eval/score-against-key.mjs --run "$(RUN)" $(if $(OVERRIDES),--overrides "$(OVERRIDES)",)
