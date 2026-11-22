"""整本 AI 精修 —— 作业执行。

流程:
  1. 读整部剧本(优先 storyboard, 无则 chapter), 序列化成纯文本。
  2. 两轮同上下文调 LLM: 分析 → 按分析精修(重发全文防遗忘)。
  3. 把精修后的整本文本按"第N集"边界切回每集, 分镜稿再用 parser 拆回 shots_json。
  4. 整本校验(集数/场数一致); 通过才逐集存 History 并整本覆写, 否则整本失败不覆写。

可靠性铁律: 要么整本成功覆写、要么整本不动。绝不部分覆写导致上下集断裂。
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope, ScriptStoryboard, ScriptChapter
from ..db.models import RewriteJob
from ..models.catalog import sanitize_provider_spec
from ..models.llm import get_llm, finish_reason_of
from .parser import (serialize_episode, parse_episode, roundtrip_equivalent,
                     _RE_SCENE, _RE_TIMELOC, _RE_CHARS, _RE_DIALOGUE)
from .prompts import (SYSTEM_PROMPT, ANALYZE_PROMPT, REWRITE_PROMPT,
                      REWRITE_BATCH_PROMPT, USER_GUIDANCE_TMPL,
                      system_prompt_for, analyze_prompt_for,
                      rewrite_prompt_for, rewrite_batch_prompt_for)

logger = logging.getLogger("rewrite.service")

_RE_EP_HEAD = re.compile(r"^第\s*(\d+)\s*集")


def _now_naive() -> datetime:
    """库列是 naive UTC（与 jobs.py 同一口径），写入前一律转成 naive。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


#: 心跳间隔。取 30 秒（与 agent 队列的 HEARTBEAT_INTERVAL 一致）。
HEARTBEAT_SECONDS = 30

#: 判活窗口：超过这么久没心跳即认定持有者已死。必须**明显大于** HEARTBEAT_SECONDS
#: —— 单次长 LLM 调用（第一轮整本诊断动辄几分钟）期间只有心跳在跑，窗口太紧会把
#: 正常的作业误判成僵尸，那比不回收更糟（用户眼睁睁看着跑了一半的作业被标记失败）。
REWRITE_STALE_SECONDS = 180

#: 回收时给用户的交代。不谎称"已完成"，也不说"失败了"——它其实是**被中断**，
#: 原稿按精修铁律保持不动（要么整本覆写、要么整本不动）。
REAP_ERROR = ("该精修作业在 180 秒内没有任何进展（服务重启或进程中断），"
              "已判定为中断。按精修铁律，没跑完就不会覆写草稿，原稿保持原样。")

#: 第二轮分批精修: 每批集数。整本一次输出会超 token 上限被截断(50集全丢),
# 故按批(连续集)分别精修, 每批输出量可控。诊断清单整本一次生成后, 每批都带上以保跨集一致。
_BATCH_SIZE = 6

# ===== 批次缺集: 重试 + 留证据(2026-10-07 事故) =====
#
# 事故: prod 草稿 2409「同事请客…」的一次精修, 报告写 `total=61 / finished=51`,
# **10 集一字未动**(3,4,5,6 与 31-36)。内部原因写的是"模型未返回该集, 保持原稿"。
# 后果特别阴: 诊断清单里**点名了**第 3 集的中秋矛盾、第 31-36 集的残留小标题,
# 而这 10 集**恰好就是没被改的那批** —— 用户看到"优化建议"与"实际改动"对不上。
#
# 查全库 rewrite_jobs: 出现跳过的作业共 8 个, **几乎每次都是连续 6 集整块消失**
# (job 86/73: 19-24; job 59: 2-6; job 13: 8-12; job 92: 3-6 与 31-36),
# 跨草稿复现。同草稿更早的 job 88 却是 61/61 全成功 —— 上游响应不稳定, 不是固定坏。
#
# 病灶是当时的处理策略: 响应缺集 → 直接判 skipped、不重试、不失败, 作业照写 done
# (下面原注释还写着"不能因此整本作废", 那是把"不要整本失败"错做成了"默默少改几集")。
# 精修是**覆写**操作, 少改几集用户看不出来 —— 必须重试, 且必须留下证据。
#
# ⚠️ 重试只补"这一批缺失的集", 不改 _BATCH_SIZE、不加并发(并发数铁律)。
_BATCH_RETRY = 2

#: 证据里单批原始响应最多存多少字。只为事后定位"哪一批掉了、掉的那段长什么样",
#: 不是归档全文; 超长截断并置 raw_truncated 标记。
_EVIDENCE_CHARS = 40000

# ===== 尾巴退化防治(见 docs/PLAN-对话工坊-v3-体检修复.md §一/§2.2) =====
#
# 病灶: 分批精修时, 第 35 集那一批只看得到第一轮的**诊断清单**, 看不到第 30 集
# **改完之后的真实文本**。而诊断清单是"评论文本"不是"剧本文本" —— 模型据此无法
# 得知前面几批实际写了什么新东西(新改的人名写法、新出现的场景、固定的开场节奏),
# 于是后面的批次只能各自发挥, 越往后越飘。这不是模型能力问题, 是上下文投喂问题。
#
# 因此给批次之间补两条**跨批传递通道**:
#   · prev_tail —— 上一批**真实产出文本的尾部**(不是摘要、不是诊断), 原样给下一批看。
#     模型对"真实的文本"比"对文本的评论"敏感得多, 看到真实尾句就会自然接上去。
#   · prev_digest —— 从前面各批实际产出里**用代码抽出来的新词台账**(零 LLM):
#     新增出场人名 / 场景地点 / 每批开场首句(节奏样本)。给的是事实清单, 不是评论。
#
# ⚠️ _BATCH_SIZE 保持不动(并发数铁律): 批间本来就串行, 本次只加"传递内容", 不加并发、
# 不改批大小。治尾巴靠"把上文喂对", 不靠"改并发"。
_TAIL_CHARS = 1500          # 上一批真实文本尾巴的截取长度
_DIGEST_MAX_NAMES = 24      # 新词台账: 最多记多少人名
_DIGEST_MAX_PLACES = 16     # 最多记多少地点
_DIGEST_TAIL_NOTES = 6      # 最多保留几批的开场样本(只留近几批, 防台账自己膨胀)

