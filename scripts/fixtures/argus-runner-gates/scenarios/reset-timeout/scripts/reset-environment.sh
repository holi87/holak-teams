#!/usr/bin/env bash
# Destructive reset of the replay target that never finishes.
printf 'reset\n' >>reports/fake-calls.log
sleep 30
printf 'reset-finished\n' >>reports/fake-calls.log
