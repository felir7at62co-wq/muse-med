#!/bin/bash
# Shared helpers for the gateway release drivers. They run on any machine that reaches both the git machine and the
# cloud server over SSH; git runs only on the git machine.
set -euo pipefail
REL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_HOST=${MUSE_RELEASE_GIT_HOST:?set MUSE_RELEASE_GIT_HOST to the SSH destination of the machine that holds the repo}
GIT_REPO=${MUSE_RELEASE_GIT_REPO:?set MUSE_RELEASE_GIT_REPO to the repo path on the git machine}
SRV=${MUSE_RELEASE_SERVER:?set MUSE_RELEASE_SERVER to the SSH destination of the cloud server, as root}
SRV_OPTS=(-o ControlMaster=auto -o ControlPath=/tmp/cm-%C -o ControlPersist=600 -o ConnectTimeout=20)
RELEASES=${MUSE_GATEWAY_RELEASES:-/opt/muse/platform/releases}
OPS_ROOT=${MUSE_GATEWAY_OPS:-/opt/muse/platform/operations}

say() { printf '== %s %s\n' "$(TZ=Asia/Shanghai date +%H:%M:%S)" "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
srv() { ssh "${SRV_OPTS[@]}" "$SRV" "$@"; }
git_host() {  # the git machine's SSH drops now and then; retry three times on connection failure only
  local n rc
  for n in 1 2 3; do
    ssh -o BatchMode=yes -o ConnectTimeout=25 "$GIT_HOST" "$@" && return 0
    rc=$?; [ "$rc" = 255 ] || return "$rc"; sleep 10
  done
  return 255
}

# Full sha of S, refusing a commit that is not local main or an ancestor of it unless ALLOW_OFF_MAIN=1.
resolve_sha() {
  local s on
  s=$(git_host "git -C '$GIT_REPO' rev-parse --verify '$1^{commit}'") || die "cannot resolve $1 on the git machine"
  if git_host "git -C '$GIT_REPO' merge-base --is-ancestor $s main"; then on=1; else on=0; fi
  [ "$on" = 1 ] || [ "${ALLOW_OFF_MAIN:-0}" = 1 ] || die "$s is not on local main (set ALLOW_OFF_MAIN=1 to override)"
  printf '%s\n' "$s"
}
ops_dir() { printf '%s/gateway-main-%s\n' "$OPS_ROOT" "${1:0:10}"; }

# Run a server command as a transient unit (it survives a dropped SSH session) and follow its log until it ends.
run_unit() {  # unit log exitfile command...
  local unit=$1 log=$2 exitfile=$3; shift 3
  local offset size
  offset=$(srv "stat -c %s '$log' 2>/dev/null || echo 0")
  srv "rm -f '$exitfile'; systemctl is-active --quiet '$unit' && exit 9; systemd-run --quiet --unit '$unit' --collect -p StandardOutput=append:$log -p StandardError=append:$log $*" \
    || die "could not start $unit (already running?)"
  while :; do
    sleep 5
    size=$(srv "stat -c %s '$log' 2>/dev/null || echo 0")
    if [ "$size" -gt "$offset" ]; then srv "tail -c +$((offset + 1)) '$log' | head -c $((size - offset))"; offset=$size; fi
    if srv "test -f '$exitfile' && ! systemctl is-active --quiet '$unit'"; then return "$(srv "cut -d' ' -f1 '$exitfile'")"; fi
  done
}
