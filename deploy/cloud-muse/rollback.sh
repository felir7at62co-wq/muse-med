#!/bin/bash
# Put the previous release back. Usage: rollback.sh <S> [--restore-state] [--check-only]
#   --check-only     read-only: show what a rollback would find and restore
#   --restore-state  also restore the small state backup taken at the stop (loses Bot/Session changes since)
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: rollback.sh <S> [options]}; shift
S=$(resolve_sha "$ARG"); SHORT=${S:0:10}; OPS=$(ops_dir "$S")
if [[ " $* " == *" --check-only "* ]]; then
  srv "test -f '$OPS/server/rollback-server.sh'" || { echo "nothing to roll back: $OPS/server missing"; exit 0; }
  srv "bash '$OPS/server/rollback-server.sh' $S --check-only"; exit $?
fi
say "server scripts gate.py $(sync_server_scripts "$S")"
run_unit "muse-cloud-rollback-$SHORT" "$OPS/logs/rollback-run.log" "$OPS/rollback.exit" /bin/bash "$OPS/server/rollback-server.sh" "$S" "$@" \
  || die "rollback did not complete; see $OPS/logs/rollback.log and README (manual rollback)"
deliver_login_link "$S"
say "rolled back"
