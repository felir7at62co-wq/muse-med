"""按镜头里写的名字补建资产行（2026-11-03 抽出）。

## 为什么单独成模块

资产行原先只有一处会建：拆解落库（`routers/shots.py::do_breakdown` 末尾的
「资产增量合并」）。桌面端 Agent 不走拆解、逐镜 `patch_shot` 写人物/场景/道具时，
镜头上有「林小满、吴秘书」，资产表里却一行都没有 —— 要素页空白，出片也注入不了
任何参考图（生产「西北婚约125」11 镜 / 0 资产）。

两处共用这一份规则，避免再出现「拆解建、手改不建」的口径分叉。

## 规则（与拆解原逻辑逐字一致）

- 角色按**原名**建行；
- 场景、道具按 `canonical_of` 的**归一名**建行（拆解给的是带「夜 内」前缀的原名，
  照原样建会让同一个房间分裂成多行、各出一张图）；
- 已有同名行（**含墓碑**）一律不建：用户删掉的资产不该被一次改镜头悄悄复活。

调用方负责 commit。
"""
from __future__ import annotations

import uuid
from typing import Iterable

from .db import Asset


def ensure_assets(session, project_id: str, *,
                  characters: Iterable[str] = (),
                  locations: Iterable[str] = (),
                  props: Iterable[str] = ()) -> list[dict]:
    """为还没有资产行的名字补建资产行。返回新建的 `[{kind, name}]`（按建行顺序）。"""
    from .scenes import canonical_of

    existing = {(a.kind, a.name) for a in
                session.query(Asset.kind, Asset.name)
                .filter(Asset.project_id == project_id).all()}
    created: list[dict] = []

    def _add(kind: str, name: str) -> None:
        if not name or (kind, name) in existing:
            return
        existing.add((kind, name))
        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                          kind=kind, name=name))
        created.append({"kind": kind, "name": name})

    for c in characters:
        _add("character", (c or "").strip())
    for raw in locations:
        raw = (raw or "").strip()
        if raw:
            _add("location", canonical_of(session, project_id, raw) or raw)
    for raw in props:
        # 道具与场景同款走归一名（道具别名同在 SceneAlias 那条链上）
        raw = (raw or "").strip()
        if raw:
            _add("prop", canonical_of(session, project_id, raw) or raw)
    return created
