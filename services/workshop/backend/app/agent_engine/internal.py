"""worker → orchestrator 的内部通道：把"本来就跑在 orchestrator 进程里的后台任务"交回 orchestrator 启动。

为什么需要：裂变、批量创建、剧本分析、去AI味、小说/推文这几项，平台的实现是在 orchestrator
进程里 asyncio.create_task 起后台任务，并且 orchestrator 启动时有自动恢复（裂变、批量创建）。
Agent 工具跑在 worker 里，若直接调用，任务会起在 worker 进程：worker 重启就丢；只重启 orchestrator
时它的启动恢复还会把 worker 里仍在跑的同一个任务**再起一份**。交回 orchestrator 启动后，与用户在
界面上点按钮完全同一条路径、同一套恢复机制。

安全：dev 的 nginx 有 /api/ → orchestrator 的透传，所以不能只靠路径名。两道防护：
  1. 必须带 X-Internal-Key（由 jwt_secret 派生，不新增配置）；
  2. 带 X-Real-IP / X-Forwarded-For（即经过 nginx 转发）的请求一律拒绝。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("agent_engine.internal")

router = APIRouter(prefix="/internal/agent-engine", tags=["internal"], include_in_schema=False)
ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_INTERNAL_URL", "http://orchestrator:8000")


def _key() -> str:
    from ..config import get_settings
    return hmac.new(get_settings().jwt_secret.encode(), b"agent-engine-internal-launch", hashlib.sha256).hexdigest()


class LaunchIn(BaseModel):
    action: str
    user_id: int
    args: dict = {}
    writing_model: str | None = None


async def _launch(action: str, user, args: dict) -> dict:
    if action == "spawn":
        from ..spawn.routes import SubmitBody, submit
        return await submit(SubmitBody(**args), user=user)
    if action == "batch_create":
        from ..batch_create.routes import BatchCreateIn, create_batch
        return await create_batch(BatchCreateIn(**args), user=user)
    if action == "analysis":
        from ..analysis.routes import start_analysis
        return await start_analysis(int(args["draft_id"]), user=user)
    if action == "deai":
        from ..deai.routes import ApplyBody, submit
        return await submit(ApplyBody(**args), user=user)
    if action == "novel_tweet":
        from ..agent.chat_jobs import start_generate
        return await start_generate(draft_id=int(args["draft_id"]), user_id=user.id, gen_kind=args["gen_kind"],
                                    writing_model=args.get("writing_model"))
    raise HTTPException(400, f"未知动作 {action}")


@router.post("/launch")
async def launch(body: LaunchIn, request: Request):
    if request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for"):
        raise HTTPException(404, "Not Found")
    if not hmac.compare_digest(request.headers.get("x-internal-key", ""), _key()):
        raise HTTPException(404, "Not Found")
    from ..auth.models import User
    from ..db import session_scope
    async with session_scope() as s:
        user = await s.get(User, body.user_id)
        if not user:
            raise HTTPException(404, "用户不存在")
        s.expunge(user)
    logger.info("agent-engine launch %s user=%s writing_model=%s", body.action, body.user_id, body.writing_model)
    # 写作模型在这个请求里设好：裂变/批量创建/分析/去AI味是在这里 create_task 出去的，
    # 子任务会拷贝当前 context，所以它们后续的每次 get_llm 都会用上。
    from ..job_context import WRITING_MODEL
    token = WRITING_MODEL.set(body.writing_model or None)
    try:
        return await _launch(body.action, user, body.args)
    finally:
        WRITING_MODEL.reset(token)


async def launch_in_orchestrator(action: str, user_id: int, args: dict) -> dict:
    """worker 侧调用。失败时抛出带原因的异常（由工具层转成给模型看的失败说明）。
    当前环境的写作模型一并带过去（跨进程 contextvar 过不去）。"""
    from ..job_context import current_writing_model
    async with httpx.AsyncClient(timeout=120) as cl:
        r = await cl.post(f"{ORCHESTRATOR_URL}/internal/agent-engine/launch",
                          json={"action": action, "user_id": user_id, "args": args,
                                "writing_model": current_writing_model()},
                          headers={"X-Internal-Key": _key()})
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {"detail": r.text[:300]}
    if r.status_code >= 400:
        raise RuntimeError(str(data.get("detail") if isinstance(data, dict) else data))
    return data