#: 每批抽一次"开场样本", 累积进 prev_digest —— 让后面的批次知道前面的开场是什么节奏。
_DIGEST_HEAD_LINES = 2

#: 从诊断清单里认集号: 支持 `[第12/18/30集]` 这种跨集写法(要求上一轮 prompt 已强制带集号)
_RE_ANCHOR_NUMS = re.compile(r"第\s*([0-9]+(?:\s*[/、,，]\s*[0-9]+)*)\s*集")


#: scope.target 的合法值。'chapter' = 改正文/原文, 'storyboard' = 改剧本(分镜)。
#: ⚠️ **刻意没有 'auto'** —— 2026-10-06 用户裁定: 改哪一层必须由用户说了算。
#: 此前后端按"有剧本就整本按剧本"偷偷决定, 用户圈 31-40 集想改正文,
#: 实际去剧本表找、找不到就整批失败, 而他根本不知道系统替他选了层。
VALID_TARGETS = ("chapter", "storyboard")

#: 人话层名, 用于所有面向用户的文案。
_TARGET_LABEL = {"chapter": "正文/原文", "storyboard": "剧本"}


class ScopeMiss(ValueError):
    """用户圈的精修范围与草稿实际集号无交集。

    单独一个异常类型(不复用 ValueError)是为了让 ``run_rewrite`` 能把它判成
    "用户输入问题 → 作业 failed + 人话提示", 而不是当成代码 bug 抛给队列重试:
    重试也只会再撞一次同样的空范围。
    """


class TargetMiss(ValueError):
    """用户指定了改哪一层(target), 但那一层的**赋值本身**不合法。

    与 ScopeMiss 分开是因为失败点不同: ScopeMiss 是"层选对了、只是这几集没有",
    TargetMiss 是"根本没选出一个能用的层"。两者都要 fail + 人话提示、
    都不能静默换层, 但提示文案不一样。

    ⚠️ 关键是**不能回落到另一层**。旧的 `_norm_scope` 对一切非法形状都宽容地
    "当作整本", 那是为了不因为一个畸形范围就报 400; 但 target 不同 ——
    回落到任何默认层都是**背着用户改他没要的那一份稿子**, 是覆写操作,
    代价不可逆。所以这里必须硬失败。
    """


def _norm_scope(scope) -> tuple[int | None, int | None]:
    """scope 归一。合同: {"start_ep": int|null, "end_ep": int|null, "target": str}。

    集数部分: 任何非法值(字符串、负数、缺字段、两端反了)一律**不报错**, 直接当作"整本"。
    理由: 用户圈了个范围是想拿到结果, 不是为了收到一个 400。

    ⚠️ 但"两端都给了、只是落在实际集之外"**不**走这条宽容路线 ——
    那由 ``_load_episodes`` 抛 ``ScopeMiss`` 拒绝。区别在于: 这里宽容的是
    *形状*不合法(读不出范围 → 用户没有有效意图 → 按整本), 那里拒绝的是
    *范围*明确但无内容可改(用户有明确意图 → 静默改成整本等于背着用户扩大覆写面)。

    target 不在这里校验 —— 见 ``_norm_target``, 它要能独立失败。
    """
    if not isinstance(scope, dict):
        return None, None
    def _int(v):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None
    a, b = _int(scope.get("start_ep")), _int(scope.get("end_ep"))
    if a and b and a > b:
        a, b = b, a
    return a, b


def _norm_target(scope, *, default: str | None = "storyboard") -> str:
    """从 scope 里读 target, 返回 'chapter' 或 'storyboard'。

    非法的 target 值**抛 TargetMiss**, 不回落到任何层(理由见 TargetMiss 的 docstring)。

    default: 完全没传 target 时用什么。**只给非用户路径用** ——
      · 对话工坊动作栏 / 任何用户入口: 必须传 `default=None`, 缺了就是报错,
        因为"没传"就等于"让后端替用户选层", 正是这次要消灭的行为;
      · 旧调用方(超级 Agent 的 start_rewrite 技能、/v1/rewrite 独立端点、
        队列重放的历史作业): 它们历史上就是"有剧本按剧本", 传 'storyboard'
        保持逐字一致, 不因为加了新字段就改变老路径的行为。
    """
    raw = scope.get("target") if isinstance(scope, dict) else None
    t = (str(raw).strip().lower() if raw is not None else "")
    if not t:
        if default is None:
            raise TargetMiss(
                "没说要改哪一层。请选「改正文」或「改剧本」再发起精修。"
            )
        return default
    if t not in VALID_TARGETS:
        raise TargetMiss(
            f"改哪一层传了个不认识的值（{t!r}），只能是 "
            + " 或 ".join(f"「{k}」" for k in VALID_TARGETS)
            + "。为避免改错稿子，这次没有执行。"
        )
    return t


def _scope_label(scope) -> str:
    """范围的人话标签。带宽了层级的情况, 让作业记录和提示里能看出改的是哪一份。"""
    a, b = _norm_scope(scope)
    if not a and not b:
        base = "整本"
    elif a and b:
        base = f"第{a}-{b}集"
    else:
        base = f"第{a}集起" if a else f"到第{b}集"
    # 这里故意**不抛** TargetMiss: label 也会被用在错误提示里(那时 target 可能正是不合法的),
    # 让一个提示函数自己抛异常会把原始错误盖掉。读不出就只报范围。
    raw = scope.get("target") if isinstance(scope, dict) else None
    t = str(raw).strip().lower() if raw is not None else ""
    if t in _TARGET_LABEL:
        return f"{base}·{_TARGET_LABEL[t]}"
    return base


