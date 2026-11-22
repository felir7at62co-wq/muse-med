"""镜流桌面客户端调用剧本平台工具的入口（2026-11-01）。

桌面客户端有自己的 Agent（模型、对话、上下文压缩都在客户端），它要的只是「能调剧本平台的工具」。
所以这里不起 AgentRun、不跑 LangGraph，只做三件事：

- ``GET  /v1/desktop-agent/tools``：工具目录（名字、说明、参数 JSON schema、风险等级）+ 给客户端系统提示词用的工作说明；
- ``POST /v1/desktop-agent/call``：执行一个工具；
- 确认：与超级 Agent **同一套**判据（``policy.needs_approval``，按用户的权限开关），需要确认而请求没带
  ``confirmed`` 时不执行，返回 ``needs_confirm`` 和给人看的说明（``policy.describe``），客户端弹卡片、用户同意后带
  ``confirmed: true`` 重调。判据放在执行这一步、而不是只在目录里标注：目录里的标注拦不住直接调用。

工具本身（权限校验、单剧本/只读范围、写后回读、作业幂等）全部原样复用 ``tools.py``，这里一行业务逻辑都不写。
运行配置固定为 ``producer``（全局制片：跨草稿、可新建），与网页超级 Agent 的默认配置一致。

不计费（用户 2026-11-01 裁定）：与剧本平台网页一致，文本生成只记用量。

写稿模型按人记住（用户 2026-11-01 裁定）：存在 ``user_profiles.preferred_model``，与网页模型下拉的个人默认是同一个
字段，所以在桌面选了网页默认也跟着变。没选过时用 ``DEFAULT_WRITING_MODEL``。两个桌面专用工具
``list_writing_models`` / ``set_writing_model`` 只在这里登记、不进 ``tools.py`` 的 META：网页超级 Agent 用对话栏的
模型选择器，不需要它们。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..auth.dependencies import get_current_user
from ..auth.models import User
from .context import EngineContext
from .policy import _TOOL_LABEL, describe, merge_permissions, needs_approval
from .prompts import PROFILE_TOOLS, system_prompt
from .tools import AGGREGATES, META, all_tools, resolve_tool, rewrite_hints

logger = logging.getLogger("agent_engine.desktop")

router = APIRouter(prefix="/v1/desktop-agent", tags=["desktop-agent"])

#: 一次 HTTP 调用最多占用多久（秒）。必须小于平台的两道总超时：TimeoutMiddleware 的 300 秒
#: （超了返回 504「Request timed out after 300s」）与 nginx /v1/ 的 proxy_read_timeout 600 秒。
#: 2026-11-02 生产实测：regenerate_storyboard / regenerate_outline_range / wait_job 同步跑超 300 秒，
#: 用户只看到一串 504，而稿子其实还在写。所以慢的事一律放进作业队列，HTTP 调用只等这么久。
CALL_TIMEOUT_SEC = 280
#: 慢工具转成作业后，本次调用原地等它多久（秒）；没跑完就返回作业号，让 Agent 用 wait_job 接着等。
#: 约 1 分钟的单集重写在这个时间里跑完，用起来和以前一样直接拿到结果。
INLINE_WAIT_SEC = 240
#: 作业里执行一个工具的上限（秒）。extend_outline 自己最多等 1 小时。
JOB_TOOL_TIMEOUT_SEC = 3900
JOB_KIND = "desktop_tool"

#: 会调模型、可能跑上好几分钟、却在工具里同步等结果的工具：经作业队列执行。
#: 已经自己提交作业、立刻返回 job_id 的工具（generate_* / start_* 等）不在这里。
SLOW_TOOLS = frozenset({
    "regenerate_outline_episode", "regenerate_outline_range", "regenerate_chapter", "regenerate_storyboard",
    "regenerate_product", "expand_outline_beats", "extend_outline", "rebalance_timeline", "diagnose_timeline",
    "build_character_cards", "scan_character_warnings", "extract_characters", "build_story_bible",
    "backfill_settings", "refresh_ledger", "run_check", "check_mainline", "adapt_analyze", "adapt_propose",
})
#: 自己会原地等的读工具：等待参数压到 INLINE_WAIT_SEC 以内，没等完就让 Agent 再调一次。
_WAIT_ARGS = {"wait_job": "max_wait_seconds", "get_analysis": "wait_seconds"}

#: 给桌面客户端的补充说明：接在超级 Agent 的系统提示词后面。网页里那几句「去对应页面」在桌面端
#: 要换成「新开镜流对话」，确认也换成客户端的确认卡片。
#: 写稿模型怎么选、怎么换（桌面端与 MCP 共用）。
WRITING_MODEL_NOTE = """- 写稿模型（大纲、正文、剧本、精修、去AI味、改编由哪个模型写）按用户记住，与你自己用的模型无关。每个对话第一次要做事之前先调一次 list_writing_models：
  - chosen 为 false（用户从没选过）：把 recommended 里的几个模型列给用户，说明各自特点，请他选一个；他选了就调 set_writing_model 存下。他说随便或没有偏好，就存 recommended 的第一个，以后不再问。
  - chosen 为 true：照他存的模型做，不再问。
