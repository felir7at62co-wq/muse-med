"""pytest 公共夹具：临时 SQLite 库、不读 `.env`、不碰网络。

## 为什么环境变量必须在这里、且在任何 `import app.*` 之前设

`app/db.py` 在**导入时**就定下库地址（`FW_DATABASE_URL` → 同目录 `.env` → 写死的
dev 路径）。不先设环境变量，测试会去读 `backend/.env` 并连上那里写的库 ——
那是真实的开发/生产库。`app/config.py` 的 `Settings` 同理会读 `.env`
（里面是真实密钥），所以把它的 `env_file` 摘掉：测试只用代码里的默认值。

## 每个测试一套干净的表

`db` 夹具每次 drop_all + create_all。表不多、库在临时目录里，几十毫秒的事，
换来的是测试之间互不可见。
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

_TMP = tempfile.mkdtemp(prefix="jingliu-tests-")
os.environ["FW_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["FW_DATA_DIR"] = f"{_TMP}/data"
os.environ["FW_DB_SLOW_LOG"] = "0"

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app import config as _config  # noqa: E402

_config.Settings.model_config["env_file"] = None
_config.get_settings.cache_clear()


def run(coro):
    """跑一个协程到结束（不引 pytest-asyncio：少一个依赖，也少一层魔法）。"""
    return asyncio.run(coro)


@pytest.fixture()
def db():
    """一套干净的表。返回 `get_session`。"""
    from app import db as _db
    assert _db.DATABASE_URL.startswith(f"sqlite:///{_TMP}"), _db.DATABASE_URL
    # 工具模块要先导入，Agent 的三张表才在 metadata 里（都在 app.db，随它一起建）
    _db.Base.metadata.drop_all(_db.engine)
    _db.Base.metadata.create_all(_db.engine)
    from app.continuity import invalidate_run_cache
    invalidate_run_cache()
    return _db.get_session


@pytest.fixture()
def tools():
    """注册全部 Agent 工具（注册表靠导入副作用填充）。返回 `registry` 模块。"""
    from app.agent import (registry, tools_audit, tools_gen, tools_gen2,  # noqa: F401
                           tools_read, tools_write)
    return registry


# ---------------------------------------------------------------------------
# 造数据的小工具（测试文件直接 `from conftest import …`）
# ---------------------------------------------------------------------------

PID = "proj-test-0001"


def make_project(get_session, pid: str = PID, **kw) -> str:
    from app.db import Project
    with get_session() as s:
        s.add(Project(id=pid, title=kw.pop("title", "测试剧"), **kw))
        s.commit()
    return pid


def add_shot(get_session, pid: str, order: int, *, episode: int = 1,
             script_ref: str = "", **kw) -> str:
    import uuid

    from app.db import Shot
    sid = kw.pop("id", None) or uuid.uuid4().hex[:12]
    with get_session() as s:
        s.add(Shot(id=sid, project_id=pid, order=order, episode=episode,
                   script_ref=script_ref or f"第{order}镜的剧本", **kw))
        s.commit()
    return sid


def add_asset(get_session, pid: str, kind: str, name: str, image_url: str | None = None,
              **kw) -> str:
    import uuid

    from app.db import Asset
    aid = uuid.uuid4().hex[:12]
    with get_session() as s:
        s.add(Asset(id=aid, project_id=pid, kind=kind, name=name, image_url=image_url, **kw))
        s.commit()
    return aid


def shots_of(get_session, pid: str, episode: int | None = None) -> list:
    """按镜号取镜头（脱离会话的只读快照：取出的列都已加载）。"""
    from app.db import Shot
    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == pid)
        if episode is not None:
            q = q.filter(Shot.episode == episode)
        rows = q.order_by(Shot.order).all()
        for r in rows:
            s.refresh(r)
        s.expunge_all()
        return rows


def get_shot(get_session, sid: str):
    from app.db import Shot
    with get_session() as s:
        r = s.get(Shot, sid)
        if r is not None:
            s.refresh(r)
            s.expunge(r)
        return r


def tool_ctx(pid: str = PID, role: str = "owner"):
    from app.agent.executor import ToolCtx
    return ToolCtx(run_id="test-run", project_id=pid, user_id=None, role=role)


def call_tool(name: str, pid: str = PID, /, **args) -> dict:
    """像桌面端网关那样调一个工具：经 `execute_tool`（权限 / 报价 / 审计），返回解析后的 dict。

    前两个参数只能按位置给：有的工具自己就有叫 `name` 的参数（站位图那几个）。
    """
    import json as _json

    from app.agent import registry
    from app.agent.executor import execute_tool

    spec = registry.get_spec(name)
    assert spec is not None, f"工具没有注册：{name}"
    if "project_id" in spec.args_schema.model_fields:
        args.setdefault("project_id", pid)
    text = run(execute_tool(tool_ctx(pid), spec, args, call_id="call-" + name))
    return _json.loads(text)