def _filter_analysis_by_scope(analysis: str, eps: list) -> str:
    """只保留与本次要改的集相关的大纲诊断条目。

    不相关的问题条目不发给这一批 —— 否则模型会顺着清单去改范围外的情节
    (范围外那些集这次根本不会覆写, 改了也是白改, 还容易被诱导加戏)。
    无法识别集号的条目(承接句、总述)保留, 它们提供上下文。
    """
    keep = {int(e[0]) for e in eps}
    out: list[str] = []
    for ln in (analysis or "").split("\n"):
        nums = {int(x) for part in _RE_ANCHOR_NUMS.findall(ln)
                for x in re.split(r"[/、,，]", part) if x.strip()}
        if not nums or (nums & keep):
            out.append(ln)
    return "\n".join(out).strip()


def _collect_new_terms(piece: str, seen_names: set, seen_places: set) -> tuple[list, list]:
    """从一批真实产出里抽出**新出现**的人名与地点(纯代码, 零 LLM)。

    人名 = 对白行冒号前的说话人前缀; 地点 = `景:` 行。只记"这一批之前从没见过"的,
    所以台账天然是增量, 不会每批重复灌同一批名字。
    """
    new_names, new_places = [], []
    for raw in (piece or "").split("\n"):
        ln = raw.strip()
        if not ln:
            continue
        m = _RE_TIMELOC.match(ln)
        if m:
            place = m.group(1).strip()[:24]
            if place and place not in seen_places:
                seen_places.add(place)
                new_places.append(place)
            continue
        if ln[0] in "△【（(第" or _RE_SCENE.match(ln) or _RE_CHARS.match(ln):
            continue
        m = _RE_DIALOGUE.match(ln)
        if m:
            name = m.group(1).strip()
            # 单字/超长的不当人名(单字多为误切, 超长多半是动作行没被认出来)
            if 1 < len(name) <= 8 and name not in seen_names:
                seen_names.add(name)
                new_names.append(name)
    return new_names, new_places


def _head_sample(piece: str) -> str:
    """取这一批开场的前两行, 作为"开场节奏样本"。"""
    lines = [l.strip() for l in (piece or "").split("\n") if l.strip()]
    return " / ".join(lines[:_DIGEST_HEAD_LINES])[:120]


async def _load_episodes(draft_id: int, scope=None, target: str | None = None):
    """返回 (kind, [(ep, title, shots_or_none, full_text_or_none)])。

    target: 'chapter' | 'storyboard' —— **用户要改哪一层**。
      · 给了就按它取表, 那一层没有内容 → 抛 ``TargetMiss``, **绝不回落到另一层**;
      · 没给(None)走旧的"有剧本就按剧本"存在性单选, 供超级 Agent 技能 /
        /v1/rewrite 独立端点等历史路径保持逐字一致。

    ⚠️ 2026-10-06 改: 以前层是**隐式**定的 —— `if sbs:` 只要存在任意一集剧本,
    整本就按剧本。用户圈 31-40 集想改正文, 系统去剧本表找、找不到就整批失败,
    而他完全不知道系统替他选了层。现在由用户显式指定(见 VALID_TARGETS)。

    scope: ``{"start_ep": int|null, "end_ep": int|null}``。给定时只返回范围内的集 ——
    这是"只精修第 10-20 集"能真正省下 LLM 开销的地方(旧版永远读整本)。

    范围与草稿实际集号**完全无交集**时抛 ``ScopeMiss``, 不再退回整本。
    2026-09-16 实测事故: 对 50 集的草稿发 ``{"start_ep":51,"end_ep":51}``(第 51 集
    只有正文、还没生成剧本), 旧版"退回整本"把**全部 50 集剧本覆写了一遍**, 作业记录
    还写成"精修完成(第51-51集), 覆写 50 集"——用户圈 1 集、实际改 50 集。
    精修是覆写操作, 把范围静默放大是不可接受的; 同文件 chat_jobs 也写着
    "用户圈的范围被无声放大, 这是不可接受的"。部分交集仍照常处理(取交集)。
    """
    async with session_scope() as s:
        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()

        if target == "storyboard":
            kind = "storyboard"
            eps = [(int(sb.chapter_order), "", sb.shots_json or [], None) for sb in sbs]
            if not eps:
                # 用户明确要改剧本, 但一集都没有。**不回落正文** —— 回落等于
                # 改了他没要的那份稿子。列出现状让他改选或先生成。
                raise TargetMiss(
                    "你要改的是「剧本」，但这部下还没有生成过剧本。"
                    "先在右侧切到「剧本」页签点生成，或改选「正文」。"
                )
        elif target == "chapter":
            kind = "chapter"
            eps = [(int(ch.chapter_order), ch.title or "", None, ch.full_text or "")
                   for ch in chs if (ch.full_text or "").strip()]
            if not eps:
                raise TargetMiss(
                    "你要改的是「正文」，但这部下还没有正文内容。"
                    "先在上方点「补全正文」，或改选「剧本」。"
                )
        elif sbs:
            # 老路径: 没指定 target。保持历史行为(有剧本按剧本)逐字不变。
            kind = "storyboard"
            eps = [(int(sb.chapter_order), "", sb.shots_json or [], None) for sb in sbs]
        else:
            kind = "chapter"
            eps = [(int(ch.chapter_order), ch.title or "", None, ch.full_text or "") for ch in chs]

    a, b = _norm_scope(scope)
    if a or b:
        picked = [e for e in eps if (not a or e[0] >= a) and (not b or e[0] <= b)]
        if picked:
            return kind, picked
        have = [e[0] for e in eps]
        rng = (f"第{min(have)}-{max(have)}集" if have else "无")
        logger.warning("draft %s scope %s 与实际集号(%s)无交集, 拒绝执行", draft_id, scope, rng)
        raise ScopeMiss(
            f"你圈的范围（{_scope_label(scope)}）在这部剧里没有可精修的集。"
            f"当前有{('剧本' if kind == 'storyboard' else '正文')}的是{rng}。"
            f"请把范围改到这个区间内，或先把那几集生成出来。"
        )
    return kind, eps


