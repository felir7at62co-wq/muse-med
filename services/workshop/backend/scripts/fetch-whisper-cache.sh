#!/bin/bash
# 同步 faster-whisper 模型离线副本到构建上下文。
#
# 背景: 自动字幕依赖 faster-whisper small 模型(约 464MB)。它必须烘进镜像 ——
# 算力机的 nv_worker* 容器是手工 `docker run` 起的、无 volume, 模型若只存在
# 容器可写层, 容器一重建就清零, 得从 hf-mirror 重下; 而 hf-mirror 不稳
# (2026-10-12 的"出片无字幕"事故: 4 个 prod 容器只有 1 个下成功)。
#
# 构建期现下同样不可靠(实测反复 handshake timeout 导致构建失败), 故改为:
# 在本脚本里把一份**已验证完整**的缓存同步到 services/orchestrator/whisper-cache/,
# Dockerfile 直接 COPY 进镜像, 全程不依赖网络。
#
# 用法:
#   scripts/fetch-whisper-cache.sh              # 本地已有则跳过
#   scripts/fetch-whisper-cache.sh --force      # 强制重新下载
#   scripts/fetch-whisper-cache.sh --from-host <ssh目标>   # 从已有缓存的机器拷(推荐)
#
# 同步后务必确认 Dockerfile 能构建(它会做 HF_HUB_OFFLINE=1 的离线加载硬校验)。
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # services/orchestrator
DEST="$HERE/whisper-cache/huggingface"
MODEL="small"
REPO="Systran/faster-whisper-small"
FORCE=0
FROM_HOST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --from-host) FROM_HOST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [[ -d "$DEST/hub" && "$FORCE" -eq 0 ]]; then
  echo "==> 缓存已存在($(du -sh "$DEST" | cut -f1)), 跳过。要重新同步请加 --force"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"

if [[ -n "$FROM_HOST" ]]; then
  # 从别的机器拷(算力机上是 /root/nv_shared_hf_cache/huggingface)。
  # 用相对符号链接的目录必须在同一 tar 流里搬运, 否则快照指针会断。
  echo "==> 从 $FROM_HOST 拉取缓存"
  ssh "$FROM_HOST" 'tar -C /root/nv_shared_hf_cache -cf - huggingface' \
    | tar -C "$(dirname "$DEST")" -xf -
else
  echo "==> 从 hf-mirror 下载 $REPO (约 464MB)"
  echo "    ⚠ 该镜像站不稳, 失败是常态; 优先用 --from-host 从已有缓存的机器拷。"
  rm -rf "$DEST"
  HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" \
  HF_HUB_DISABLE_XET=1 \
  python3 - <<PY
from faster_whisper import WhisperModel
WhisperModel("$MODEL", device="cpu", compute_type="int8")
print("下载完成")
PY
  # faster-whisper 下到 ~/.cache/huggingface, 搬到构建上下文
  SRC="${HOME}/.cache/huggingface"
  [[ -d "$SRC/hub" ]] || { echo "❌ 未找到下载产物: $SRC" >&2; exit 1; }
  mkdir -p "$DEST"
  cp -a "$SRC/." "$DEST/"
fi

# 完整性硬校验: 4 个关键文件缺一不可(Dockerfile 里的离线加载也会再验一次)
echo "==> 校验缓存完整性"
MISSING=0
for f in model.bin config.json tokenizer.json vocabulary.txt; do
  if ! find "$DEST/hub" -name "$f" -print -quit | grep -q .; then
    echo "  ❌ 缺 $f"; MISSING=1
  fi
done
[[ "$MISSING" -eq 0 ]] || { echo "❌ 缓存不完整, 请重跑(或换 --from-host)" >&2; exit 1; }

echo "==> 就绪: $DEST ($(du -sh "$DEST" | cut -f1))"
echo "    现在可以构建: cd infra/docker && docker compose build orchestrator"
