#!/bin/bash
# Prepare one cloud Muse release beside the live one. The service, its unit, drop-ins, config and live profile are
# never changed here. Usage (root, on the server):
#   prepare-server.sh <full sha> [--check-only] [--skip-rehearsal]
# Stages leave markers in $OPS/stages/; a rerun skips finished stages. Remove a marker to redo that stage.
set -euo pipefail
S=${1:?full commit sha}; shift
CHECK_ONLY=0; REHEARSE=1
for a in "$@"; do case $a in --check-only) CHECK_ONLY=1;; --skip-rehearsal) REHEARSE=0;; *) echo "unknown option $a" >&2; exit 64;; esac; done
[ -n "${SHORT:-}" ] || source "$(dirname "$0")/env.sh"   # --check-only may arrive on stdin after env.sh
GATE="python3 $OPS/server/gate.py"
[ -f "$OPS/server/gate.py" ] || GATE="python3 $(dirname "$0")/gate.py"
done_stage() { [ -f "$OPS/stages/$1.ok" ]; }
mark() { date -Is > "$OPS/stages/$1.ok"; }
NICE=(nice -n 10 ionice -c3)

# ---------- preflight (read-only) ----------
preflight() {
  say "preflight for $S"
  [ "$(id -u)" = 0 ] || die "run as root"
  [ -x "$NODE" ] && [ -x "$PNPM_DIR/bin/pnpm" ] || die "node or pnpm missing"
  local free; free=$(df --output=avail -BG /opt | tail -1 | tr -dc 0-9); [ "$free" -ge 15 ] || die "only ${free}G free on /opt"
  echo "disk: ${free}G free on /opt; /run lock dir: $(ls -d /run/lock)"
  local drop; drop=$(exec_dropin); echo "release drop-in: $drop ($(sha "$drop" | cut -c1-12))"
  local live_release; live_release=$(unit_env | sed -n 's/^MUSE_CLOUD_RELEASE=//p'); echo "live release: $live_release"
  grep -q -- "$live_release/apps/cli/lib/bin.js" "$drop" || die "drop-in ExecStart does not match MUSE_CLOUD_RELEASE"
  echo "other drop-ins: $(ls "$DROPIN_DIR" | grep -v "^$(basename "$drop")$" | tr '\n' ' ')"
  echo "unit env names: $(unit_env_names | tr '\n' ' ')"
  [ -d "$LIVE/node_modules" ] || die "live profile missing"
  echo "live owner layer: $(sha "$LIVE/cordis.patch.yml" | cut -c1-12) $(stat -c %y "$LIVE/cordis.patch.yml" | cut -c1-19)"
  echo "live config: $(sha "$CONFIG" | cut -c1-12)"
  echo "live profile links: $(find "$LIVE/node_modules" -type l | wc -l), broken: $(find "$LIVE/node_modules" -xtype l | wc -l)"
  [ ! -e "$BEFORE" ] || die "$BEFORE already exists (a switch for $SHORT happened?)"
  if [ -e "$NEXT" ] && [ ! -f "$NEXT/.release-$SHORT" ]; then die "$NEXT exists and is not this release's"; fi
  if ss -ltn | awk '{print $4}' | grep -q ":$REHEARSAL_PORT\$"; then die "rehearsal port $REHEARSAL_PORT is in use (set REHEARSAL_PORT)"; fi
  echo "rehearsal port $REHEARSAL_PORT free"
  echo "service: $(systemctl is-active $UNIT) pid=$(systemctl show $UNIT -p MainPID --value) NRestarts=$(systemctl show $UNIT -p NRestarts --value)"
  echo "ops dir: $OPS $( [ -d "$OPS" ] && echo exists || echo 'not yet')"
  [ -z "$RELEASE" ] || echo "release dir: $RELEASE ($( [ -d "$RELEASE" ] && cat "$RELEASE/SOURCE_COMMIT" 2>/dev/null || echo absent))"
}

preflight
[ "$CHECK_ONLY" = 1 ] && { say "check-only: nothing changed"; exit 0; }

