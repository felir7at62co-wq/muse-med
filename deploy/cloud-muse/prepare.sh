#!/bin/bash
# Prepare one cloud Muse release from a Muse main commit, beside the live one; the service is not touched.
# Usage: prepare.sh <S> [--check-only] [--skip-rehearsal]
#   --check-only  read-only: resolve S on the Mac and run the server preflight (disk, drop-ins, profile, port)
# Steps: resolve S on the Mac -> git archive + temporary tailnet HTTP server on the Mac -> server downloads and
# verifies -> server/prepare-server.sh runs as transient unit muse-cloud-prepare-<short> (build core, plugin
# archives, profiles/muse-cloud-next, link and carry checks, cloud.patch.yml.next, release.conf, dump-config,
# isolated rehearsal) -> receipt $OPS/prepared.json.
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: prepare.sh <S> [--check-only] [--skip-rehearsal]}; shift
CHECK_ONLY=0; EXTRA=(); RELAY=0; DELTA_BASE=
for a in "$@"; do case $a in --check-only) CHECK_ONLY=1;; --skip-rehearsal) EXTRA+=(--skip-rehearsal);; --relay) RELAY=1;; --delta=*) DELTA_BASE=${a#--delta=};; *) die "unknown option $a";; esac; done
S=$(resolve_sha "$ARG"); SHORT=${S:0:10}; OPS=$(ops_dir "$S")
say "release commit $S"
if [ "$CHECK_ONLY" = 1 ]; then
  cat "$REL_DIR/server/env.sh" "$REL_DIR/server/prepare-server.sh" | srv "S=$S bash -s -- $S --check-only"
  mac 'test -f "$HOME/Muse云端登录链接.txt" && echo "Mac login link file present ($(stat -f %Sp "$HOME/Muse云端登录链接.txt"))"; (tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4) | head -1 | sed "s/^/Mac tailnet IP: /"'
  exit 0
fi

srv "mkdir -p '$OPS/incoming' '$OPS/server' '$OPS/logs' && chmod 700 '$OPS'"
trap 'mac_script stop-serving.zsh "$S" >/dev/null 2>&1 || true' EXIT
if [ -n "$DELTA_BASE" ]; then
  # --delta=<base>: send only the change from an already prepared base release; the server rebuilds and verifies the tree.
  B=$(resolve_sha "$DELTA_BASE"); BASE_OPS=$(ops_dir "$B")
  srv "test -s '$BASE_OPS/incoming/source.tar.gz'" || die "base $B has no archive on the server"
  line=$(mac_script delta.zsh "$S" "$B" | tee /dev/stderr | sed -n 's/^DELTA //p'); [ -n "$line" ] || die "the Mac could not build the delta"
  say "sending the delta ($(echo "$line" | awk '{print $2}') bytes) through this machine"
  ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC" "cat '$(echo "$line" | awk '{print $1}')'" | srv "cat > '$OPS/incoming/delta.tar.gz'" || die "delta copy failed"
  srv "tar -xzf '$OPS/incoming/delta.tar.gz' -O ./server/delta-apply.sh | bash -s -- '$OPS' '$BASE_OPS' && cd '$OPS/incoming' && sha256sum -c --quiet SHA256SUMS && cp server/* '$OPS/server/' && chmod 700 '$OPS/server'" || die "delta rebuild failed"
  mac "rm -rf /tmp/muse-delta-$SHORT"; trap - EXIT
elif [ "$RELAY" = 1 ]; then
  # --relay: the Mac-server tailnet path is slow (DERP); stream the same payload through this machine over SSH.
  mac_script archive.zsh "$S" >&2 || die "the Mac could not build the archive"
  say "relaying the payload through this machine"
  ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC" "tar -C /tmp/muse-release-$SHORT/payload -cf - ." | srv "set -e; cd '$OPS/incoming'; tar -xf -
    sha256sum -c --quiet SHA256SUMS && cp server/* '$OPS/server/' && chmod 700 '$OPS/server' && ls -la source.tar.gz | awk '{print \"source archive bytes:\", \$5}'" \
    || die "relay or checksum failed"
  mac_script stop-serving.zsh "$S" >/dev/null; trap - EXIT
else
  URL=$(mac_script archive.zsh "$S" | tee /dev/stderr | sed -n 's/^SERVING //p')
  [ -n "$URL" ] || die "the Mac did not start serving the archive"
  say "server downloads from $URL"
  srv "set -e; cd '$OPS/incoming'; curl -fsS --max-time 60 -O '$URL/SHA256SUMS'
    for f in \$(awk '{print \$2}' SHA256SUMS); do curl -fsS --max-time 1200 --create-dirs -o \"\$f\" '$URL/'\"\$f\"; done
    sha256sum -c --quiet SHA256SUMS && cp server/* '$OPS/server/' && chmod 700 '$OPS/server' && ls -la source.tar.gz | awk '{print \"source archive bytes:\", \$5}'"
  mac_script stop-serving.zsh "$S"; trap - EXIT
fi
say "build and prepare on the server (follow: $OPS/logs/prepare-run.log)"
run_unit "muse-cloud-prepare-$SHORT" "$OPS/logs/prepare-run.log" "$OPS/prepare.exit" /bin/bash "$OPS/server/prepare-server.sh" "$S" "${EXTRA[@]}" \
  && say "prepared. Review $OPS/carry.txt and $OPS/dump/compare.txt, then switch.sh $SHORT" \
  || die "prepare stopped; fix and rerun prepare.sh (finished stages are skipped)"
