"""Agent 助手 HTTP API。

路由前缀: /v1/agent
所有接口都需登录,通过 get_current_user(authorization: Bearer) 鉴权。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, or_, select, update

from ..auth.dependencies import get_current_user
from ..auth.models import User
from ..config import get_settings
from ..db import (AgentConversation, AgentMessage, ScriptChapter, ScriptDraft,
                  ScriptStoryboard, session_scope)
from ..models.llm import get_llm
#: 模块级导入（非函数内）：`_OUTLINE_DIFF_FIELDS` 要在模块加载时就算出来。
#: check.fixer 只依赖 db / models / rewrite —— 不反向依赖 agent，无循环导入。
from ..check.fixer import OUTLINE_EDITABLE_FIELDS
from .context_loader import build_draft_context, build_full_context, get_intent_context
from .compaction import Compactor as _Compactor
from ..models.catalog import split_provider_model
from .prompts import load_system_prompt
from .chat_modes import get_mode_framework, list_modes_public

logger = logging.getLogger("agent.routes")

router = APIRouter(prefix="/v1/agent", tags=["agent"])


# 限制
# 50000 字符可容纳约 ~25k 中文字, 一份 docx 短篇剧本附件 + 用户问题完全够用.
# 旧值 2000 不够附件场景, 改大不影响历史数据.
MAX_USER_MSG_CHARS = 500000  # 提高: 容纳整本 60 集剧本附件
# 单会话不设消息条数上限: LLM 上下文只取最近 HISTORY_TURNS_FOR_LLM 轮, 消息多不影响
# 成本/质量。未来若有用户把上下文打爆, 再做"压缩上下文"功能, 而不是拦截发消息。
HISTORY_TURNS_FOR_LLM = 10           # 喂给 LLM 的最近 N 轮对话(user+assistant)

# ============ 对话工坊可调参数(生成参数) ============
# 这些值都是**真下发**给模型的, 不是摆设:
#   temperature → get_llm(temperature=...)   top_p → get_llm(top_p=...)
#   history_turns → _build_messages 取历史的轮数
# ⚠ 刻意不提供 max_tokens 滑块: models/llm.py 已定全局策略"不向 API 下发
#   max_tokens"(推理模型会被 reasoning token 吃光预算导致截断), 给了也是假的。
CHAT_TEMP_DEFAULT = 0.6              # 与改造前硬编码值一致, 保证默认行为不变
CHAT_TEMP_MIN, CHAT_TEMP_MAX = 0.0, 1.5
CHAT_TOP_P_MIN, CHAT_TOP_P_MAX = 0.1, 1.0
# 上下文轮数不设硬上限: 滑块 1~50 只是"好拖", 传 0 表示**不限**(整段历史全带上)。
# 之所以不做成"滑块最右即不限": 50 和 ∞ 语义不同, 混在一起用户会误以为封顶 50。
CHAT_HISTORY_MIN, CHAT_HISTORY_MAX = 1, 50
CHAT_HISTORY_UNLIMITED = 0           # 前后端约定的哨兵值


#: 会话级压缩器：记录熔断状态与增量摘要。
#: 放在进程内存里是刻意的——压缩状态是"会话的会话状态"，
#: 丢失的后果只是下次从头压一次，不影响正确性（与长任务不同）。
#: 加容量上限防止长期运行泄漏。
_compactors: dict[int, "_Compactor"] = {}
_COMPACTOR_MAX = 500


def _model_id_from_spec(spec: str | None) -> str:
    """从 "provider:model" 里取出真实 model id（压缩阈值按模型能力算）。"""
    try:
        _p, m = split_provider_model(spec)
        return m or ""
    except Exception:  # noqa: BLE001
        return ""


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _norm_gen_params(
    temperature: float | None,
    top_p: float | None,
    history_turns: int | None,
) -> tuple[float, float | None, int]:
    """把前端传来的生成参数收敛到安全区间(None → 默认值)。

    前端已做限幅, 但接口是公开的, 服务端必须自己再夹一次:
    temperature=99 之类的值会让中转站直接 400。

    返回的 turns: 正整数 = 最近 N 轮; 0 = 不限(整段历史)。
    ⚠ 轮数**不封顶** —— 传 0 或任何 >CHAT_HISTORY_MAX 的值都按"不限"处理,
      不再悄悄夹到 50。撑爆模型上下文时由中转站如实报错, 不替用户做主截断。
    """
    temp = CHAT_TEMP_DEFAULT if temperature is None else _clamp(
        float(temperature), CHAT_TEMP_MIN, CHAT_TEMP_MAX)
    # top_p: None 或 >=1.0 一律视为"不下发", 保持模型默认(见 llm.get_llm 文档)
    tp: float | None = None
    if top_p is not None and float(top_p) < CHAT_TOP_P_MAX:
        tp = _clamp(float(top_p), CHAT_TOP_P_MIN, CHAT_TOP_P_MAX)
    if history_turns is None:
        turns = HISTORY_TURNS_FOR_LLM
    elif int(history_turns) <= 0 or int(history_turns) > CHAT_HISTORY_MAX:
        turns = CHAT_HISTORY_UNLIMITED
    else:
        turns = int(history_turns)
    return temp, tp, turns


# ============ Schemas ============

class CreateConvIn(BaseModel):
    # 与 GenParamsIn 同样的理由: 前后端同仓, 字段漂移要在入口 422 暴露,
    # 而不是让多余字段被静默忽略(前端以为设上了、后端根本没接)。
    model_config = ConfigDict(extra="forbid")

    draft_id: int | None = None
    title: str | None = None


class GenParamsIn(BaseModel):
    """对话工坊"设置"弹窗里可调的生成参数(发消息 / 编辑重发共用)。

    三个都可以不传 → 用服务端默认(等价改造前的硬编码行为)。
    不做 Field(ge/le) 约束而是服务端夹取: 越界时静默收敛比 422 更符合
    "滑块拖到头"的直觉, 也避免旧前端传旧值就报错。
    """

    # 禁止多余字段: pydantic 默认 ignore, 于是"前端传了新参数、后端 Schema 没加"
    # 不会报错, 而会在后面 payload.xxx 处抛 AttributeError → 500, 排查成本高。
    # 这两端在同一个仓里, 让不匹配在入口就 422 暴露出来更划算。
    model_config = ConfigDict(extra="forbid")

    temperature: float | None = None      # 0.0~1.5, 默认 0.6
    top_p: float | None = None            # 0.1~1.0, >=1.0 视为不下发
    history_turns: int | None = None      # 1~30 轮, 默认 10


class SendMessageIn(GenParamsIn):
    # 只发图片不写字是合法的（"看看这张截图"本身就够了）—— 空文本由 send_message
    # 里与 image_ids 一起校验：两者都空才拒。
    content: str = Field("", max_length=MAX_USER_MSG_CHARS)
    # 右栏当前页签 (outline/chapters/storyboards/novel/tweet)。
    # ⚠️ 它定位的是"哪一份稿子", 不是"哪一集"——集号由用户自己在消息里说。
    # 同一句"第7集这段太平", 在原文页指正文、剧本页指分镜、大纲页指契约;
    # 不传这个字段, 后端只能永远按正文取数(那正是改版前的 bug)。
    kind: str | None = None
    # 前端传来的"当前页面 draft_id"
    # 用户在哪个草稿页就带哪个剧本上下文,即使会话本身的 draft_id 是空或不同
    # 服务端首次有这个值时会顺手把会话的 draft_id 也写上,让历史会话变成"和这部剧关联"
    current_draft_id: int | None = None
    # 对话模式 (大纲/章节/剧本/角色/分析/头脑风暴...): 后端据此注入隐藏提示词框架,
    # 不写入用户消息, 不对用户展示。None = 不启用任何模式框架。
    mode: str | None = None
    # 模型选择: gemini(跨世界观/默认) / deepseek(通用) / gpt5(逻辑专项)。
    # 用户在对话工坊可自由切换; 不传则默认 gemini。
    provider: str | None = None
    # 上下文压缩开关: 前端设置面板写入, 默认开(None 视为开)。
    # ⚠️ 这两个字段必须和 EditMessageIn 保持同步 —— 发消息与编辑重发共用
    # _stream_chat/_stream_edit_chat 的同一套参数, 少一个就会在 payload.xxx
    # 处抛 AttributeError 变成 500 (2026-09-12 实测踩过: 发消息整条链路 500)。
    compaction: bool | None = None
    # 工具模式: "off"(纯对话, 默认) / "auto"(可读写) / "readonly"(只读工具)。
    #   · "off"      —— **不跑 Agent 循环**，模型只回文本。检查/精修/去AI味等能力
    #                   改由动作栏按钮触发（action 分支，确定性后端路径）。
    #                   这是对话工坊的日常模式：对话里拿文本，高亮选中→按钮插入草稿。
    #   · "auto"     —— 老的行为：Agent 工具循环，模型自己决定调哪些工具。
    #   · "readonly" —— 审核模式：只允许只读工具（writes 类被闸门拦掉）。
    tool_mode: str | None = None
    # 对话模式 (前端发送框下方的下拉菜单, 二选一):
    #   · "chat"   —— 讨论。走 Agent 工具循环, 也就是对话工坊原来的行为。
    #   · "polish" —— 自动精修。**不跑 Agent 循环**, 直接把用户这句话当作
    #     "参考意见(guidance)" 触发整本 AI 精修(两轮同上下文重写, 覆写回草稿)。
    #     为什么不做成"让 Agent 自己调 start_rewrite 工具": 那样用户说一句
    #     "精修一遍" 要等模型先聊两轮才启动, 而精修本身就是几十集的长任务,
    #     前面那两轮纯属浪费; 且模式是用户显式选的, 意图已经确定, 不需要模型再判断。
    # None / 其它值 → 按 "chat" 处理(向后兼容旧的请求体)。
    chat_mode: str | None = None
    # ===== 动作栏(对话工坊 v3)=====
    # 用户点的是按钮, 但按钮**只负责把一句人话填进输入框**, 真正走的是下面这个
    # 结构化字段。这样"按钮"和"用户自己打字"走的是同一条后端路径, 不会出现
    # "手打能用、点按钮不能用"的裂缝。
    #   · "check" —— 体检。按 kinds/scope 跑一次, 出报告卡。不调 Agent 循环。
    #   · "fix"   —— 定点修复。issue_ids 是报告卡上勾中的问题 id, **只传 id**,
    #                内容由服务端从 check_reports 取回(防伪造修复)。
    #   · "rewrite" —— 整本/范围精修(等价 chat_mode="polish", 但范围由 scope 给)。
    #   · None / 其它 → 走 chat_mode 的老路径。
    #   · "generate" —— 生成大纲/正文/剧本。gen_kind 指定生成哪一层。**确定性入队**,
    #                 不走 Agent 循环（原因见 chat_jobs.start_generate 的注释）。
    #   · "deai"  —— 去 AI 味。作业队列 deai_apply，**写回草稿**（默认原稿；用户话里要副本
    #                 就先复制一份改副本）。每集先留历史，可「看改动」、可逐集恢复。
    # 上面这段注释**同时**要落在 schema 的 description 里：注释只有读源码的人看得到，
    # 而调试接口 / 生成客户端的人只看得到 schema。
    action: str | None = Field(
        default=None,
        description=(
            "动作栏的结构化意图（优先于 chat_mode 判断）。取值：\n"
            "  · \"check\"    —— 体检，出报告卡，不调 Agent 循环。\n"
            "  · \"fix\"      —— 定点修复，只传 issue_ids（内容由服务端取回，防伪造）。\n"
            "  · \"rewrite\"  —— 整本/范围精修，范围由 scope 给。\n"
            "  · \"generate\" —— 生成大纲/正文/剧本，gen_kind 指定层。\n"
            "  · \"deai\"     —— 去 AI 味。入队 deai_apply，写回草稿（用户话里要副本则改在副本里），"
            "SSE 回 \"job\" 事件（kind=deai_apply），改动可走 /jobs/{id}/changes 查看。\n"
            "  · null / 其它 → 走 chat_mode 的老路径。"
        ),
    )
    #: 生成类动作要生成哪一层: "outline" / "chapters" / "storyboards"。
    #: 只在 action="generate" 时有意义；其它情况下忽略。
    gen_kind: str | None = None
    #: 体检范围 / 精修范围: {"start_ep": int|null, "end_ep": int|null}
    scope: dict | None = None
    #: 体检类别: ["structure","style","consistency","script"], 空 = 全部
    kinds: list[str] | None = None
    #: 定点修复要改的问题 id(来自报告卡)
    issue_ids: list[str] | None = None
    #: 定点修复依据的报告 id; 0 = 该草稿最新一份
    report_id: int | None = None
    #: 体检是否跑 LLM 深度层(跨集逻辑矛盾只有 LLM 看得出)
    deep: bool | None = None

    #: 用户这次临时补的写作要求(原话)。
    #:
    #: 2026-09 用户反馈的修复点：用户把 60 集细纲和前六集正文贴进对话、又补了几句
    #: 自己的要求，然后点生成 —— 成片"AI 感很重、细节僵硬"。根因是**生成路径没有
    #: 任何指令入口**：`generate_chapter` 的 prompt 完全由 outline 字典拼成，
    #: 用户补的那几句一个字也进不去，模型只能照大纲硬写。
    #: 精修(rewrite)一直有 guidance 通道，生成这条路漏了，这个字段就是补它。
    #:
    #: 与 action 配合使用：
    #:   · action="generate"  → 逐集注入正文/剧本的生成 prompt
    #:   · action="rewrite"   → 与 scope 一起进精修(等价于旧的 chat_mode="polish")
    #:   · 其余情况           → 忽略(聊天本身就把用户的话当上下文，不需要再注入一遍)
    #: 留空(null / "")时行为与加这个字段之前**完全一致**。
    guidance: str | None = Field(
        default=None, max_length=4000,
        description="用户本次补的写作要求原话。action=generate/rewrite 时生效，"
                    "逐集注入生成 prompt；空则只按大纲写。",
    )
    #: 这一轮附带的图片（先经 POST /images 上传拿到的 id）。
    #: 只在**这一轮**组装进多模态消息；之后的历史轮次里只留一行文字引用
    #: （见 agent/images.py 顶部的"不随历史重发"说明）。
    image_ids: list[int] | None = Field(default=None, max_length=10)


class UpdateTitleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 见 CreateConvIn

    title: str = Field(..., min_length=1, max_length=120)


# ============ 会话 CRUD ============

@router.get("/conversations")
async def list_conversations(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    with_total: bool = Query(False, description="true 时返回 {items, total, has_more}，供滚动分页"),
    draft_id: int | None = Query(None, description="过滤指定 draft_id 的会话"),
    user: User = Depends(get_current_user),
):
    """列出当前用户的会话（按最近更新倒序），可按 draft_id 过滤。

    ## 为什么要分页（2026-10-26 用户反馈）

    > "有用户说只保留50条，再多就看不到了"

    不是"只保留" —— 库里一条没删（这个接口从不删数据，也没有任何归档作业），
    真正的问题是**列不出来**：这里的 `le=50` 是硬上限，前端传 `limit=100` 会被
    FastAPI 直接拒掉；侧栏也没有"加载更多"，于是第 51 个往后的会话在界面上
    **完全不存在**。生产实测 11 个用户越过这条线，最多的 204 个会话只看得见 50。

    滚动分页需要的三件事全在这里：
      · `limit` 上限抬到 200（每页仍然是 50，见前端）；
      · `offset` 按 `(updated_at DESC, id DESC)` 稳定切页；
      · `with_total` 让前端能显示"共 N 个"而不是"共 50 个"（后者看着像全部，
        恰恰是这个误导让用户以为数据被删了）。

    ⚠️ 排序必须带 `id` 作次序键：`updated_at` 会因作业回填而变化，只按它排序时
    翻页会**漏行或重复**（某条从第 2 页跳到第 1 页，用户就再也翻不到它）。
    """
    async with session_scope() as s:
        base = select(AgentConversation).where(
            AgentConversation.user_id == user.id,
            AgentConversation.is_deleted == False,  # noqa: E712
            # Agent 引擎的会话(source=agent)有自己的列表，不混进对话工坊
            AgentConversation.source == "studio",
        )
        if draft_id is not None:
            base = base.where(AgentConversation.draft_id == draft_id)

        total: int | None = None
        if with_total:
            total = (await s.execute(
                select(func.count()).select_from(base.subquery())
            )).scalar() or 0

        rows = (await s.execute(
            base.order_by(desc(AgentConversation.updated_at), desc(AgentConversation.id))
                .limit(limit).offset(offset)
        )).scalars().all()

        # 每个会话的消息数，用于前端"复用空会话"的判断。
        # ⚠️ 原先是逐行 `select(AgentMessage).where(...)` 再 `len()` —— 一页 50 行
        #    就是 50 次往返，而且每次都把整条消息体捞出来只为了数个数。
        #    改成一条 GROUP BY：一页一次查询，且不传输消息正文。
        counts: dict[int, int] = {}
        if rows:
            for cid, n in (await s.execute(
                select(AgentMessage.conversation_id, func.count())
                .where(AgentMessage.conversation_id.in_([r.id for r in rows]))
                .group_by(AgentMessage.conversation_id)
            )).all():
                counts[cid] = int(n)

        items = [{
            "id": r.id,
            "draft_id": r.draft_id,
            "title": r.title,
            "message_count": counts.get(r.id, 0),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        } for r in rows]

        # 补上草稿标题 —— 跨剧历史列表要能认出"这条对话属于哪部剧"（方案 C）。
        # 只查本页涉及的 draft_id，一次 IN 查询，不做 per-row join。
        # ⚠️ 用 getattr 而不是直接 import ScriptDraft 到顶部：本模块 import 面已经很宽，
        #    这里局部取一次即可，避免多一条顶部依赖。
        draft_ids = sorted({r.draft_id for r in rows if r.draft_id})
        if draft_ids:
            from ..db.models import ScriptDraft
            titles = {row[0]: row[1] for row in (await s.execute(
                select(ScriptDraft.id, ScriptDraft.title).where(ScriptDraft.id.in_(draft_ids))
            )).all()}
            for it in items:
                it["draft_title"] = titles.get(it["draft_id"]) if it["draft_id"] else None

    # 不分页的老调用方拿到的是**数组**（`Array.isArray(d) ? d : d.items` 两边都在兼容）。
    # 只有明确要 total 的才给包一层的对象 —— 让滚动分页与老代码共用同一个端点。
    if total is None:
        return items
    return {"items": items, "total": total, "has_more": offset + len(items) < total}


@router.post("/conversations")
async def create_conversation(
    payload: CreateConvIn,
    user: User = Depends(get_current_user),
):
    """新建会话。"""
    async with session_scope() as s:
        conv = AgentConversation(
            user_id=user.id,
            draft_id=payload.draft_id,
            title=payload.title or "新对话",
        )
        s.add(conv)
        await s.flush()
        await s.refresh(conv)
        return {
            "id": conv.id,
            "draft_id": conv.draft_id,
            "title": conv.title,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
        }


@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: int, user: User = Depends(get_current_user)):
    """获取会话详情 + 激活消息(按槽位升序) + 问答版本组元数据。

    编辑重发产生的旧版本消息(is_active=False)不返回;
    groups 给前端渲染 v1/v2 版本切换标签:
      {"<group_id>": {"versions": [1,2], "active": 2}}
    """
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user.id or conv.is_deleted:
            raise HTTPException(404, "会话不存在")

        slot = func.coalesce(AgentMessage.seq, AgentMessage.id)
        msgs = (await s.execute(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conv_id)
            .order_by(slot, AgentMessage.id)
        )).scalars().all()

        # 版本组元数据 (含未激活版本, 用于 v1/v2 标签)
        groups: dict[int, dict] = {}
        for m in msgs:
            if not m.group_id:
                continue
            g = groups.setdefault(m.group_id, {"versions": set(), "active": None})
            g["versions"].add(m.version or 1)
            if m.role == "user" and m.is_active is not False:
                g["active"] = m.version or 1

        # 每条用户消息挂了哪些图（界面回放用；喂模型时历史图只留文字引用）。
        # 一次 IN 查询，复用当前 session。user_id 闸门同 images.load_for_message。
        from ..db.models_phase5 import AgentImage
        imgs_by_msg: dict[int, list[dict]] = {}
        _uids = [m.id for m in msgs if m.role == "user" and m.is_active is not False]
        if _uids:
            for im in (await s.execute(
                select(AgentImage).where(AgentImage.message_id.in_(_uids),
                                         AgentImage.user_id == user.id)
                .order_by(AgentImage.id)
            )).scalars().all():
                imgs_by_msg.setdefault(im.message_id, []).append(
                    {"id": im.id, "filename": im.filename, "width": im.width, "height": im.height})

        return {
            "id": conv.id,
            "draft_id": conv.draft_id,
            "title": conv.title,
            "created_at": conv.created_at.isoformat() if conv.created_at else None,
            "messages": [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "group_id": m.group_id,
                    "version": m.version or 1,
                    # 挂在这条消息上的体检报告(通常为 None)。前端据此把报告卡
                    # 渲染回来 —— 用户刷新页面/换设备回来还能看到当时那份报告、
                    # 还能接着点"让 AI 改这个"。
                    "report": m.report_json or None,
                    "images": [
                        {"id": x["id"], "filename": x["filename"],
                         "width": x["width"], "height": x["height"],
                         "url": f"{_IMAGE_URL_PREFIX}/{x['id']}"}
                        for x in imgs_by_msg.get(m.id, [])
                    ],
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                }
                for m in msgs if m.is_active is not False
            ],
            "groups": {
                str(gid): {"versions": sorted(g["versions"]), "active": g["active"]}
                for gid, g in groups.items()
            },
        }


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: int, user: User = Depends(get_current_user)):
    """软删除会话。"""
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user.id:
            raise HTTPException(404, "会话不存在")
        conv.is_deleted = True
        return {"ok": True}


@router.patch("/conversations/{conv_id}/title")
async def update_title(
    conv_id: int,
    payload: UpdateTitleIn,
    user: User = Depends(get_current_user),
):
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user.id or conv.is_deleted:
            raise HTTPException(404, "会话不存在")
        conv.title = payload.title.strip()[:120]
        return {"ok": True, "title": conv.title}


class SetDraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 见 CreateConvIn

    # 传具体 id = 关联到该草稿; 传 null = 取消关联(变成通用对话)
    draft_id: int | None = None


@router.patch("/conversations/{conv_id}/draft")
async def set_conversation_draft(
    conv_id: int,
    payload: SetDraftIn,
    user: User = Depends(get_current_user),
):
    """设置/取消会话关联的草稿。draft_id=null 即取消关联(当作通用 AI 对话)。"""
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user.id or conv.is_deleted:
            raise HTTPException(404, "会话不存在")
        conv.draft_id = payload.draft_id
        return {"ok": True, "draft_id": conv.draft_id}


# ============ 发消息 (SSE 流式) ============

def _sse(data: dict) -> str:
    """把 dict 拼成 SSE event payload。"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _build_messages(
    *,
    user_id: int,
    user_role: str | None = None,
    conv: AgentConversation,
    user_input: str,
    effective_draft_id: int | None = None,
    mode: str | None = None,
    before_slot: int | None = None,
    history_turns: int | None = None,
    kind: str | None = None,
) -> tuple[list[dict], list[AgentMessage]]:
    """构建喂给 LLM 的 messages 列表 + 加载历史。

    返回:
      messages: [{role, content}, ...] 直接传 ChatOpenAI
      history_msgs: 用于客户端展示和写库的历史消息 ORM

    mode: 对话模式 key (大纲/章节/...), 对应的隐藏提示词框架会拼到 system prompt,
      不写入用户消息, 不对用户展示。

    before_slot: 编辑重发场景 — 只取"槽位 < before_slot"的历史,
      即被编辑消息之前的上文; 被编辑的旧问答及其后消息不进上下文。

    history_turns: 喂给 LLM 的最近 N 轮对话(用户在对话工坊设置里可调),
      None = 用默认 HISTORY_TURNS_FOR_LLM; 0 = 不限, 整段激活历史全带上。
    """
    # 1) 系统提示词
    system_prompt = await load_system_prompt()

    # 1.5) 模式框架 (隐藏提示词, 用户不可见)
    mode_fw = get_mode_framework(mode)
    if mode_fw:
        system_prompt = f"{system_prompt}\n\n{mode_fw}"

    # 2) 增强上下文 (用户长期画像 + 记忆 + 优秀片段 + 草稿上下文)
    draft_id_for_ctx = effective_draft_id or conv.draft_id
    full_ctx = await build_full_context(
        user_id=user_id,
        user_role=user_role,
        draft_id=draft_id_for_ctx,
        recent_user_message=user_input,
        kind=kind,
        conversation_id=conv.id,   # 上传文档按会话归属检索（见 agent/doc_context.py）
    )
    if full_ctx:
        system_prompt = f"{system_prompt}\n\n{full_ctx}"

    # 3) 历史消息(取最近 N 轮; 只取激活版本, 编辑重发的旧问答不进上下文, 防污染)
    async with session_scope() as s:
        slot = func.coalesce(AgentMessage.seq, AgentMessage.id)
        stmt = select(AgentMessage).where(
            AgentMessage.conversation_id == conv.id,
            or_(AgentMessage.is_active.is_(None), AgentMessage.is_active.is_(True)),
        )
        if before_slot is not None:
            stmt = stmt.where(slot < before_slot)
        # turns=0 → 不加 limit, 整段历史全取(用户显式勾了"不限轮数")
        turns = HISTORY_TURNS_FOR_LLM if history_turns is None else history_turns
        stmt = stmt.order_by(desc(slot), desc(AgentMessage.id))
        if turns > 0:
            stmt = stmt.limit(turns * 2)
        history = (await s.execute(stmt)).scalars().all()
        history = list(reversed(history))  # 槽位升序

    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    # 历史里带过图的用户消息：只补一行文字引用，**不**重发图片本身。
    # 理由见 agent/images.py："图片随历史每轮重发，上下文随轮数平方增长"。
    # 没有这行引用的话，模型在后续轮次里完全不知道用户发过图，
    # 用户说"按刚才那张图改"它会一脸茫然。
    img_names: dict[int, list[str]] = {}
    hist_user_ids = [m.id for m in history if m.role == "user"]
    if hist_user_ids:
        try:
            from .images import list_for_conversation
            got = await list_for_conversation(user_id=user_id, conversation_id=conv.id,
                                              message_ids=hist_user_ids)
            img_names = {mid: [x["filename"] for x in xs] for mid, xs in got.items()}
        except Exception as e:  # noqa: BLE001 — 引用只是提示，取不到不该挡住对话
            logger.warning("load history image refs failed: %s", e)
    for m in history:
        if m.role in ("user", "assistant"):
            content = m.content
            if m.role == "user" and img_names.get(m.id):
                from .images import text_ref
                content = f"{text_ref(img_names[m.id])}\n{content}" if content else text_ref(img_names[m.id])
            messages.append({"role": m.role, "content": content})
    messages.append({"role": "user", "content": user_input})

    return messages, history