def _serialize_eps(kind: str, eps: list) -> str:
    """把这批集序列化为纯文本。storyboard 走 parser; chapter 直接用集标题+正文。"""
    blocks = []
    for ep, title, shots, full_text in eps:
        if kind == "storyboard":
            blocks.append(serialize_episode(shots or [], ep=ep, title=title))
        else:
            head = f"第{ep}集" + (f" {title}" if title else "")
            blocks.append(head + "\n\n" + (full_text or ""))
    return "\n\n".join(blocks)


#: 兼容旧调用名(整本 = 全部集)
_serialize_full = _serialize_eps


def _split_full_by_episode(text: str) -> dict[int, str]:
    """把整本精修文本按"第N集"边界切成 {ep: 该集文本(含集标题行)}。"""
    lines = (text or "").split("\n")
    out: dict[int, str] = {}
    cur_ep: int | None = None
    buf: list[str] = []

    def _flush():
        if cur_ep is not None:
            out[cur_ep] = "\n".join(buf).strip()

    for ln in lines:
        m = _RE_EP_HEAD.match(ln.strip())
        if m:
            _flush()
            cur_ep = int(m.group(1))
            buf = [ln]
        else:
            if cur_ep is not None:
                buf.append(ln)
    _flush()
    return out


async def _update_job(job_id: int, **fields) -> None:
    """更新改写作业。

    ⚠️ 每次更新都顺带刷新 ``heartbeat_at``：这既是"作业还活着"的唯一依据，
    也保证了正常路径（换阶段、每批精修、写终态）永远不会被误判成僵尸。
    判活与回收见 chat_jobs.has_active_job / reap_stale_rewrite_jobs。
    """
    async with session_scope() as s:
        job = await s.get(RewriteJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        for jkey in ("per_ep_json", "summary_json", "batch_evidence"):
            if jkey in fields:
                flag_modified(job, jkey)
        job.heartbeat_at = _now_naive()


async def touch_rewrite_heartbeat(job_id: int) -> None:
    """只刷心跳，不改其它字段。给心跳循环用。"""
    async with session_scope() as s:
        job = await s.get(RewriteJob, job_id)
        if job:
            job.heartbeat_at = _now_naive()


async def _heartbeat_loop(job_id: int, stop: asyncio.Event) -> None:
    """执行期间周期性刷心跳，直到 ``stop`` 被置位。

    必须**独立于进度回调**：``progress`` 只在"换阶段/换批次"时被调，而第一轮
    整本诊断是一次几分钟的长 LLM 调用，中间没有任何回调 —— 只靠 progress 刷心跳
    的话，那几分钟里作业看起来就是死的。

    自身异常一律吞掉：心跳失败不该把正在跑的精修带崩（它只是判活依据，
    真正的产出走 _update_job）。作业被删/不存在时静默退出。
    """
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_SECONDS)
            return          # stop 被置位
        except asyncio.TimeoutError:
            pass
        if stop.is_set():
            return
        try:
            await touch_rewrite_heartbeat(job_id)
        except Exception as ex:  # noqa: BLE001
            logger.warning("rewrite job %d 心跳刷新失败: %s", job_id, ex)


async def _is_canceled(job_id: int) -> bool:
    async with session_scope() as s:
        job = await s.get(RewriteJob, job_id)
        return bool(job and job.status == "canceled")


def _strip_fence(text: str) -> str:
    t = re.sub(r"^```[a-zA-Z]*\s*", "", (text or "").strip())
    return re.sub(r"\s*```$", "", t).strip()


async def _analyze(script_text: str, provider: str, guidance: str = "",
                   kind: str = "storyboard") -> str:
    """第一轮: 整本通读诊断, 返回问题清单。

    guidance: 用户额外给的参考意见(对话工坊「自动精修」模式下用户发的那句话)。
      有值时追加到诊断请求末尾, 让诊断清单优先覆盖用户点名的问题。

    kind: 'storyboard' | 'chapter' —— 决定用哪套模板。
      ⚠️ 正文与剧本的**格式铁律完全不同**(剧本要保 场:/景:/△, 正文要保散文体、
      且明确禁止被改成剧本)。以前只有一个剧本版模板, 正文路径在错用它。
    """
    llm = get_llm("rewrite", temperature=0.3, provider=provider, max_tokens=8192)
    req = analyze_prompt_for(kind).format(script=script_text)
    if guidance.strip():
        req += "\n\n" + USER_GUIDANCE_TMPL.format(guidance=guidance.strip())
    resp = await llm.ainvoke([
        SystemMessage(content=system_prompt_for(kind)),
        HumanMessage(content=req),
    ])
    return (getattr(resp, "content", None) or "").strip()