mkdir -p "$OPS/stages" "$OPS/logs" "$OPS/backup" "$OPS/dump"
trap 'echo "$? $(date -Is)" > "$OPS/prepare.exit"' EXIT
chmod 700 "$OPS" "$OPS/dump" "$OPS/backup"
exec > >(tee -a "$OPS/logs/prepare.log") 2>&1
[ -f "$OPS/incoming/source.tar.gz" ] || die "source archive missing in $OPS/incoming"
(cd "$OPS/incoming" && sha256sum -c --quiet SHA256SUMS) || die "incoming checksums do not match"

# ---------- extract ----------
if ! done_stage extract; then
  [ -n "$RELEASE" ] || { RELEASE=/opt/muse/cloud/releases/$(TZ=Asia/Shanghai date +%Y%m%d)-main-$SHORT; echo "$RELEASE" > "$OPS/release.path"; }
  ARCHIVES=/opt/muse/cloud/plugin-archives/$(basename "$RELEASE")
  [ ! -e "$RELEASE" ] || die "$RELEASE exists; remove it or its release.path to start over"
  say "extract into $RELEASE"
  mkdir -p "$RELEASE"
  tar -xzf "$OPS/incoming/source.tar.gz" --strip-components=1 -C "$RELEASE"
  echo "$S" > "$RELEASE/SOURCE_COMMIT"
  [ -f "$RELEASE/pnpm-lock.yaml" ] && [ -f "$RELEASE/apps/desktop-host/config/desktop.cordis.patch.yml" ] || die "archive incomplete"
  mark extract
fi
[ -n "$RELEASE" ] && [ "$(cat "$RELEASE/SOURCE_COMMIT")" = "$S" ] || die "release dir does not hold $S"

BUILD_ENV=(env HOME=/var/cache/muse-cloud/home XDG_CACHE_HOME=/var/cache/muse-cloud npm_config_store_dir=/var/cache/muse-cloud/pnpm-store
  CI=true DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_CONCURRENCY=2 DSH_CLIENT_COMMIT_HASH=$SHORT PATH="$PATH")
mkdir -p /var/cache/muse-cloud/home

# ---------- build core (as build-core-20261121.sh) ----------
if ! done_stage build-core; then
  cd "$RELEASE"
  say "pnpm install";      "${NICE[@]}" "${BUILD_ENV[@]}" pnpm install --frozen-lockfile > "$OPS/logs/install.log" 2>&1 || { tail -30 "$OPS/logs/install.log"; die "pnpm install failed"; }
  say "build:artifacts";   "${NICE[@]}" "${BUILD_ENV[@]}" pnpm run build:artifacts > "$OPS/logs/build-artifacts.log" 2>&1 || { tail -30 "$OPS/logs/build-artifacts.log"; die "build:artifacts failed"; }
  say "native system";     "${NICE[@]}" "${BUILD_ENV[@]}" node --import tsx/esm native/system/scripts/build.ts > "$OPS/logs/native.log" 2>&1 || { tail -30 "$OPS/logs/native.log"; die "native build failed"; }
  for f in apps/cli/lib/bin.js apps/web/dist/index.html apps/desktop-host/lib/index.js apps/desktop-host/lib/office.js apps/desktop-host/lib/native-preset.js; do
    [ -f "$f" ] || die "build output missing: $f"
  done
  grep -q '"DSH_CLIENT_COMMIT_HASH": "'"${SHORT:0:7}" .dsh-build/client-build-environment.json || die "client build did not record $SHORT"
  mark build-core
fi

# ---------- koffi link (memory note: needed at node_modules/.pnpm/node_modules/koffi) ----------
if ! done_stage koffi; then
  k="$RELEASE/node_modules/.pnpm/node_modules/koffi"
  if [ ! -e "$k" ]; then
    v=$(cd "$RELEASE/node_modules/.pnpm" && ls -d koffi@* 2>/dev/null | sort -V | tail -1)
    [ -n "$v" ] || die "koffi is not installed in the release"
    ln -s "../$v/node_modules/koffi" "$k"; echo "created koffi link -> ../$v/node_modules/koffi"
  fi
  [ -f "$k/package.json" ] || die "koffi link broken"
  mark koffi
fi