# ============ 对话工坊可选模型 ============
# 下拉里展示的是**模型原名**(Gemini 3.6 Flash / gemini-3.6-flash), 不再用
# "跨世界观模型"这类别名 —— 用户要求看真名, 自己判断该用哪个。
# ⚠ 模型 id 必须由 settings/env 现算后下发给前端, 绝不能在前端写死:
#   否则改了 LLM_REWRITE_MODEL 之后, 页面还写着旧名字 = 对用户谎报。
# 注意对话走的是 get_llm(role="rewrite"), 所以 gemini 取 llm_rewrite_model。
_CHAT_PROVIDERS: tuple[tuple[str, str, str], ...] = (
    # (provider, settings 字段, 兜底值)
    ("gemini", "llm_rewrite_model", "gemini-3.6-flash"),
    ("deepseek", "deepseek_model", "__REDACTED__"),
    ("gpt5", "gpt5_model", "gpt-5.5"),
    ("grok", "grok_model", "grok-4.5"),
)
_ALLOWED_CHAT_PROVIDERS = {p for p, *_ in _CHAT_PROVIDERS}

#: 模型 id 分段的展示写法(纯美化, 不影响真正下发的 model_id)
_MODEL_WORD_CASE = {
    "gpt": "GPT", "deepseek": "DeepSeek", "gemini": "Gemini", "grok": "Grok",
    "claude": "Claude", "qwen": "Qwen", "flash": "Flash", "pro": "Pro",
    "mini": "Mini", "max": "Max", "turbo": "Turbo", "lite": "Lite",
    "opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku",
}


def _pretty_model(model_id: str) -> str:
    """gemini-3.6-flash → "Gemini 3.6 Flash"(仅作下拉主标题, 原始 id 一并下发)。"""
    words: list[str] = []
    for seg in (model_id or "").replace("_", "-").split("-"):
        if not seg:
            continue
        low = seg.lower()
        if low in _MODEL_WORD_CASE:
            words.append(_MODEL_WORD_CASE[low])
        elif low.startswith("v") and low[1:] and low[1:].replace(".", "").isdigit():
            words.append("V" + low[1:])
        elif low.replace(".", "").isdigit():
            words.append(low)
        else:
            words.append(seg.capitalize())
    return " ".join(words) or model_id


def chat_model_catalog() -> list[dict]:
    """对话工坊模型清单(**扁平旧版**): provider(接口取值) + 真实 model id + 展示名。

    刻意不带"综合最均衡/推理最强"之类的解说文案 —— 用户要的是模型原名,
    评价性描述既主观又会随版本过时。

    ⚠ 2026-09-09 起前端改吃 ``/v1/models/catalog`` 的**分组清单**(每个厂商下列出
    具体型号 + 实测"稳"标)。这份扁平清单保留下来只作两个用途: 老客户端兜底,
    以及"当前 env 默认型号是什么"的快速查询。新增型号请改 models/catalog.py。
    """
    s = get_settings()
    return [
        {
            "provider": provider,
            "model": getattr(s, field, "") or fallback,
            "label": _pretty_model(getattr(s, field, "") or fallback),
        }
        for provider, field, fallback in _CHAT_PROVIDERS
    ]


def normalize_chat_provider(spec: str | None) -> str:
    """把前端传来的模型选择规范化成 get_llm 认的 "provider" 或 "provider:model"。

    前端从 2026-09-09 起传的是 "gemini:gemini-3.8-flash" 这种编码串。这里必须
    **连型号一起校验**: 只校验厂商、把型号原样透传, 等于让任意字符串直达上游。
    厂商不认或型号不在白名单 → 退回 gemini 默认(与改版前行为一致)。
    """
    from ..models.catalog import is_allowed, join_provider_model, split_provider_model

    provider, model = split_provider_model(spec)
    if provider not in _ALLOWED_CHAT_PROVIDERS:
        return "gemini"
    if model and not is_allowed(provider, model):
        logger.warning("对话工坊收到不在白名单的型号 %s(厂商 %s), 已忽略型号", model, provider)
        model = None
    return join_provider_model(provider, model)


