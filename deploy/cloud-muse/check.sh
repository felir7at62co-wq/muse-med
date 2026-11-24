#!/bin/bash
# Post-release checks, login link delivery and the queue plan. Usage:
#   check.sh <S> [--restart-wait SECONDS] [--keep-paused] [--check-only]
#   --check-only  read-only checks against whatever runs now (no before.json comparison, no link, no unpause)
# Exit non-zero on any failed check; then run rollback.sh.
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: check.sh <S> [options]}; shift
S=$(resolve_sha "$ARG"); OPS=$(ops_dir "$S")
if [[ " $* " == *" --check-only "* ]]; then
  if srv "test -f '$OPS/server/check-server.sh'"; then srv "bash '$OPS/server/check-server.sh' $S --check-only"
  else srv "python3 - live-check" < "$REL_DIR/server/gate.py"; fi
  exit $?
fi
say "server scripts gate.py $(sync_server_scripts "$S")"
set +e
srv "bash '$OPS/server/check-server.sh' $S $*"; rc=$?
set -e
deliver_login_link "$S"
[ "$rc" = 0 ] || die "checks failed (exit $rc): run rollback.sh ${S:0:10}"
say "checks passed; queue plan (dry run):"
"$REL_DIR/finish.sh" "$S" || true
