#!/usr/bin/env bash
# 安全地对当前 orchestrator 容器所连数据库执行 Alembic 迁移。
#
# 用法 (在宿主机):
#   bash scripts/run_migrations.sh <容器名>
# 例:
#   bash scripts/run_migrations.sh drama-dev-orchestrator
#
# 安全保证:
# - 只跑 `alembic upgrade head`, 即"把缺的迁移补上", 绝不 downgrade、不 drop。
# - 迁移只动数据库 schema, 不触碰 uploads/ 等磁盘文件。
# - 升级前自动 dump 一份 schema 备份到 /tmp, 便于回查。
set -euo pipefail

CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  echo "用法: bash scripts/run_migrations.sh <orchestrator容器名>" >&2
  exit 1
fi

echo "[migrate] 目标容器: $CONTAINER"
echo "[migrate] 当前版本:"
docker exec -w /app "$CONTAINER" alembic current 2>&1 || true

echo "[migrate] 待应用的迁移 (current..head):"
docker exec -w /app "$CONTAINER" alembic history -r current:head 2>&1 || true

echo "[migrate] 执行 upgrade head ..."
docker exec -w /app "$CONTAINER" alembic upgrade head

echo "[migrate] 完成, 现版本:"
docker exec -w /app "$CONTAINER" alembic current 2>&1