async def _stream_polish(
    *,
    conv_id: int,
    user_id: int,
    user_input: str,
    current_draft_id: int | None = None,
    provider: str | None = None,
    scope: dict | None = None,
    guidance: str = "",
) -> AsyncGenerator[str, None]:
    """「自动精修」模式: 把用户这一句话当参考意见, 触发整本 AI 精修。

    与「讨论」模式的根本区别:
      · 不调 LLM 聊天, 不做工具循环 —— 用户选了这个模式, 意图已经确定
      · 只入队一个 ``rewrite_script`` 作业就返回(秒级), 几十集的活在后台跑
      · 用户那句话进 ``guidance``, 不是"命令"而是"优先级提示"(见 rewrite/prompts.py)

    为什么发消息要落库: 精修是覆写操作, 用户半个月后回来看"这版为什么改成这样",
    得能看到当时自己说了什么。助手那条回复先落"已启动", 结束后再回填最终结果
    (前端也会实时显示), 这样即使前端关掉页面, 会话记录里也留着完整交代。

    ``scope`` = ``{"start_ep": int|null, "end_ep": int|null}``, None/空 = 整本。
    诊断仍通读全剧(跨集一致性问题只有通读才看得出), **只有重写被限制在范围内**。

    ``guidance``: 显式给的参考意见(动作栏 rewrite 用 payload.guidance 传)。
    为空时**照旧**回落到 ``user_input`` —— 手打那句话就是参考意见, 这是原来的行为,
    不能因为多了个字段就让它变空。

    边界:
      · 没有可用草稿 → 直接报错, 不建作业(否则用户等一个必然失败的作业)
      · 本草稿已有重任务在跑 → 报错并点名, 不排队(精修/生成都是覆写型, 并发会互相盖)
    """
    from . import chat_jobs, jobs as _jobs

    # 1) 会话与草稿
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return
        draft_id = current_draft_id or conv.draft_id
        if not draft_id:
            yield _sse({"type": "error",
                        "message": "这个对话还没有关联草稿，自动精修需要先选一部剧本。"})
            return
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            yield _sse({"type": "error", "message": f"草稿 {draft_id} 不存在。"})
            return
        # 与"讨论"模式一致: 首次带上 draft_id 时顺手把会话也绑上这部剧
        if not conv.draft_id:
            await s.execute(update(AgentConversation)
                            .where(AgentConversation.id == conv_id)
                            .values(draft_id=draft_id))
        title = d.title or f"草稿{draft_id}"
        model = provider or d.model_provider or "gemini"

    # 2) 落用户消息（顺带补会话标题，与讨论模式同一套规则）
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="user", content=user_input))
        if (conv.title or "") in ("", "新对话"):
            await s.execute(update(AgentConversation)
                            .where(AgentConversation.id == conv_id)
                            .values(title=f"精修 · {title}"[:60]))

    # 3a) 有没有可精修的内容。空草稿走到处理器里也会失败（"该草稿无剧本/正文可精修"），
    # 但那要等 worker 领到作业才报，用户会先看到"已启动"再等出个失败——
    # 当作前置条件查一次，代价是一条 count 查询。
    async with session_scope() as s:
        n_ch = (await s.execute(
            select(func.count()).select_from(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                func.coalesce(ScriptChapter.full_text, "") != "")
        )).scalar_one()
        n_sb = (await s.execute(
            select(func.count()).select_from(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id)
        )).scalar_one()
    if not n_ch and not n_sb:
        msg = (f"《{title}》还没有正文或剧本，没有可精修的内容。\n\n"
               f"先切到「讨论」让我把内容生成出来（或者去草稿页生成），再来精修。")
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    # 3b) 重复触发拦截（在入队前查，省得建一个必然失败的作业）
    active = await chat_jobs.has_active_job(draft_id)
    if active:
        msg = (f"《{title}》已有任务在跑（{active}）。自动精修会覆写整本，"
               f"和它同时跑会互相覆盖，所以这次没有启动。等它完成后再发一次。")
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    # 4) 入队
    # ⚠️ 优先级：显式 guidance > 用户那句话。动作栏的 rewrite 会把用户圈的范围和
    # 输入框里那句话分别放进 scope / guidance；手打 polish 模式下 guidance 是空的，
    # 回落成 user_input，与改这个参数之前逐字一致。
    guidance = (str(guidance).strip() or user_input).strip()[:8000]
    # 范围: 用户可能只圈了"第 10-20 集"。落库(RewriteJob.scope_json)而不是只留在
    # payload —— 精修会被队列重放, 重放时读不到范围就会把整本悄悄重写一遍。
    _scope = scope if isinstance(scope, dict) else None
    try:
        job_id = await _jobs.enqueue(
            kind="rewrite_script", draft_id=draft_id, user_id=user_id,
            payload={"model": model, "guidance": guidance, "scope": _scope},
        )
    except Exception as ex:  # noqa: BLE001
        logger.exception("polish enqueue failed: %s", ex)
        msg = f"启动精修失败：{ex}"
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "error", "message": msg})
        return

    _scope_txt = _scope_label_text(_scope)
    ack = (f"已按你的意见对《{title}》启动自动精修（范围：{_scope_txt}）。\n\n"
           f"- **参考意见（优先修）**：{guidance[:200]}"
           f"{'…' if len(guidance) > 200 else ''}\n"
           f"- **作业号**：#{job_id}\n"
           f"- 这是长任务（要通读全剧做诊断、再分批重写），会跑一段时间，"
           f"**可以关掉页面**，跑完内容直接生效。\n"
           f"- ⚠️ 精修是**覆写**操作：成功则范围内的集被替换（每集存了历史，可回滚），"
           f"失败则原稿保持原样；范围外的集**一字不碰**。\n\n"
           f"进度可以随时问我「精修好了吗」。")
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=ack))

    yield _sse({"type": "start", "conversation_id": conv_id})
    yield _sse({"type": "delta", "content": ack})
    yield _sse({"type": "done", "full_content": ack})
    yield _sse({"type": "job", "job_id": job_id, "kind": "rewrite_script",
                "draft_id": draft_id, "scope": _scope})


def _scope_label_text(scope: dict | None) -> str:
    """把范围说成人话（"整本" / "第10-20集"）。只用于回执文案。"""
    if not isinstance(scope, dict):
        return "整本"
    def _i(v):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None
    a, b = _i(scope.get("start_ep")), _i(scope.get("end_ep"))
    if a and b:
        return f"第{min(a, b)}-{max(a, b)}集"
    if a:
        return f"第{a}集起"
    if b:
        return f"到第{b}集"
    return "整本"


async def _stream_check(
    *,
    conv_id: int,
    user_id: int,
    user_input: str,
    draft_id: int,
    kinds: list | None = None,
    scope: dict | None = None,
    deep: bool = True,
    provider: str | None = None,
) -> AsyncGenerator[str, None]:
    """「体检」动作: 同步跑一次体检, 把报告落库 + 挂到助手消息上, SSE 推给前端。

    为什么**同步**而不入队: 体检是纯读 + 只读 LLM 分析, 秒级返回; 用户点一下按钮
    就想要看到卡片, 排队等 worker 领作业会凭空多出几秒延迟, 且用户会以为没反应。
    修复才是长任务(它要改写剧本), 那个才入队。

    报告同时写进 ``agent_messages.report_json`` —— 前端刷新页面后能从历史里把卡片
    渲染回来, 用户不用"再点一次体检"才能看到上次的结果。
    """
    from ..check.engine import run_check, ALL_KINDS, KIND_LABEL
    from ..check.fixer import index_issues
    from ..db import CheckReport

    # 先落用户消息 —— 与 _stream_polish/_stream_generate/_stream_deai 一致。
    # 漏了它的后果: 会话里只有一条凭空出现的报告卡, 用户自己问的那句话不见了,
    # 刷新页面回看更是莫名其妙(2026-09-16 实测: 5 条体检会话各只有 1 条 assistant 消息)。
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="user", content=user_input))

    kinds_t = tuple(k for k in (kinds or []) if k in ALL_KINDS) or ALL_KINDS
    try:
        report = await run_check(draft_id=draft_id, kinds=kinds_t, scope=scope,
                                 provider=provider or "gemini", deep=bool(deep))
    except Exception as ex:  # noqa: BLE001
        logger.exception("体检失败 draft=%s", draft_id)
        msg = f"体检没能跑完：{ex}"
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "error", "message": msg})
        return

    idx = index_issues(report)
    totals = report.get("totals") or {}
    text = _report_summary_text(report, user_input)
    async with session_scope() as s:
        row = CheckReport(draft_id=draft_id, user_id=user_id, kinds=list(kinds_t),
                          scope=scope if isinstance(scope, dict) else None,
                          report=report, issue_index=idx)
        s.add(row)
        await s.flush()
        report_id = row.id
        report["report_id"] = report_id
        m = AgentMessage(conversation_id=conv_id, role="assistant", content=text)
        m.report_json = {"report_id": report_id, **report}
        s.add(m)
        await s.flush()
        msg_id = m.id

    yield _sse({"type": "start", "conversation_id": conv_id})
    yield _sse({"type": "delta", "content": text})
    yield _sse({"type": "done", "full_content": text, "message_id": msg_id})
    yield _sse({"type": "check", "report_id": report_id, "draft_id": draft_id,
                "totals": totals, "report": report, "issue_index": idx,
                "kinds": [KIND_LABEL.get(k, k) for k in kinds_t]})


def _report_summary_text(report: dict, user_input: str) -> str:
    """体检回执的自然语言摘要（卡片另有一份完整报告, 这里只做导语）。"""
    from ..check.engine import KIND_LABEL
    totals = report.get("totals") or {}
    e, w = int(totals.get("error") or 0), int(totals.get("warn") or 0)
    label = report.get("scope_label") or "整本"
    lines = [f"体检完成（{label}，扫了 {totals.get('episodes', 0)} 集）："
             f"**{e} 个硬伤 / {w} 个提醒**。"]
    for kind, c in (report.get("checks") or {}).items():
        n = len(c.get("issues") or [])
        if n:
            k_e = sum(1 for i in (c.get("issues") or []) if i.get("level") == "error")
            lines.append(f"- {KIND_LABEL.get(kind, kind)}：{n} 条"
                         + (f"（其中硬伤 {k_e}）" if k_e else ""))
    top = [i for i in (report.get("issues_flat") or []) if i.get("level") == "error"][:3]
    if top:
        lines.append("\n**先修这几条：**")
        # 集号只在**确实有**的时候写前缀。全剧级问题（全剧标题/全剧主线）本来就没有
        # 集号，硬套"第—集"会让用户以为是坏了；而 message 自己往往已经带了集号
        # （"第1集synopsis出现…"），再加前缀就成了"第—集：第1集…"，重复且难看。
        for i in top:
            ep = i.get("episode")
            lines.append(f"- 第{ep}集：{i.get('message')}" if ep is not None
                         else f"- {i.get('message')}")
    if e == 0 and w == 0:
        # 按**实际跑了的类别**说，别硬写"四类"：单点「检查文风」时只跑一类，
        # 说成"四类体检都没发现问题"会让用户以为结构/一致性/分镜也一起查过了，
        # 从而跳过那几项检查(2026-09-16 实测: 只跑 style 也这么说)。
        ran = [KIND_LABEL.get(k, k) for k in (report.get("checks") or {})]
        who = "、".join(ran) if ran else "本次体检"
        lines.append(f"\n{who}没发现问题 —— 可以往下走了。"
                     if len(ran) == 1 else f"\n{who}都没发现问题 —— 可以往下走了。")
    else:
        lines.append("\n下面这张卡片里每条都能单独点「让 AI 改这个」，也可以整卡一键全修。")
    return "\n".join(lines)


async def _stream_fix(
    *,
    conv_id: int,
    user_id: int,
    user_input: str,
    draft_id: int,
    issue_ids: list,
    report_id: int = 0,
) -> AsyncGenerator[str, None]:
    """「定点修复」动作: 按 issue_id 入队修复作业。**只传 id, 不传内容**。

    内容由服务端从 check_reports 取回(见 chat_jobs.start_fix / check/fixer.run_fix),
    这样前端(或被篡改的前端)不可能构造一条不存在的问题让引擎去执行。
    """
    from . import chat_jobs

    # 先落用户消息（理由同 _stream_check）。放在所有早退分支之前 —— 连"没选中问题"
    # 这种失败也该留下用户那句话, 否则会话里只剩一句没头没尾的拒绝。
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="user", content=user_input))

    if not issue_ids:
        msg = "没有选中要修的问题。"
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    active = await chat_jobs.has_active_job(draft_id)
    if active:
        msg = (f"这部剧已有任务在跑（{active}）。修复会覆写剧本，和它同时跑会互相覆盖，"
               f"所以这次没有启动。等它完成后再点一次。")
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    r = await chat_jobs.start_fix(draft_id=draft_id, user_id=user_id,
                                  issue_ids=issue_ids, report_id=int(report_id or 0))
    if not r.get("ok"):
        msg = f"启动修复失败：{r.get('error')}"
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "error", "message": msg})
        return

    ack = (f"已启动定点修复：这次改 **{len(issue_ids)}** 个问题。\n\n"
           f"- **作业号**：#{r['job_id']}\n"
           f"- 只改被点名的集，**没点到的集一字不碰**（这是它和「整本精修」的根本区别）。\n"
           f"- 每集改之前都存了历史版本，可回滚。\n"
           f"- 改完会**立刻复检**：如果问题数没降下来，我会如实告诉你「没改到位」，"
           f"不会假装成功。")
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=ack))
    yield _sse({"type": "start", "conversation_id": conv_id})
    yield _sse({"type": "delta", "content": ack})
    yield _sse({"type": "done", "full_content": ack})
    yield _sse({"type": "fix", "job_id": r["job_id"], "kind": "fix_script",
                "draft_id": draft_id, "report_id": r.get("report_id"),
                "issue_ids": list(issue_ids)})


async def _stream_generate(
    *,
    conv_id: int,
    user_id: int,
    user_input: str,
    draft_id: int | None,
    gen_kind: str,
    scope: dict | None = None,
    guidance: str = "",
    mode: str | None = None,
) -> AsyncGenerator[str, None]:
    """「生成大纲 / 生成正文 / 生成剧本」三颗按钮的后端。

    与 `_stream_polish` 同一套骨架（落用户消息 → 前置条件 → 入队 → 回执 + job 事件），
    因为它们解决的是同一类问题：用户点一下，后台跑一个几十集的长任务，可以关页面。

    与 `_stream_check`/`_stream_fix` 的差别只在"要不要等结果"：体检秒出所以同步返回
    报告卡，生成是长任务所以只回执 + 作业号，前端拿作业号去轮询进度。

    draft_id: **可以是 None**。用户反馈"我就想在对话里直接写，不想碰草稿"（2026-09），
    而生成必须落在某部草稿上 —— 缺 draft_id 时由 `chat_jobs.start_generate` 自己
    解析一部（会话已绑的 / 从会话原文导入一份 / 新建空草稿），用户不需要知道。
    ⚠️ 以前这里是 `draft_id: int`，没草稿时下游走到 "草稿 None 不存在"。

    **前置条件在入队前查**（`chat_jobs.start_generate` 里），不入队一个必然失败的作业：
    "没有大纲却要生成正文"这种情况当场说清楚，比让用户等一分钟再看到一个失败好得多。

    scope: ``{"start_ep": int|null, "end_ep": int|null}``（动作栏"这批"选择器的范围）。
    ⚠️ 以前这里**收了 scope 却没往下传**，圈 3~10 集照样按整本跑 —— 用户圈了没用。
    现在原样转成 start/end 交给 `start_generate`。

    guidance: 用户这次补的写作要求原话。以前**没有任何入口**能把它带进生成，
    模型只能照大纲硬写（用户反馈"AI 感很重、细节僵硬"的结构性原因）。
    现在透传给 `start_generate` → 逐集注入 prompt；为空时行为与改前一致。

    mode: 会话当前选的模式 key。以前模式只进聊天的 system prompt，够不着生成，
    用户"选剧本模式也没有用"是准确的 —— 现在作为**写法参考**并入 guidance
    （冲突时用户原话为准，见 `chat_jobs._compose_guidance`）。
    """
    from . import chat_jobs

    g_start = int((scope or {}).get("start_ep") or 0)
    g_end = int((scope or {}).get("end_ep") or 0)

    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return
        # ⚠️ 只有**确实拿到了 draft_id** 才回填会话。没有草稿时 draft_id 是 None，
        # 回填会把会话的 draft_id 写成 NULL，抹掉用户之前关联的那一部。
        if draft_id and not conv.draft_id:
            await s.execute(update(AgentConversation)
                            .where(AgentConversation.id == conv_id)
                            .values(draft_id=draft_id))

    # 落用户消息（用户点按钮时前端也把那句话填进了输入框，历史里应当留下它）
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="user",
                           content=user_input or "（生成）"))

    res = await chat_jobs.start_generate(
        draft_id=draft_id, user_id=user_id, gen_kind=gen_kind,
        start=g_start or None, end=g_end or None,
        guidance=(guidance or "").strip()[:4000], mode=mode,
        conversation_id=conv_id)
    if not res.get("ok"):
        msg = str(res.get("error") or "启动失败")
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    # 解析出来的草稿要接住：既回填会话（下次不必再解析），也要用它的 id 发 job 事件，
    # 否则前端拿到的是 None，作业完成了也无法定位到这部剧去拉改动。
    draft_id = int(res.get("draft_id") or draft_id or 0)
    label = res.get("label") or "生成"
    title = res.get("title") or f"草稿{draft_id}"
    job_id = res["job_id"]
    span = str(res.get("span") or "")
    # 回执里把"这次到底会生成多少"说清楚 —— 生成本身就是长任务，用户最想知道的是量级。
    if res.get("adapt"):
        # 小说/推文走改编作业表，回执由 _start_adapt 自己拼好（它知道进度条不跟）
        extra = str(res.get("extra") or "")
    elif gen_kind == "outline":
        extra = (f"- **集数**：{res.get('planned') or 0} 集"
                 f"（草稿设过集数就按它，没设过就顺着现有大纲/默认 50 集）\n")
    elif gen_kind == "chapters":
        extra = (f"- **依据**：现有分集大纲（{res.get('planned') or 0} 集），"
                 f"只补这个范围内还没有正文的集\n" if span else
                 f"- **依据**：现有分集大纲（{res.get('planned') or 0} 集），"
                 f"只补还没有正文的集\n")
    else:
        extra = (f"- **依据**：现有正文（{res.get('chapters') or 0} 集），"
                 f"只补这个范围内还没有剧本的集\n" if span else
                 f"- **依据**：现有正文（{res.get('chapters') or 0} 集），"
                 f"只补还没有剧本的集\n")
    if span:
        extra = f"- **范围**：{span}（范围外的集一字不碰）\n" + extra
    # 用户补的要求有没有真的进去，回执里必须看得见 —— 否则"我说了它没听"
    # 这种怀疑永远没法自查（这正是用户反馈里"中间加不了指令"的体感来源）。
    g_txt = (guidance or "").strip()
    if g_txt and gen_kind in ("chapters", "storyboards"):
        head = g_txt[:120] + ("…" if len(g_txt) > 120 else "")
        extra += f"- **已带上你的要求**（{len(g_txt)} 字，逐集生效）：{head}\n"
    elif gen_kind in ("chapters", "storyboards") and res.get("guidance_applied"):
        # 用户没自己写要求，但模式约定附上去了 —— 也说出来，否则"选了模式到底有没有用"
        # 永远没法自查（用户反馈里那句"选择剧本模式也没有用"就是这么来的）。
        extra += "- **已按当前模式的写法要求附带生成**（你没写额外要求，它就按模式约定走）\n"
    r_note = str(res.get("resolved_note") or "")
    if r_note:
        extra += f"- **本次落点**：{r_note}\n"
    # ⚠️ 改编（小说/推文）走另一套作业表，**不在**进度条的统计里 ——
    # 照抄"上方进度条会实时走"就是骗人。
    tail = ("- 这是长任务，**可以关掉页面**，跑完内容直接生效。\n\n"
            if res.get("adapt") else
            "- 这是长任务，**可以关掉页面**，跑完内容直接生效（上方进度条会实时走）。\n\n")
    ack = (f"已对《{title}》启动**{label}**。\n\n"
           f"{extra}"
           f"- **作业号**：#{job_id}\n"
           f"{tail}"
           f"进度可以随时问我「生成好了吗」。")
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=ack))

    yield _sse({"type": "start", "conversation_id": conv_id})
    yield _sse({"type": "delta", "content": ack})
    yield _sse({"type": "done", "full_content": ack})
    yield _sse({"type": "job", "job_id": job_id, "kind": res["kind"],
                "draft_id": draft_id, "gen_kind": gen_kind})


