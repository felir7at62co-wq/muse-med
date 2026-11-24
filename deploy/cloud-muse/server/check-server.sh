#!/bin/bash
# Post-release checks (root, on the server). Usage:
#   check-server.sh <full sha> [--restart-wait SECONDS] [--keep-paused] [--check-only]
# --check-only runs the checks that need no before.json against whatever runs now and changes nothing.
# On success it lifts the transcription pause only if switch.sh set it, and writes checked.ok.
set -euo pipefail
S=${1:?full commit sha}; shift
WAIT=300; KEEP=0; CHECK_ONLY=0
while [ $# -gt 0 ]; do case $1 in --restart-wait) WAIT=$2; shift;; --keep-paused) KEEP=1;; --check-only) CHECK_ONLY=1;; *) echo "unknown option $1" >&2; exit 64;; esac; shift; done
source "$(dirname "$0")/env.sh"
GATE=(python3 "$(dirname "$0")/gate.py")
if [ "$CHECK_ONLY" = 1 ]; then
  say "read-only checks against the running service"
  exp=(); [ -f "$OPS/prepared.json" ] && [ -f "$OPS/switched.ok" ] && exp=(--expected "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nextClientSHA"])' "$OPS/prepared.json")")
  "${GATE[@]}" live-check "${exp[@]}"; exit $?
fi
[ -f "$OPS/switched.ok" ] || die "no switched.ok: switch did not finish"
exec > >(tee -a "$OPS/logs/check.log") 2>&1
say "post-release checks for $S (NRestarts window ${WAIT}s)"
"${GATE[@]}" check --before "$OPS/before.json" --expected "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nextClientSHA"])' "$OPS/prepared.json")" \
  --release "$RELEASE" --restart-wait "$WAIT" --out "$OPS/after.json" || die "checks failed: run rollback.sh (transcription stays paused)"
if [ "$KEEP" = 0 ]; then "${GATE[@]}" runner-restore "$OPS/runner-pause.json"; fi
date -Is > "$OPS/checked.ok"
say "all checks passed"