"""
SWITCH_MODEL_NOTE = """- 用户在对话里说要换写稿模型时：先调 list_writing_models 把他说的名字对上清单里的型号，再调 set_writing_model。清单里没有的型号不要自己编。
"""
#: 慢操作转后台作业后怎么接着等（桌面端与 MCP 共用）。
BACKGROUND_JOB_NOTE = """- 按意见重写、区间重写、体检、主线核对这类要调模型的操作，4 分钟内写完就直接返回结果；没写完会返回 job_id（running_in_background 为 true），这不是失败：告诉用户还在写，用 script_job(action="wait", job_id=…, kind="agent") 接着等，结果在返回的 result.output 里。每次最多等约 4 分钟，没结束就再调一次。"""

DESKTOP_NOTE = """

# 你现在在镜流桌面客户端里
- 你接的是**剧本平台**：大纲、场景卡、正文、剧本（分镜剧本，文字）的生成与按意见改稿，以及验收和版本回退。
- 视频、镜头、出片、资产图、剪映草稿都在**镜流**那边，不在这个对话里：用户要做视频时，告诉他新开一个「镜流」对话。
- 会改内容的操作（生成、覆盖、删除、导出）执行前客户端会弹确认卡片，用户点同意后才会执行；被拒绝就照实告诉用户没做。
- 草稿 id 是数字（例如 2931），不是镜流项目那种 12 位字母数字。
""" + WRITING_MODEL_NOTE + """- 用户问你能做什么时：先说主要能力（从一句话创意生成大纲、场景卡、剧本，验收并按意见逐集改稿，改坏了回退），再说他多半不知道的：把草稿写成飞书文档、读和改飞书文档（发链接即可）、到点或作业结束时飞书提醒、读本机 Word/PDF、把常用做法存成技能（输入框打 / 能看到）、换写稿模型、把剧本送到镜流做视频。不要念工具名。
""" + SWITCH_MODEL_NOTE + BACKGROUND_JOB_NOTE


#: 通宵模式下一律不做的工具：删草稿、取消别人正在跑的任务。其余覆盖类操作都留历史版本，可以回退。
UNATTENDED_REFUSED = frozenset({"trash_draft", "cancel_draft_tasks"})

#: wait_job 认识的作业类型。
JOB_KINDS = ("agent", "batch", "deai", "novel_tweet", "spawn", "batch_create")

#: 推荐写稿模型时的厂商顺序（用户 2026-11-01 指定）。每家取清单里最靠前（清单按新的在前排）的一个正式型号。
RECOMMEND_VENDORS = ("kimi", "deepseek", "gemini", "gpt5")
#: 备注里带这些词的型号不拿来推荐：快照、老一代、轻量或长文偏弱的档位。
_NOT_RECOMMENDED = ("快照", "老一代", "上一代", "偏弱", "轻量")

LIST_MODELS = "list_writing_models"
SET_MODEL = "set_writing_model"
REMIND_DONE = "remind_when_job_done"
#: 提醒发送失败后最多再试几次。
REMIND_MAX_ATTEMPTS = 5
REMIND_INTERVAL_SEC = 20

#: 两个桌面专用工具的目录条目（格式与 ``_catalog_entry`` 相同）。
LOCAL_TOOLS: dict[str, dict] = {
    LIST_MODELS: {
        "name": LIST_MODELS,
        "description": "列出剧本平台可选的写稿模型（大纲、正文、剧本、精修等由哪个模型写），以及用户现在用的是哪个、"
                       "他有没有选过（chosen）、推荐给他选的几个（recommended，Kimi / DeepSeek / Gemini / GPT 各家最新的正式型号）。"
                       "stable 为 true 表示最近实测每条线路都通。",
        "parameters": {"type": "object", "properties": {}},
        "risk": "read", "scope": "global", "long_running": False,
    },
    SET_MODEL: {
        "name": SET_MODEL,
        "description": "把用户选的写稿模型存下来：以后这个用户所有对话里的生成、改写都用它（网页上的默认模型也跟着变）。"
                       "model 用 list_writing_models 返回的 value（形如 kimi:kimi-k3），也可以只写型号名。只在用户明确选了或同意推荐后调用。",
        "parameters": {"type": "object", "properties": {"model": {"type": "string", "description": "list_writing_models 里的 value 或型号名"}},
                       "required": ["model"]},
        "risk": "meta", "scope": "global", "long_running": False,
    },
    REMIND_DONE: {
        "name": REMIND_DONE,
        "description": "作业结束（成功、失败或取消）时由飞书机器人私信提醒用户本人，用户不用等着，也不用开着客户端。只在用户要求时调用。"
                       "job_id 和 kind 取自提交作业时的返回值。不花钱。",
        "parameters": {"type": "object", "properties": {
            "job_id": {"type": "integer"},
            "kind": {"type": "string", "enum": list(JOB_KINDS), "description": "作业类型，与 job 工具的 kind 相同，默认 agent"},
            "text": {"type": "string", "description": "提醒里附带的话"},
        }, "required": ["job_id"]},
        "risk": "meta", "scope": "global", "long_running": False,
    },
}


async def _remind_done(user: User, args: dict) -> dict:
    from sqlalchemy import select
    from ..db import session_scope
    from ..db.models_phase5 import DesktopReminder
    from .tools import ToolFailure, _job_snapshot

    kind = str((args or {}).get("kind") or "agent")
    if kind not in JOB_KINDS:
        return {"ok": False, "error": f"kind 只能是 {'、'.join(JOB_KINDS)}"}
    try:
        job_id = int((args or {}).get("job_id"))
        await _job_snapshot(await _context(user), job_id, kind)
    except (TypeError, ValueError):
        return {"ok": False, "error": "job_id 要是作业号（整数）"}
    except ToolFailure as e:
        return {"ok": False, "error": str(e)}
    if not user.feishu_union_id:
        return {"ok": False, "error": "不知道你的飞书账号：请用飞书扫码登录一次"}
    text = str((args or {}).get("text") or "去看看结果").strip()[:400]
    async with session_scope() as s:
        old = (await s.execute(select(DesktopReminder.id).where(
            DesktopReminder.user_id == user.id, DesktopReminder.job_id == job_id, DesktopReminder.job_kind == kind,
            DesktopReminder.status == "pending"))).first()
        if old is None:
            s.add(DesktopReminder(user_id=user.id, job_id=job_id, job_kind=kind, text=text))
    return {"ok": True, "result": json.dumps({"job_id": job_id, "kind": kind, "note": "作业结束时会飞书私信提醒"}, ensure_ascii=False)}


async def sweep_reminders() -> int:
    """发出作业已结束的提醒，返回发出的条数。一条失败不影响其他条。"""
    from datetime import datetime
    from sqlalchemy import select
    from ..db import session_scope
    from ..db.models_phase5 import DesktopReminder
    from ..feishu.client import send_text
    from .tools import _TERMINAL, ToolFailure, _job_snapshot

    async with session_scope() as s:
        ids = (await s.execute(select(DesktopReminder.id).where(DesktopReminder.status == "pending"))).scalars().all()
    sent = 0
    for rid in ids:
        async with session_scope() as s:
            r = await s.get(DesktopReminder, rid)
            u = await s.get(User, r.user_id)
            try:
                role = u.role if u else "user"
                ctx = EngineContext(user_id=r.user_id, role=role or "user", run_id=0, conversation_id=0, profile="producer")
                snap = await _job_snapshot(ctx, r.job_id, r.job_kind)
                if snap.get("status") not in _TERMINAL:
                    continue
                state = {"done": "已完成", "succeeded": "已完成", "completed": "已完成",
                         "canceled": "已取消", "cancelled": "已取消"}.get(snap["status"], "没有全部成功")
                await send_text(union_id=(u.feishu_union_id if u else "") or "", text=f"剧本平台的作业 #{r.job_id} {state}。{r.text}")
                r.status, r.sent_at, r.error = "sent", datetime.utcnow(), None
                sent += 1
            except ToolFailure as e:
                r.status, r.error = "failed", str(e)[:300]
            except Exception as e:  # noqa: BLE001  一条发不出去不能挡住后面的
                r.attempts += 1
                r.error = repr(e)[:300]
                if r.attempts >= REMIND_MAX_ATTEMPTS:
                    r.status = "failed"
                logger.warning("desktop reminder %s 发送失败 attempts=%s: %r", rid, r.attempts, e)
    return sent


async def run_reminder_daemon() -> None:
    while True:
        await asyncio.sleep(REMIND_INTERVAL_SEC)
        try:
            await sweep_reminders()
        except Exception:  # noqa: BLE001  单轮失败不能让循环退出
            logger.exception("desktop reminder 本轮失败")


async def _preferred(user_id: int) -> str | None:
    """用户存的写稿模型；没存、或存的型号已下架，返回 None（= 用默认）。"""
    from ..agent.memory import get_or_create_profile
    from ..models.catalog import is_allowed, split_provider_model
    prof = await get_or_create_profile(user_id)
    spec = str((prof or {}).get("preferred_model") or "").strip() if isinstance(prof, dict) else ""
    prov, mid = split_provider_model(spec)
    return spec if spec and mid and is_allowed(prov, mid) else None


def _resolve(spec: str) -> str | None:
    """``厂商:型号`` 或裸型号名（含别名、推理档后缀）→ 清单里的 ``厂商:型号``；对不上返回 None。"""
    from ..models.catalog import all_specs, is_allowed, normalize_model, split_provider_model
    s = (spec or "").strip()
    prov, mid = split_provider_model(s)
    if mid:
        mid = normalize_model(mid)
        return f"{prov}:{mid}" if is_allowed(prov, mid) else None
    want = normalize_model(s).lower()
    hits = [m for m in all_specs() if m.id.lower() == want]
    return f"{hits[0].provider}:{hits[0].id}" if len(hits) == 1 else None


async def _list_models(user: User) -> str:
    from ..models.health import catalog_with_health
    from .llm import DEFAULT_WRITING_MODEL
    groups = await catalog_with_health()
    recommended = []
    for vendor in RECOMMEND_VENDORS:
        group = next((g for g in groups if g["provider"] == vendor), None)
        if group is None:
            continue
        pool = [m for m in group["models"] if not any(w in (m.get("note") or "") for w in _NOT_RECOMMENDED)] or group["models"]
        pick = next((m for m in pool if m.get("stable")), pool[0] if pool else None)
        if pick is not None:
            recommended.append({"value": pick["value"], "vendor": group["label"], "note": pick.get("note") or "",
                                "stable": bool(pick.get("stable"))})
    mine = await _preferred(user.id)
    return json.dumps({
        "chosen": mine is not None,
        "current": mine or DEFAULT_WRITING_MODEL,
        "recommended": recommended,
        "all": [{"vendor": g["label"], "models": [{"value": m["value"], "stable": bool(m.get("stable")),
                                                    **({"note": m["note"]} if m.get("note") else {})} for m in g["models"]]}
                for g in groups],
    }, ensure_ascii=False)


async def _set_model(user: User, args: dict) -> dict:
    from ..agent.memory import update_profile
    raw = str((args or {}).get("model") or "").strip()
    spec = _resolve(raw)
    if spec is None:
        return {"ok": False, "error": f"清单里没有「{raw}」这个写稿模型；先调 {LIST_MODELS} 看可选的 value"}
    await update_profile(user.id, preferred_model=spec)
    logger.info("desktop writing model user=%s model=%s", user.id, spec)
    return {"ok": True, "result": json.dumps({"saved": spec, "note": "以后这个用户的生成、改写都用它；网页上的默认模型也已同步"},
                                              ensure_ascii=False)}


def _catalog_entry(name: str, tool: Any) -> dict:
    meta = META[name]
    try:
        params = tool.tool_call_schema.model_json_schema()
    except Exception:  # noqa: BLE001  个别工具的 schema 生成失败不能拖垮整份目录
        logger.exception("desktop catalog: %s 的参数 schema 生成失败", name)
        params = {"type": "object", "properties": {}}
    return {
        "name": name,
        "description": (tool.description or "").strip(),
        "parameters": params,
        "risk": meta.risk,
        "scope": meta.scope,
        "long_running": meta.long_running,
    }


async def _context(user: User) -> EngineContext:
    from ..agent.memory import get_or_create_profile
    prof = await get_or_create_profile(user.id)
    perms = merge_permissions((prof or {}).get("agent_permissions") if isinstance(prof, dict) else None)
    return EngineContext(user_id=user.id, role=(user.role or "user"), run_id=0, conversation_id=0,
                         profile="producer", draft_id=None, permissions=perms,
                         writing_model=await _preferred(user.id))


@router.get("/tools")
async def list_tools(user: User = Depends(get_current_user)) -> dict:
    """工具目录 + 工作说明（客户端拼进系统提示词）。"""
    tools = all_tools()
    # 与超级 Agent 同一个配置档：producer 列出哪些工具，客户端（和 MCP）就看到哪些。
    # 没列出的老工具仍可按名字调用（客户端「导出飞书文档」直接调 read_outline）。
    shown = PROFILE_TOOLS.get("producer") or set(META)
    entries = [_catalog_entry(n, t) for n, t in sorted(tools.items()) if n in META and n in shown] \
        + list(LOCAL_TOOLS.values())
    return {"tools": entries, "count": len(entries),
            "guide": system_prompt("producer", None) + DESKTOP_NOTE}


class CallIn(BaseModel):
    name: str
    args: dict = Field(default_factory=dict)
    #: 用户已在客户端的确认卡片上点了同意。只对需要确认的工具有意义。
    confirmed: bool = False
    #: 客户端处在通宵模式（用户不在电脑前，2026-11-02）。此时不弹确认、直接执行，
    #: 但 UNATTENDED_REFUSED 里的操作一律不做：没人能拦，而它们要么删稿、要么停掉别人正在等的任务。
    unattended: bool = False


@router.post("/call")
async def call_tool(body: CallIn, user: User = Depends(get_current_user)) -> dict:
    """执行一个工具。工具自己的失败（``[失败] …``）照常以 200 返回，``ok`` 为 false。"""
    if body.name == LIST_MODELS:
        return {"ok": True, "result": await _list_models(user)}
    if body.name == SET_MODEL:
        return await _set_model(user, body.args)
    if body.name == REMIND_DONE:
        return await _remind_done(user, body.args)
    tool = all_tools().get(body.name)
    if tool is None or body.name not in META:
        raise HTTPException(404, f"没有这个工具：{body.name}")
    ctx = await _context(user)
    try:
        args = tool.tool_call_schema.model_validate(body.args).model_dump(exclude_unset=True)
    except ValidationError as e:
        return {"ok": False, "error": "参数不对：" + "; ".join(
            f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()[:8])}
    # 聚合工具按它实际执行的老工具判断通宵拦截、转作业与等待上限（script_draft(action=delete) 就是 trash_draft）。
    inner, inner_args = resolve_tool(body.name, args)
    if body.unattended and inner in UNATTENDED_REFUSED:
        return {"ok": False, "code": "blocked_unattended",
                "error": "通宵模式下不做这一步（删草稿、取消正在跑的任务）。跳过它，写进早上的报告，让用户回来自己决定。"}
    if needs_approval(body.name, args, ctx.permissions) and not (body.confirmed or body.unattended):
        message = describe(body.name, args)
        if META[inner].risk in ("generate", "overwrite"):
            from .tools import _writing_model
            message += f"\n· 写稿模型：{_writing_model(ctx)}"
        return {"ok": False, "needs_confirm": True, "risk": META[body.name].risk, "message": message}
    started = time.monotonic()
    if inner in SLOW_TOOLS:
        return await _call_via_job(user, ctx, inner, inner_args)
    if inner in _WAIT_ARGS:
        key = _WAIT_ARGS[inner]
        inner_args[key] = min(int(inner_args.get(key) or 0) or INLINE_WAIT_SEC, INLINE_WAIT_SEC)
    if inner != body.name:
        tool, args = all_tools()[inner], inner_args
    try:
        out = await asyncio.wait_for(tool.coroutine(runtime=SimpleNamespace(context=ctx), **args),
                                     timeout=CALL_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        logger.warning("desktop call timeout user=%s tool=%s", user.id, body.name)
        return {"ok": False, "error": f"超过 {CALL_TIMEOUT_SEC} 秒没有结果，这次调用已中止；如果是后台作业，用 script_job(action='status') 查它的进度"}
    text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
    if body.name in AGGREGATES:
        text = rewrite_hints(text)
    ok = not text.startswith("[失败]")
    logger.info("desktop call user=%s tool=%s ok=%s %.1fs", user.id, body.name, ok, time.monotonic() - started)
    return {"ok": ok, "result": text}


async def _call_via_job(user: User, ctx: EngineContext, name: str, args: dict) -> dict:
    """把慢工具放进作业队列执行，原地最多等 ``INLINE_WAIT_SEC`` 秒。

    跑完了：与同步调用一样返回工具结果。没跑完：返回 job_id，作业照常跑到底，结果在作业的 result.output 里。
    作业行不填 draft_id：填了会被当成「这部草稿有任务在跑」，extend_outline 这类自己查占位的工具会把自己拦下，
    只读的体检也会排在几小时的生成后面。这些工具同步执行时本来就不占草稿，进队列后保持一样。
    """
    from ..agent import jobs as _jobs
    from ..db import session_scope
    from ..db.models import AgentJob
    payload = {"tool": name, "args": args, "writing_model": ctx.writing_model}
    jid = await _jobs.enqueue(kind=JOB_KIND, user_id=user.id, payload=payload, max_attempts=2)
    logger.info("desktop call user=%s tool=%s → job #%s", user.id, name, jid)
    deadline = time.monotonic() + INLINE_WAIT_SEC
    status, result = "queued", {}
    while time.monotonic() < deadline:
        await asyncio.sleep(2)
        async with session_scope() as s:
            j = await s.get(AgentJob, jid)
            status, result = (j.status, j.result or {}) if j else ("failed", {})
        if status in ("done", "failed", "canceled"):
            break
    if status == "done" and isinstance(result.get("output"), str):
        return {"ok": bool(result.get("ok")), "result": rewrite_hints(result["output"])}
    if status in ("failed", "canceled"):
        return {"ok": False, "error": f"后台作业 #{jid} {'已取消' if status == 'canceled' else '执行失败'}，用 script_job(action='status', job_id={jid}, kind='agent') 看原因"}
    return {"ok": True, "result": json.dumps({
        "job_id": jid, "kind": "agent", "status": status, "running_in_background": True,
        "note": f"{INLINE_WAIT_SEC // 60} 分钟内没写完，还在后台继续写（不是失败）。用 script_job(action='wait', job_id={jid}, kind='agent') 接着等，"
                "结束后结果在 result.output 里；用户要求时也可以用 remind_when_job_done 让飞书提醒他。",
    }, ensure_ascii=False)}


async def _handle_tool_job(job: dict) -> dict:
    """作业处理器：以提交人的身份执行一次桌面端的慢工具调用。确认已在入队前做过。"""
    from ..agent import jobs as _jobs
    from ..db import session_scope
    from ..factory.usage import set_usage_context
    p = job.get("payload") or {}
    name = str(p.get("tool") or "")
    tool = all_tools().get(name)
    if tool is None or name not in SLOW_TOOLS:
        return {"ok": False, "output": f"[失败] 不支持在后台执行 {name}"}
    async with session_scope() as s:
        user = await s.get(User, int(job.get("user_id") or 0))
        if user is None:
            return {"ok": False, "output": "[失败] 提交作业的用户不存在"}
        s.expunge(user)
    set_usage_context(user_id=user.id, source="desktop_agent")
    ctx = await _context(user)
    ctx.writing_model = p.get("writing_model") or ctx.writing_model   # 用入队那一刻的模型，排队期间用户改了也不影响这一次
    await _jobs.set_progress(job["id"], progress=5, note=f"桌面端：{_TOOL_LABEL.get(name, name)}")
    try:
        out = await asyncio.wait_for(tool.coroutine(runtime=SimpleNamespace(context=ctx), **(p.get("args") or {})),
                                     timeout=JOB_TOOL_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        return {"ok": False, "tool": name, "output": f"[失败] 超过 {JOB_TOOL_TIMEOUT_SEC} 秒没有结果"}
    text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
    ok = not text.startswith("[失败]")
    logger.info("desktop job #%s user=%s tool=%s ok=%s", job["id"], user.id, name, ok)
    return {"ok": ok, "tool": name, "output": text}


def register() -> None:
    """登记桌面慢工具的作业处理器。worker 启动时调用。"""
    from ..agent import jobs as _jobs
    _jobs.register_handler(JOB_KIND, _handle_tool_job)