_DEAI_COPY_WORDS = ("副本", "另存", "复制一份", "拷贝一份", "新建一份", "别动原", "不要动原", "不动原")


async def _stream_deai(
    *,
    conv_id: int,
    user_id: int,
    user_input: str,
    draft_id: int,
    provider: str | None,
    scope: dict | None = None,
) -> AsyncGenerator[str, None]:
    """「去 AI 味」按钮的后端（对话工坊动作栏 / v2 对话栏）。范围由 scope 给（与精修同一个范围选择器），空 = 全剧。

    2026-10-30 起**写回草稿**（用户裁定，见 deai/routes.py 模块说明）：默认改在原稿里；
    用户这句话里要了副本（「建个副本」「别动原稿」…）就先复制一份、改在副本里。
    走作业队列（deai_apply），回 "job" 事件 —— 前端用与精修同一套轮询与「看改动」。
    """
    from ..deai.routes import start_deai_apply

    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return
        if not conv.draft_id:
            await s.execute(update(AgentConversation)
                            .where(AgentConversation.id == conv_id)
                            .values(draft_id=draft_id))

    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="user",
                           content=user_input or "（去 AI 味）"))

    target = "copy" if any(w in (user_input or "") for w in _DEAI_COPY_WORDS) else "inplace"
    sc = scope if isinstance(scope, dict) else {}
    res = await start_deai_apply(draft_id=draft_id, user_id=user_id, target=target,
                                 inject_level="light", allow_typo=True, model=provider or "gemini",
                                 start_ep=int(sc.get("start_ep") or 0), end_ep=int(sc.get("end_ep") or 0),
                                 layer=sc.get("target") if sc.get("target") in ("storyboard", "chapter") else None)
    if not res.get("ok"):
        msg = str(res.get("error") or "启动失败")
        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=msg))
        yield _sse({"type": "start", "conversation_id": conv_id})
        yield _sse({"type": "delta", "content": msg})
        yield _sse({"type": "done", "full_content": msg})
        return

    job_id, work_id = res["job_id"], res["draft_id"]
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        title = (d.title if d else None) or f"草稿{draft_id}"
    if target == "copy":
        where = (f"- **改在副本里**：已复制出新草稿 **#{work_id}**《{title}（去AI味副本）》，"
                 f"原稿 #{draft_id} 一个字都不动。跑完在副本里看结果。\n")
    else:
        where = ("- **直接改在这部剧里**：每集改之前都先存了历史版本，"
                 "跑完点「看改动」能逐集看改前/改后，不满意的集可以在历史里恢复。\n"
                 "  想保留原稿、改在副本里，就说「去 AI 味，建个副本」。\n")
    rng = _scope_label_text(scope)
    ack = (f"已对《{title}》（{rng}）启动**去 AI 味**（作业 #{job_id}）。\n\n"
           f"{where}"
           f"- 力度：轻度（只清 AI 腔的硬信号，保留原本的说话习惯）\n"
           f"- 只改文字腔调，场次、行数、说话人都不变；哪一集改完对不上原来的结构，那一集就不写回。\n"
           f"- 长任务，可以关掉页面，后台会跑完。")
    async with session_scope() as s:
        s.add(AgentMessage(conversation_id=conv_id, role="assistant", content=ack))

    yield _sse({"type": "start", "conversation_id": conv_id})
    yield _sse({"type": "delta", "content": ack})
    yield _sse({"type": "done", "full_content": ack})
    yield _sse({"type": "job", "job_id": job_id, "kind": "deai_apply", "draft_id": work_id,
                "target": target, "source_draft_id": draft_id})


async def _stream_action(**kw) -> AsyncGenerator[str, None]:
    """动作栏入口外壳：把对话栏选的模型设为这次动作的**写作模型**，再交给真正的分派。

    以前只有 rewrite/deai/check 把 provider 往下传，「生成大纲/正文/剧本」与「定点修复」
    读的是草稿自己的 model_provider —— 对话栏选了 deepseek，生成仍走 gemini。
    在这里设好 job_context.WRITING_MODEL 后：同步调用经 get_llm 替换，入队的作业由
    jobs.enqueue 带进 payload。只认带型号的值（"厂商:型号"）；厂商级老值不覆盖。
    """
    from ..job_context import WRITING_MODEL
    spec = str(kw.get("provider") or "")
    token = WRITING_MODEL.set(spec) if ":" in spec else None
    try:
        async for evt in _stream_action_impl(**kw):
            yield evt
    finally:
        if token is not None:
            WRITING_MODEL.reset(token)


async def _stream_action_impl(
    *,
    action: str,
    conv_id: int,
    user_id: int,
    user_input: str,
    current_draft_id: int | None,
    provider: str | None,
    scope: dict | None,
    kinds: list | None,
    issue_ids: list | None,
    report_id: int,
    deep: bool,
    gen_kind: str | None = None,
    guidance: str = "",
    mode: str | None = None,
) -> AsyncGenerator[str, None]:
    """动作栏的统一入口: 解析会话/草稿, 再分派给 check / fix / rewrite / generate / deai 五条路。

    五条路都遵守同一条边界: **没有可用草稿就当场说清楚**, 不建一个必然失败的作业。
    ⚠️ 唯一的例外是 generate: 用户反馈"我就想在对话里直接写，不想碰草稿"，
       而生成又必须落在某部草稿上。所以那条路允许**没有草稿**——由
       `chat_jobs.start_generate` 自己找一部/建一部（用户不需要知道）。
       体检/精修/去 AI 味仍然要求先有草稿：它们是对**已有内容**做二次加工，
       没有内容时"没有草稿"就是真实原因，藏起来反而误导。

    mode: 会话当前模式 key，只对 generate 有意义（作为写法参考并入 guidance）。
    """
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return
        draft_id = current_draft_id or conv.draft_id
        if not draft_id and action != "generate":
            yield _sse({"type": "error",
                        "message": "这个对话还没有关联草稿。先在页面上选一部剧本，再来做体检/精修。"})
            return
        if draft_id:
            d = await s.get(ScriptDraft, draft_id)
            if not d:
                yield _sse({"type": "error", "message": f"草稿 {draft_id} 不存在。"})
                return
            if not conv.draft_id:
                await s.execute(update(AgentConversation)
                                .where(AgentConversation.id == conv_id)
                                .values(draft_id=draft_id))

    if action == "fix":
        async for evt in _stream_fix(
                conv_id=conv_id, user_id=user_id, user_input=user_input,
                draft_id=draft_id, issue_ids=issue_ids or [], report_id=report_id):
            yield evt
        return
    if action == "rewrite":
        async for evt in _stream_polish(
                conv_id=conv_id, user_id=user_id, user_input=user_input,
                current_draft_id=draft_id, provider=provider, scope=scope,
                guidance=guidance):
            yield evt
        return
    if action == "generate":
        # ⚠️ **不要**在这里兜底成 "outline"。
        # 原来写的是 `gen_kind or "outline"`：前端少传一个字段（实际发生过 ——
        # 驼峰/下划线写错），后端就默默去**重新生成大纲**，
        # 而那会覆盖用户的分集计划、契约与账本。
        # 静默兜底把一个前端笔误变成了数据损失，宁可报错。
        if not (gen_kind or "").strip():
            yield _sse({"type": "error",
                        "message": "没说清要生成哪一层（大纲/正文/剧本）。"
                                   "请重新点一次生成菜单里的具体项。"})
            return
        async for evt in _stream_generate(
                conv_id=conv_id, user_id=user_id, user_input=user_input,
                draft_id=draft_id, gen_kind=gen_kind,
                scope=scope, guidance=guidance, mode=mode):
            yield evt
        return
    if action == "deai":
        async for evt in _stream_deai(
                conv_id=conv_id, user_id=user_id, user_input=user_input,
                draft_id=draft_id, provider=provider, scope=scope):
            yield evt
        return
    # 默认按体检处理(action 的合法值只有 check/fix/rewrite, 这里收口)
    async for evt in _stream_check(
            conv_id=conv_id, user_id=user_id, user_input=user_input, draft_id=draft_id,
            kinds=kinds, scope=scope, deep=deep, provider=provider):
        yield evt


async def _stream_chat(
    conv_id: int,
    user_id: int,
    user_input: str,
    user_role: str | None = None,
    current_draft_id: int | None = None,
    mode: str | None = None,
    provider: str | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    history_turns: int | None = None,
    compaction_enabled: bool = True,
    tool_mode: str = "off",
    chat_mode: str = "chat",
    action: str | None = None,
    scope: dict | None = None,
    kinds: list | None = None,
    issue_ids: list | None = None,
    report_id: int = 0,
    deep: bool = True,
    gen_kind: str | None = None,
    guidance: str = "",
    kind: str | None = None,
    image_ids: list[int] | None = None,
) -> AsyncGenerator[str, None]:
    """核心: 调 LLM 流式生成, SSE 推送 delta, 完成后写库。

    current_draft_id: 前端传来的"用户当前所在草稿页 ID",
      用于动态注入草稿上下文,即使会话本身没绑这个 draft。

    temperature / top_p / history_turns: 对话工坊"设置"弹窗的生成参数,
      不传则用服务端默认(见 _norm_gen_params)。

    chat_mode: "chat"(默认, Agent 循环) / "polish"(自动精修, 见下方分支)。

    action: 动作栏的结构化意图(见 SendMessageIn)。**优先于 chat_mode 判断** ——
      按钮和手打走同一条路径, 前端只负责把一句人话填进输入框, 语义在这里收口:
        · "check"   → 体检(同步出报告卡)
        · "fix"     → 按 issue_id 定点修复(入队)
        · "rewrite" → 范围精修(等价 chat_mode="polish", 但范围由 scope 给)
        · "generate"→ 生成大纲/正文/剧本(gen_kind 指定哪一层, 确定性入队)
        · "deai"    → 去 AI 味(入队 deai_apply, 写回原稿或副本)
        · None      → 老路径(chat_mode)

    guidance: 用户本次补的写作要求原话。只在 action=generate/rewrite 时有意义;
      "讨论"模式下用户那句话本身就是上下文, 不需要再注入一遍, 故忽略。
    """
    if action in ("check", "fix", "rewrite", "generate", "deai"):
        async for evt in _stream_action(
            action=action, conv_id=conv_id, user_id=user_id, user_input=user_input,
            current_draft_id=current_draft_id, provider=provider, scope=scope,
            kinds=kinds, issue_ids=issue_ids, report_id=report_id, deep=deep,
            gen_kind=gen_kind, guidance=guidance, mode=mode,
        ):
            yield evt
        return

    temp, tp, turns = _norm_gen_params(temperature, top_p, history_turns)

    # ── 自动精修模式：不跑 Agent 循环，直接触发整本精修 ──
    # 放在最前面是因为它连 LLM 上下文都不需要（精修自己会通读全剧），
    # 少一次会话加载 + 少一轮模型对话，启动更快。
    if chat_mode == "polish":
        async for evt in _stream_polish(
            conv_id=conv_id, user_id=user_id, user_input=user_input,
            current_draft_id=current_draft_id, provider=provider,
            guidance=guidance,
        ):
            yield evt
        return

    # 1) 加载会话
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return

        # 消息计数: 仅用于"首条消息时用用户输入生成会话标题", 不做条数上限拦截
        msg_count = (await s.execute(
            select(func.count(AgentMessage.id)).where(AgentMessage.conversation_id == conv_id)
        )).scalar() or 0

        # 若会话尚未绑定 draft, 把当前页 draft_id 顺手补上(让会话变成"和这部剧关联")
        if not conv.draft_id and current_draft_id:
            conv.draft_id = current_draft_id

    # 2) 构建 prompt + 历史 (优先使用当前页 draft_id, 否则回退会话绑定的)
    try:
        messages, _hist = await _build_messages(
            user_id=user_id,
            user_role=user_role,
            conv=conv,
            user_input=user_input,
            effective_draft_id=current_draft_id or conv.draft_id,
            mode=mode,
            history_turns=turns,
            kind=kind,
        )
    except Exception as ex:
        logger.exception("build messages failed: %s", ex)
        yield _sse({"type": "error", "message": f"构建上下文失败: {ex}"})
        return

    # 3) 写入用户消息
    user_msg_id: int | None = None
    async with session_scope() as s:
        _um = AgentMessage(
            conversation_id=conv_id,
            role="user",
            content=user_input,
        )
        s.add(_um)
        await s.flush()
        user_msg_id = _um.id
        # 若是第一条消息, 用户输入前 30 字作为标题。
        # ⚠️ 只在标题还是默认值时改 —— 建会话时显式起过名字的(POST /conversations
        # 带 title)不能被冲掉: 用户特意命名的会话, 发第一句话就被改成那句话的前 30 字,
        # 等于命名功能对新会话完全无效。同文件精修改名(见 `title=f"精修 · ..."` 处)
        # 早就有这道保护, 这里漏了。
        if msg_count == 0:
            # 只发了图没写字时，别把会话标题留成空串
            new_title = user_input.strip().replace("\n", " ")[:30] or ("图片对话" if image_ids else "")
            await s.execute(
                update(AgentConversation)
                .where(AgentConversation.id == conv_id)
                .where(func.coalesce(AgentConversation.title, "").in_(("", "新对话")))
                .values(title=new_title or "新对话")
            )

    # 3.5) 把这一轮附带的图片挂到刚写入的用户消息上，并取出来备用。
    #      绑定在写消息**之后**做：要拿到 message_id 才能绑；图片行上的
    #      user_id 闸门保证只能绑自己上传、且还没被绑过的图。
    turn_images: list[dict] = []
    if image_ids and user_msg_id:
        from .images import bind_to_message, load_for_message
        try:
            await bind_to_message(user_id=user_id, image_ids=list(image_ids),
                                  message_id=user_msg_id, conversation_id=conv_id)
            turn_images = await load_for_message(user_id=user_id, message_id=user_msg_id)
        except Exception as e:  # noqa: BLE001
            # 图片取不到要让用户知道，而不是静默当没发过（模型会回答"我没看到图"，
            # 用户却以为模型看过了）
            logger.exception("bind chat images failed: %s", e)
            yield _sse({"type": "error", "message": f"图片处理失败：{e}"})
            return
        if len(turn_images) < len(image_ids):
            logger.warning("conv %s: 请求 %d 张图, 实际可用 %d 张",
                           conv_id, len(image_ids), len(turn_images))

    yield _sse({"type": "start", "conversation_id": conv_id})

    # 4) 调 LLM（用户选定的模型，非法值回退 gemini）
    chosen_provider = normalize_chat_provider(provider)
    full_text = ""

    # ---- 上下文压缩（分层：剪枝→摘要→反应式→熔断，见 agent/compaction.py）----
    # 是否启用压缩由请求参数决定（前端设置里的开关），默认开启。
    real_model = _model_id_from_spec(chosen_provider)
    if compaction_enabled:
        try:
            compactor = _compactors.setdefault(conv_id, _Compactor())
            sys_prompt = ""
            body = list(messages)
            if body and body[0].get("role") == "system":
                sys_prompt = str(body[0].get("content") or "")
                body = body[1:]
            if compactor.should_compact(body, model=real_model):
                res = await compactor.compact(
                    system_prompt=sys_prompt, messages=body,
                    model=real_model, provider=chosen_provider)
                if res.compacted or res.pruned_chars:
                    messages = [{"role": "system", "content": sys_prompt}] + res.messages
                    # 轻量提示，不做成卡片（用户要求：像普通对话）
                    yield _sse({"type": "delta", "content":
                        "（上下文较长，我已压缩了早期对话以保持流畅。"
                        "关键信息都已保留。）\n\n"})
                    logger.info("conv %s 压缩: %s→%s tokens, %s",
                                conv_id, res.estimated_tokens_before,
                                res.estimated_tokens_after, res.reason)
        except Exception as e:  # noqa: BLE001
            # 压缩失败绝不阻断对话——原样继续
            logger.warning("compaction failed (continue without): %s", e)

    # 本轮图片在**压缩之后**才拼进去：压缩器按字符串估算 token，多模态数组
    # 进去会被当成异常内容；而且图片本来就不该参与"压缩早期对话"的判断。
    if turn_images:
        from .images import build_content
        for _i in range(len(messages) - 1, -1, -1):
            if messages[_i].get("role") == "user":
                messages[_i] = {"role": "user",
                                "content": build_content(str(messages[_i].get("content") or ""),
                                                         turn_images)}
                break

    async def _save_partial() -> None:
        """客户端断开时把已生成的部分内容落库, 避免整段丢失。"""
        if not full_text:
            return
        async with session_scope() as s:
            s.add(AgentMessage(
                conversation_id=conv_id,
                role="assistant",
                content=full_text + "\n\n[!] 生成中断(连接断开), 以上为已生成部分",
            ))

    # ── 纯对话模式（tool_mode="off"，对话工坊的日常模式）：一次模型调用，到此为止 ──
    # 2026-09 用户反馈：给普通用户一个**不带工具**的对话工坊。
    #   · 他们习惯"在对话里拿到文本 → 高亮选中 → 按钮插入草稿"，
    #     而不是"下命令 → agent 调工具 → 等结果"——后者链路长一倍，出错面也大一倍。
    #   · 检查/精修/去AI味等能力改由**按钮**触发（action 分支，见 _stream_action），
    #     那些分支本来就走确定性后端路径，压根不经过 AgentLoop。
    # 为什么不是"带空工具列表跑 AgentLoop"：那个循环会把 LOOP_INSTRUCTIONS 和工具
    # 说明书一起塞进 system（模型会**在正文里编造** <invoke> 调用），还带收敛判定、
    # 假完成核对、tool_start 内联提示——这些对纯聊天全是噪音。直接单轮最干净。
    #
    # ⚠️ 位置很重要：必须放在**上下文压缩之后**。纯对话是默认模式，用户会在这里粘
    # 几十集细纲、聊十几轮，跳过压缩就等于让默认路径裸奔撞上下文上限。
    # 2026-10-18: 对话里的工具循环（AgentLoop, tool_mode=auto/readonly）已下线 ——
    # 前端早就恒发 "off"，那条路径无人触发；多步自主能力统一由 Agent 引擎提供
    # （对话工坊「交给 Agent」→ /v1/agent-engine）。这里一律走纯对话。
    if True:
        _plain_llm = get_llm("rewrite", temperature=temp, provider=chosen_provider, top_p=tp)
        try:
            async for chunk in _plain_llm.astream(messages):
                piece = getattr(chunk, "content", "") or ""
                if isinstance(piece, list):
                    piece = "".join(
                        (p.get("text", "") if isinstance(p, dict) else str(p)) for p in piece)
                if piece:
                    full_text += piece
                    yield _sse({"type": "delta", "content": piece})
        except (asyncio.CancelledError, GeneratorExit):
            # 客户端断开：已生成部分必须落库，否则这条回复永久丢失（与 Agent 路径一致）
            if full_text:
                await asyncio.shield(asyncio.ensure_future(_save_partial()))
            raise
        except Exception as ex:  # noqa: BLE001
            logger.exception("plain chat failed: %s", ex)
            yield _sse({"type": "error", "message": f"模型调用失败: {ex}"})
            if full_text:
                async with session_scope() as s:
                    s.add(AgentMessage(conversation_id=conv_id, role="assistant",
                                       content=full_text + "\n\n[!] 生成中断"))
            return

        async with session_scope() as s:
            s.add(AgentMessage(conversation_id=conv_id, role="assistant",
                               content=full_text or "(空回复)", tokens_in=0, tokens_out=0))
        yield _sse({"type": "done", "full_content": full_text})
        return


