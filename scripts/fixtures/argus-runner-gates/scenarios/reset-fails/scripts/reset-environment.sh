#!/usr/bin/env bash
# Destructive reset of the replay target that fails.
printf 'reset\n' >>reports/fake-calls.log
exit 1
