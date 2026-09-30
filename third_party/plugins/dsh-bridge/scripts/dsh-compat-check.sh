#!/usr/bin/env bash
# 在**隔离环境**里把移动端 UI 行为验收跑到另一个 DSH 版本上（不碰线上服务）。
#
# 用途：DSH 升级前先验证本插件在新宿主上是否仍然可用。
# 做法：
#   1) 把目标版本装到 /tmp/dsh-next（不动全局安装）；
#   2) 复制一份 DSH_HOME 到 /tmp/dsh-home-next，并做三处隔离：
#        - 重指插件 link 符号链接（原 profile 里是相对链接，拷到 /tmp 后会断）
#        - 禁用 cloudflared / 自建隧道的 autoStart 并清空 Token（否则会抢占线上隧道）
#        - 把插件本地反代端口从 3082 挪开（否则与线上实例抢端口）
#   3) 用该 DSH_HOME 在备用端口起一个实例，再把 test/browser 的验收打过去；
#   4) 结束后停实例并删除含凭据副本的临时 HOME。
#
# 用法：
#   bash scripts/dsh-compat-check.sh 0.1.7-rc.2
#   bash scripts/dsh-compat-check.sh 0.1.7-rc.2 --keep-home   # 保留临时 HOME 便于复查
set -uo pipefail

VERSION="${1:-}"
KEEP_HOME="${2:-}"
if [ -z "$VERSION" ]; then
  echo "用法: bash scripts/dsh-compat-check.sh <dsh 版本，例如 0.1.7-rc.2> [--keep-home]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NEXT_DIR=/tmp/dsh-next
HOME_COPY=/tmp/dsh-home-next
PORT="${DSH_COMPAT_PORT:-3099}"
REAL_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "==> 目标 DSH 版本: $VERSION | 隔离端口: $PORT | 真实 DSH_HOME: $REAL_HOME"

# --- 1) 安装目标版本到隔离目录 ---
mkdir -p "$NEXT_DIR"
if [ ! -d "$NEXT_DIR/node_modules/@deepseek-ai/dsh" ]; then
  ( cd "$NEXT_DIR" && [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm i "@deepseek-ai/dsh@$VERSION" --registry=https://registry.npmjs.org/ --no-audit --no-fund >/dev/null 2>&1 )
fi
echo "    已就位: $(node -p "require('$NEXT_DIR/node_modules/@deepseek-ai/dsh/package.json').version")"

# --- 2) 复制并隔离 DSH_HOME ---
rm -rf "$HOME_COPY"; mkdir -p "$HOME_COPY"
( cd "$REAL_HOME" && tar -cf - --exclude='./sessions' --exclude='./attachments' --exclude='./storages' . ) \
  | ( cd "$HOME_COPY" && tar -xf - )
# 2a) 修复插件 link（相对符号链接拷到 /tmp 后会断）
ln -sfn "$REPO_ROOT" "$HOME_COPY/profiles/web/node_modules/@wenbin_wb/dsh-bridge" 2>/dev/null || true
# 2b) 禁用一切对外隧道并清空凭据，避免抢占线上隧道
node -e '
const fs=require("fs"),p=process.argv[1];
if(!fs.existsSync(p)) process.exit(0);
const c=JSON.parse(fs.readFileSync(p,"utf8"));
for (const k of ["cloudflared","customTunnel"]) if (c[k]) { c[k].autoStart=false; if("token" in c[k]) c[k].token=""; if("accessToken" in c[k]) c[k].accessToken=""; }
fs.writeFileSync(p, JSON.stringify(c,null,2));
' "$HOME_COPY/dsh-bridge/config.json"
# 2c) 反代端口挪开
PATCH="$HOME_COPY/profiles/web/cordis.patch.yml"
grep -q "port: 3092" "$PATCH" 2>/dev/null || printf "\n# [临时·兼容性测试] 反代端口挪开，避免与线上实例抢端口\n- id: '@wenbin_wb/dsh-bridge'\n  config:\n    port: 3092\n" >> "$PATCH"
echo "    隔离 HOME 就绪: $HOME_COPY"

# --- 3) 起实例并跑验收 ---
DSH_HOME="$HOME_COPY" node "$NEXT_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" web --no-open --port "$PORT" \
  >/tmp/dsh-compat-instance.log 2>&1 &
INSTANCE_PID=$!
trap 'kill $INSTANCE_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do
  sleep 2
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
done
echo "    实例日志（含被新版拒绝的插件）:"
sed 's/^/      /' /tmp/dsh-compat-instance.log | head -8

( cd "$REPO_ROOT" && DSH_WEB_PORT="$PORT" npm run verify:mobile-ui )
RC=$?

kill $INSTANCE_PID 2>/dev/null; sleep 2

# --- 4) 清理（默认删掉含凭据副本的临时 HOME）---
if [ "$KEEP_HOME" != "--keep-home" ]; then rm -rf "$HOME_COPY"; echo "    已删除临时 HOME（含凭据副本）"; fi
exit $RC