@router.post("/conversations/{conv_id}/messages")
async def send_message(
    conv_id: int,
    payload: SendMessageIn,
    user: User = Depends(get_current_user),
):
    """发送消息 + SSE 流式返回 AI 回复。

    SSE event 格式:
      {"type": "start", "conversation_id": int}
      {"type": "delta", "content": "..."}
      ...
      {"type": "done", "full_content": "完整文本"}
      {"type": "error", "message": "..."}
    """
    if not (payload.content or "").strip() and not payload.image_ids:
        raise HTTPException(422, "消息内容不能为空")
    return StreamingResponse(
        _stream_chat(
            conv_id,
            user.id,
            (payload.content or "").strip(),
            user_role=getattr(user, "role", None),
            current_draft_id=payload.current_draft_id,
            mode=payload.mode,
            provider=payload.provider,
            temperature=payload.temperature,
            top_p=payload.top_p,
            history_turns=payload.history_turns,
            compaction_enabled=(payload.compaction is not False),
            tool_mode=(payload.tool_mode or "off"),
            chat_mode=(payload.chat_mode or "chat"),
            action=payload.action,
            scope=payload.scope,
            kinds=payload.kinds,
            issue_ids=payload.issue_ids,
            report_id=int(payload.report_id or 0),
            deep=(payload.deep is not False),
            gen_kind=payload.gen_kind,
            guidance=(payload.guidance or ""),
            kind=payload.kind,
            image_ids=payload.image_ids,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # nginx: 关闭缓冲
        },
    )

# ============ 编辑已发消息 → 重新生成 (问答版本化) ============

class EditMessageIn(GenParamsIn):
    content: str = Field(..., min_length=1, max_length=MAX_USER_MSG_CHARS)
    current_draft_id: int | None = None
    mode: str | None = None
    provider: str | None = None
    compaction: bool | None = None
    # ⚠️ 与 SendMessageIn 的同名字段保持同步（取值说明见那边）。
    #    默认 "off"：纯对话，不跑 Agent 循环。
    tool_mode: str | None = None
    chat_mode: str | None = None      # 见 SendMessageIn 的说明; 与发消息保持一致


class ActivateVersionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 见 CreateConvIn

    version: int = Field(..., ge=1)


async def _stream_edit_chat(
    conv_id: int,
    msg_id: int,
    user_id: int,
    new_content: str,
    user_role: str | None = None,
    current_draft_id: int | None = None,
    mode: str | None = None,
    provider: str | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    history_turns: int | None = None,
    compaction_enabled: bool = True,
    tool_mode: str = "off",
    chat_mode: str = "chat",
) -> AsyncGenerator[str, None]:
    """编辑已发用户消息 → 旧问答对下线为历史版本 → 基于新文本重新流式生成。

    上下文规则: 只取"被编辑消息之前"的激活历史 (旧的这组问答不进上下文, 防污染);
    该消息之后的其他对话原样保留不动。

    temperature / top_p / history_turns: 同 _stream_chat, 来自设置弹窗。

    chat_mode="polish": 不重新生成对话, 而是把改后的文本当参考意见**再启动一次整本精修**。
    与发消息共用同一条分支(见 _stream_polish), 所以"改一句话重新触发精修"是醒的;
    代价是这条路径不回填版本组, 旧问答仍按普通编辑规则下线为历史版本。
    """
    temp, tp, turns = _norm_gen_params(temperature, top_p, history_turns)

    if chat_mode == "polish":
        async for evt in _stream_polish(
            conv_id=conv_id, user_id=user_id, user_input=new_content,
            current_draft_id=current_draft_id, provider=provider,
        ):
            yield evt
        return

    # 1) 校验 + 建立版本组
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user_id or conv.is_deleted:
            yield _sse({"type": "error", "message": "会话不存在"})
            return
        target = await s.get(AgentMessage, msg_id)
        if not target or target.conversation_id != conv_id or target.role != "user":
            yield _sse({"type": "error", "message": "消息不存在或不是用户消息"})
            return
        if target.is_active is False:
            yield _sse({"type": "error", "message": "只能编辑当前版本的消息"})
            return

        # 版本组: 首次编辑时以首版用户消息 id 作为 group_id, 并固定槽位 seq
        group_id = target.group_id or target.id
        user_slot = target.seq if target.seq is not None else target.id
        old_user_ver = target.version or 1
        if target.group_id is None:
            target.group_id = group_id
            target.version = 1
            target.seq = user_slot

        # 找旧配对回复: 槽位在被编辑消息之后、下一条激活用户消息之前的激活 assistant 消息
        slot = func.coalesce(AgentMessage.seq, AgentMessage.id)
        after = (await s.execute(
            select(AgentMessage)
            .where(
                AgentMessage.conversation_id == conv_id,
                or_(AgentMessage.is_active.is_(None), AgentMessage.is_active.is_(True)),
                slot > user_slot,
            )
            .order_by(slot, AgentMessage.id)
        )).scalars().all()
        old_reply = None
        for m in after:
            if m.role == "user":
                break
            if m.role == "assistant":
                old_reply = m
                break
        reply_slot = None
        if old_reply is not None:
            reply_slot = old_reply.seq if old_reply.seq is not None else old_reply.id
            if old_reply.group_id is None:
                old_reply.group_id = group_id
                old_reply.version = old_user_ver
                old_reply.seq = reply_slot

        # 新版本号 = 组内最大版本 + 1
        max_ver = (await s.execute(
            select(func.max(AgentMessage.version))
            .where(AgentMessage.conversation_id == conv_id, AgentMessage.group_id == group_id)
        )).scalar() or 1
        new_ver = max_ver + 1

        # 旧问答对下线
        target.is_active = False
        if old_reply is not None:
            old_reply.is_active = False

    # 2) 构建上下文: 只取被编辑消息之前的激活历史
    try:
        messages, _hist = await _build_messages(
            user_id=user_id,
            user_role=user_role,
            conv=conv,
            user_input=new_content,
            effective_draft_id=current_draft_id or conv.draft_id,
            mode=mode,
            before_slot=user_slot,
            history_turns=turns,
        )
    except Exception as ex:
        logger.exception("build edit messages failed: %s", ex)
        # 回滚下线操作, 避免这组问答凭空消失
        async with session_scope() as s:
            await s.execute(
                update(AgentMessage)
                .where(AgentMessage.conversation_id == conv_id,
                       AgentMessage.group_id == group_id,
                       AgentMessage.version == old_user_ver)
                .values(is_active=True)
            )
        yield _sse({"type": "error", "message": f"构建上下文失败: {ex}"})
        return

    # 3) 写入新版本用户消息 (继承原槽位, 停留在原位置)
    async with session_scope() as s:
        new_user = AgentMessage(
            conversation_id=conv_id,
            role="user",
            content=new_content,
            group_id=group_id,
            version=new_ver,
            is_active=True,
            seq=user_slot,
        )
        s.add(new_user)
        await s.flush()
        new_user_id = new_user.id

    yield _sse({
        "type": "start", "conversation_id": conv_id,
        "group_id": group_id, "version": new_ver, "user_message_id": new_user_id,
    })

    # 4) 调 LLM 流式
    chosen_provider = normalize_chat_provider(provider)
    assistant_seq = reply_slot if reply_slot is not None else user_slot
    full_text = ""

    async def _save_partial_edit() -> None:
        """客户端断开时把已生成的部分内容作为新版本回复落库, 避免整组问答丢失。

        注意: 此时旧问答已下线、新版本用户消息已写入, 若不保存回复,
        切页回来这组问答就只剩用户消息没有回复(甚至看似丢失)。
        """
        if not full_text:
            return
        async with session_scope() as s:
            s.add(AgentMessage(
                conversation_id=conv_id, role="assistant",
                content=full_text + "\n\n[!] 生成中断(连接断开), 以上为已生成部分",
                group_id=group_id, version=new_ver, is_active=True, seq=assistant_seq,
            ))

    try:
        llm = get_llm("rewrite", temperature=temp, provider=chosen_provider, top_p=tp)
        async for chunk in llm.astream(messages):
            delta = getattr(chunk, "content", "") or ""
            if delta:
                full_text += delta
                yield _sse({"type": "delta", "content": delta})
    except (asyncio.CancelledError, GeneratorExit):
        # 客户端断开(切页/关标签/停止): 保存已生成部分为新版本回复。
        await asyncio.shield(asyncio.ensure_future(_save_partial_edit()))
        raise
    except Exception as ex:
        logger.exception("agent edit llm stream failed: %s", ex)
        yield _sse({"type": "error", "message": f"模型调用失败: {ex}"})
        if full_text:
            async with session_scope() as s:
                s.add(AgentMessage(
                    conversation_id=conv_id, role="assistant",
                    content=full_text + "\n\n[!] 生成中断",
                    group_id=group_id, version=new_ver, is_active=True, seq=assistant_seq,
                ))
        return

    # 5) 写入新版本助手回复 (同组同版本, 槽位继承旧回复位置)
    async with session_scope() as s:
        s.add(AgentMessage(
            conversation_id=conv_id,
            role="assistant",
            content=full_text or "(空回复)",
            group_id=group_id,
            version=new_ver,
            is_active=True,
            seq=assistant_seq,
            tokens_in=0,
            tokens_out=0,
        ))

    yield _sse({"type": "done", "full_content": full_text, "group_id": group_id, "version": new_ver})


@router.post("/conversations/{conv_id}/messages/{msg_id}/edit")
async def edit_message(
    conv_id: int,
    msg_id: int,
    payload: EditMessageIn,
    user: User = Depends(get_current_user),
):
    """编辑已发出的用户消息并重新生成回复 (SSE 流式, 事件格式同发消息)。

    旧的"用户消息+AI回复"问答对保留为历史版本 (v1/v2...),
    可通过 groups/{group_id}/activate 切换回显。
    """
    return StreamingResponse(
        _stream_edit_chat(
            conv_id,
            msg_id,
            user.id,
            payload.content.strip(),
            user_role=getattr(user, "role", None),
            current_draft_id=payload.current_draft_id,
            mode=payload.mode,
            provider=payload.provider,
            temperature=payload.temperature,
            top_p=payload.top_p,
            history_turns=payload.history_turns,
            compaction_enabled=(payload.compaction is not False),
            tool_mode=(payload.tool_mode or "off"),
            chat_mode=(payload.chat_mode or "chat"),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/conversations/{conv_id}/groups/{group_id}/activate")
async def activate_qa_version(
    conv_id: int,
    group_id: int,
    payload: ActivateVersionIn,
    user: User = Depends(get_current_user),
):
    """切换一组问答的显示版本: 该版本置 active, 其余版本下线。

    激活的版本同时决定 LLM 上下文里这组问答用哪个版本。
    """
    async with session_scope() as s:
        conv = await s.get(AgentConversation, conv_id)
        if not conv or conv.user_id != user.id or conv.is_deleted:
            raise HTTPException(404, "会话不存在")
        rows = (await s.execute(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conv_id, AgentMessage.group_id == group_id)
        )).scalars().all()
        if not rows:
            raise HTTPException(404, "版本组不存在")
        versions = sorted({m.version or 1 for m in rows})
        if payload.version not in versions:
            raise HTTPException(404, f"版本 v{payload.version} 不存在 (可选: {versions})")
        activated = []
        for m in rows:
            m.is_active = (m.version or 1) == payload.version
            if m.is_active:
                activated.append({"id": m.id, "role": m.role, "content": m.content,
                              "report": m.report_json or None})
        activated.sort(key=lambda x: x["id"])
        return {"ok": True, "group_id": group_id, "active": payload.version,
                "versions": versions, "messages": activated}


@router.get("/modes")
async def api_list_modes(user: User = Depends(get_current_user)):
    """列出对话工坊可选模式 (只含 key/label/desc, 隐藏的 framework 不下发)。"""
    return {"items": list_modes_public()}


@router.get("/models")
async def api_list_chat_models(user: User = Depends(get_current_user)):
    """列出对话工坊可选模型(真实模型 id)+ 生成参数的默认值与取值区间。

    前端下拉/设置弹窗完全由这份数据驱动: 换 env 里的 LLM_REWRITE_MODEL、
    调整参数区间, 都不需要动前端代码, 也不会出现"页面写的和实际调的不一致"。

    ``groups`` 是 2026-09-09 新增的**分组清单**(Gemini/DeepSeek/GPT/Grok 四个子表,
    每个厂商下列出具体型号 + 实测"稳"标), 与 /v1/models/catalog 同源。
    ``items`` 是旧的扁平厂商清单, 保留给老客户端兜底。
    """
    from ..models.catalog import default_choice
    from ..models.health import catalog_with_health

    try:
        groups = await catalog_with_health()
    except Exception as e:  # noqa: BLE001 - 拿不到健康数据也要能选模型
        logger.warning("模型健康清单获取失败, 退回扁平清单: %s", e)
        groups = []
    return {
        "items": chat_model_catalog(),
        "groups": groups,
        # provider → 该厂商的默认型号(形如 "gemini:gemini-3.6-flash"), 与
        # /v1/models/catalog 同源。前端拿它把老的纯厂商值("gemini")升级成带型号的值,
        # 若没有这份默认值, 前端只能退回"该组第一个", 那会把默认模型悄悄换掉。
        "defaults": {g["provider"]: default_choice(g["provider"]) for g in groups},
        "default_provider": "gemini",
        "params": {
            "temperature": {
                "default": CHAT_TEMP_DEFAULT,
                "min": CHAT_TEMP_MIN, "max": CHAT_TEMP_MAX, "step": 0.1,
            },
            "top_p": {
                # 默认 1.0 = 不下发该参数, 保持模型自身默认
                "default": CHAT_TOP_P_MAX,
                "min": CHAT_TOP_P_MIN, "max": CHAT_TOP_P_MAX, "step": 0.05,
            },
            "history_turns": {
                "default": HISTORY_TURNS_FOR_LLM,
                "min": CHAT_HISTORY_MIN, "max": CHAT_HISTORY_MAX, "step": 1,
                # 轮数没有硬上限: 滑块画到 max 为止, 另有一个"不限"开关传 0
                "unlimited": CHAT_HISTORY_UNLIMITED,
            },
        },
    }


# ============================================================================
# 用户长期记忆: profile / memories / snippets / operations
# ============================================================================
from .memory import (
    get_or_create_profile, update_profile,
    list_memories, insert_memory, update_memory, delete_memory,
    list_snippets, insert_snippet, delete_snippet,
)
from .operations import (
    list_operations, get_operation, create_operation,
    confirm_operation, reject_operation, rollback_operation,
    OP_TYPES, OP_LABEL,
)
from .intent import detect_intent
from .extraction import schedule_extraction


# ---- Profile ----

class ProfilePatch(BaseModel):
    preferred_genres: list[str] | None = None
    forbidden_topics: list[str] | None = None
    preferred_length: int | None = None
    preferred_pace: str | None = None
    style_summary: str | None = None
    tone_keywords: list[str] | None = None
    custom_instructions: str | None = None
    memory_enabled: bool | None = None


@router.get("/profile")
async def api_get_profile(user: User = Depends(get_current_user)):
    p = await get_or_create_profile(user.id)
    if "updated_at" in p and p["updated_at"]:
        p["updated_at"] = p["updated_at"].isoformat() if hasattr(p["updated_at"], "isoformat") else str(p["updated_at"])
    if "last_summarized_at" in p and p["last_summarized_at"]:
        p["last_summarized_at"] = p["last_summarized_at"].isoformat() if hasattr(p["last_summarized_at"], "isoformat") else str(p["last_summarized_at"])
    return p


@router.patch("/profile")
async def api_patch_profile(payload: ProfilePatch, user: User = Depends(get_current_user)):
    patches = {k: v for k, v in payload.dict(exclude_none=True).items()}
    p = await update_profile(user.id, **patches)
    if "updated_at" in p and p["updated_at"] and hasattr(p["updated_at"], "isoformat"):
        p["updated_at"] = p["updated_at"].isoformat()
    return p


# ---- Memories ----

class MemoryIn(BaseModel):
    type: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1, max_length=5000)
    title: str | None = None
    importance: int = 5
    pinned: bool = False
    # None = 按 type 自动判定作用域（世界观/角色/情节 → 剧本级，偏好 → 用户级）。
    # 前端不再硬塞 "global"：那会让手动建的角色记忆又变成跨剧可见。
    scope: str | None = None
    scope_ref: str | None = None


