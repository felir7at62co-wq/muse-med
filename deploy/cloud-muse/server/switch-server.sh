#!/bin/bash
# The restart window for one prepared cloud Muse release (root, on the server; switch.sh starts it as a transient
# unit so a dropped SSH session cannot cut it in half). Usage:
#   switch-server.sh <full sha> [--wait-minutes N] [--allow-desk-turns] [--no-auto-rollback] [--check-only]
# Order: lock, compare-and-swap preconditions, pause the transcription runner, wait for a quiet moment, snapshot,
# stop, back up small state, swap profiles, install drop-in and config, daemon-reload, start, wait until ready.
# Any failure after the stop rolls back automatically unless --no-auto-rollback. The runner stays paused until
# check.sh passes (or rollback restores it).
set -euo pipefail
S=${1:?full commit sha}; shift
WAIT=60; ALLOW=(); AUTO=1; CHECK_ONLY=0; BUSY=0
while [ $# -gt 0 ]; do case $1 in
  --wait-minutes) WAIT=$2; shift;; --allow-desk-turns) ALLOW=(--allow-desk-turns);; --no-auto-rollback) AUTO=0;; --check-only) CHECK_ONLY=1;; --restart-busy) BUSY=1;;
  *) echo "unknown option $1" >&2; exit 64;; esac; shift; done
source "$(dirname "$0")/env.sh"
GATE=(python3 "$OPS/server/gate.py")
RECEIPT=$OPS/prepared.json
r() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$RECEIPT" "$1"; }
PHASE=start
RETIRED_DROPIN=station-events-retired.conf