async def _rewrite_batches(
    kind: str, eps: list, analysis: str, provider: str, guidance: str = "",
    progress=None, job_id: int | None = None,
) -> str:
    """第二轮: 按批(每 _BATCH_SIZE 集)精修, 拼回整本。

    整本一次输出会超 token 上限导致 50 集全被截断(输出里一个"第N集"都切不出),
    故按连续集分批, 每批独立调用; 每批都带上第一轮的全剧诊断清单以保跨集一致。
    批间串行(不改并发)。

    guidance 同样每批都带上: 分批时模型只看得到本批, 不带就等于只在部分集生效。

    **跨批传递(治尾巴退化, 见文件头注释)**:
      · 每批带上上一批真实产出的尾巴 ``prev_tail``(原样文本, 不是摘要)。
        第 1 批没有上文, 带的是"这是全剧开头"的声明 —— 与 consistency_lint
        同一裁定: 不给"第0集"的假快照, 否则模型会自己编一个不存在的上文出来。
      · 每批带上 ``prev_digest`` 新词台账(新增人名/地点/开场样本), 纯代码抽取。
      · 诊断清单按集号过滤: 只把与本批相关的条目发下去(整本给会被诱导越界改戏)。
    """
    llm = get_llm("rewrite", temperature=0.5, provider=provider, max_tokens=16384)
    out_blocks: list[str] = []
    seen_names: set[str] = set()
    seen_places: set[str] = set()
    digest = {"names": [], "places": [], "opens": []}
    prev_tail = ""
    n_batches = max(1, (len(eps) + _BATCH_SIZE - 1) // _BATCH_SIZE)
    #: 批次取证的累积结果(见文件头「批次缺集」注释)。返回给 run_rewrite 落库,
    #: **仅后端可查**, 不进任何面向用户的接口 —— 目的是下次还能定位"哪批掉了什么"。
    evidence: list[dict] = []

    for bi, i in enumerate(range(0, len(eps), _BATCH_SIZE), start=1):
        batch = eps[i:i + _BATCH_SIZE]
        start_ep = int(batch[0][0])
        end_ep = int(batch[-1][0])
        batch_text = _serialize_eps(kind, batch)
        req = rewrite_batch_prompt_for(kind).format(
            start=start_ep, end=end_ep, script=batch_text,
        )
        # 跨批上下文(真实文本尾巴 + 新词台账), 拼在本批原文之前
        ctx = _continuity_block(prev_tail, digest)
        if ctx:
            req = ctx + "\n\n" + req
        # 诊断清单按本批集号过滤后再给
        local_analysis = _filter_analysis_by_scope(analysis, batch) or analysis
        if guidance.strip():
            req += "\n\n" + USER_GUIDANCE_TMPL.format(guidance=guidance.strip())
        msgs = [
            SystemMessage(content=system_prompt_for(kind)),
            HumanMessage(content="【全剧诊断清单(供跨集一致性参考)】\n" + local_analysis),
            HumanMessage(content=req),
        ]
        # ---- 调模型 + 缺集重试 ----
        # 缺集**不再默默跳过**: 本批没返回全的集, 用小一点的范围再要一次。
        # 重试只补缺口(已拿到的集用 setdefault 保住, 不会被重试覆盖), 不改批大小、不加并发。
        wanted = [int(e[0]) for e in batch]
        pieces: dict[int, str] = {}
        attempts: list[dict] = []
        raws: list[str] = []
        for attempt in range(_BATCH_RETRY + 1):
            missing = [e for e in batch if int(e[0]) not in pieces]
            if not missing:
                break
            if attempt == 0:
                use_msgs = msgs
            else:
                miss_first, miss_last = int(missing[0][0]), int(missing[-1][0])
                note = (
                    f"⚠️ 上一次调用**没有返回全**第 {start_ep}~{end_ep} 集"
                    f"（第 {bi}/{n_batches} 批）。\n"
                    f"这次**只补第 {miss_first}~{miss_last} 集**：不要重复输出"
                    f"已经给过的集，也不要输出其他集。\n\n"
                )
                req = note + rewrite_batch_prompt_for(kind).format(
                    start=miss_first, end=miss_last,
                    script=_serialize_eps(kind, missing),
                )
                ctx = _continuity_block(prev_tail, digest)
                if ctx:
                    req = ctx + "\n\n" + req
                if guidance.strip():
                    req += "\n\n" + USER_GUIDANCE_TMPL.format(guidance=guidance.strip())
                use_msgs = [
                    SystemMessage(content=system_prompt_for(kind)),
                    HumanMessage(content="【全剧诊断清单(供跨集一致性参考)】\n"
                                         + local_analysis),
                    HumanMessage(content=req),
                ]
            try:
                resp = await llm.ainvoke(use_msgs)
            except Exception as e:  # noqa: BLE001
                # 单次调用异常不该让整批作废: 记进证据, 交给重试/上层判 skipped。
                attempts.append({"attempt": attempt + 1, "error": str(e)[:300],
                                 "missing": [int(e[0]) for e in missing]})
                logger.warning("rewrite batch 第%d~%d集 第%d次调用异常: %s",
                               start_ep, end_ep, attempt + 1, e)
                continue
            text = _strip_fence(getattr(resp, "content", None) or "")
            raws.append(text)
            got = _split_full_by_episode(text)
            # 只认本批要的集; 模型越界多给的集一律丢弃(不让它改到别的集)
            fresh = {ep: t for ep, t in got.items() if ep in wanted and t.strip()}
            for ep, t in fresh.items():
                pieces.setdefault(ep, t)   # 先到的优先, 重试只填空缺
            attempts.append({
                "attempt": attempt + 1,
                "finish_reason": finish_reason_of(resp),
                "chars": len(text),
                "returned": sorted(got.keys()),
                "accepted": sorted(fresh.keys()),
                "missing_after": [e for e in wanted if e not in pieces],
            })
            logger.info("rewrite batch 第%d~%d集 第%d次调用: 返回%s 收到%d集",
                        start_ep, end_ep, attempt + 1, sorted(got.keys()), len(fresh))

        still_missing = [ep for ep in wanted if ep not in pieces]
        # 本批文本按**原集号顺序**拼回; 缺的集不拼, 由上层判 skipped(并已留证据)
        piece = "\n\n".join(pieces[ep] for ep in wanted if ep in pieces)
        evidence.append({
            "batch": bi, "of": n_batches,
            "start_ep": start_ep, "end_ep": end_ep,
            "wanted": wanted,
            "accepted_eps": sorted(pieces.keys()),
            "missing_eps": still_missing,
            "attempts": attempts,
            "input_chars": len(batch_text),
            "output_chars": len(piece),
            # 原始响应留底(后端证据, 绝不下发前端)。只为事后定位"哪批掉了、掉的那段
            # 长什么样"; 超长截断并置标记, 不是归档全文。
            "raw": [r[:_EVIDENCE_CHARS] for r in raws],
            "raw_truncated": any(len(r) > _EVIDENCE_CHARS for r in raws),
        })
        if still_missing:
            # 重试到底还是缺: 这是**真问题**, 必须显眼(作业仍会 done, 但证据里有明细)
            logger.error("rewrite batch 第%d~%d集 重试 %d 次后仍缺集 %s",
                         start_ep, end_ep, _BATCH_RETRY, still_missing)

        if piece:
            out_blocks.append(piece)
            # ---- 更新跨批通道: 尾巴用真实文本, 台账用代码抽出的新词 ----
            prev_tail = piece[-_TAIL_CHARS:]
            new_names, new_places = _collect_new_terms(piece, seen_names, seen_places)
            if new_names:
                digest["names"].extend(new_names)
                digest["names"] = digest["names"][-_DIGEST_MAX_NAMES:]
            if new_places:
                digest["places"].extend(new_places)
                digest["places"] = digest["places"][-_DIGEST_MAX_PLACES:]
            head = _head_sample(piece)
            if head:
                digest["opens"].append(f"第{start_ep}-{end_ep}集: {head}")
                digest["opens"] = digest["opens"][-_DIGEST_TAIL_NOTES:]
        logger.info("rewrite batch 第%d~%d集 done: %d chars (缺 %d 集)",
                    start_ep, end_ep, len(piece), len(still_missing))
        if progress:
            await progress(f"正在精修第{start_ep}-{end_ep}集（{bi}/{n_batches}）",
                           int(95 * bi / n_batches))
        if job_id and await _is_canceled(job_id):
            break
    return "\n\n".join(out_blocks), evidence


def _continuity_block(prev_tail: str, digest: dict) -> str:
    """拼跨批上下文块。无内容时返回空串(第1批的尾巴声明除外)。

    第 1 批必须显式声明"这是开头, 没有上文", 否则模型会以为省略了前文而自行编造
    —— 这正是 consistency_lint 里"第0集幻觉"的同款问题。
    """
    parts: list[str] = []
    if prev_tail.strip():
        parts.append(
            "【上一批**精修后**的真实结尾原文(原样摘录, 不是摘要)】\n"
            "下面是紧邻本批之前那一段的实际文字。请**接着它的写法与称谓继续** —— "
            "人名写法、称呼习惯、场景地点、句式节奏都要与它一致, 不要另起一套:\n"
            "```\n" + prev_tail.strip() + "\n```"
        )
    else:
        parts.append(
            "【位置说明】本批是全剧开头, 之前没有任何已精修的段落。"
            "不存在「第0集」。"
        )
    names = digest.get("names") or []
    places = digest.get("places") or []
    opens = digest.get("opens") or []
    if names or places or opens:
        rows = []
        if names:
            rows.append("- 前面各批已出现的说话人写法(沿用这些写法, 不要另造同义新名字): "
                        + "、".join(names))
        if places:
            rows.append("- 前面各批已出现的场景地点(沿用同名, 不要给同一地点换称呼): "
                        + "、".join(places))
        if opens:
            rows.append("- 前面各批的开场写法样本(保持同样的开场节奏):\n  "
                        + "\n  ".join(opens))
        parts.append("【前面各批实际建立的新写法台账(代码从真实产出中抽取)】\n" + "\n".join(rows))
    return "\n\n".join(parts)


async def _two_round_rewrite(kind: str, eps: list, script_text: str, model: str,
                             guidance: str = "", progress=None,
                             job_id: int | None = None) -> tuple[str, str, list[dict]]:
    """两轮: 整本诊断 → 分批精修。返回 (analysis_text, rewritten_full, evidence)。

    evidence: 分批取证的明细(每批要了哪些集、返回了哪些、重试了几次、原始响应留底)。
      见文件头「批次缺集」注释 —— 由 ``run_rewrite`` 落到 ``RewriteJob.batch_evidence``,
      **仅供后端排查**, 不下发前端。

    ⚠️ 诊断轮读的是**整本**(``script_text`` 由调用方按整本序列化) —— 跨集矛盾
    (第 3 集与第 40 集的设定打架)只有在整本视角下才看得出来, 范围精修同样需要
    整本诊断。真正按范围缩小的是第二轮的改写面(``eps``)。
    """
    # 接受 "gemini:gemini-3.8-flash" 这种带型号的值; 只判厂商会把它整串判掉,
    # 然后静默落回 gpt5 —— 用户选的型号就这么丢了(见 catalog.sanitize_provider_spec)
    provider = sanitize_provider_spec(
        model, ("gemini", "deepseek", "gpt5", "claude", "qwen"), "gpt5")
    # 诊断也要按 kind 选模板 —— 正文与剧本的格式铁律不同, 用错模板会让诊断
    # 盯着"场次锚点"这类正文里根本不存在的东西提问题。
    analysis = await _analyze(script_text, provider, guidance=guidance, kind=kind)
    if progress:
        await progress("诊断完成，开始分批精修", 10)
    rewritten, evidence = await _rewrite_batches(
        kind, eps, analysis, provider, guidance=guidance,
        progress=progress, job_id=job_id)
    return analysis, rewritten, evidence


async def run_rewrite(job_id: int, progress=None) -> None:
    """执行一个整本精修作业。

    scope 从 ``RewriteJob.scope_json`` 读 —— 用户在对话工坊里圈的"只精修第 10-20 集"
    由入队 payload 落到这里。合同 ``{"start_ep": int|null, "end_ep": int|null,
    "target": "chapter"|"storyboard"}``; 集数非法值一律退回整本(不报错),
    **但 target 非法或缺失一律失败** —— 见 TargetMiss。

    ⚠️ 两次 ``_load_episodes``(整本诊断 / 范围内改写)必须用**同一个 target**,
    否则诊断读的是一层、改的是另一层, 分析结论对不上要改的稿子。

    ⚠️ 全程挂一个后台心跳（见 _heartbeat_loop）：这是"作业还活着"的唯一依据。
    没有它，一次 worker 重启就能让这行永远停在 rewriting，把该草稿上的
    「修硬伤」「精修这批」「生成」全部锁死（2026-10-08 事故）。
    """
    stop_beat = asyncio.Event()
    beat_task = asyncio.create_task(_heartbeat_loop(job_id, stop_beat))
    try:
        async with session_scope() as s:
            job = await s.get(RewriteJob, job_id)
            if not job:
                return
            draft_id = job.draft_id
            model = job.model or "gpt5"
            guidance = (getattr(job, "guidance", "") or "").strip()
            scope = getattr(job, "scope_json", None)

        # 用户在 scope 里指定了要改哪一层。
        # ⚠️ 判定口径(2026-10-06, 用户裁定"不要自动"):
        #   · scope **整个是 None** → 老路径(超级 Agent 的 start_rewrite 技能、
        #     POST /v1/rewrite 直投端点)。它们历史上就是"有剧本按剧本", 保持逐字一致。
        #   · scope **是个 dict** → 只可能来自对话工坊动作栏(用户入口)。
        #     这种就必须带 target, 缺了直接失败 —— "没传"在这里等于"让后端替用户
        #     选层", 正是这次要消灭的行为。宁可报错也不猜。
        #
        # ⚠️ `_norm_target` 也会抛 TargetMiss, 必须与下面 `_load_episodes` 的
        # TargetMiss **同一个 except 兜住**: 否则它落到文件末尾的通用 `except Exception`,
        # 被当成代码 bug 记成 "crashed" —— 而队列处理器是看 summary_json 的
        # target_miss 标来决定"这是用户输入问题, 别重试"的, 少了这个标它会把
        # 同一个必败的作业重跑三次, 白烧配额。
        try:
            if scope is None:
                target = "storyboard"
            else:
                target = _norm_target(scope, default=None)
            # 整本(用于第一轮整本诊断): 跨集矛盾只有整本视角才看得出
            # target 与下面那次一致 —— 诊断与改写必须同源
            kind, all_eps = await _load_episodes(draft_id, target=target)
        except TargetMiss as e:
            await _update_job(job_id, status="failed", error=str(e),
                              summary_json={"target_miss": True, "scope": scope},
                              finished_at=datetime.now(timezone.utc))
            return
        total = len(all_eps)
        if total == 0:
            await _update_job(job_id, status="failed", error="该草稿无剧本/正文可精修",
                              finished_at=datetime.now(timezone.utc))
            return
        # 要改的集(受 scope 限制)。范围落空 → 直接失败, 绝不退回整本覆写。
        try:
            _, eps = await _load_episodes(draft_id, scope, target=target)
        except ScopeMiss as e:
            # summary_json 打 scope_miss 标: 队列处理器靠它认出"这是用户输入问题,
            # 别重试"——重试只会再撞一次同一个空范围, 白烧三次配额。
            await _update_job(job_id, status="failed", error=str(e),
                              summary_json={"scope_miss": True, "scope": scope,
                                            "scope_label": _scope_label(scope)},
                              finished_at=datetime.now(timezone.utc))
            return
        scope_label = _scope_label(scope)
        await _update_job(job_id, total=len(eps), status="analyzing")

        script_text = _serialize_eps(kind, all_eps)
        target_text = _serialize_eps(kind, eps)
        orig_eps = {ep: (title, shots, full_text) for ep, title, shots, full_text in eps}
        if progress:
            await progress(f"正在通读全剧做诊断（本次精修范围：{scope_label}）", 5)

        if await _is_canceled(job_id):
            return

        # 第一轮整本诊断 → 第二轮分批精修(只改 scope 内的集)
        await _update_job(job_id, status="rewriting")
        analysis, rewritten_full, evidence = await _two_round_rewrite(
            kind, eps, script_text, model, guidance=guidance,
            progress=progress, job_id=job_id)
        if not rewritten_full:
            await _update_job(job_id, status="failed", error="模型未返回精修结果", analysis_text=analysis,
                              batch_evidence=evidence,
                              finished_at=datetime.now(timezone.utc))
            return
        if await _is_canceled(job_id):
            return

        # 切回每集
        per_ep_text = _split_full_by_episode(rewritten_full)

        # ===== 逐集拆回 + 校验: 返回且合格的集才覆写, 缺失/不合格的集保持原样(跳过) =====
        # 说明: 长剧(几十集)LLM 单次可能只返回部分集(如跳过它认为无需改的前几集, 或输出到上限截断),
        # 不能因此整本作废。改为"能改的集就改, 改不了的保持原稿"。缺失/不合格的集不覆写、原稿不动;
        # 每集覆写前存 History 可回滚; 续写场景原文(章节)与剧本(storyboard)分层, 导出可另选源。
        parsed_by_ep: dict[int, object] = {}
        per_ep_stat: dict[str, dict] = {}
        skipped_eps: list[int] = []
        for ep, (title, shots, full_text) in orig_eps.items():
            new_text = per_ep_text.get(ep)
            if not new_text:  # LLM 未返回该集
                skipped_eps.append(ep)
                per_ep_stat[str(ep)] = {"status": "skipped", "reason": "模型未返回该集, 保持原稿"}
                continue
            if kind == "storyboard":
                new_shots = parse_episode(new_text)
                orig_n = len(shots or [])
                new_n = len(new_shots)
                # 只要拆回有有效场次就接受(允许精修时合并/增删场次)。
                # 仅在"完全拆不出场次"时跳过(说明该集文本异常/被截断)。
                if new_n == 0:
                    skipped_eps.append(ep)
                    per_ep_stat[str(ep)] = {"status": "skipped",
                                            "reason": "拆回0场(该集文本异常/被截断), 保持原稿"}
                    continue
                # ---- 往返等价：与 check/fixer.py 同一条安全线 ----
                # ⚠️ 2026-10-08 补。此前这里只查"拆得出场次吗"，而定点修复
                # (check/fixer.py:249) 是查"拆回来**一模一样**吗" —— 同一个解析器，
                # 两条覆写路径的安全线不一样。
                #
                # 后果实测（dev 草稿 653）：模型把对白行写成
                # `△池煜(（电话里，声音紧绷）): 是我。`（多一个 △、括号套了全角），
                # 解析器按"△ 开头即动作"读 → 这一行从**对白**变成**动作**。
                # 拆回场数仍是 3 场，所以旧校验一路放行、覆写落库，
                # 下一次体检直接多出 5 个 roundtrip_broken 硬伤 ——
                # 用户看到的就是"修完硬伤反而变多"。
                #
                # 注意这**不限制**精修合并/增删场次：比对的是"模型产出的这份稿子
                # 能否被系统原样还原"，与场次多少无关。不能还原 = 导出 Word、
                # 生成分镜、再次精修都会读错，绝不该落库。
                rt_ok, rt_diff = roundtrip_equivalent(new_shots, ep=ep)
                if not rt_ok:
                    skipped_eps.append(ep)
                    per_ep_stat[str(ep)] = {
                        "status": "skipped",
                        "reason": "精修后格式无法被系统解析（会变成新的硬伤）, 保持原稿",
                        "roundtrip_diff": rt_diff[:300],
                    }
                    logger.warning("rewrite job %d 第%d集 往返等价失败, 保持原稿: %s",
                                   job_id, ep, rt_diff[:200])
                    continue
                parsed_by_ep[ep] = new_shots
                per_ep_stat[str(ep)] = {"status": "ok", "before_scenes": orig_n, "after_scenes": new_n}
            else:
                body = re.sub(r"^第\s*\d+\s*集.*?(\n|$)", "", new_text, count=1).strip()
                if not body:
                    skipped_eps.append(ep)
                    per_ep_stat[str(ep)] = {"status": "skipped", "reason": "精修后正文为空, 保持原稿"}
                    continue
                parsed_by_ep[ep] = body
                per_ep_stat[str(ep)] = {"status": "ok",
                                        "before_chars": len(full_text or ""), "after_chars": len(body)}

        # 一集都没改成 → 判失败(原稿完全未动)
        if not parsed_by_ep:
            await _update_job(
                job_id, status="failed", analysis_text=analysis, per_ep_json=per_ep_stat,
                batch_evidence=evidence,
                error="模型未返回任何可用的集, 原稿未改动",
                finished_at=datetime.now(timezone.utc),
            )
            return

        # ===== 覆写: 只覆写合格的集(先存 History), 跳过的集原样保留 =====
        # 归档统一走 candidate_store.snapshot_in —— 每集每阶段封顶 10 版。
        # 原先是本文件直接 s.add(ScriptEpisodeHistory(...)), 没有上限,
        # 与章节/剧本/adapt_products 三条路径不一致, 会无限增长。
        # 这里用 snapshot_in 而不是 save_candidate: 覆写循环必须保持"整本原子",
        # save_candidate 会各自另开事务, 破坏"要么整本成功、要么整本不动"。
        from ..stages.candidate_store import snapshot_in
        changed = 0
        async with session_scope() as s:
            for ep, (title, shots, full_text) in orig_eps.items():
                if ep not in parsed_by_ep:
                    continue  # 跳过的集: 原稿不动
                if kind == "storyboard":
                    sb = (await s.execute(
                        select(ScriptStoryboard).where(
                            ScriptStoryboard.draft_id == draft_id,
                            ScriptStoryboard.chapter_order == ep,
                        )
                    )).scalars().first()
                    if not sb:
                        continue
                    # 存历史版本(可回滚)
                    await snapshot_in(
                        s, draft_id=draft_id, order=ep, stage="storyboard",
                        content=sb.shots_json or [], version=(sb.version or 1),
                        created_by="ai_rewrite",
                    )
                    sb.shots_json = parsed_by_ep[ep]
                    sb.version = (sb.version or 1) + 1
                    sb.is_stale = 0
                    flag_modified(sb, "shots_json")
                    changed += 1
                else:
                    ch = (await s.execute(
                        select(ScriptChapter).where(
                            ScriptChapter.draft_id == draft_id,
                            ScriptChapter.chapter_order == ep,
                        )
                    )).scalars().first()
                    if not ch:
                        continue
                    await snapshot_in(
                        s, draft_id=draft_id, order=ep, stage="chapter",
                        content={"full_text": ch.full_text or ""}, version=(ch.version or 1),
                        created_by="ai_rewrite",
                    )
                    ch.full_text = parsed_by_ep[ep]
                    ch.word_count = len(parsed_by_ep[ep])
                    ch.version = (ch.version or 1) + 1
                    ch.is_stale = 1  # 编剧稿改了, 分镜需重生
                    changed += 1

        await _update_job(
            job_id, status="done", analysis_text=analysis,
            per_ep_json=per_ep_stat, finished=changed,
            batch_evidence=evidence,
            summary_json={"kind": kind, "applied_eps": changed,
                          "scope": scope if isinstance(scope, dict) else None,
                          "scope_label": scope_label,
                          "scoped_total": len(eps), "draft_total": total,
                          "before_chars": len(target_text), "after_chars": len(rewritten_full),
                          # 留底: 本次精修带了什么用户参考意见(便于回溯"为什么改成这样")
                          "guidance": guidance[:2000]},
            finished_at=datetime.now(timezone.utc),
        )
        logger.info("rewrite job %d done: kind=%s scope=%s applied=%d/%d",
                    job_id, kind, scope_label, changed, len(eps))
    except Exception as e:  # noqa: BLE001
        logger.exception("rewrite job %d crashed", job_id)
        await _update_job(job_id, status="failed", error=str(e)[:500],
                          finished_at=datetime.now(timezone.utc))
    finally:
        # 心跳必须在**所有出口**都停掉：正常 done、ScopeMiss/TargetMiss 早退、
        # 异常、以及被 cancel 时的 return。漏掉任何一个，那个协程都会一直跑下去
        # 给一行已经终态的作业刷心跳 —— 下次判活就会把死作业看成活的。
        stop_beat.set()
        beat_task.cancel()
        try:
            await beat_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass