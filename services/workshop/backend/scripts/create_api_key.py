"""给某个账号签发一把 API Key（外部 Agent 经 /v1/mcp 用）。

用法（在 orchestrator 容器里）：
    python scripts/create_api_key.py --username <账号> --name "同事 Agent" --out /tmp/key.txt
    python scripts/create_api_key.py --username <账号> --list
    python scripts/create_api_key.py --revoke <key id>

明文只写进 --out 指定的文件（权限 0600），屏幕上连前缀都不显示，只显示 key 编号：交给对方后删掉这个文件。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select  # noqa: E402

from app.auth.api_keys import create_key  # noqa: E402
from app.auth.models import User  # noqa: E402
from app.db import session_scope  # noqa: E402
from app.db.models_phase5 import ApiKey  # noqa: E402


async def _user(username: str) -> User:
    async with session_scope() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        sys.exit(f"没有账号：{username}")
    return user


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--username")
    ap.add_argument("--name", default="外部 Agent")
    ap.add_argument("--out", help="明文写入这个文件（0600）")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--revoke", type=int)
    a = ap.parse_args()
    print(f"ENV={os.environ.get('ENV', '?')}  DATABASE={os.environ.get('DATABASE_URL', '?').rsplit('/', 1)[-1]}")
    if a.revoke:
        async with session_scope() as s:
            row = await s.get(ApiKey, a.revoke)
            if row is None:
                sys.exit("没有这把 key")
            row.revoked_at = row.revoked_at or datetime.utcnow()
            await s.commit()
        print(f"已吊销 key #{a.revoke}")
        return
    if not a.username:
        sys.exit("需要 --username")
    user = await _user(a.username)
    if a.list:
        async with session_scope() as s:
            rows = (await s.execute(select(ApiKey).where(ApiKey.user_id == user.id))).scalars().all()
        for r in rows:
            print(f"#{r.id} {r.name} 建于 {r.created_at} 最近使用 {r.last_used_at} "
                  f"{'已吊销' if r.revoked_at else '有效'}")
        return
    if not a.out:
        sys.exit("需要 --out：明文只写文件，不打印")
    plain, row = await create_key(user.id, a.name)
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(plain + "\n")
    print(f"已为 {a.username}（id {user.id}）签发 key #{row.id}，明文在 {a.out}")


if __name__ == "__main__":
    asyncio.run(main())