class MemoryPatch(BaseModel):
    type: str | None = None
    content: str | None = None
    title: str | None = None
    importance: int | None = None
    pinned: bool | None = None
    archived: bool | None = None


@router.get("/memories")
async def api_list_memories(
    type: str | None = Query(None),
    archived: bool = Query(False),
    search: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
):
    # ⚠️ 管理界面要**看见全部**记忆（含别的剧的），否则用户无法管理自己已有的记忆。
    # 隔离只针对"注入模型"那条路径（recall_memories），不是这里。
    rows = await list_memories(user.id, type=type, archived=archived, limit=limit,
                               offset=offset, search=search, all_scopes=True)
    for r in rows:
        for k in ("created_at", "last_accessed_at"):
            if k in r and r[k] and hasattr(r[k], "isoformat"):
                r[k] = r[k].isoformat()
    return {"items": rows}


@router.post("/memories")
async def api_create_memory(payload: MemoryIn, user: User = Depends(get_current_user)):
    mid = await insert_memory(
        user.id, type=payload.type, content=payload.content, title=payload.title,
        importance=payload.importance, pinned=payload.pinned,
        scope=payload.scope, scope_ref=payload.scope_ref,
    )
    return {"id": mid}


@router.patch("/memories/{mem_id}")
async def api_update_memory(mem_id: int, payload: MemoryPatch, user: User = Depends(get_current_user)):
    patches = {k: v for k, v in payload.dict(exclude_none=True).items()}
    r = await update_memory(user.id, mem_id, **patches)
    if r is None:
        raise HTTPException(404, "memory not found")
    return r


@router.post("/memories/{mem_id}/pin")
async def api_pin_memory(mem_id: int, user: User = Depends(get_current_user)):
    rows = await list_memories(user.id, archived=True)
    cur = next((m for m in rows if m["id"] == mem_id), None)
    if not cur: raise HTTPException(404, "memory not found")
    new_pinned = not bool(cur.get("pinned"))
    await update_memory(user.id, mem_id, pinned=new_pinned)
    return {"pinned": new_pinned}


@router.delete("/memories/{mem_id}")
async def api_delete_memory(mem_id: int, user: User = Depends(get_current_user)):
    ok = await delete_memory(user.id, mem_id)
    if not ok: raise HTTPException(404, "memory not found")
    return {"ok": True}


@router.post("/memories/clear-all")
async def api_clear_all_memories(user: User = Depends(get_current_user)):
    """用户主动清空全部记忆 (软删除, 不可恢复)."""
    from sqlalchemy import text as sql_text
    async with session_scope() as s:
        r = await s.execute(sql_text(
            "UPDATE user_memories SET archived=TRUE WHERE user_id=:u AND archived=FALSE"),
            {"u": user.id})
        return {"archived": r.rowcount or 0}


# ---- Snippets ----

class SnippetIn(BaseModel):
    content: str = Field(..., min_length=10)
    category: str = "other"
    rating: int = 7
    tags: list[str] | None = None


@router.get("/snippets")
async def api_list_snippets(
    category: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
):
    rows = await list_snippets(user.id, category=category, limit=limit)
    for r in rows:
        if "created_at" in r and r["created_at"] and hasattr(r["created_at"], "isoformat"):
            r["created_at"] = r["created_at"].isoformat()
    return {"items": rows}


@router.post("/snippets")
async def api_create_snippet(payload: SnippetIn, user: User = Depends(get_current_user)):
    sid = await insert_snippet(user.id, content=payload.content, category=payload.category,
                                rating=payload.rating, tags=payload.tags)
    return {"id": sid}


@router.delete("/snippets/{sid}")
async def api_delete_snippet(sid: int, user: User = Depends(get_current_user)):
    ok = await delete_snippet(user.id, sid)
    if not ok: raise HTTPException(404, "snippet not found")
    return {"ok": True}


# ---- Operations ----

class OperationCreateIn(BaseModel):
    conversation_id: int
    message_id: int | None = None
    op_type: str
    target_draft_id: int | None = None
    target_chapter_order: int | None = None
    target_field: str | None = None
    payload: dict
    confidence: float = 0.8


@router.get("/operations")
async def api_list_operations(
    conversation_id: int | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
):
    rows = await list_operations(user.id, conversation_id=conversation_id, status=status, limit=limit)
    for r in rows:
        for k in ("created_at", "expires_at", "applied_at", "rolled_back_at"):
            if k in r and r[k] and hasattr(r[k], "isoformat"):
                r[k] = r[k].isoformat()
    return {"items": rows}


@router.get("/operations/types")
async def api_op_types(user: User = Depends(get_current_user)):
    return {"types": [{"op_type": t, "label": OP_LABEL.get(t, t)} for t in sorted(OP_TYPES)]}


@router.get("/operations/{op_id}")
async def api_get_operation(op_id: int, user: User = Depends(get_current_user)):
    op = await get_operation(op_id, user.id)
    if not op: raise HTTPException(404, "op not found")
    for k in ("created_at", "expires_at", "applied_at", "confirmed_at", "rolled_back_at"):
        if k in op and op[k] and hasattr(op[k], "isoformat"):
            op[k] = op[k].isoformat()
    return op


@router.post("/operations")
async def api_create_operation(payload: OperationCreateIn, user: User = Depends(get_current_user)):
    """前端/AI 主动创建 OperationCard."""
    try:
        op = await create_operation(
            conversation_id=payload.conversation_id, message_id=payload.message_id,
            user_id=user.id, op_type=payload.op_type,
            target_draft_id=payload.target_draft_id,
            target_chapter_order=payload.target_chapter_order,
            target_field=payload.target_field,
            payload=payload.payload, confidence=payload.confidence,
        )
        return op
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))


@router.post("/operations/{op_id}/confirm")
async def api_confirm_operation(op_id: int, user: User = Depends(get_current_user)):
    try:
        return await confirm_operation(op_id, user.id,
                                       getattr(user, "role", None))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/operations/{op_id}/reject")
async def api_reject_operation(op_id: int, user: User = Depends(get_current_user)):
    ok = await reject_operation(op_id, user.id)
    if not ok: raise HTTPException(400, "op not pending")
    return {"ok": True}


@router.post("/operations/{op_id}/rollback")
async def api_rollback_operation(op_id: int, user: User = Depends(get_current_user)):
    try:
        return await rollback_operation(op_id, user.id)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 意图识别 + 抽取触发 ----

class IntentDetectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 见 CreateConvIn

    user_message: str
    conversation_id: int
    current_draft_id: int | None = None


@router.post("/intent/detect")
async def api_detect_intent(payload: IntentDetectIn, user: User = Depends(get_current_user)):
    """用户消息分析: 是否要创建 OperationCard?

    流程: 前端发完消息后调一次, 拿到 intent 决定是否在消息流里渲染卡片.
    若 intent=operation 且 confidence 足够, 后端自动 create_operation 并返回 op 详情.
    """
    ctx = await get_intent_context(user.id, payload.current_draft_id,
                                   getattr(user, "role", None))
    intent = await detect_intent(payload.user_message, ctx)
    out = {"intent": intent}
    if intent.get("intent") == "operation":
        try:
            op = await create_operation(
                conversation_id=payload.conversation_id, message_id=None,
                user_id=user.id,
                op_type=intent.get("op_type"),
                target_draft_id=intent.get("target_draft_id") or payload.current_draft_id,
                target_chapter_order=intent.get("target_chapter_order"),
                target_field=intent.get("target_field"),
                payload=intent.get("payload") or {},
                confidence=float(intent.get("confidence", 0.8) or 0.8),
            )
            for k in ("created_at", "expires_at"):
                if k in op and op[k] and hasattr(op[k], "isoformat"):
                    op[k] = op[k].isoformat()
            out["operation"] = op
        except Exception as e:
            logger.warning("auto create op failed: %s", e)
            out["operation_error"] = str(e)
    return out


@router.post("/conversations/{conv_id}/extract")
async def api_trigger_extraction(conv_id: int, user: User = Depends(get_current_user)):
    """用户主动触发记忆抽取(也用于对话结束后调用)."""
    schedule_extraction(conv_id, user.id)
    return {"scheduled": True}


# ============================================================================
# 文档解析: 让用户在对话工坊上传 .txt/.md/.docx/.pdf, 后端解析为纯文本
# 直接返回文本, 前端把它作为引用块拼到 user message 里.
# 不存数据库, 不存附件元信息, 走最薄的实现, 之后要扩展再说.
# ============================================================================

# 单文件最大 10 MB; 解析后超过 30000 字符会截断.
PARSE_FILE_MAX_BYTES = 10 * 1024 * 1024
PARSE_FILE_MAX_CHARS = 400000  # 提高: 60 集 docx 不再被截断


# ============================================================================
# 对话工坊：图片附件（2026-10-28）
#
# 流程：粘贴/拖拽/点选 → POST /images 上传压缩落盘，拿回 id（此时 message_id=NULL）
#      → 发消息时把 image_ids 一起带上 → 后端在写入用户消息后把这些图绑上去，
#        并只在**这一轮**把图组装进多模态 content 喂给模型。
# 为什么先传后发：图片动辄几 MB，塞进发消息的 JSON 体里会让 SSE 请求迟迟不开始，
# 用户看到的是"点了发送没反应"。先传可以在输入时就并行完成，发送那一下只带 id。
# ============================================================================