# ---------- plugin archives (as build-plugins-20261121.sh) ----------
if ! done_stage build-plugins; then
  [ ! -e "$ARCHIVES" ] || [ -z "$(ls -A "$ARCHIVES")" ] || die "$ARCHIVES is not empty"
  mkdir -p "$ARCHIVES"; cd "$RELEASE"
  say "community plugins"; "${NICE[@]}" "${BUILD_ENV[@]}" pnpm --dir third_party/plugins/toolchain run build --out "$ARCHIVES" > "$OPS/logs/plugins.log" 2>&1 || { tail -30 "$OPS/logs/plugins.log"; die "plugin build failed"; }
  say "download tools";    "${NICE[@]}" "${BUILD_ENV[@]}" node third_party/plugins/build-downloads.mjs --out "$ARCHIVES" > "$OPS/logs/downloads.log" 2>&1 || { tail -30 "$OPS/logs/downloads.log"; die "download tool build failed"; }
  ls -la "$ARCHIVES"
  mark build-plugins
fi

# ---------- next profile ----------
if ! done_stage profile; then
  [ ! -e "$NEXT" ] || [ -f "$NEXT/.release-$SHORT" ] || die "$NEXT exists and is not this release's"
  say "prepare $NEXT"
  cd "$RELEASE"
  RELEASE="$RELEASE" ARCHIVES="$ARCHIVES" PROJECT_DIR="$NEXT" node --import tsx/esm "$OPS/server/prepare-profile.mts"
  # prepareDevelopmentProject links community siblings by absolute path into the project; make them relative so
  # the directory still works after it is renamed to profiles/muse-cloud.
  python3 - "$NEXT" <<'PY'
import os, sys
root = sys.argv[1]
changed = 0
for base, dirs, files in os.walk(root):
    for name in dirs + files:
        path = os.path.join(base, name)
        if os.path.islink(path):
            target = os.readlink(path)
            if target == root or target.startswith(root + '/'):
                os.unlink(path)
                os.symlink(os.path.relpath(target, os.path.dirname(path)), path)
                changed += 1
print('relative self links:', changed)
PY
  [ -f "$LIVE/cordis.patch.yml" ] && cp -p "$LIVE/cordis.patch.yml" "$NEXT/cordis.patch.yml"
  sha "$NEXT/cordis.patch.yml" > "$OPS/owner-layer.prepare.sha"
  date -Is > "$NEXT/.release-$SHORT"
  chown -R muse-cloud:muse-cloud "$NEXT"; chmod 700 "$NEXT"
  mark profile
fi

# ---------- link check ----------
say "link check"
total=$(find "$NEXT" -type l | wc -l)
broken=$(find "$NEXT" -xtype l | wc -l)
other=$(find "$NEXT" -type l -lname '/opt/muse/cloud/releases/*' ! -lname "$RELEASE/*" | wc -l)
selfabs=$(find "$NEXT" -type l -lname "$PROFILES/*" | wc -l)
varlib=$(find "$NEXT" -type l -lname '/var/lib/*' | wc -l)
echo "links=$total broken=$broken into-other-release=$other absolute-into-profiles=$selfabs into-/var/lib=$varlib"
find "$NEXT" -type l -printf '%l\n' | sed -E "s#^$RELEASE/.*#release#; s#^/.*#OTHER-ABSOLUTE#; s#^[^/].*#relative#" | sort | uniq -c
[ "$broken" = 0 ] && [ "$other" = 0 ] && [ "$selfabs" = 0 ] && [ "$varlib" = 0 ] || die "next profile has bad links"
printf '{"links":%s}\n' "$total" > "$OPS/links.json"

# ---------- carry check: hand edits in the live profile vs the next one ----------
if ! done_stage carry; then
  say "carry check (live hand edits vs next build)"
  python3 - "$LIVE" "$NEXT" > "$OPS/carry.txt" <<'PY'
import hashlib, json, os, sys
live, nxt = sys.argv[1:3]
since = os.stat(os.path.join(live, 'desktop-runtime.json')).st_mtime
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
rows = []
nm = os.path.join(live, 'node_modules')
for base, dirs, files in os.walk(nm):
    dirs[:] = [d for d in dirs if not (base == nm and d.startswith('.')) and not os.path.islink(os.path.join(base, d))]
    for f in files:
        p = os.path.join(base, f)
        if os.path.islink(p) or (base == nm and f.startswith('.')) or os.stat(p).st_mtime <= since:
            continue
        rel = os.path.relpath(p, live)
        q = os.path.join(nxt, rel)
        rows.append((rel, 'SAME' if os.path.isfile(q) and sha(p) == sha(q) else ('DIFFERS' if os.path.isfile(q) else 'ABSENT-IN-NEXT')))
