"""任务（Job）的对外契约：`JobOut` / `JobSubmitIn`。

## 为什么单独成模块

`JobOut` 有三个消费者：`routes_v2`（提交与查询）、`routers/desub.py`、
`routers/upscale.py`、`routers/look.py`（场景多视角生成）。
它先是住在 `routes_v2.py` 里，于是子模块要反向 import 路由文件。
按 `docs/PLAN-路由按域拆分.md` 的原则下沉到这一层。

## 与 `POST /v2/jobs` 的 JobOut **逐字段同构**

去字幕那套复用同一个轮询器（`jobStatus()`），不为某个域单开一套返回类型 ——
少一个类型就少一处会漂的契约。
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class JobSubmitIn(BaseModel):
    kind: str  # asset_batch
    payload: dict


class JobOut(BaseModel):
    id: str
    kind: str
    status: str
    progress: int
    result: Optional[str] = None
    error: Optional[str] = None
    #: 本次提交命中了去重、返回的是已在跑的那个 job（前端据此提示"已在生成中"
    #: 而不是当成新任务再弹一次"已提交"）
    deduped: bool = False
    #: 本次提交里**因为已在跑而被剔掉**的镜头 id（2026-10-16）。
    #:
    #: 与 `deduped` 是两件事，别混：`deduped=true` 是**整条提交**被复用、
    #: 一个镜头都没新排；`skipped` 非空而 `deduped=false` 是**交集** ——
    #: 用户勾了 5 镜、其中 2 镜在跑，于是剔掉那 2 镜、剩下 3 镜照常提交。
    #:
    #: 界面必须把这件事说出来（"已提交 3 镜，跳过 2 镜"）。不说的话用户
    #: 勾了 5 个却只有 3 个在跑，看起来就像"点了没反应"——那正是我们要修的
    #: 那类问题，只是换了个位置出现。
    skipped: list[str] = []
    #: 当前阶段（进程内态，见 jobs._JOB_PHASE）。i2va 批量出片会先把整批首帧
    #: 生完才提交视频，没有这个字段前几分钟只有"已出片 0/170"，看着像卡死。
    phase: Optional[dict] = None
