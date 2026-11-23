#!/bin/zsh
# Stop and remove the 绿泡泡 collector. Keeps the isolated WeChat copy, its user-home, the outbox and state unless --purge;
# the WeChat copy and user-home are never deleted by this script.
#
#   ./uninstall.sh [--purge]
set -euo pipefail

ROOT="$HOME/Library/Application Support/muse-lvpaopao-collector"
LABEL=cn.muse.lvpaopao.collector
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PURGE=0
[[ ${1:-} == --purge ]] && PURGE=1

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
if [[ -x $ROOT/venv/bin/python3 && -d $ROOT/app ]]; then
  PYTHONPATH="$ROOT/app" "$ROOT/venv/bin/python3" -m lvpaopao_collector --config "$ROOT/config.json" stop-wechat || true
fi
rm -rf "$ROOT/app" "$ROOT/venv" "$ROOT/native" "$ROOT/helper-runtime" "$ROOT/run"
if (( PURGE )); then
  rm -rf "$ROOT/state" "$ROOT/outbox" "$ROOT/logs" "$ROOT/config.json" "$ROOT/station-token"
fi
print "removed the collector; kept: $(ls "$ROOT" 2>/dev/null | tr '\n' ' ')"