print('# files edited in the live profile after it was prepared, compared with the next profile')
for rel, verdict in sorted(rows):
    print(f'{verdict:15} {rel}')
def has(rel, needle):
    p = os.path.join(nxt, rel)
    return os.path.isfile(p) and needle in open(p, encoding='utf-8', errors='ignore').read()
print('# markers in the next profile')
for rel, needle in [('node_modules/ds-bot/src/host/channel.js', 'installCentralMembers'),
                    ('node_modules/ds-bot/src/host/central-members.js', 'MUSE_CENTRAL_MEMBERS'),
                    ('node_modules/ds-bot/src/host/station-events.js', 'MUSE_STATION_EVENTS_BOT'),
                    ('node_modules/ds-bot/src/host/im/platforms/feishu-dsh-im.js', 'feishuDshIm'),
                    ('node_modules/muse-hongguo-download/patches/0002-electron-main-only.patch', 'process.type')]:
    print(f"{'PRESENT' if has(rel, needle) else 'MISSING':15} {needle} in {rel}")
ld = set(json.load(open(os.path.join(live, 'package.json')))['dependencies'])
nd = set(json.load(open(os.path.join(nxt, 'package.json')))['dependencies'])
print('# profile dependencies only in live:', sorted(ld - nd) or 'none', '| only in next:', sorted(nd - ld) or 'none')
PY
  cat "$OPS/carry.txt"
  grep -q '^MISSING .*0002-electron-main-only' "$OPS/carry.txt" && echo "WARN: Hongguo Node-only catalog patch 0002 is not in $S; the live 16:55 hot fix will be dropped"
  grep -q '^MISSING .*installCentralMembers\|^MISSING .*MUSE_STATION_EVENTS_BOT\|^MISSING .*feishuDshIm' "$OPS/carry.txt" && die "next profile lacks Central, station notices or the dsh-im Feishu mapping"
  grep -q "only in live: none" "$OPS/carry.txt" || die "the live profile has dependencies the next one lacks"
  mark carry
fi

# ---------- config and drop-in ----------
if ! done_stage config; then
  say "stage cloud.patch.yml.next and $NEW_DROPIN_NAME"
  # A queued config change waits in staging/next (staging/README.md); otherwise the live file is carried unchanged.
  STAGED_CONFIG=/opt/muse/cloud/staging/next/cloud.patch.yml
  if [ -f "$STAGED_CONFIG" ]; then
    cp -p "$STAGED_CONFIG" "$OPS/cloud.patch.yml.next"
    say "cloud.patch.yml.next from $STAGED_CONFIG; difference from the live file:"
    diff "$CONFIG" "$STAGED_CONFIG" || true
  else
    cp -p "$CONFIG" "$OPS/cloud.patch.yml.next"
  fi
  # muse-cloud must read the staged config for dump-config and the rehearsal; $OPS is root-only.
  install -m "$(stat -c %a "$CONFIG")" -o root -g "$(stat -c %G "$CONFIG")" "$OPS/cloud.patch.yml.next" "$(dirname "$CONFIG")/cloud.patch.yml.next-$SHORT"
  sha "$CONFIG" > "$OPS/config.prepare.sha"
  old=$(exec_dropin); old_release=$(sed -n 's/^Environment=MUSE_CLOUD_RELEASE=//p' "$old")
  [ -d "$old_release" ] || die "cannot read the live release from $old"
  echo "$old" > "$OPS/old-dropin.path"; sha "$old" > "$OPS/old-dropin.sha"
  python3 - "$old" "$old_release" "$RELEASE" > "$OPS/$NEW_DROPIN_NAME" <<'PY'
import sys
text, old, new = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3]
assert text.count(old) == 3, f'expected 3 mentions of the live release, found {text.count(old)}'
out = text.replace(old, new)
assert out.count('ExecStart=') == 2 and out.count('Environment=MUSE_CLOUD_RELEASE=' + new) == 1
print('# Cloud Muse release ' + new.rsplit('/', 1)[1] + ' (installed by release-main scripts; replaces ' + sys.argv[1].rsplit('/', 1)[1] + ').')
print(out.rstrip('\n'))
PY
  chmod 644 "$OPS/$NEW_DROPIN_NAME"
  cat "$OPS/$NEW_DROPIN_NAME"
  mark config
