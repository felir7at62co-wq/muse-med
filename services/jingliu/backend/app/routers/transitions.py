"""镜头接缝转场：增删改查。

`GET    /v2/projects/{pid}/transitions`
`POST   /v2/transitions`
`PATCH  /v2/transitions/{trans_id}`
`DELETE /v2/transitions/{trans_id}`

## 为什么从 routes_v2.py 搬出来

那个文件的行数预算在架构守卫里是「只许减」（见 `routers/__init__.py` 与
`desktop/scripts/verify-architecture.ts` 的 BUDGETS）。转场这一域与
`routes_v2` 里的东西**没有任何共享状态**：它只碰 `Transition` / `Shot` /
`Project` 三张表，自己的两个小工具（`_trans_out` / `_clamp_transition_duration`）
也只被本文件使用。搬出来整块自洽，`routes_v2` 净减。

## 时长钳制为什么在落库时做

`_clamp_transition_duration` 把转场时长压到「任一侧镜头时长的一半」以内：
xfade 的重叠区从两侧各吃掉一段，转场比某侧镜头还长时那个镜头会被整个吃掉，
产出画面完全不是用户想要的。前端也做同样校验——**两边都做**是因为接口
可能被别处调用，而"别处调用时忘了钳制"的代价是成片里少一个镜头。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Project, Shot, get_session

router = APIRouter(prefix="/v2", tags=["transitions"])


class TransitionIn(BaseModel):
    project_id: str
    from_shot_id: str
    to_shot_id: str
    type: str = "fade"
    duration: float = 0.5
    params: Optional[dict] = None


class TransitionPatch(BaseModel):
    type: Optional[str] = None
    duration: Optional[float] = None
    params: Optional[dict] = None


def _trans_out(t) -> dict:
    return {"id": t.id, "type": t.type, "duration": t.duration,
            "from_shot_id": t.from_shot_id, "to_shot_id": t.to_shot_id,
            "params": json.loads(t.params) if t.params else None}


def _clamp_transition_duration(session, from_id: str, to_id: str, want: float) -> float:
    """转场时长不能超过任一侧镜头时长的一半。

    xfade 的重叠区是从两侧各吃掉一段。若转场比某侧镜头还长，那个镜头会被
    整个吃掉，产出画面完全不是用户想要的。这里在落库时钳制，前端也做同样
    校验——两边都做是因为接口可能被别处调用。
    """
    lo = 0.1
    hi = 5.0
    for sid in (from_id, to_id):
        sh = session.get(Shot, sid)
        if sh:
            hi = min(hi, max(lo, float(sh.duration_sec or 5.0) / 2))
    return max(lo, min(hi, float(want)))


@router.get("/projects/{project_id}/transitions")
def list_transitions(project_id: str) -> dict:
    from ..db import Transition
    with get_session() as session:
        rows = (session.query(Transition)
                .filter(Transition.project_id == project_id).all())
        return {"transitions": [_trans_out(t) for t in rows]}


@router.post("/transitions")
def create_transition(body: TransitionIn) -> dict:
    """在两个镜头的接缝处建转场。同一接缝只允许一个——重复提交视为替换。"""
    from ..db import Transition
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        a, b = session.get(Shot, body.from_shot_id), session.get(Shot, body.to_shot_id)
        # ⚠️ 两个镜头必须都属于 body.project_id（2026-10-09 补）。中间件只校验了
        # body.project_id 是你的；shot id 是另外两个独立参数。不比对的话，
        # 可以在自己的项目下建一条指向别人镜头的转场，进而经
        # `_clamp_transition_duration` 读到别人镜头的时长。
        if (not a or not b or a.project_id != body.project_id
                or b.project_id != body.project_id):
            raise HTTPException(status_code=404, detail="shot not found")
        if a.order + 1 != b.order:
            raise HTTPException(
                status_code=422,
                detail=f"转场只能加在相邻镜头之间（#{a.order} 与 #{b.order} 不相邻）")

        dur = _clamp_transition_duration(session, body.from_shot_id, body.to_shot_id,
                                         body.duration)
        # 同一接缝已有转场 → 覆盖，而不是叠加出两个
        exist = (session.query(Transition)
                 .filter(Transition.from_shot_id == body.from_shot_id,
                         Transition.to_shot_id == body.to_shot_id).first())
        if exist:
            exist.type = body.type
            exist.duration = dur
            exist.params = json.dumps(body.params, ensure_ascii=False) if body.params else None
            session.commit()
            return {"ok": True, "replaced": True, **_trans_out(exist)}

        t = Transition(
            id=uuid.uuid4().hex[:12], project_id=body.project_id,
            type=body.type, duration=dur,
            from_shot_id=body.from_shot_id, to_shot_id=body.to_shot_id,
            params=json.dumps(body.params, ensure_ascii=False) if body.params else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        session.add(t)
        session.commit()
        return {"ok": True, "replaced": False, **_trans_out(t)}


@router.patch("/transitions/{trans_id}")
def patch_transition(trans_id: str, body: TransitionPatch) -> dict:
    from ..db import Transition
    with get_session() as session:
        t = access.req_transition(session, trans_id)
        if body.type is not None:
            t.type = body.type
        if body.duration is not None:
            t.duration = _clamp_transition_duration(
                session, t.from_shot_id, t.to_shot_id, body.duration)
        if body.params is not None:
            t.params = json.dumps(body.params, ensure_ascii=False)
        session.commit()
        return {"ok": True, **_trans_out(t)}


@router.delete("/transitions/{trans_id}")
def delete_transition(trans_id: str) -> dict:
    from ..db import Transition
    with get_session() as session:
        t = access.req_transition(session, trans_id)
        session.delete(t)
        session.commit()
    return {"ok": True}