preconditions() {
  [ "$(id -u)" = 0 ] || die "run as root"
  [ -f "$RECEIPT" ] || die "no prepare receipt $RECEIPT"
  [ "$(r sha)" = "$S" ] && [ "$(r release)" = "$RELEASE" ] || die "receipt is for another release"
  [ ! -f "$OPS/switched.ok" ] || die "already switched ($(cat "$OPS/switched.ok"))"
  [ -d "$NEXT" ] && [ -f "$NEXT/.release-$SHORT" ] || die "$NEXT missing or not this release's"
  [ ! -e "$BEFORE" ] || die "$BEFORE exists"
  local old; old=$(exec_dropin)
  [ "$old" = "$(r oldDropin)" ] && [ "$(sha "$old")" = "$(r oldDropinSHA)" ] || die "the live release drop-in changed since prepare"
  [ "$(sha "$CONFIG")" = "$(r configSHA)" ] || die "cloud.patch.yml changed since prepare; re-run the config stage"
  [ "$(sha "$OPS/release.conf")" = "$(r newDropinSHA)" ] && [ "$(sha "$OPS/cloud.patch.yml.next")" = "$(r configNextSHA)" ] || die "staged drop-in or config changed"
  [ "$(sha "$NEXT/node_modules/ds-bot/client.js")" = "$(r nextClientSHA)" ] || die "next profile changed since prepare"
  [ "$(find "$NEXT" -xtype l | wc -l)" = 0 ] || die "next profile has broken links"
  [ "$(find "$NEXT" -type l -lname '/opt/muse/cloud/releases/*' ! -lname "$RELEASE/*" | wc -l)" = 0 ] || die "next profile links into another release"
  [ "$(systemctl is-active $UNIT)" = active ] || die "$UNIT is not active"
  [ -f "$DROPIN_DIR/central-members.conf" ] || die "drop-in central-members.conf missing"
  # The station webhook drop-in stays until a round retires it (retire-station-events in $OPS).
  [ -f "$DROPIN_DIR/station-events-bot.conf" ] || [ -f "$DROPIN_DIR/$RETIRED_DROPIN" ] || die "drop-in station-events-bot.conf missing"
  echo "preconditions hold: receipt, drop-in $(basename "$old"), config, next profile, service active"
}

if [ "$CHECK_ONLY" = 1 ]; then
  ( preconditions ) || true
  "${GATE[@]}" check-only "${ALLOW[@]}" || true
  say "check-only: nothing changed"; exit 0
fi

exec 9>"$LOCK"
flock -n 9 || die "another deploy holds $LOCK"
export MUSE_DEPLOY_LOCKED=1
mkdir -p "$OPS/backup/dropin"
finish() {
  local rc=$?
  echo "$rc $PHASE $(date -Is)" > "$OPS/switch.exit"
  if [ "$rc" != 0 ]; then
    case $PHASE in
      start|paused|quiet|snapshot) say "aborted before the stop; service untouched"; "${GATE[@]}" runner-restore "$OPS/runner-pause.json" || true;;
      stopped|swapped|installed|started)
        if [ "$AUTO" = 1 ]; then say "failure after the stop ($PHASE): automatic rollback"; bash "$OPS/server/rollback-server.sh" "$S" --auto || say "ROLLBACK FAILED: act by hand (README)";
        else say "failure after the stop ($PHASE); --no-auto-rollback given: run rollback.sh"; fi;;
    esac
  fi
}
trap finish EXIT

say "switch $S -> $RELEASE"
preconditions
"${GATE[@]}" runner-pause "$OPS/runner-pause.json"; PHASE=paused
say "waiting up to $WAIT min for a transcription batch boundary and a quiet Muse"
if [ "$BUSY" = 1 ]; then
  # The owner asked to update even while Bots work: record what runs now, so it can be woken after the start.
  "${GATE[@]}" check-only --allow-desk-turns --shapes > "$OPS/logs/busy-before.txt" 2>&1 || true
  python3 "$OPS/server/gate.py" running-sessions > "$OPS/busy-sessions.json" 2>/dev/null || true
  say "restarting while busy (--restart-busy); running work recorded in $OPS/busy-sessions.json"
else
  "${GATE[@]}" wait --minutes "$WAIT" "${ALLOW[@]}" || die "no quiet moment within $WAIT min"
fi
PHASE=quiet
"${GATE[@]}" snapshot "$OPS/before.json"; PHASE=snapshot
if [ "$BUSY" != 1 ]; then "${GATE[@]}" check-only "${ALLOW[@]}" > "$OPS/logs/final-gate.txt" || { cat "$OPS/logs/final-gate.txt"; die "Muse became busy after the snapshot"; }; fi
PRIOR=$(systemctl show $UNIT -p MainPID --value)

say "stop $UNIT (pid $PRIOR)"
PHASE=stopped
systemctl stop $UNIT
[ "$(systemctl is-active $UNIT || true)" != active ] || die "service still active"

say "back up small state (home without profiles, attachments, runtimes, caches; root-only)"
tar -C "$HOME_DIR" --exclude=./profiles --exclude=./attachments --exclude=./dsh-runtimes --exclude=./cache --exclude=./.npm \
  -cf "$OPS/backup/home-state.tar" .
chmod 600 "$OPS/backup/home-state.tar"; ls -la "$OPS/backup/home-state.tar" | awk '{print "state backup bytes:", $5}'

say "carry the live owner layer and swap profiles"
[ "$(sha "$LIVE/cordis.patch.yml")" = "$(r ownerLayerSHA)" ] || echo "owner layer changed since prepare; carrying the current one"
cp -p "$LIVE/cordis.patch.yml" "$NEXT/cordis.patch.yml"
mv "$LIVE" "$BEFORE"
PHASE=swapped
mv "$NEXT" "$LIVE"

say "install drop-in and config"
OLD=$(r oldDropin)
mv "$OLD" "$OPS/backup/dropin/$(basename "$OLD")"
install -m 644 "$OPS/release.conf" "$DROPIN_DIR/$NEW_DROPIN_NAME"
PHASE=installed
cp -p "$CONFIG" "$OPS/backup/cloud.patch.yml.before"
if [ "$(sha "$CONFIG")" != "$(sha "$OPS/cloud.patch.yml.next")" ]; then
  cp "$OPS/cloud.patch.yml.next" "$CONFIG.release-tmp"; chmod 644 "$CONFIG.release-tmp"; mv "$CONFIG.release-tmp" "$CONFIG"; echo "cloud.patch.yml replaced"
else echo "cloud.patch.yml unchanged"; fi
# Station webhook retirement: its drop-in moves to the backup and an empty secret-file setting keeps the route off
# (station-events.js registers nothing without MUSE_STATION_EVENTS_SECRET_FILE). Rollback reverses both.
if [ -f "$OPS/retire-station-events" ]; then
  if [ -f "$DROPIN_DIR/station-events-bot.conf" ]; then mv "$DROPIN_DIR/station-events-bot.conf" "$OPS/backup/dropin/station-events-bot.conf"; fi
  if [ ! -f "$DROPIN_DIR/$RETIRED_DROPIN" ]; then
    printf '[Service]\n# Station webhook retired %s (release %s); remove this file to restore the route.\nEnvironment=MUSE_STATION_EVENTS_SECRET_FILE=\n' "$(date +%F)" "$SHORT" > "$DROPIN_DIR/$RETIRED_DROPIN"
    chmod 644 "$DROPIN_DIR/$RETIRED_DROPIN"; touch "$OPS/station-events-retired.created"
  fi
  echo "station webhook retired: $RETIRED_DROPIN installed, station-events-bot.conf backed up"
fi
systemctl daemon-reload
systemctl show $UNIT -p ExecStart --value | grep -q -- "$RELEASE/apps/cli/lib/bin.js" || die "ExecStart does not name the new release"
[ "$(unit_env | sed -n 's/^MUSE_CLOUD_RELEASE=//p')" = "$RELEASE" ] || die "MUSE_CLOUD_RELEASE is not the new release"
unit_env_names | grep -qx MUSE_CENTRAL_MEMBERS || die "Central env lost"
if [ -f "$DROPIN_DIR/$RETIRED_DROPIN" ]; then
  [ -z "$(unit_env | sed -n 's/^MUSE_STATION_EVENTS_SECRET_FILE=//p')" ] && ! unit_env_names | grep -qx MUSE_STATION_EVENTS_BOT || die "station webhook still configured"
else
  unit_env_names | grep -qx MUSE_STATION_EVENTS_BOT || die "station env lost"
fi

say "start"
PHASE=started
systemctl start $UNIT
"${GATE[@]}" ready --expected "$(r nextClientSHA)" --prior-pid "$PRIOR" --timeout 240
echo "$S pid=$PRIOR->$(systemctl show $UNIT -p MainPID --value) $(date -Is)" > "$OPS/switched.ok"
PHASE=done
say "switched. Transcription stays paused until check.sh passes. Old profile: $BEFORE"