fi

# ---------- composed configuration ----------
run_dump() {  # profile release config out
  local -a envs=()
  while IFS= read -r kv; do
    case ${kv%%=*} in MUSE_CLOUD_RELEASE) envs+=("MUSE_CLOUD_RELEASE=$2");; *) envs+=("$kv");; esac
  done < <(unit_env)
  (cd "$WORKSPACE" && runuser -u muse-cloud -- env -i "${envs[@]}" "$NODE" "$2/apps/cli/lib/bin.js" --profile "$1" \
     --patch "$2/apps/desktop-host/config/desktop.cordis.patch.yml" --patch "$3" --dump-config) > "$4" 2> "$4.err"
  chmod 600 "$4" "$4.err"
}
if ! done_stage dump; then
  say "dump-config (next and live)"
  live_release=$(unit_env | sed -n 's/^MUSE_CLOUD_RELEASE=//p')
  run_dump muse-cloud "$live_release" "$CONFIG" "$OPS/dump/live.txt" || die "live dump-config failed (see $OPS/dump/live.txt.err)"
  run_dump muse-cloud-next "$RELEASE" "$(dirname "$CONFIG")/cloud.patch.yml.next-$SHORT" "$OPS/dump/next.txt" || { sed -E 's/(token|key|secret)[^ ]*/\1<masked>/I' "$OPS/dump/next.txt.err" | tail -20; die "next dump-config failed"; }
  if ! python3 - "$OPS/dump/live.txt" "$OPS/dump/next.txt" > "$OPS/dump/compare.txt" <<'PY'
import re, sys
live, nxt = (open(p, encoding='utf-8').read() for p in sys.argv[1:3])
ids = lambda t: sorted(set(re.findall(r'\bid: ([A-Za-z0-9@/_.:-]+)', t)))
L, N = ids(live), ids(nxt)
print('rows (id: lines): live', len(re.findall(r'\bid:', live)), 'next', len(re.findall(r'\bid:', nxt)))
print('ids only in next:', [i for i in N if i not in L] or 'none')
print('ids only in live:', [i for i in L if i not in N] or 'none')
need = {'muse-desktop-office': 'id: muse-desktop-office', 'jingliu-connection': 'id: jingliu-connection',
        'workshop-connection': 'id: workshop-connection', 'feishu-channel row': 'id: feishu-channel',
        'feishuDshIm mapping': 'im_975ad889', 'workshop_script_editor keywords': 'workshop_script_editor',
        'tailnet port': '19490', 'cloud-skills dir': 'cloud-skills'}
bad = [k for k, v in need.items() if v not in nxt]
m = re.search(r'id: jingliu-connection[\s\S]{0,900}?localMedia: (\w+)', nxt)
print('jingliu-connection localMedia:', m.group(1) if m else 'not shown')
if m and m.group(1) != 'false': bad.append('localMedia must be false on cloud')
m = re.search(r'id: feishu-channel\n((?:\s{2,}.*\n){0,3})', nxt)
print('feishu-channel row:', (m.group(1) if m else 'not found').strip().replace('\n', ' | '))
if m and 'disabled: true' in m.group(1): bad.append('feishu-channel disabled')
print('MISSING:', bad) if bad else print('next composition has every required row')
sys.exit(1 if bad else 0)
PY
  then cat "$OPS/dump/compare.txt"; die "next composition misses required rows"; fi
  cat "$OPS/dump/compare.txt"
  mark dump
fi

# ---------- rehearsal on 127.0.0.1:$REHEARSAL_PORT with an empty throwaway home ----------
REH_UNIT=muse-cloud-rehearsal-$SHORT
if [ "$REHEARSE" = 1 ] && ! done_stage rehearsal; then
  TH=/var/cache/muse-release-$SHORT   # not /var/tmp: PrivateTmp hides it from the unit
  say "rehearsal $REH_UNIT on 127.0.0.1:$REHEARSAL_PORT (home $TH, no live state, Feishu off)"
  systemctl is-active --quiet "$REH_UNIT" && die "$REH_UNIT already running"
  rm -rf --one-file-system "$TH"; mkdir -p "$TH/home/profiles" "$TH/cache" "$TH/workspace"
  cp -a "$NEXT" "$TH/home/profiles/muse-cloud"
  cat > "$TH/rehearsal.patch.yml" <<YML
