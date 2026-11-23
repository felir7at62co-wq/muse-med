#!/bin/zsh
# Install the 绿泡泡 collector for the current macOS user. Not run automatically; see README.md (启用步骤).
#
#   ./install.sh --token-file /path/to/token [--move-wechat] [--no-load] [--native DIR] [--wechat-from DIR] [--python PY]
#
# Copies the package and the plugin's native/ resources into ~/Library/Application Support/muse-lvpaopao-collector/,
# creates a venv with the pinned helper dependencies, writes the station token (0600) and config.json, optionally moves the
# isolated WeChat copy and its user-home there, and loads the launchd agent.
set -euo pipefail

HERE=${0:A:h}
ROOT="$HOME/Library/Application Support/muse-lvpaopao-collector"
NATIVE="$HOME/工作间/aa muse-med dev/third_party/plugins/muse-lvpaopao/native"
WECHAT_FROM="$HOME/工作间/aa muse-med dev/.artifacts/lvpaopao-analysis-20261019/mac-isolated"
PY=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3
TOKEN_FILE=""
MOVE_WECHAT=0
LOAD=1
LABEL=cn.muse.lvpaopao.collector
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

while (( $# )); do
  case $1 in
    --token-file) TOKEN_FILE=$2; shift 2 ;;
    --move-wechat) MOVE_WECHAT=1; shift ;;
    --no-load) LOAD=0; shift ;;
    --native) NATIVE=$2; shift 2 ;;
    --wechat-from) WECHAT_FROM=$2; shift 2 ;;
    --python) PY=$2; shift 2 ;;
    *) print -u2 "unknown option $1"; exit 64 ;;
  esac
done

[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { print -u2 "macOS arm64 only"; exit 1 }
[[ -f $NATIVE/boot.py && -f $NATIVE/requirements-macos-arm64-269602.lock ]] || { print -u2 "plugin native/ not found: $NATIVE"; exit 1 }
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || { print -u2 "$PY must be Python 3.11+ (helper wheels are pinned for 3.14)"; exit 1 }

umask 077
mkdir -p "$ROOT"/{app,run,state,logs,outbox,wechat}
chmod 700 "$ROOT"

# 1. package and native resources (tests and caches excluded)
rsync -a --delete --exclude '__pycache__' "$HERE/lvpaopao_collector/" "$ROOT/app/lvpaopao_collector/"
rsync -a --delete --exclude '__pycache__' --exclude 'test_*.py' --exclude '*.spec.mjs' "$NATIVE/" "$ROOT/native/"

# 2. venv with the helper's pinned, hash-checked wheels
[[ -x $ROOT/venv/bin/python3 ]] || "$PY" -m venv "$ROOT/venv"
"$ROOT/venv/bin/python3" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: \
  -r "$ROOT/native/requirements-macos-arm64-269602.lock"

# 3. station token (never printed)
if [[ -n $TOKEN_FILE ]]; then
  install -m 600 "$TOKEN_FILE" "$ROOT/station-token"
elif [[ ! -f $ROOT/station-token ]]; then
  print -n "数据站采集端令牌（输入不回显）: "
  read -rs TOKEN; print
  print -rn -- "$TOKEN" > "$ROOT/station-token"
  unset TOKEN
fi
chmod 600 "$ROOT/station-token"

# 4. optional: move the isolated WeChat copy out of the repo's .artifacts folder (same volume: hashes unchanged)
APP="$ROOT/wechat/WeChat-Muse-Test.app"
if (( MOVE_WECHAT )) && [[ ! -d $APP ]]; then
  if ps -axo comm= | grep -qF "$WECHAT_FROM/WeChat-Muse-Test.app/"; then
    print -u2 "the isolated WeChat copy is running; quit it (and Muse's isolated-session supervisor) first"; exit 1
  fi
  mv "$WECHAT_FROM/WeChat-Muse-Test.app" "$ROOT/wechat/"
  mv "$WECHAT_FROM/user-home" "$ROOT/wechat/"
fi
[[ -d $APP ]] || APP="$WECHAT_FROM/WeChat-Muse-Test.app"

# 5. config.json (kept when it exists)
if [[ ! -f $ROOT/config.json ]]; then
  "$ROOT/venv/bin/python3" - "$HERE/config.example.json" "$ROOT/config.json" "$APP" <<'PY'
import json, sys
config = json.load(open(sys.argv[1], encoding='utf8'))
config['wechat']['app'] = sys.argv[3]
with open(sys.argv[2], 'w', encoding='utf8') as out:
    json.dump(config, out, ensure_ascii=False, indent=2)
PY
  chmod 600 "$ROOT/config.json"
fi
PYTHONPATH="$ROOT/app" "$ROOT/venv/bin/python3" -m lvpaopao_collector --config "$ROOT/config.json" status >/dev/null

# 6. launchd agent
sed "s#@ROOT@#$ROOT#g" "$HERE/launchd/$LABEL.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
if (( LOAD )); then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

print "installed to $ROOT"
print "grant Accessibility and Screen Recording (and allow controlling System Events) to:"
"$ROOT/venv/bin/python3" -c 'import os, sys; print("  " + os.path.realpath(sys.executable))'
