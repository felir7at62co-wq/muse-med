#!/bin/bash
# The restart window. Usage: switch.sh <S> [--wait-minutes N] [--allow-desk-turns] [--restart-busy] [--no-auto-rollback] [--check-only]
#   --check-only        read-only: preconditions against the receipt and one pass of the quiet gate
#   --wait-minutes N    how long to wait for a transcription batch boundary and a quiet Muse (default 60)
#   --allow-desk-turns  tolerate running turns of the desk's transcription Bots (转写2/转写3); the desk re-prompts them
# Runs server/switch-server.sh as transient unit muse-cloud-switch-<short> and follows its log.
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: switch.sh <S> [options]}; shift
S=$(resolve_sha "$ARG"); SHORT=${S:0:10}; OPS=$(ops_dir "$S")
if [[ " $* " == *" --check-only "* ]]; then
  if srv "test -f '$OPS/server/switch-server.sh'"; then srv "bash '$OPS/server/switch-server.sh' $S $*"
  else echo "not prepared yet ($OPS/server missing); quiet gate only:"; srv "python3 - check-only $(printf '%s\n' "$@" | grep -x -- --allow-desk-turns || true)" < "$REL_DIR/server/gate.py" || true; fi
  exit 0
fi
srv "test -f '$OPS/prepared.json'" || die "not prepared: $OPS/prepared.json missing"
say "server scripts gate.py $(sync_server_scripts "$S")"
run_unit "muse-cloud-switch-$SHORT" "$OPS/logs/switch.log" "$OPS/switch.exit" /bin/bash "$OPS/server/switch-server.sh" "$S" "$@" \
  || { srv "cat '$OPS/switch.exit'"; srv "test -f '$OPS/rolled-back.ok'" && deliver_login_link "$S"; die "switch did not complete (see above)"; }
say "switched; now run check.sh $SHORT"
