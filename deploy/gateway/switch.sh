#!/bin/bash
# Switch the gateway unit to a prepared release, or roll it back. One restart.
# Usage: switch.sh <S> check|activate|rollback
#   check     read-only: the unit still runs the base prepare saw, and the drop-in rewrite is unambiguous
#   activate  rewrite the effective ExecStart drop-in from the live release path to the prepared one, restart, health
#             check (GET /login = 200), roll back automatically on failure
#   rollback  restore the drop-in saved by activate and restart
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: switch.sh <S> check|activate|rollback}; MODE=${2:?mode}
S=$(resolve_sha "$ARG"); OPS=$(ops_dir "$S")
srv "test -s '$OPS/prepared.json'" || die "run prepare.sh first"
tar -C "$REL_DIR/server" -cf - . | srv "tar -xf - -C '$OPS/server'"
case $MODE in
  check) srv "python3 -I '$OPS/server/switch.py' '$OPS' check" ;;
  activate|rollback) run_unit "muse-gateway-$MODE-${S:0:10}" "$OPS/switch.log" "$OPS/switch.exit" "python3 -I '$OPS/server/switch.py' '$OPS' $MODE" ;;
  *) die "unknown mode $MODE" ;;
esac
