#!/bin/bash
# Shared paths for one cloud Muse release, sourced by every server script. Requires S (full commit sha).
# Prints nothing; never reads secret files.
[ -n "${S:-}" ] || { echo "env.sh: S is not set" >&2; exit 64; }
[[ "$S" =~ ^[0-9a-f]{40}$ ]] || { echo "env.sh: S must be a full 40-character commit sha" >&2; exit 64; }
SHORT=${S:0:10}
OPS=/opt/muse/cloud/operations/release-main-$SHORT          # this release's scripts, logs, receipts, backups
NODE_DIR=/opt/muse/cloud/runtime/node-v24.21.0
NODE=$NODE_DIR/bin/node
PNPM_DIR=/opt/muse/cloud/toolchain/pnpm-11.28.5
HOME_DIR=/var/lib/muse-cloud/home
PROFILES=$HOME_DIR/profiles
LIVE=$PROFILES/muse-cloud
NEXT=$PROFILES/muse-cloud-next
BEFORE=$PROFILES/muse-cloud.before-$SHORT
UNIT=muse-cloud.service
DROPIN_DIR=/etc/systemd/system/muse-cloud.service.d
NEW_DROPIN_NAME=release.conf
CONFIG=/opt/muse/cloud/config/cloud.patch.yml
LOCK=/run/lock/muse-cloud-deploy.lock
WORKSPACE=/var/lib/muse-cloud/workspace
CONTROL="$WORKSPACE/转写生产/.production/control.json"
RUNNER_STATUS="$WORKSPACE/转写生产/.production/status.json"
REHEARSAL_PORT=${REHEARSAL_PORT:-19523}
# The release directory name carries the prepare date (CST); prepare writes it once, later scripts read it.
if [ -f "$OPS/release.path" ]; then RELEASE=$(cat "$OPS/release.path"); else RELEASE=; fi
if [ -n "$RELEASE" ]; then ARCHIVES=/opt/muse/cloud/plugin-archives/$(basename "$RELEASE"); else ARCHIVES=; fi
export PATH=$NODE_DIR/bin:$PNPM_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

say() { printf '== %s %s\n' "$(TZ=Asia/Shanghai date +%H:%M:%S)" "$*"; }
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -c1-64; }

# The one drop-in that sets ExecStart (the live release); exactly one must exist.
exec_dropin() {
  local found; found=$(grep -l '^ExecStart=/' "$DROPIN_DIR"/*.conf 2>/dev/null || true)
  [ "$(printf '%s\n' "$found" | grep -c .)" = 1 ] || die "expected exactly one drop-in with ExecStart in $DROPIN_DIR, found: ${found:-none}"
  printf '%s\n' "$found"
}

# Unit environment as NAME=value lines (paths and flags only; the unit holds no secret values).
unit_env() { systemctl show "$UNIT" -p Environment --value | python3 -c 'import shlex,sys; [print(x) for x in shlex.split(sys.stdin.read())]'; }
unit_env_names() { unit_env | cut -d= -f1 | sort; }
