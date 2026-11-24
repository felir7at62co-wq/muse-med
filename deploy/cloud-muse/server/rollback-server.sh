#!/bin/bash
# Put the previous cloud Muse release back (root, on the server). Usage:
#   rollback-server.sh <full sha> [--auto] [--restore-state] [--check-only]
# Each step checks what is there, so it also finishes a switch that stopped half way. The previous profile, drop-in
# and config come back; the current owner layer (model choice) is carried back. --restore-state also restores the
# small state backup taken at the stop (loses Bot and Session changes made since; use only if the new release
# damaged state).
set -euo pipefail
S=${1:?full commit sha}; shift
AUTO=0; RESTORE_STATE=0; CHECK_ONLY=0
for a in "$@"; do case $a in --auto) AUTO=1;; --restore-state) RESTORE_STATE=1;; --check-only) CHECK_ONLY=1;; *) echo "unknown option $a" >&2; exit 64;; esac; done
source "$(dirname "$0")/env.sh"
GATE=(python3 "$OPS/server/gate.py")
RECEIPT=$OPS/prepared.json
r() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$RECEIPT" "$1"; }
OLD=$(r oldDropin); OLD_BACKUP=$OPS/backup/dropin/$(basename "$OLD")
NEW=$DROPIN_DIR/$NEW_DROPIN_NAME

plan() {
  echo "previous profile: $( [ -d "$BEFORE" ] && echo "$BEFORE present" || echo 'absent')"
  echo "live profile is the new one: $( [ -f "$LIVE/.release-$SHORT" ] && echo yes || echo no)"
  echo "new drop-in installed: $( [ -f "$NEW" ] && [ "$(sha "$NEW")" = "$(r newDropinSHA)" ] && echo yes || echo no); old drop-in backup: $( [ -f "$OLD_BACKUP" ] && echo present || echo absent)"
  echo "config backup: $( [ -f "$OPS/backup/cloud.patch.yml.before" ] && echo present || echo absent)"
  echo "state backup: $( [ -f "$OPS/backup/home-state.tar" ] && echo present || echo absent)"
}
if [ "$CHECK_ONLY" = 1 ]; then plan; exit 0; fi
[ "$(id -u)" = 0 ] || die "run as root"
if [ -z "${MUSE_DEPLOY_LOCKED:-}" ]; then exec 9>"$LOCK"; flock -n 9 || die "another deploy holds $LOCK"; fi
trap 'echo "$? $(date -Is)" > "$OPS/rollback.exit"' EXIT
exec > >(tee -a "$OPS/logs/rollback.log") 2>&1
say "rollback of $S"; plan
EXPECTED=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["installedClientSHA"])' "$OPS/before.json" 2>/dev/null || true)

systemctl stop $UNIT || true
if [ -d "$BEFORE" ]; then
  if [ -f "$LIVE/cordis.patch.yml" ] && ! cmp -s "$LIVE/cordis.patch.yml" "$BEFORE/cordis.patch.yml"; then
    cp -p "$LIVE/cordis.patch.yml" "$BEFORE/cordis.patch.yml"; echo "carried the current owner layer back"
  fi
  if [ -e "$LIVE" ]; then
    [ -f "$LIVE/.release-$SHORT" ] || die "$LIVE is not this release's profile; refusing to move it"
    mv "$LIVE" "$PROFILES/muse-cloud.failed-$SHORT-$(date +%H%M%S)"
  fi
  mv "$BEFORE" "$LIVE"; echo "previous profile restored"
elif [ -f "$LIVE/.release-$SHORT" ]; then
  die "live profile is the new one but $BEFORE is missing"
fi
[ -n "$EXPECTED" ] || EXPECTED=$(sha "$LIVE/node_modules/ds-bot/client.js")

if [ -f "$NEW" ] && [ "$(sha "$NEW")" = "$(r newDropinSHA)" ]; then rm -f "$NEW"; echo "removed $NEW_DROPIN_NAME"; fi
if [ ! -f "$OLD" ] && [ -f "$OLD_BACKUP" ]; then install -m 644 "$OLD_BACKUP" "$OLD"; echo "restored $(basename "$OLD")"; fi
[ -f "$OLD" ] || die "previous release drop-in missing"
# Undo a station webhook retirement made by this round.
if [ -f "$OPS/backup/dropin/station-events-bot.conf" ] && [ ! -f "$DROPIN_DIR/station-events-bot.conf" ]; then
  install -m 644 "$OPS/backup/dropin/station-events-bot.conf" "$DROPIN_DIR/station-events-bot.conf"; echo "restored station-events-bot.conf"
fi
if [ -f "$OPS/station-events-retired.created" ] && [ -f "$DROPIN_DIR/station-events-retired.conf" ]; then
  rm -f "$DROPIN_DIR/station-events-retired.conf"; echo "removed station-events-retired.conf"
fi
if [ -f "$OPS/backup/cloud.patch.yml.before" ] && ! cmp -s "$CONFIG" "$OPS/backup/cloud.patch.yml.before"; then
  cp -p "$OPS/backup/cloud.patch.yml.before" "$CONFIG"; echo "restored cloud.patch.yml"
fi
if [ "$RESTORE_STATE" = 1 ]; then
  [ -f "$OPS/backup/home-state.tar" ] || die "no state backup"
  tar -C "$HOME_DIR" -xpf "$OPS/backup/home-state.tar"; echo "restored the small state backup taken at the stop"
fi
systemctl daemon-reload
OLD_RELEASE=$(sed -n 's/^Environment=MUSE_CLOUD_RELEASE=//p' "$OLD")
systemctl show $UNIT -p ExecStart --value | grep -q -- "$OLD_RELEASE/apps/cli/lib/bin.js" || die "ExecStart is not the previous release"
systemctl start $UNIT
"${GATE[@]}" ready --expected "$EXPECTED" --prior-pid 0 --timeout 240
"${GATE[@]}" runner-restore "$OPS/runner-pause.json" || true
echo "$(date -Is) auto=$AUTO" > "$OPS/rolled-back.ok"
say "rolled back; served client.js = ${EXPECTED:0:12} (previous)"
