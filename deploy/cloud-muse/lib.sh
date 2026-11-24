#!/bin/bash
# Shared helpers for the release drivers. They run on any machine that reaches both the Mac (git, archive, login
# link file) and the cloud server over SSH; git runs only on the Mac.
set -euo pipefail
REL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Required: the git machine (macOS, holds the repo) and the cloud server, as SSH destinations, and the repo path there.
MAC=${MUSE_RELEASE_GIT_HOST:?set MUSE_RELEASE_GIT_HOST to the SSH destination of the machine that holds the repo}
SRV=${MUSE_RELEASE_SERVER:?set MUSE_RELEASE_SERVER to the SSH destination of the cloud server}
MAC_REL="${MUSE_RELEASE_GIT_REPO:?set MUSE_RELEASE_GIT_REPO to the repo path on the git machine}/deploy/cloud-muse"   # this folder, as the git machine sees it
SRV_OPTS=(-o ControlMaster=auto -o ControlPath=/tmp/cm-%C -o ControlPersist=600 -o ConnectTimeout=20)

say() { printf '== %s %s\n' "$(TZ=Asia/Shanghai date +%H:%M:%S)" "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
srv() { ssh "${SRV_OPTS[@]}" "$SRV" "$@"; }
mac() {  # the Mac's tailnet SSH drops now and then; retry three times
  local n
  for n in 1 2 3; do
    ssh -o BatchMode=yes -o ConnectTimeout=25 "$MAC" "$@" && return 0
    local rc=$?; [ "$rc" = 255 ] || return "$rc"; sleep 10
  done
  return 255
}
mac_script() { local name=$1; shift; mac "zsh -l '$MAC_REL/mac/$name' $*"; }

# Full sha of S, refusing a commit that is not local main or an ancestor of it unless ALLOW_OFF_MAIN=1.
resolve_sha() {
  local line; line=$(mac_script resolve.zsh "'$1'") || die "cannot resolve $1 on the Mac"
  set -- $line
  [ "$2" = on-main ] || [ "${ALLOW_OFF_MAIN:-0}" = 1 ] || die "$1 is not on local main (set ALLOW_OFF_MAIN=1 to override)"
  printf '%s\n' "$1"
}
ops_dir() { printf '/opt/muse/cloud/operations/release-main-%s\n' "${1:0:10}"; }

# Push this folder's server scripts into $OPS/server (after prepare created it).
sync_server_scripts() {
  local ops; ops=$(ops_dir "$1")
  srv "test -d '$ops'" || die "$ops does not exist; run prepare.sh first"
  tar -C "$REL_DIR/server" -czf - . | srv "mkdir -p '$ops/server' && tar -xzf - -C '$ops/server' && chmod 700 '$ops/server' && sha256sum '$ops/server/gate.py' | cut -c1-12"
}

# Run a server script as a transient unit (it survives a dropped SSH session) and follow its log until it ends.
run_unit() {  # unit log exitfile command...
  local unit=$1 log=$2 exitfile=$3; shift 3
  local offset size rc
  offset=$(srv "stat -c %s '$log' 2>/dev/null || echo 0")
  srv "rm -f '$exitfile'; systemctl is-active --quiet '$unit' && exit 9; systemd-run --quiet --unit '$unit' --collect -p StandardOutput=append:$log -p StandardError=append:$log $*" \
    || die "could not start $unit (already running?)"
  while :; do
    sleep 10
    size=$(srv "stat -c %s '$log' 2>/dev/null || echo 0")
    if [ "$size" -gt "$offset" ]; then srv "tail -c +$((offset + 1)) '$log' | head -c $((size - offset))"; offset=$size; fi
    if srv "test -f '$exitfile' && ! systemctl is-active --quiet '$unit'"; then
      rc=$(srv "cut -d' ' -f1 '$exitfile'")
      return "$rc"
    fi
  done
}

deliver_login_link() {  # never printed: server journal -> pipe -> Mac file (0600)
  local ops; ops=$(ops_dir "$1")
  srv "python3 '$ops/server/gate.py' login-link" | mac 'umask 077; f="$HOME/Muse云端登录链接.txt"; cat > "$f.tmp" && grep -q "^http" "$f.tmp" && mv "$f.tmp" "$f" && chmod 600 "$f" && echo "login link delivered to ~/Muse云端登录链接.txt"' \
    || echo "WARN: login link not delivered"
}