# Rehearsal only: loopback port, no Feishu, no IM mapping.
- id: webserver
  disabled: false
  config: { host: 127.0.0.1, port: $REHEARSAL_PORT, compression: gzip, compressionLevel: 1, compressionThresholdBytes: 1024 }
- id: feishu-channel
  disabled: true
- id: bot
  config:
    feishuDshIm: {}
YML
  chown -R muse-cloud:muse-cloud "$TH"; chmod 700 "$TH"
  setenv=()
  while IFS= read -r kv; do
    case ${kv%%=*} in
      MUSE_STATION_EVENTS_SECRET_FILE|MUSE_STATION_EVENTS_BOT|MUSE_CENTRAL_*) ;;
      HOME|MUSE_HOME|DSH_HOME) setenv+=(--setenv="${kv%%=*}=$TH/home");;
      XDG_CACHE_HOME) setenv+=(--setenv="XDG_CACHE_HOME=$TH/cache");;
      MUSE_CLOUD_RELEASE) setenv+=(--setenv="MUSE_CLOUD_RELEASE=$RELEASE");;
      *) setenv+=(--setenv="$kv");;
    esac
  done < <(unit_env)
  systemd-run --unit "$REH_UNIT" --uid=muse-cloud --gid=muse-cloud --working-directory="$TH/workspace" \
    -p RuntimeMaxSec=900 -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes -p NoNewPrivileges=yes \
    -p ReadWritePaths="$TH" -p InaccessiblePaths=/var/lib/muse-cloud -p MemoryMax=6G -p UMask=0077 "${setenv[@]}" \
    "$NODE" "$RELEASE/apps/cli/lib/bin.js" --profile muse-cloud --patch "$RELEASE/apps/desktop-host/config/desktop.cordis.patch.yml" \
    --patch "$(dirname "$CONFIG")/cloud.patch.yml.next-$SHORT" --patch "$TH/rehearsal.patch.yml" --no-open --host 127.0.0.1 --port "$REHEARSAL_PORT"
  set +e
  $GATE probe --unit "$REH_UNIT" --port "$REHEARSAL_PORT" --profile "$TH/home/profiles/muse-cloud" > "$OPS/rehearsal.json"; rc=$?
  set -e
  systemctl stop "$REH_UNIT" 2>/dev/null || true
  cat "$OPS/rehearsal.json"
  [ "$rc" = 0 ] || die "rehearsal failed; journal: journalctl -u $REH_UNIT (contains a login URL: filter it)"
  rm -rf --one-file-system "$TH"
  mark rehearsal
fi

# ---------- receipt ----------
python3 - "$OPS" "$S" "$RELEASE" "$ARCHIVES" "$NEXT" "$REHEARSE" <<'PY'
import hashlib, json, os, sys
ops, s, release, archives, nxt, rehearse = sys.argv[1:]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
receipt = {'sha': s, 'release': release, 'archives': archives, 'nextProfile': nxt,
           'nextClientSHA': sha(os.path.join(nxt, 'node_modules/ds-bot/client.js')),
           'oldDropin': open(os.path.join(ops, 'old-dropin.path')).read().strip(), 'oldDropinSHA': open(os.path.join(ops, 'old-dropin.sha')).read().strip(),
           'newDropinSHA': sha(os.path.join(ops, 'release.conf')), 'configSHA': open(os.path.join(ops, 'config.prepare.sha')).read().strip(),
           'configNextSHA': sha(os.path.join(ops, 'cloud.patch.yml.next')), 'ownerLayerSHA': open(os.path.join(ops, 'owner-layer.prepare.sha')).read().strip(),
           'links': json.load(open(os.path.join(ops, 'links.json')))['links'], 'rehearsed': rehearse == '1'}
json.dump(receipt, open(os.path.join(ops, 'prepared.json'), 'w'), indent=1)
print(json.dumps(receipt, indent=1))
PY
say "prepared $S; nothing live changed. Next: switch.sh"
