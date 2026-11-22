"""运行事件：写入 agent_run_events（前端 SSE 按 seq 续读，断线重连不丢）。

同一运行同一时刻只有一个执行者（线程咨询锁保证），所以 seq 由执行者在内存里递增即可；
启动时从库里取当前最大 seq 接着往下编。
"""
from __future__ import annotations

from sqlalchemy import func, select

from ..db import session_scope
from .models import AgentRunEvent


class EventWriter:
    def __init__(self, run_id: int):
        self.run_id = run_id
        self.seq = 0

    async def init(self) -> "EventWriter":
        async with session_scope() as s:
            self.seq = (await s.execute(
                select(func.coalesce(func.max(AgentRunEvent.seq), 0)).where(AgentRunEvent.run_id == self.run_id)
            )).scalar_one()
        return self

    async def emit(self, type_: str, payload: dict | None = None) -> int:
        from sqlalchemy.exc import IntegrityError
        for _ in range(3):
            self.seq += 1
            try:
                async with session_scope() as s:
                    s.add(AgentRunEvent(run_id=self.run_id, seq=self.seq, type=type_, payload=payload or {}))
                return self.seq
            except IntegrityError:
                # 兜底：接口层(emit_once)与执行者偶发同时写 → 重取当前最大序号再写，事件不丢
                await self.init()
        raise RuntimeError(f"run {self.run_id} 事件写入连续冲突")


async def emit_once(run_id: int, type_: str, payload: dict | None = None) -> None:
    """运行器之外（接口层）写一条事件，如"已取消""审批已提交"。"""
    w = await EventWriter(run_id).init()
    await w.emit(type_, payload)