@router.post("/images")
async def api_upload_image(
    file: UploadFile = File(...),
    conversation_id: int | None = Form(None),
    user: User = Depends(get_current_user),
):
    """上传一张图片给对话工坊用。返回 {id, filename, width, height, byte_size, url}。"""
    from .images import ALLOWED_MIME, MAX_IMAGE_BYTES, save_image

    mime = (file.content_type or "").lower()
    # 剪贴板粘贴的图常常没有可靠文件名，以 content_type 为准；
    # 但也有浏览器给出空 content_type，退一步看扩展名。
    if mime not in ALLOWED_MIME:
        name = (file.filename or "").lower()
        ext_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}
        mime = next((m for e, m in ext_map.items() if name.endswith(e)), "")
    if mime not in ALLOWED_MIME:
        raise HTTPException(415, "只支持 PNG / JPG / WEBP / GIF / BMP 图片")

    raw = await file.read()
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"图片超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB 上限")

    # 会话归属校验：图片只能挂到自己的会话上
    if conversation_id is not None:
        async with session_scope() as s:
            conv = await s.get(AgentConversation, conversation_id)
            if not conv or conv.user_id != user.id or conv.is_deleted:
                raise HTTPException(404, "会话不存在")

    try:
        info = await save_image(user_id=user.id, raw=raw, filename=file.filename or "image.png",
                                mime=mime, conversation_id=conversation_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001 — PIL 打不开等，要让用户知道而不是 500 无信息
        logger.warning("chat image save failed: %s", e)
        raise HTTPException(400, f"图片无法识别或已损坏：{e}")

    return {**info, "url": f"{_IMAGE_URL_PREFIX}/{info['id']}"}


#: 前端取图的 URL 前缀（挂在本 router 的 /v1/agent 下）
_IMAGE_URL_PREFIX = "/v1/agent/images"


@router.get("/images/{image_id}")
async def api_get_image(image_id: int, user: User = Depends(get_current_user)):
    """取图（只认上传者本人）。

    ⚠️ 必须鉴权：用户截图里常有隐私（聊天记录、后台数据），不能做成谁拿到 id
    都能看的公开静态文件 —— 这一点与草稿封面（/uploads/draft-covers）不同。
    """
    from fastapi.responses import FileResponse
    from .images import IMAGE_DIR
    from ..db.models_phase5 import AgentImage
    async with session_scope() as s:
        row = await s.get(AgentImage, image_id)
        if not row or row.user_id != user.id:
            raise HTTPException(404, "图片不存在")
        stored, mime = row.stored_name, row.mime
    fp = IMAGE_DIR / stored
    if not fp.is_file():
        raise HTTPException(404, "图片文件已丢失")
    return FileResponse(fp, media_type=mime or "image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})


@router.post("/parse-file")
async def api_parse_file(
    file: UploadFile = File(...),
    persist: bool = Form(False),
    conversation_id: int | None = Form(None),
    draft_id: int | None = Form(None),
    user: User = Depends(get_current_user),
):
    """解析 .txt/.md/.docx/.pdf, 返回纯文本.

    返回:
      { "filename", "size", "content", "truncated", "document_id", "chapter_count" }

    ``persist=true``（对话工坊走这条）：**全文入库**，返回里 ``content`` 为空、
    只给 ``document_id`` 与章节数 —— 前端据此在消息里放一行引用即可。
    正文改由后端每轮按需检索注入（见 ``agent/doc_context.py``）。

    为什么必须落盘：整篇原本被拼进 user message，随对话历史进上下文，实测
    40 万字的原文约第 33~35 轮被剪成占位符、第 38 轮彻底滑出窗口，
    模型随后开始自己编 —— 用户报的"40 轮后瞎写"就是这个。
    落盘后它不再进历史，问题从根上消失。

    ``persist=false``（默认）：保持老行为，原样返回 content。
    导入剧本等"本来就要那份全文"的调用方仍走它。
    """
    # 大小校验 (UploadFile 没有 size, 先 spool 一次)
    raw = await file.read()
    if len(raw) > PARSE_FILE_MAX_BYTES:
        raise HTTPException(413, f"文件超过 {PARSE_FILE_MAX_BYTES // 1024 // 1024}MB 上限")
    # 重置一下 file 指针给 parse_file 用 (它会重新 await read())
    await file.seek(0) if hasattr(file, "seek") else None
    # 简单写: 把 raw 包成 SpooledTemporaryFile-like, 直接给现有 parse_file
    # parse_file 在 stages/file_upload.py 接 UploadFile 类型, 它内部走 file.read()
    # 这里我们已经 read 过, 改成手动按后缀分发, 用更稳妥的就地解码
    from ..stages.file_upload import parse_text_file, parse_docx_file, parse_pdf_file, parse_markdown_file

    name = (file.filename or "uploaded").lower()
    # 把 raw 重新塞回一个 fresh UploadFile-like (重建 UploadFile 比较麻烦, 走类型分发 + 临时文件)
    import io
    from starlette.datastructures import UploadFile as StarletteUploadFile
    fresh = StarletteUploadFile(filename=file.filename, file=io.BytesIO(raw))

    try:
        if name.endswith(".txt"):
            content = await parse_text_file(fresh)
        elif name.endswith(".md") or name.endswith(".markdown"):
            content = await parse_markdown_file(fresh)
        elif name.endswith(".docx"):
            content = await parse_docx_file(fresh)
        elif name.endswith(".pdf"):
            content = await parse_pdf_file(fresh)
        else:
            # 兜底: 当作纯文本 utf-8 读, 失败就 latin-1
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                content = raw.decode("latin-1", errors="replace")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("parse-file failed: %s", e)
        raise HTTPException(400, f"解析失败: {e}")

    # ── 落盘路径（对话工坊）：全文入库，正文不再回传 ──
    if persist:
        from .doc_context import save_document
        try:
            info = await save_document(
                user_id=user.id, filename=file.filename or "uploaded",
                content=content, conversation_id=conversation_id, draft_id=draft_id,
            )
        except Exception as e:  # noqa: BLE001 — 落盘失败要显式报错，不能静默降级
            # 这里**不能**回退成"把全文塞回消息"：那正是要修的行为，
            # 静默降级会让用户在不知情的情况下又踩一次"40 轮后瞎写"。
            logger.exception("save_document failed: %s", e)
            raise HTTPException(500, f"文档入库失败，请重试：{e}")
        return {
            "filename": file.filename or "uploaded",
            "size": len(raw),
            "content": "",                 # 正文已入库，不回传
            "truncated": False,            # 全文入库，不存在截断
            "document_id": info["id"],
            "char_count": info["char_count"],
            "chapter_count": info["chapter_count"],
        }

    truncated = False
    if len(content) > PARSE_FILE_MAX_CHARS:
        content = content[:PARSE_FILE_MAX_CHARS]
        truncated = True

    return {
        "filename": file.filename or "uploaded",
        "size": len(raw),
        "content": content,
        "truncated": truncated,
    }


# ============================================================================
# Phase 3: 智能化 - 风格指纹 (基于 user_snippets 自动生成)
# Phase 4: project_series CRUD
# Phase 5: 周度合并去重(手动触发,后续可做 cron)
# ============================================================================
from sqlalchemy import text as _sql
from datetime import datetime, timedelta


# ---- Phase 4: Series ----

class SeriesIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    shared_world: dict | None = None
    shared_characters: list | None = None


@router.get("/series")
async def api_list_series(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(_sql("""
            SELECT id, name, description, shared_world, shared_characters, created_at
            FROM project_series WHERE user_id=:u ORDER BY id DESC LIMIT 100"""),
            {"u": user.id})).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("created_at") and hasattr(d["created_at"], "isoformat"):
            d["created_at"] = d["created_at"].isoformat()
        # 关联草稿数
        async with session_scope() as s2:
            cnt = (await s2.execute(_sql("SELECT COUNT(*) FROM script_drafts WHERE series_id=:s AND user_id=:u"),
                                    {"s": d["id"], "u": user.id})).scalar()
            d["draft_count"] = cnt or 0
        out.append(d)
    return {"items": out}


@router.post("/series")
async def api_create_series(payload: SeriesIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        r = await s.execute(_sql("""
            INSERT INTO project_series (user_id, name, description, shared_world, shared_characters)
            VALUES (:u, :n, :d, :w, :c) RETURNING id"""),
            {"u": user.id, "n": payload.name, "d": payload.description,
             "w": json.dumps(payload.shared_world or {}, ensure_ascii=False),
             "c": json.dumps(payload.shared_characters or [], ensure_ascii=False)})
        return {"id": r.scalar()}


@router.patch("/series/{sid}")
async def api_update_series(sid: int, payload: SeriesIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        r = await s.execute(_sql("""
            UPDATE project_series SET name=:n, description=:d, shared_world=:w, shared_characters=:c
            WHERE id=:i AND user_id=:u"""),
            {"i": sid, "u": user.id, "n": payload.name, "d": payload.description,
             "w": json.dumps(payload.shared_world or {}, ensure_ascii=False),
             "c": json.dumps(payload.shared_characters or [], ensure_ascii=False)})
        if (r.rowcount or 0) == 0:
            raise HTTPException(404, "series not found")
        return {"ok": True}


@router.delete("/series/{sid}")
async def api_delete_series(sid: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        # 解绑草稿
        await s.execute(_sql("UPDATE script_drafts SET series_id=NULL WHERE series_id=:i AND user_id=:u"),
                        {"i": sid, "u": user.id})
        r = await s.execute(_sql("DELETE FROM project_series WHERE id=:i AND user_id=:u"),
                            {"i": sid, "u": user.id})
        if (r.rowcount or 0) == 0:
            raise HTTPException(404, "series not found")
        return {"ok": True}


class AssignSeriesIn(BaseModel):
    draft_id: int
    series_id: int | None = None


@router.post("/series/assign")
async def api_assign_series(payload: AssignSeriesIn, user: User = Depends(get_current_user)):
    """把 draft 关联到 series, series_id=null 表示解绑"""
    async with session_scope() as s:
        if payload.series_id:
            ok = (await s.execute(_sql("SELECT 1 FROM project_series WHERE id=:s AND user_id=:u"),
                                  {"s": payload.series_id, "u": user.id})).scalar()
            if not ok: raise HTTPException(404, "series not found")
        r = await s.execute(_sql("UPDATE script_drafts SET series_id=:s WHERE id=:d AND user_id=:u"),
                            {"s": payload.series_id, "d": payload.draft_id, "u": user.id})
        if (r.rowcount or 0) == 0:
            raise HTTPException(404, "draft not found")
        return {"ok": True}


# ---- Phase 3: 风格指纹 (按需重生 style_summary) ----

@router.post("/profile/regenerate-style")
async def api_regen_style(user: User = Depends(get_current_user)):
    """从用户的 user_snippets 中抽取风格摘要, 写入 user_profile.style_summary."""
    from .memory import list_snippets, update_profile
    from .intent import _parse_json
    from ..models.llm import ainvoke_with_fallback
    snips = await list_snippets(user.id, limit=20)
    if not snips:
        return {"skipped": "no_snippets"}
    sample = "\n\n---\n\n".join(f"[{s.get('category','?')}, 评分{s.get('rating',5)}]\n{(s.get('content') or '')[:500]}"
                                 for s in snips[:10])
    prompt = [
        {"role": "system", "content": "你是写作风格分析师。读完用户的 N 段优秀作品片段, 用一句话总结他的核心风格(50-150 字)。仅输出风格摘要文本, 不要解释。"},
        {"role": "user", "content": sample},
    ]
    try:
        resp = await ainvoke_with_fallback(prompt, role="extract", temperature=0.2, max_tokens=300)
        text = (getattr(resp, "content", "") or "").strip()[:500]
        # 保险丝: 截断的残句不能写进用户画像(风格摘要会长期影响后续生成)
        from ..models.llm import looks_truncated
        if looks_truncated(resp, text, min_len=20):
            logger.warning("regen style: 输出疑似截断(len=%d), 跳过写入画像", len(text))
            return {"failed": True, "reason": "truncated"}
        if text:
            await update_profile(user.id, style_summary=text)
            return {"style_summary": text}
    except Exception as e:
        logger.warning("regen style failed: %s", e)
    return {"failed": True}


# ---- Phase 5: 周度记忆合并去重 ----

@router.post("/memories/consolidate")
async def api_consolidate_memories(user: User = Depends(get_current_user)):
    """合并去重: 同 type 下 cosine > 0.92 的归并; 90 天未访问 + importance<5 + 非 pinned 的归档."""
    from .memory import _cosine
    cutoff = datetime.now() - timedelta(days=90)
    archived_count = 0
    merged_count = 0

    async with session_scope() as s:
        # 1. 归档老旧低重要度 memory
        r = await s.execute(_sql("""
            UPDATE user_memories
            SET archived=TRUE
            WHERE user_id=:u AND archived=FALSE AND pinned=FALSE
              AND importance < 5
              AND (last_accessed_at IS NULL OR last_accessed_at < :c)
              AND created_at < :c"""),
            {"u": user.id, "c": cutoff})
        archived_count = r.rowcount or 0

        # 2. 合并去重 (同 type, embedding cosine > 0.92)
        rows = (await s.execute(_sql("""
            SELECT id, type, content, embedding, importance, hit_count, pinned
            FROM user_memories WHERE user_id=:u AND archived=FALSE
            ORDER BY id"""), {"u": user.id})).mappings().all()
        rows = [dict(r) for r in rows]
        archived_ids = set()
        for i in range(len(rows)):
            if rows[i]["id"] in archived_ids: continue
            for j in range(i+1, len(rows)):
                if rows[j]["id"] in archived_ids: continue
                if rows[i]["type"] != rows[j]["type"]: continue
                e1, e2 = rows[i].get("embedding"), rows[j].get("embedding")
                if not e1 or not e2: continue
                cos = _cosine(list(e1), list(e2))
                if cos > 0.92:
                    # 保留 importance/hit_count 高的, 归档另一条
                    keep, drop = (rows[i], rows[j]) if (rows[i]["importance"], rows[i]["hit_count"]) >= (rows[j]["importance"], rows[j]["hit_count"]) else (rows[j], rows[i])
                    if drop["pinned"]: continue  # pinned 不合并
                    archived_ids.add(drop["id"])
                    merged_count += 1
        if archived_ids:
            await s.execute(_sql("UPDATE user_memories SET archived=TRUE WHERE id = ANY(:ids)"),
                            {"ids": list(archived_ids)})
    return {"archived_old": archived_count, "merged_duplicates": merged_count}


# ---- Phase 3: 用户优秀片段自动入库的 helper (供 chapter_gen 调用) ----

@router.post("/snippets/auto-from-chapter/{draft_id}/{chapter_order}")
async def api_auto_snippet_from_chapter(draft_id: int, chapter_order: int, user: User = Depends(get_current_user)):
    """从指定章节抽取优秀段落, 入 user_snippets. chapter_gen 完成时可调用."""
    from .memory import insert_snippet
    from .intent import _parse_json
    from ..models.llm import ainvoke_with_fallback
    from ..db import ScriptChapter, ScriptDraft

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or d.user_id != user.id: raise HTTPException(403, "permission denied")
        ch = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
        if not ch or not ch.full_text: raise HTTPException(404, "chapter empty")
        # ⚠️ 2026-10-10：不再 `ch.full_text[:8000]`（只喂开头）。
        # 抽"最有特色的片段"要覆盖整章 —— 高潮与金句常在集尾，
        # 只给开头等于永远抽不到。改为保头+保尾，上限按模型窗口算。
        from ..stages.episode_text import clip as _clip
        _cap = 8_000
        try:
            from ..config import get_settings
            from ..stages.text_budget import text_budget_chars
            _cap = text_budget_chars(
                get_settings().llm_generate_model or "", purpose="polish")
        except Exception:  # noqa: BLE001
            pass
        text = _clip(ch.full_text, _cap, keep="both")

    prompt = [
        {"role": "system", "content": """你是创作风格分析助手。读完一章短剧正文, 抽取 1-3 段最有特色的片段(每段 100-300 字)。

输出 JSON: {"snippets": [{"category": "opening|twist|dialogue_witty|climax|other", "content": "原文片段", "reason": "好在哪"}]}

只抽真正有亮点的部分。如果整章平庸, 输出 {"snippets": []}."""},
        {"role": "user", "content": text},
    ]
    try:
        resp = await ainvoke_with_fallback(prompt, role="extract", temperature=0.3, max_tokens=2500)
        data = _parse_json(getattr(resp, "content", "") or "")
        if not data: return {"added": 0}
        added = 0
        for sp in (data.get("snippets") or [])[:3]:
            if not sp.get("content"): continue
            sid = await insert_snippet(user.id, content=sp["content"],
                                        category=sp.get("category", "other"),
                                        rating=8, source_type="chapter", source_id=ch.id)
            if sid: added += 1
        return {"added": added}
    except Exception as e:
        logger.warning("auto snippet failed: %s", e)
        return {"added": 0, "error": str(e)}


# ===========================================================================
# 对话工坊 AI 编排: 长任务（持久化队列）
#
# 与旧的 fire-and-forget 长任务的区别：入队只写一行，执行交给独立 worker，
# 租约+心跳判活，崩溃自动重放。前端轮询进度即可，刷新页面不丢。
# ===========================================================================


class EnqueueJobIn(BaseModel):
    kind: str
    draft_id: int | None = None
    payload: dict = {}


@router.post("/jobs")
async def api_enqueue_job(payload: EnqueueJobIn, user: User = Depends(get_current_user)):
    """入队一个长任务，返回 job_id。立即返回，不阻塞。"""
    from . import chat_jobs, jobs as _jobs
    chat_jobs.register_all()          # 幂等，确保处理器在
    if payload.kind not in _jobs.registered_kinds():
        raise HTTPException(400, f"未知作业类型: {payload.kind}")
    if payload.draft_id is not None:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, payload.draft_id)
            if not d or (d.user_id and d.user_id != user.id
                         and getattr(user, "role", "") not in ("admin", "superadmin")):
                raise HTTPException(404, "草稿不存在")

        # ⚠️ 同一草稿的"重任务"互斥 —— 这里此前**漏了**这道闸门。
        #
        # 设计意图写在 chat_jobs.py 顶部：生成/精修都是**覆写同一批集**的作业，
        # 同一草稿并发跑会互相覆盖（后完成的赢），所以必须硬拦。
        # 但那条规则只在对话工坊（chat_skills）和各业务入口实现了，**这个通用
        # 入队端点没有** —— 于是 `POST /v1/agent/jobs {kind:"gen_outline", draft_id:X}`
        # 成了一条绕过闸门的侧门，同一草稿能被叠加任意多个重任务。
        #
        # 拦在**服务端**而不是靠调用方自觉：这是唯一的收口点，任何客户端
        # （网页、桌面、脚本、以后接入的第三方）都从这里进。
        active = await chat_jobs.has_active_job(payload.draft_id)
        if active:
            raise HTTPException(
                409,
                f"该草稿已有任务在跑（{active}）。生成/精修都会覆写整本，"
                f"同时跑会互相覆盖，所以这次没有启动。等它完成或先取消它。",
            )

    jid = await _jobs.enqueue(
        kind=payload.kind, draft_id=payload.draft_id, user_id=user.id,
        payload=payload.payload or {})
    return {"job_id": jid, "status": "queued"}


@router.get("/jobs")
async def api_list_jobs(draft_id: int | None = Query(None),
                        limit: int = Query(20, ge=1, le=200),
                        user: User = Depends(get_current_user)):
    """列出当前用户的作业（可按草稿过滤）。

    `state` 是每个作业的**唯一进度口径**（排队/进行中/疑似卡住/等你确认/终态），
    见 `job_status.describe`。前端四个状态入口都应当读它，不要再各自拿 status 猜。
    """
    from ..db import AgentJob
    from . import jobs as _jobs
    async with session_scope() as s:
        stmt = select(AgentJob).where(AgentJob.user_id == user.id)
        if draft_id is not None:
            stmt = stmt.where(AgentJob.draft_id == draft_id)
        rows = (await s.execute(
            stmt.order_by(AgentJob.id.desc()).limit(limit))).scalars().all()
        queued_ids = [j.id for j in rows if j.status == "queued"]
        s.expunge_all()
    positions = await _jobs.queue_positions(queued_ids)
    return {"items": [_job_brief(j, queue_position=positions.get(j.id)) for j in rows]}


#: 对照视图单侧文本的截断阈值（字符）。短剧一集正文常在几千字，剧本更长；
#: 一次性把几十集全文塞进浏览器会卡死。超出就截断并标注，用户要全文去草稿页看。
_CHANGE_CHARS = 6000

#: 大纲对照里要摊平的字段 —— **直接取自** check/fixer.py 的 `OUTLINE_EDITABLE_FIELDS`。
#:
#: 2026-10-11：这份表原先是在这里手抄一遍、再用注释声明"必须与那边一致"。
#: 实测两边已经漂移（这边有 hook_in/hook_out、那边有 hook/contract），
#: 而那句注释没有任何东西在强制它成立 —— 抄第二份就是等着再漂一次。
#: 直接从唯一的真值源取，漂移在结构上就不可能发生。
#: 顺序只为展示友好：先基本信息，再契约与钩子。
_OUTLINE_DIFF_ORDER = (
    "title", "synopsis", "must_have", "characters",
    "core_push", "value_shift", "stakes", "escalation",
    "hook_out", "hook_in", "audience_knows_delta", "plant", "payoff", "forbidden",
)
_OUTLINE_DIFF_FIELDS = tuple(
    k for k in _OUTLINE_DIFF_ORDER if k in OUTLINE_EDITABLE_FIELDS)
_OUTLINE_FIELD_LABEL = {
    "title": "标题", "synopsis": "概要", "must_have": "必须有的场面",
    "characters": "出场人物", "stakes": "失败代价", "escalation": "主线推进",
    "core_push": "核心推进点", "audience_knows_delta": "观众认知变化",
    "hook_out": "结尾卡点", "hook_in": "入口钩", "value_shift": "价值转变",
    "plant": "埋设", "payoff": "回收", "forbidden": "禁止项",
}


def _clip(t: str) -> tuple[str, bool]:
    """截断过长文本。返回 (文本, 是否被截断)。"""
    t = t or ""
    if len(t) <= _CHANGE_CHARS:
        return t, False
    return t[:_CHANGE_CHARS], True


async def _job_changes(j, s) -> dict:
    """把**这一次作业**的**改前 / 改后**文本取回来，供前端画左右对照。

    数据来源不是新表 —— 改一集之前都会往 ``script_episode_history`` 写一条历史，
    那就是改前原文。改后文本取当前 ``ScriptChapter.full_text`` / ``ScriptStoryboard.shots_json``。

    只在**最近一次**历史与当前内容确实不同时才认为"这一集被这次作业改过"：
    精修会跳过它认为无需改的集（保持原稿），那种集前后一样，列出来只会让用户以为
    AI 偷懒。判据是文本比较，不是作业的 per_ep_json —— 那个在重放后可能对不上。

    ## 2026-10-11：改成按 job_id 取数（用户甲报"看记录说没有可比对的记录"）

    原实现有三处叠加的错，而且**完全不按作业号区分**：

      WHERE draft_id = ? AND created_by = 'ai_rewrite'
        AND stage IN ('chapter','storyboard') ORDER BY id DESC LIMIT 200

      1. 定点修复写的是 ``created_by='ai_fix'``（见 check/fixer.py 两处），
         只有整本精修才写 ``'ai_rewrite'`` —— 于是修硬伤点开永远说没有记录；
      2. ``structure`` 类问题全走**大纲**路径（``stage='outline'``），不在白名单里；
      3. 没有任何作业维度 —— 同一份草稿上只要留下过 ``ai_rewrite``，
         点**任意**作业都会看到同一份。dev 实测 job #107（只改 1 集大纲）与
         job #110（整本精修 61 集剧本）返回内容的 md5 完全相同。

    现在优先 ``WHERE job_id = ?``（该列由 ``job_context`` 自动注入，见
    ``app/job_context.py``）。**旧作业该列为 NULL**，所以保留一条按
    "作业起止时间 + created_by" 的兜底查询 —— 它在 dev 上已实测能精确圈定
    #107 / #108 / #110（关键是要叠加 created_by：单纯的时间窗会把用户
    在作业跑动期间的手动编辑一起圈进来，实测 #106 的窗口里就混着 2 条 user_edit）。
    """
    from ..db.models import ScriptEpisodeHistory

    draft_id = j.draft_id or 0
    if not draft_id:
        return {"items": [], "total": 0, "changed_total": 0, "job_id": j.id,
                "kind": j.kind, "status": j.status, "result": j.result or {}}

    #: 这两条路径才会写历史：整本精修 → ai_rewrite；定点修复 → ai_fix。
    #: 收在这里是为了让下面的两个查询共用同一份白名单（曾经只写 ai_rewrite，
    #: 是这次事故的第一个根因）。
    WRITERS = ("ai_rewrite", "ai_fix", "ai_deai")
    #: 'outline' 也要 —— structure 类问题全在大纲层（这是事故的第二个根因）。
    STAGES = ("chapter", "storyboard", "outline")

    rows = []
    if j.id:
        rows = (await s.execute(
            select(ScriptEpisodeHistory).where(
                ScriptEpisodeHistory.draft_id == draft_id,
                ScriptEpisodeHistory.job_id == j.id,
                ScriptEpisodeHistory.created_by.in_(WRITERS),
                ScriptEpisodeHistory.stage.in_(STAGES),
            ).order_by(ScriptEpisodeHistory.id.desc()).limit(500)
        )).scalars().all()

    if not rows:
        # 兜底：迁移前的作业没有 job_id。按作业起止时间 + 写入者圈定。
        # 按 kind 映射写入者，避免把"用户在作业跑动期间的手改"混进来。
        by_kind = {
            "fix_script": ("ai_fix",),
            "rewrite_script": ("ai_rewrite",),
            "deai_apply": ("ai_deai",),
            "gen_chapters": ("ai_generate",),
            "gen_storyboards": ("ai_generate",),
        }.get(str(j.kind or ""), WRITERS)
        lo = j.created_at
        hi = j.updated_at or j.created_at
        if lo:
            rows = (await s.execute(
                select(ScriptEpisodeHistory).where(
                    ScriptEpisodeHistory.draft_id == draft_id,
                    ScriptEpisodeHistory.created_by.in_(by_kind),
                    ScriptEpisodeHistory.stage.in_(STAGES),
                    ScriptEpisodeHistory.created_at >= lo,
                    ScriptEpisodeHistory.created_at <= hi,
                ).order_by(ScriptEpisodeHistory.id.desc()).limit(500)
            )).scalars().all()

    # 每 (stage, ep) 只取**最新**一条：再精修一次时旧的那条是上一轮的历史，
    # 拿它当"原文"会把两轮之间的改动混进来。
    seen: set[tuple[str, int]] = set()
    picks: list[ScriptEpisodeHistory] = []
    for r in rows:
        k = (str(r.stage), int(r.episode_order or 0))
        if k in seen:
            continue
        seen.add(k)
        picks.append(r)

    chapters = {c.chapter_order: c for c in (await s.execute(
        select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
    )).scalars().all()}
    boards = {b.chapter_order: b for b in (await s.execute(
        select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
    )).scalars().all()}
    #: 大纲集号 → 当前那一集的 dict。structure 类问题的修复落在这里
    #: （见 check/fixer.py:_fix_outline_episode），所以对照也需要它。
    draft_row = await s.get(ScriptDraft, draft_id)
    outline = (draft_row.outline if draft_row else None) or {}
    outline_eps = {
        int(e.get("order") or 0): e
        for e in (outline.get("chapters") or outline.get("episodes") or [])
        if isinstance(e, dict)
    }

    def _outline_text(x) -> str:
        """把大纲里一集摊成可读文本，只取**修复能改的那些字段**。

        ⚠️ 只按 `_OUTLINE_DIFF_FIELDS`（= check/fixer.py 的 `OUTLINE_EDITABLE_FIELDS`）
        列字段，不是把整集 JSON 倒出来。两个理由：整集 dump 会把 synopsis 这类长文
        连同字符数一起算进 before_chars/after_chars，"改了几个字"的观感被淹没；
        而且白名单外的键（version/locked 等内部字段、beats/power 等导演层字段）
        不是这次作业能改的东西，摆出来只会让人以为被改了。字典/列表值按 JSON
        渲染，保持可读。
        """
        import json as _json
        if not isinstance(x, dict):
            return ""
        out = []
        for k, v in x.items():
            if k not in _OUTLINE_DIFF_FIELDS or v in (None, "", [], {}):
                continue
            label = _OUTLINE_FIELD_LABEL.get(k, k)
            if isinstance(v, (dict, list)):
                out.append(f"{label}：{_json.dumps(v, ensure_ascii=False)}")
            else:
                out.append(f"{label}：{v}")
        return "\n".join(out).strip()

    def _board_text(x) -> str:
        """把分镜 JSON 摊成可读文本（每场：场景/人物/台词各一行）。"""
        shots = x if isinstance(x, list) else []
        out = []
        for i, sh in enumerate(shots, start=1):
            if not isinstance(sh, dict):
                out.append(f"{i}. {sh}")
                continue
            head = (sh.get("scene") or sh.get("location")
                    or sh.get("slug") or f"第{i}场")
            out.append(f"{i}. {head}")
            if sh.get("characters"):
                cs = sh["characters"]
                out.append("   人物：" + ("、".join(map(str, cs)) if isinstance(cs, list) else str(cs)))
            if sh.get("action"):
                out.append("   " + str(sh["action"]))
            # ⚠️ `dialogue` 的**规范形态是字符串**（多句台词以 "\n" 连接），
            # 由 `rewrite/parser.py:_split_dialogue` 写出，前端与导出（export_docx.py
            # 的 `.split("\n")`）都按这个读。这里原先写的是
            # `for d in (sh.get("dialogue") or [])` —— 对字符串就是**逐字符迭代**，
            # 于是「改前/改后对照」里一个字一行，整面板糊成竖条。
            # （2026-10-07 用户在对照浮层里发现。）
            # 数组形态是历史/兼容数据，一并支持，别再退回逐字符。
            dlg = sh.get("dialogue")
            if isinstance(dlg, str):
                for ln in dlg.split("\n"):
                    if ln.strip():
                        out.append("   " + ln.strip())
            else:
                for d in (dlg or []):
                    if isinstance(d, dict):
                        out.append(f"   {d.get('speaker') or d.get('who') or ''}：{d.get('text') or d.get('line') or ''}")
                    else:
                        out.append(f"   {d}")
        return "\n".join(out).strip()

    items = []
    for r in picks:
        ep = int(r.episode_order or 0)
        if r.stage == "chapter":
            before = str((r.content or {}).get("full_text") or "")
            cur = chapters.get(ep)
            after = str(getattr(cur, "full_text", "") or "")
            stage_label = "正文"
        elif r.stage == "outline":
            # 大纲历史存的是**整集 dict**（见 fixer._fix_outline_episode 的
            # snapshot_in），当前值要从 draft.outline 里按集号取 —— 它不在
            # ScriptChapter / ScriptStoryboard 里。
            before = _outline_text(r.content)
            after = _outline_text(outline_eps.get(ep))
            stage_label = "大纲"
        else:
            before = _board_text(r.content if isinstance(r.content, list)
                                 else (r.content or {}).get("shots"))
            cur = boards.get(ep)
            after = _board_text(getattr(cur, "shots_json", None))
            stage_label = "剧本"
        if not before and not after:
            continue
        b, bt = _clip(before)
        a, at = _clip(after)
        items.append({
            "episode": ep, "stage": r.stage, "stage_label": stage_label,
            "before": b, "after": a,
            "before_chars": len(before), "after_chars": len(after),
            "truncated": bool(bt or at),
            "changed": before.strip() != after.strip(),
        })

    items.sort(key=lambda x: (x["stage"], x["episode"]))
    return {"items": items, "total": len(items),
            "changed_total": sum(1 for x in items if x["changed"]),
            "job_id": j.id, "kind": j.kind, "status": j.status,
            "result": j.result or {}}


@router.get("/jobs/{job_id}/changes")
async def api_job_changes(job_id: int, user: User = Depends(get_current_user)):
    """一次精修作业「哪几集、改前什么样、改后什么样」。

    前端拿它画左右对照文本块（用户明确要求的形式：左边原文、右边改后）。
    为什么要单独一个接口而不是塞进 /jobs/{id}：对照文本动辄几十万字，
    轮询接口每 3 秒拉一次会把浏览器拖死 —— 只在终态拉一次。
    """
    from ..db import AgentJob
    async with session_scope() as s:
        j = await s.get(AgentJob, job_id)
        if not j or (j.user_id and j.user_id != user.id
                     and getattr(user, "role", "") not in ("admin", "superadmin")):
            raise HTTPException(404, "作业不存在")
        if j.kind not in ("rewrite_script", "fix_script", "gen_chapters", "gen_storyboards", "deai_apply"):
            return {"items": [], "total": 0, "changed_total": 0,
                    "job_id": j.id, "kind": j.kind, "status": j.status,
                    "result": {}, "note": "这类作业没有改前/改后对照"}
        return await _job_changes(j, s)


@router.get("/jobs/{job_id}")
async def api_get_job(job_id: int, user: User = Depends(get_current_user)):
    """查作业进度/结果。前端轮询这个。

    `state.phase` 是判活唯一口径（见 `job_status.describe`）——前端不要再自己
    拿 status 判断"在跑还是卡死"，尤其是 `running` + 心跳过期那种情况。
    """
    from ..db import AgentJob
    from . import jobs as _jobs
    async with session_scope() as s:
        j = await s.get(AgentJob, job_id)
        if not j or (j.user_id and j.user_id != user.id
                     and getattr(user, "role", "") not in ("admin", "superadmin")):
            raise HTTPException(404, "作业不存在")
        pos = (await _jobs.queue_positions([j.id])).get(j.id) if j.status == "queued" else None
        s.expunge(j)
    return _job_detail(j, queue_position=pos)


@router.post("/jobs/{job_id}/cancel")
async def api_cancel_job(job_id: int, user: User = Depends(get_current_user)):
    """取消作业。执行中的作业会在下次心跳时发现租约丢失而停止。"""
    from ..db import AgentJob
    async with session_scope() as s:
        j = await s.get(AgentJob, job_id)
        if not j or (j.user_id and j.user_id != user.id
                     and getattr(user, "role", "") not in ("admin", "superadmin")):
            raise HTTPException(404, "作业不存在")
        if j.status in ("done", "failed", "canceled"):
            return {"job_id": job_id, "status": j.status, "note": "作业已结束"}
        j.status = "canceled"
        j.lease_owner = None
        j.lease_expires_at = None
        # 精修的取消必须**传导到 RewriteJob**，否则取消是假的(2026-09-16 实测)：
        # `rewrite.service.run_rewrite` 收到的是 RewriteJob.id，它轮询的
        # `_is_canceled` 查的也是 `RewriteJob.status`；而这里只改 AgentJob.status。
        # 两张表——取消写一张、循环看另一张，于是接口返回 canceled、精修照样把
        # 40 集全覆写完。精修是覆写操作，"以为停住了其实没停"的代价是数据被改。
        if j.kind == "rewrite_script":
            rj_id = int((j.result or {}).get("rewrite_job_id") or 0)
            if rj_id:
                from ..db import RewriteJob
                rj = await s.get(RewriteJob, rj_id)
                if rj and rj.status not in ("done", "failed", "canceled"):
                    rj.status = "canceled"
        await s.flush()
    return {"job_id": job_id, "status": "canceled"}


def _job_brief(j, *, queue_position: int | None = None) -> dict:
    # error / finished_at 是状态栏要的: "上次任务失败提示"必须能显示失败原因,
    # 否则用户只看到一个"failed"字样, 还得自己去找日志。
    # progress_note 已有, 但没有 error 时它就是空的。
    #
    # ⚠️ `state` 是本接口唯一被允许用来判断"在跑/排队/卡死"的字段（2026-10-24）。
    # 此前四个界面各自拿 status 猜 —— queued 和 running 在它们眼里都是"在跑"，
    # 而 running 但心跳没了也判不出来。口径统一在 job_status.describe()。
    from .job_status import describe
    # 真正开跑的时刻存在 payload['_started_at']（epoch 秒），见 jobs.claim_one。
    # 拿不到就退回 created_at —— 那时 ETA 会偏大（把排队时间也算进去），
    # 但比不给强，且只在**老作业**（改造前入的队）上出现。
    started = None
    _raw = (j.payload or {}).get("_started_at") if isinstance(j.payload, dict) else None
    if _raw:
        try:
            from datetime import datetime as _dt, timezone as _tz
            started = _dt.fromtimestamp(float(_raw), _tz.utc).replace(tzinfo=None)
        except (TypeError, ValueError, OSError):
            started = None
    st = describe(status=j.status, progress=j.progress, progress_note=j.progress_note,
                  heartbeat_at=getattr(j, "heartbeat_at", None), created_at=j.created_at,
                  started_at=started, attempt=getattr(j, "attempt", None),
                  queue_position=queue_position)
    return {"id": j.id, "kind": j.kind, "status": j.status,
            "draft_id": j.draft_id, "progress": j.progress,
            "progress_note": j.progress_note,
            "error": (j.error or "")[:500] if j.error else None,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
            "state": st}


def _job_detail(j, *, queue_position: int | None = None) -> dict:
    d = _job_brief(j, queue_position=queue_position)
    d.update({
        "result": j.result or {}, "error": j.error,
        "attempt": j.attempt, "max_attempts": j.max_attempts,
        "heartbeat_at": j.heartbeat_at.isoformat() if j.heartbeat_at else None,
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
    })
    return d
