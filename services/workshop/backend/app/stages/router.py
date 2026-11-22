"""M5 三阶段创作 API。本期 (M5.1) 实现：
  - drafts CRUD（含"我的草稿"列表）
  - outline 生成 + 锁定

后续：
  - M5.2: chapters 滚动生成
  - M5.3: storyboards 按章生成
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, File, Form, UploadFile, Depends
from pydantic import BaseModel, Field, validator
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm.attributes import flag_modified

from ..auth import get_current_user, require_admin, User
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db import (
    ScriptChapter,
    ScriptDraft,
    ScriptEpisodeHistory,
    ScriptStoryboard,
    session_scope,
)
from .access import check_draft_access, require_draft_access
from .outline_gen import generate_outline

router = APIRouter(prefix="/v1/stages", tags=["stages"])
logger = logging.getLogger("stages")


# ========== 权限辅助 ==========
# 实现已挪到 access.py(中立模块, 便于 router_m5_enhanced 顶层 import 而不成环)。
# 这里保留旧名字作别名, 本文件内 16 处调用与外部 import 都不用改。
_check_draft_access = check_draft_access




# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _row_to_dict(row: Any) -> dict:
    """把 ORM row 序列化成 dict。强制对 JSON 字段深拷贝避免 session 关闭后 lazy IO。"""
    import copy
    d = {}
    for c in row.__table__.columns:
        v = getattr(row, c.name)
        if hasattr(v, "isoformat"):
            d[c.name] = v.isoformat()
        elif isinstance(v, (dict, list)):
            d[c.name] = copy.deepcopy(v)
        else:
            d[c.name] = v
    return d


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
class CreateDraftIn(BaseModel):
    session_id: str | None = None
    title: str = ""
    user_input: str = ""
    # 形如 "gemini" 或 "gemini:gemini-3.8-flash"; 型号白名单由 get_llm 现查(见 models/catalog.py)
    model_provider: str = Field("gemini", pattern=r"^(gemini|deepseek|gpt5|grok|claude)(:[A-Za-z0-9._-]{1,60})?$")
    episode_count: int = Field(3, ge=1, le=500)  # M5增强: 集数验证
    chapter_word_target: int = Field(DEFAULT_CHAPTER_WORD_TARGET, ge=1, le=20000)  # 不设最低值, 用户可填任意目标字数
    
    @validator('episode_count')
    def validate_episode_count(cls, v):
        if not isinstance(v, int):
            raise ValueError('集数必须是整数')
        if v < 1 or v > 500:
            raise ValueError('集数必须在1-500之间')
        return v


class PatchDraftIn(BaseModel):
    title: str | None = None
    user_input: str | None = None
    # 总集数。⚠️ 2026-09-21 之前**建完就改不了**（这个字段根本不在这里），
    # 用户想把 30 集改成 60 集只能重新建一部剧。
    # 上限跟着 GenerateOutlineIn.chapter_count 的 500 走，再留点余量给超长剧。
    episode_count: int | None = Field(None, ge=1, le=2000)
    outline: dict | None = None
    outline_locked: int | None = None
    status: str | None = None
    chapter_word_target: int | None = None
    model_provider: str | None = Field(None, pattern=r"^(gemini|deepseek|gpt5|grok|claude)(:[A-Za-z0-9._-]{1,60})?$")


class GenerateOutlineIn(BaseModel):
    chapter_count: int = Field(24, ge=1, le=500)  # M5增强: 提升到500
    chapter_word_target: int | None = Field(None, ge=1, le=20000)  # 不设最低值


# ---------------------------------------------------------------------------
# Drafts CRUD
# ---------------------------------------------------------------------------
@router.get("/drafts")
async def list_drafts(
    session_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=5000),  # 上限提到 5000
    offset: int = Query(0, ge=0),
    all: bool = Query(False, description="true 时忽略 limit/offset 返回全部草稿(管理员看全量 / 用户草稿过万也不截断)"),
    created_on: str | None = Query(None, description="按【北京日期】过滤创建时间, 格式 YYYY-MM-DD(如 2026-07-02); 内部换算 UTC 区间, 避免时区错位"),
    min_score: int | None = Query(None, description="按最新分析综合分过滤(>=该值); 无分的草稿被排除"),
    batch_id: int | None = Query(None, description="按批量创建批次 auto_batch_job_id 过滤"),
    user: User = Depends(get_current_user),
):
    """列草稿。可按 session_id 过滤；不传则返回所有（"我的草稿"）。

    返回每条草稿的轻量元数据 + 章节计数 + storyboard 计数。
    all=true 时不分页, 返回符合条件的全部草稿(支持上万条)。
    """
    async with session_scope() as s:
        stmt = select(ScriptDraft).where(ScriptDraft.is_deleted == False)
        # 非admin只能看自己的草稿
        if user.role not in ("admin", "superadmin"):
            stmt = stmt.where(ScriptDraft.user_id == user.id)
        if session_id:
            stmt = stmt.where(ScriptDraft.session_id == session_id)
        # 按批次过滤
        if batch_id is not None:
            stmt = stmt.where(ScriptDraft.auto_batch_job_id == batch_id)
        # 按【北京日期】过滤创建时间: created_at 存 UTC, 北京日 X 对应 UTC [X-1 16:00, X 16:00)
        if created_on:
            try:
                from datetime import datetime as _dt, timedelta as _td
                d0 = _dt.strptime(created_on, "%Y-%m-%d")
                # 北京 00:00 = UTC 前一天 16:00
                utc_start = d0 - _td(hours=8)
                utc_end = utc_start + _td(days=1)
                stmt = stmt.where(ScriptDraft.created_at >= utc_start,
                                  ScriptDraft.created_at < utc_end)
            except ValueError:
                raise HTTPException(400, "created_on 格式应为 YYYY-MM-DD, 如 2026-07-02")
        stmt = stmt.order_by(ScriptDraft.updated_at.desc())
        # 精确筛选(按天/批次/会话/评分)时自动返回全部, 不再 limit 截断。
        # 原因: 用户/Agent 明确要"某天/某批次的全部草稿", 若仍默认 limit=50 会漏草稿
        # (如某天有100个只返回50个)。只有"无条件泛列草稿"时才保留分页 limit。
        _has_filter = bool(created_on or (batch_id is not None) or session_id or (min_score is not None))
        if not all and not _has_filter:
            stmt = stmt.offset(offset).limit(limit)

        # 列表瘦身（2026-09-20 第二刀）：只取需要的列，不把整行（含 outline 全量
        # JSON）搬进内存再丢掉。详见下方 _expected 处的注释。
        _is_pg = s.bind.dialect.name == "postgresql"
        if _is_pg:
            # PG：让数据库直接算出章节数，outline 本体不进入 Python
            _expected = func.coalesce(
                func.jsonb_array_length(
                    func.coalesce(ScriptDraft.outline["chapters"], text("'[]'::jsonb"))
                ), 0
            ).label("expected_chapters")
        else:
            # 非 PG（sqlite 等）：没有 jsonb 函数，退回取 outline 本体
            _expected = ScriptDraft.outline.label("outline_raw")

        _cols = [
            ScriptDraft.id, ScriptDraft.session_id, ScriptDraft.user_id,
            ScriptDraft.title,
            # 在 **SQL 层**就截断：否则 PG→应用之间仍要搬那 913 KB 全文，
            # 只在序列化时截等于白读一遍。substr 对 NULL 返回 NULL，与原行为一致。
            func.substr(ScriptDraft.user_input, 1, 120).label("user_input"),
            ScriptDraft.status,
            ScriptDraft.model_provider, ScriptDraft.episode_count,
            ScriptDraft.chapter_word_target, ScriptDraft.outline_locked,
            ScriptDraft.is_favorite, ScriptDraft.cover_url,
            ScriptDraft.auto_generated, ScriptDraft.parent_draft_id,
            ScriptDraft.created_at, ScriptDraft.updated_at,
            ScriptDraft.auto_batch_job_id,
            _expected,
        ]
        rows = (await s.execute(stmt.with_only_columns(*_cols))).all()

        # admin 视角: 草稿来自不同用户, 批量查来源用户昵称, 附到每条草稿上,
        # 方便管理员区分草稿归属。普通用户只看自己的, 无需附加。
        is_admin = user.role in ("admin", "superadmin")
        owner_map: dict[int, dict] = {}
        if is_admin:
            uids = {r.user_id for r in rows if r.user_id is not None}
            if uids:
                urows = (await s.execute(
                    select(User).where(User.id.in_(uids))
                )).scalars().all()
                for u in urows:
                    owner_map[u.id] = {
                        "owner_display_name": (u.display_name or "").strip() or None,
                        "owner_username": u.username,
                    }

        # 批量统计章节/剧本数量 — 用 2 条 GROUP BY 聚合一次取全部, 避免 N+1
        # (旧实现每条草稿跑 2 个 COUNT, 262 条 = 524 次查询 → 0.7s; 现在 2 次查询 → ~0.1s)
        draft_ids = [r.id for r in rows]
        chap_counts: dict[int, int] = {}
        sb_counts: dict[int, int] = {}
        if draft_ids:
            for did, cnt in (await s.execute(
                select(ScriptChapter.draft_id, func.count())
                .where(ScriptChapter.draft_id.in_(draft_ids))
                .group_by(ScriptChapter.draft_id)
            )).all():
                chap_counts[did] = cnt
            for did, cnt in (await s.execute(
                select(ScriptStoryboard.draft_id, func.count())
                .where(ScriptStoryboard.draft_id.in_(draft_ids))
                .group_by(ScriptStoryboard.draft_id)
            )).all():
                sb_counts[did] = cnt

        # 批量取每个草稿"最新一次分析"的综合评分(供列表分数排序/徽章)。
        # 用 DISTINCT ON(draft_id) 取每草稿 created_at 最新的 overall_score。
        score_map: dict[int, int] = {}
        if draft_ids:
            from ..db.models import ScriptAnalysis
            arows = (await s.execute(
                select(ScriptAnalysis.draft_id, ScriptAnalysis.overall_score, ScriptAnalysis.created_at)
                .where(
                    ScriptAnalysis.draft_id.in_(draft_ids),
                    ScriptAnalysis.overall_score.is_not(None),
                )
                .order_by(ScriptAnalysis.draft_id, ScriptAnalysis.created_at.desc())
            )).all()
            for did, sc, _ca in arows:
                if did not in score_map and sc is not None:
                    score_map[did] = int(sc)

        # 批量取每个草稿"最近一次自动打磨"的残留硬伤数(p0_left)。
        # 数据在 polish_jobs.per_draft_json[draft_id]，取该草稿参与过的、最新完成的作业里的 p0_left。
        # 供列表筛选"最近一次打磨硬伤数为0"。无打磨记录 → None。
        #
        # ⚠️ 2026-09-20 重写。原写法是：
        #     SELECT ... FROM polish_jobs j CROSS JOIN unnest(:dids) AS did
        #     WHERE j.per_draft_json ? did::text ...
        # 看着很"数据库"，实测是**整个接口最大的瓶颈**：
        #   Explain: Nested Loop, Rows Removed by Join Filter: 3513,
        #            Buffers: shared hit=21165, Execution Time: **691 ms**
        # 占接口总耗时 790ms 的 87%。
        # 原因是 `?`（JSONB 键存在判断）在嵌套循环里对每行 JSON **重复求值 458 次**，
        # 而 per_draft_json 是 TOAST 存储的大字段（单行最大 59KB），
        # 每次比较都要解压一遍。
        #
        # 修法：这表总共只有 8 行。**把 JSON 拉回 Python 一次，在内存里查**——
        # 458 次解压变成 8 次，几百毫秒直接消失。
        # 判据（取"最新作业里的 p0_left"）完全不变，只是换了执行地点。
        polish_p0_map: dict[int, int] = {}
        if draft_ids:
            try:
                prows = (await s.execute(
                    text(
                        "SELECT id, per_draft_json FROM polish_jobs "
                        "WHERE per_draft_json IS NOT NULL ORDER BY id DESC"
                    )
                )).all()
                want = set(draft_ids)
                for _jid, pdj in prows:            # 已按 id DESC，先到者即最新
                    if not isinstance(pdj, dict):
                        continue
                    for did_str, val in pdj.items():
                        try:
                            did = int(did_str)
                        except (TypeError, ValueError):
                            continue
                        if did not in want or did in polish_p0_map:
                            continue
                        p0 = (val or {}).get("p0_left") if isinstance(val, dict) else None
                        if p0 is not None:
                            polish_p0_map[did] = int(p0)
            except Exception as _e_p0:  # noqa: BLE001
                logger.warning("load polish p0_left map failed: %s", _e_p0)

        # 列表瘦身(C 方案): 只返回卡片需要的轻量字段, 不带 outline / story_bible_json
        # 等大 JSON。上万条草稿时, 整库 outline 深拷贝+序列化是隐藏的性能大头, 列表页
        # 用不到, 去掉后响应体积和耗时再降一截。详情页(get_draft)仍返回完整数据。
        #
        # ⚠️ 2026-09-20 补一刀: 上面那轮"瘦身"只瘦了**响应体**，没有瘦**查询**——
        # 仍然是 `select(ScriptDraft)` 把整行取回内存（含 outline 全量 JSON），
        # 再在 Python 里丢掉。dev 实测：458 部草稿整行 7.39MB，而真正发出去的
        # 只有 1.19MB，**中间 6MB 是白搬的**（深拷贝 + 序列化都在这份白搬的数据上）。
        # 接口耗时 1137ms 里，查询+取行就占 288ms，其余主要花在这份白搬上。
        #
        # 现在改成**只 select 需要的列**：outline 仅用于算 expected_chapters，
        # 那就让数据库直接给出章节数（jsonb_array_length），不再把 JSON 搬到 Python。
        # 这条正是 features/overview_routes.py 顶部注释记过的同一个坑：
        # "全程只用计数/is_stale/locked，full_text 与 shots_json 一次都没被读过，
        #  但整实体查询会把它们从 PG 搬进内存再序列化丢弃。"

        # admin 视角: 草稿来自不同用户, 批量查来源用户昵称, 附到每条草稿上,
        # 方便管理员区分草稿归属。普通用户只看自己的, 无需附加。
        is_admin = user.role in ("admin", "superadmin")
        owner_map: dict[int, dict] = {}
        if is_admin:
            uids = {r.user_id for r in rows if r.user_id is not None}
            if uids:
                urows = (await s.execute(
                    select(User).where(User.id.in_(uids))
                )).scalars().all()
                for u in urows:
                    owner_map[u.id] = {
                        "owner_display_name": (u.display_name or "").strip() or None,
                        "owner_username": u.username,
                    }

        def _to_iso(v):
            # created_at/updated_at 在库里是 naive UTC(func.now() 存的 UTC 裸时间)。
            # 直接 isoformat() 会输出不带时区的字符串, 让 Agent/前端误当本地时间读(早8小时)。
            # 这里统一转成北京时间并带 +08:00 时区标记, 消除时区歧义。
            if not hasattr(v, "isoformat"):
                return v
            try:
                from datetime import timezone, timedelta
                # naive 视为 UTC, 补上 UTC tz 再转 +08:00
                if v.tzinfo is None:
                    v = v.replace(tzinfo=timezone.utc)
                return v.astimezone(timezone(timedelta(hours=8))).isoformat()
            except Exception:
                return v.isoformat()

        out = []
        for r in rows:
            # 现在 r 是**列元组**（不再是 ScriptDraft 实体）—— 见上面 _cols 的说明。
            # expected_chapters 由数据库算好（PG 路径）或由 outline_raw 兜底（sqlite）。
            exp = getattr(r, "expected_chapters", None)
            if exp is None:
                _raw = getattr(r, "outline_raw", None)
                exp = len((_raw or {}).get("chapters") or []) if isinstance(_raw, dict) else 0
            d = {
                "id": r.id,
                "session_id": r.session_id,
                "user_id": r.user_id,
                "title": r.title,
                # ⚠️ 只给**预览**，不给全文（2026-09-24 实测定的量）。
                # 485 条草稿的列表响应 1.21 MB，其中 user_input 独占
                # 913.8 KB = 73.8% —— 而列表页的卡片根本不显示它
                # （回收站那行预览走的是另一个接口 /v1/trash）。
                # 用户反馈"全部草稿页打开很慢"，本以为是封面，实测封面已懒加载
                # 且中位只有 29 KB；真正白传的是这坨原始需求文本。
                # 截断而不是删除：保留键名与一行预览的可用性，不破坏潜在消费方。
                # 要全文请取单份草稿 GET /v1/stages/drafts/{id}。
                "user_input": (r.user_input or "")[:120],
                "status": r.status,
                "model_provider": r.model_provider,
                "episode_count": r.episode_count,
                "chapter_word_target": r.chapter_word_target,
                "outline_locked": r.outline_locked,
                "is_favorite": r.is_favorite,
                "cover_url": r.cover_url,
                "auto_generated": r.auto_generated,
                "parent_draft_id": r.parent_draft_id,
                "created_at": _to_iso(r.created_at),
                "updated_at": _to_iso(r.updated_at),
                "chapter_count": chap_counts.get(r.id, 0),
                "storyboard_count": sb_counts.get(r.id, 0),
                "expected_chapters": exp,
                "quality_score": score_map.get(r.id),          # 最新分析综合分(0-100), 无则 None
                "last_polish_p0": polish_p0_map.get(r.id),       # 最近一次自动打磨残留硬伤数(p0_left), 无打磨则 None
                "auto_batch_job_id": r.auto_batch_job_id,        # 所属批量创建批次(NULL=手动)
            }
            # 来源用户标签 (仅 admin 视角附带)
            if is_admin:
                info = owner_map.get(r.user_id) or {}
                d["owner_display_name"] = info.get("owner_display_name")
                d["owner_username"] = info.get("owner_username")
                # 前端直接展示用: 昵称优先, 退到 username, 再退到 user#id
                d["owner_label"] = (
                    info.get("owner_display_name")
                    or info.get("owner_username")
                    or (f"用户#{r.user_id}" if r.user_id is not None else "未知用户")
                )
            out.append(d)
        # 按最新分析综合分过滤(>= min_score); 无分的草稿排除
        if min_score is not None:
            out = [d for d in out if d.get("quality_score") is not None and d["quality_score"] >= min_score]
        return {"items": out, "total": len(out)}


@router.post("/drafts")
async def create_draft(payload: CreateDraftIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        row = ScriptDraft(
            session_id=payload.session_id or "",
            user_id=user.id,
            title=payload.title.strip(),
            user_input=payload.user_input.strip(),
            model_provider=payload.model_provider,
            chapter_word_target=payload.chapter_word_target,
            episode_count=payload.episode_count,
            status="draft",
            outline={},
        )
        s.add(row)
        await s.flush()
        await s.refresh(row)
        new_id = row.id
        result = _row_to_dict(row)

    # 注: 封面生成已挪到 outline 完成之后才触发 (run_outline / select_candidate),
    # 避免画面与正文不符. 创建草稿瞬间不再生图, 卡片走前端骨架/占位.
    return result


@router.get("/drafts/{draft_id}")
async def get_draft(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user)
        d = _row_to_dict(row)

        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id).order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        d["chapters"] = [_row_to_dict(c) for c in chs]

        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id).order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        d["storyboards"] = [_row_to_dict(c) for c in sbs]

        return d


@router.patch("/drafts/{draft_id}")
async def patch_draft(draft_id: int, payload: PatchDraftIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user, for_write=True)
        data = payload.model_dump(exclude_unset=True)
        # 记录字数变更, 用于后置标记 stale
        old_word_target = row.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET
        for k, v in data.items():
            if hasattr(row, k):
                setattr(row, k, v)
        # 如果修改了outline,标记所有章节和剧本为过期 + 同步到预览页选中候选
        if 'outline' in data and data['outline'] is not None:
            from sqlalchemy import update
            await s.execute(update(ScriptChapter).where(ScriptChapter.draft_id == draft_id).values(is_stale=1))
            await s.execute(update(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id).values(is_stale=1))
            # 同步到选中的preview candidate(双向同步)
            await s.execute(
                text("""UPDATE outline_candidates SET outline=:ol, updated_at=NOW()
                        WHERE draft_id=:d AND is_selected=true"""),
                {"ol": json.dumps(data['outline'], ensure_ascii=False), "d": draft_id}
            )
        # 如果修改了 chapter_word_target 且数值真的变了, 把所有"未锁定"章节标 stale,
        # 让批量重生按钮能直接捡起来重新写满到新字数。已锁定章节(用户原文/手动锁定)不动。
        if 'chapter_word_target' in data and data['chapter_word_target'] is not None:
            new_word_target = int(data['chapter_word_target'])
            if new_word_target != old_word_target:
                from sqlalchemy import update as _upd_wt, or_
                stale_chapters_n = (await s.execute(
                    _upd_wt(ScriptChapter)
                    .where(
                        ScriptChapter.draft_id == draft_id,
                        or_(ScriptChapter.locked == 0, ScriptChapter.locked.is_(None)),
                    )
                    .values(is_stale=1)
                )).rowcount
                stale_sb_n = (await s.execute(
                    _upd_wt(ScriptStoryboard)
                    .where(ScriptStoryboard.draft_id == draft_id)
                    .values(is_stale=1)
                )).rowcount
                # 写一条日志, 让前端日志面板能看到这次变更和受影响范围
                try:
                    from .log_helper import save_log
                    await save_log(
                        draft_id, "chapter_word_target",
                        f"📏 每章目标字数 {old_word_target} → {new_word_target}, "
                        f"已标记 {stale_chapters_n} 个未锁定章节 / {stale_sb_n} 个剧本为过期, "
                        f"可点击「全部生成」按新字数重新生成",
                        "log", None,
                        {"old": old_word_target, "new": new_word_target,
                         "stale_chapters": stale_chapters_n, "stale_storyboards": stale_sb_n},
                    )
                except Exception:
                    pass
        await s.flush()
        await s.refresh(row)
        return _row_to_dict(row)


@router.delete("/drafts/{draft_id}")
async def delete_draft(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user, for_write=True)
        # 级联删除章节 + 剧本
        await s.execute(delete(ScriptChapter).where(ScriptChapter.draft_id == draft_id))
        await s.execute(delete(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id))
        await s.execute(delete(ScriptDraft).where(ScriptDraft.id == draft_id))
    return {"ok": True}


# ---------------------------------------------------------------------------
# 角色一致性 — 花名册(registry) + 角色圣经(bible)
# ---------------------------------------------------------------------------
@router.get("/drafts/{draft_id}/characters")
async def get_draft_characters(draft_id: int, user: User = Depends(get_current_user)):
    """读取草稿的角色花名册 + 角色圣经(供「角色」页展示/编辑)。"""
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user)
        outline = dict(row.outline or {})
        return {
            "registry": outline.get("character_registry") or {"characters": []},
            "bible": outline.get("character_bible") or {"characters": []},
        }


@router.put("/drafts/{draft_id}/characters")
async def put_draft_characters(draft_id: int, payload: dict, user: User = Depends(get_current_user)):
    """保存用户编辑后的角色圣经(立场/性格/动机等)。

    payload: { "bible": {"characters":[...]}, "registry": {"characters":[...]} (可选) }
    """
    from datetime import datetime, timezone
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user, for_write=True)
        outline = dict(row.outline or {})
        now = datetime.now(timezone.utc).isoformat()
        if isinstance(payload.get("bible"), dict):
            b = dict(payload["bible"])
            b["version"] = int((outline.get("character_bible") or {}).get("version") or 0) + 1
            b["updated_at"] = now
            b["confirmed"] = True
            outline["character_bible"] = b
        if isinstance(payload.get("registry"), dict):
            r = dict(payload["registry"])
            r["version"] = int((outline.get("character_registry") or {}).get("version") or 0) + 1
            r["updated_at"] = now
            outline["character_registry"] = r
        row.outline = outline
        flag_modified(row, "outline")
        await s.flush()
        return {
            "ok": True,
            "registry": outline.get("character_registry") or {"characters": []},
            "bible": outline.get("character_bible") or {"characters": []},
        }


@router.post("/drafts/{draft_id}/characters/extract")
async def extract_draft_characters(draft_id: int, user: User = Depends(get_current_user)):
    """从已有章节正文抽取角色(花名册+圣经), 覆盖写入。供「角色」页手动触发/重新抽取。"""
    from .character_extract import extract_characters, split_registry_bible
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user, for_write=True)
        provider = row.model_provider or "gemini"
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id).order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        corpus = "\n\n".join(
            f"第{c.chapter_order}集 「{c.title or ''}」\n{c.full_text or ''}" for c in chs
            if (c.full_text or "").strip()
        )
        # 正文已是非必经流程: 没正文时回退用「剧本(分镜)」抽取, 再回退用「大纲」
        if not corpus.strip():
            sbs = (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id).order_by(ScriptStoryboard.chapter_order)
            )).scalars().all()
            sb_parts: list[str] = []
            for sb in sbs:
                shots = sb.shots_json or []
                if not isinstance(shots, list):
                    continue
                lines: list[str] = []
                for sh in shots:
                    if not isinstance(sh, dict):
                        continue
                    for el in sh.get("elements") or []:
                        if isinstance(el, dict):
                            ch = el.get("character")
                            content = el.get("content") or el.get("action") or ""
                            if ch:
                                lines.append(f"{ch}: {content}")
                            elif content:
                                lines.append(str(content))
                    for k in ("action", "dialogue", "subtitle"):
                        v = sh.get(k)
                        if isinstance(v, str) and v:
                            lines.append(v)
                if lines:
                    sb_parts.append(f"第{sb.chapter_order}集剧本\n" + "\n".join(lines))
            corpus = "\n\n".join(sb_parts)
        if not corpus.strip():
            # 最后回退: 用大纲(标题+梗概+已有角色名)
            outline = row.outline or {}
            ol_parts = [outline.get("synopsis") or ""]
            for ep in outline.get("chapters", []) or []:
                if isinstance(ep, dict):
                    ol_parts.append(f"{ep.get('title','')} {ep.get('synopsis','')}")
            corpus = "\n".join(p for p in ol_parts if p.strip())
    if not corpus.strip():
        raise HTTPException(status_code=400, detail="该草稿还没有任何内容(大纲/剧本/正文)可供抽取角色")
    chars = await extract_characters(corpus, provider=provider)
    if not chars:
        raise HTTPException(status_code=502, detail="角色抽取失败, 请重试")
    registry, bible = split_registry_bible(chars)
    async with session_scope() as s:
        row = await _check_draft_access(s, draft_id, user, for_write=True)
        outline = dict(row.outline or {})
        outline["character_registry"] = registry
        outline["character_bible"] = bible
        row.outline = outline
        flag_modified(row, "outline")
        await s.flush()
    return {"ok": True, "count": len(chars), "registry": registry, "bible": bible}


# ---------------------------------------------------------------------------
# Outline 生成
# ---------------------------------------------------------------------------
@router.post("/drafts/{draft_id}/outline", dependencies=[Depends(require_draft_access)])
async def run_outline(draft_id: int, payload: GenerateOutlineIn):
    """同步调 LLM 生成大纲并写库。

    注意：M5.1 先用同步阻塞，前端 loading 等 ~30s。
    M5.x 后会再加 SSE 流式。
    """
    global _current_running, _current_waiting, _queue_counter
    # 任务入队(非拒绝,等待执行)
    async with session_scope() as s:
        row = await s.get(ScriptDraft, draft_id)
        if not row:
            raise HTTPException(404, "draft not found")
        if row.outline_locked:
            raise HTTPException(409, "outline already locked; unlock first")
        user_input = row.user_input or ""
        target = payload.chapter_word_target or row.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET
        title_old = row.title or ""

        row.status = "outline_running"
        await s.flush()
        
        # 保存需要的值(session外无法访问row)
        model_provider = row.model_provider or "gemini"
        saved_draft_id = row.id

    # 在 session 外调 LLM（避免长事务持有 DB 连接）
    try:
        outline = await generate_outline(
            user_input=user_input,
            chapter_count=payload.chapter_count,
            chapter_word_target=target,
            provider=model_provider,
            draft_id=saved_draft_id,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("outline generation failed for draft %s: %s", draft_id, e)
        async with session_scope() as s:
            row = await s.get(ScriptDraft, draft_id)
            if row:
                row.status = "draft"
                await s.flush()
        raise HTTPException(500, f"outline generation failed: {e}")

    async with session_scope() as s:
        row = await s.get(ScriptDraft, draft_id)
        if not row:
            raise HTTPException(404, "draft disappeared")
        row.outline = outline
        if not (row.title or "").strip() and outline.get("title"):
            row.title = outline["title"]
        if payload.chapter_word_target:
            row.chapter_word_target = payload.chapter_word_target
        row.status = "outline_done"
        await s.flush()
        await s.refresh(row)  # 强制 reload 全部列，防 getattr lazy load 触发 MissingGreenlet
        result = _row_to_dict(row)

    # 大纲完成后异步触发封面生成 (B 方案: 标题画进画面).
    # 仅当 cover_url 还为空时触发, 避免重复消耗配额; 用户改大纲想刷新封面走重生按钮.
    if not result.get("cover_url"):
        try:
            import asyncio as _asyncio_cov
            from ..draft_cover.routes import _generate_one
            _asyncio_cov.create_task(_generate_one(draft_id))
        except Exception as _e_cov:  # noqa: BLE001
            logger.warning("schedule cover gen after outline for draft #%d failed: %s", draft_id, _e_cov)
    return result


@router.post("/drafts/{draft_id}/outline/lock", dependencies=[Depends(require_draft_access)])
async def lock_outline(draft_id: int, locked: bool = Query(True)):
    """锁定/解锁大纲。锁定后才能进入编剧阶段。"""
    async with session_scope() as s:
        row = await s.get(ScriptDraft, draft_id)
        if not row:
            raise HTTPException(404, "draft not found")
        row.outline_locked = 1 if locked else 0
        if locked and row.status == "outline_done":
            row.status = "outline_locked"
        elif (not locked) and row.status == "outline_locked":
            row.status = "outline_done"
        await s.flush()
        await s.refresh(row)
        return _row_to_dict(row)


# ---------------------------------------------------------------------------
# M5.2: 章节（编剧阶段）
# ---------------------------------------------------------------------------

@router.post("/drafts/{draft_id}/outline/episodes/{episode_order}/regenerate-with-feedback", dependencies=[Depends(require_draft_access)])
async def regenerate_episode_with_feedback(draft_id: int, episode_order: int, payload: FeedbackRegenerateIn):
    """根据用户修改意见重新生成大纲中的某一集"""
    from ..models.llm import get_llm
    from .outline_fields import STALE_AFTER_REWRITE as _STALE_CONTRACT_KEYS
    
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        model_provider = draft.model_provider or "gemini"
        outline = draft.outline or {}
        chapters = outline.get("chapters", [])
        
        # 找到目标集
        target = None
        target_idx = None
        for i, ch in enumerate(chapters):
            if ch.get("order") == episode_order:
                target = ch
                target_idx = i
                break
        # 2026-10-28：这一集还不存在、但上一集已有时，按意见**新写**这一集（逐集补齐大纲）。
        # 生产草稿 #2952 改编到第 108 集中断后，Agent 想逐集补第 109 集，这里一律 404，
        # 只能改走区间重写（那条路当时还存不住内容）。只允许紧接着补，不留空洞。
        creating = False
        if not target:
            orders = {int(c.get("order") or 0) for c in chapters}
            if episode_order - 1 in orders or (episode_order == 1 and not orders):
                creating = True
                target = {"order": episode_order, "title": "", "synopsis": ""}
                prev_ep = next((c for c in chapters if c.get("order") == episode_order - 1), None)
                next_ep = next((c for c in chapters if c.get("order") == episode_order + 1), None)
            else:
                raise HTTPException(404, f"episode {episode_order} not found in outline"
                                         f"（只能紧接已有的最后一集新写；当前最后一集是第 {max(orders) if orders else 0} 集）")
        else:
            prev_ep = chapters[target_idx - 1] if target_idx > 0 else None
            next_ep = chapters[target_idx + 1] if target_idx < len(chapters) - 1 else None
        from .context_builder import neighborhood_block
        _near = neighborhood_block(outline, episode_order)
        # 2026-11-07 改版：大纲只有 synopsis 一个正文字段，要素块就在它里面。
        # 此前这里把"当前契约"另列一段，模型只改梗概、契约原样留着，
        # 于是用户看到 A、下游读 B。现在整块正文一起重写，不存在第二份。

    _task = "新写" if creating else "重写"
    prompt = f"""你是资深短剧编剧。请根据用户的修改意见，{_task}以下大纲中第{episode_order}集的内容。

{_near}

## 当前第{episode_order}集
- 标题: {target.get('title', '') or ('（尚未生成，本次新写）' if creating else '')}
- 正文:
{target.get('synopsis', '') or ('（尚未生成，紧接上一集往下写）' if creating else '')}

## 用户修改意见
{payload.feedback}

## 上下文
- 上一集（标题 + 正文）: {(prev_ep.get('title', '') + chr(10) + str(prev_ep.get('synopsis') or '')) if prev_ep else '(无)'}
- 下一集（标题 + 正文）: {(next_ep.get('title', '') + chr(10) + str(next_ep.get('synopsis') or '')) if next_ep else '(无)'}
- 全剧主线: {outline.get('synopsis', '')}

## 要求
1. 按意见重写本集**整段正文**，不只是改标题。标题若需要跟着改，也一并给出。
2. 正文按要素写，每个要素一段，顺序如下；【结尾钩子】必填，其余要素按需取舍：

【开场卡点】这一集开场时，谁被卡在什么处境上——接住上一集结尾的悬置。
【冲突】谁要什么、谁挡着，两人争的具体是哪一件事。
【期待点】观众看到这里最想看到的那一下，以及它落在哪。
【互动】本集最主要的一来一回：谁先出手、对方怎么接、局面怎么变。
【转折】本集哪个时刻局面变了，从什么变成了什么。
【爽点】本集最值回票价的那一下，写成能被拍出来的画面或台词。
【结尾钩子】这一集最后落在哪句话或哪个动作上，观众为什么非点下一集。

3. 要素之外**不要**再加别的标签（尤其不要写"地点""时间""在场人物"）—— 地点与人物由剧本按场次决定。
4. 写的要是能被拍出来的东西：谁做了什么、说了哪句话。不写"她意识到事情不对"这类结论。
5. 人物只用上面已经出场的人，姓名与身份保持不变；与上下集衔接自然；整体风格一致。
6. 只写这一集的剧情，不写分析、不复述修改意见、不解释为什么这么安排。
7. 输出 JSON: {{"title": "本集标题", "synopsis": "整段要素正文（要素之间用换行分隔）"}}
8. 仅输出 JSON，不要解释。"""

    try:
        from .log_helper import save_log
        await save_log(draft_id, "outline", f"第{episode_order}集根据意见重写: {payload.feedback[:50]}...", "log", episode_order)
    except Exception:
        pass

    llm = get_llm("rewrite", temperature=0.7, provider=model_provider)
    resp = await llm.ainvoke(prompt)
    raw = resp.content.strip()

    # 保险丝: 截断输出不落库(否则下方兜底会把残缺 raw 塞进 synopsis)
    from ..models.llm import looks_truncated as _lt, finish_reason_of as _fr
    if _lt(resp, raw, min_len=10):
        raise HTTPException(502, f"大纲重写输出异常(finish_reason={_fr(resp)}), 已保留原大纲, 请重试")
    
    # 解析JSON
    import re
    # 契约里有嵌套对象，原来的 r'\{[^{}]+\}' 匹配不到外层 → 现在取首尾大括号之间
    _l, _r = raw.find("{"), raw.rfind("}")
    json_match = raw[_l:_r + 1] if 0 <= _l < _r else ""
    if json_match:
        try:
            new_ep = json.loads(json_match)
        except Exception:
            new_ep = {"title": target.get("title", ""), "synopsis": raw}
    else:
        new_ep = {"title": target.get("title", ""), "synopsis": raw}
    
    # 更新大纲
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        outline = draft.outline or {}
        chapters = outline.get("chapters", [])
        if creating and not any(c.get("order") == episode_order for c in chapters):
            chapters.append({"order": episode_order, "title": "", "synopsis": "", "version": 0})
            chapters.sort(key=lambda c: int(c.get("order") or 0))
            outline["chapters"] = chapters
        for ch in chapters:
            if ch.get("order") == episode_order:
                _old_syn = str(ch.get("synopsis") or "")
                _new_syn = new_ep.get("synopsis", ch.get("synopsis", ""))
                _old_title = str(ch.get("title") or "")
                _new_title = new_ep.get("title", ch.get("title", ""))
                # 🔴 2026-10-10：按意见重生成大纲这一集之前**先留痕**。
                # 与其它"AI 覆写"路径同款：用户给了意见让 AI 重出，产出的可能是
                # 另一个走向，旧正文必须能切回（工作台大纲块上的"历史"角标读的就是它）。
                if not creating and (_new_syn != _old_syn or str(_new_title) != _old_title):
                    from .candidate_store import snapshot_in
                    await snapshot_in(
                        s, draft_id=draft_id, order=episode_order, stage="outline",
                        content=dict(ch), version=int(ch.get("version") or 1),
                        created_by="ai_rewrite",
                    )
                    ch["version"] = int(ch.get("version") or 1) + 1
                ch["title"] = _new_title
                ch["synopsis"] = _new_syn
                # 2026-11-07：不再写回契约字段，也不再打 `_beats_stale`。
                # 正文整段被重写了，旧契约/旧节拍与新正文必然不一致 —— 与其留着
                # 一份会和正文打架的第二事实（模型读它、用户看不见），不如清掉：
                # 下游对缺失字段一律返回空串，只有 synopsis 说了算。
                for _k in _STALE_CONTRACT_KEYS:
                    ch.pop(_k, None)
                break
        draft.outline = outline
        if creating and episode_order > int(draft.episode_count or 0):
            draft.episode_count = episode_order
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(draft, "outline")
        # 大纲修改后标记对应章节和剧本过期
        from sqlalchemy import update as _upd_ep
        await s.execute(_upd_ep(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == episode_order).values(is_stale=1))
        await s.execute(_upd_ep(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == episode_order).values(is_stale=1))
        await s.commit()
    
    try:
        await save_log(draft_id, "outline", f"第{episode_order}集意见重写完成", "done", episode_order, {"feedback": payload.feedback, "new_episode": new_ep})
    except Exception:
        pass
    
    return {"ok": True, "episode_order": episode_order, "new_episode": new_ep, "created": creating}


from .chapter_gen import generate_chapter, summarize_chapter, detect_name_drift
from .episode_render import build_contract_block, build_beats_block



class FeedbackRegenerateIn(BaseModel):
    feedback: str = Field(..., description="用户的修改意见")


class ExpandOutlineIn(BaseModel):
    """「补全本集大纲」入参。"""
    orders: list[int] | None = Field(
        None, description="要扩写的集号；不传 = 自动挑「只有梗概、没有节拍」的集")
    start: int = Field(0, description="范围起点（含）；0 表示不限")
    end: int = Field(0, description="范围终点（含）；0 表示不限")
    overwrite: bool = Field(
        False, description="是否覆盖已有的场景节拍。默认 False = 只补空缺，"
                           "已有的一个字不动（重复点安全）")
    limit: int = Field(
        0, description="本次最多扩写多少集；0 = 全部待补的集")


@router.post("/drafts/{draft_id}/outline/expand", dependencies=[Depends(require_draft_access)])
async def expand_outline_episodes(draft_id: int, payload: ExpandOutlineIn,
                                  user: User = Depends(get_current_user)):
    """把小/薄的大纲**扩写**成有节拍、有契约的大纲。

    ## 为什么要有这个端点（2026-10-09 用户提问）

    > "用户导入大纲或原文时，大纲往往缺失甚至空白…信息量过少，导致生成剧本时
    >   AI 还是会胡乱编造。"

    实测：**51 字梗概 → 4423 字剧本**（87 倍）。编造无法完全避免，但可以
    **换个地方发生** —— 从"剧本层偷偷补"挪到"大纲层明着补"：

        现在：写剧本时暗补 → 用户读完成片才发现 → 只能整集重生成赌运气
        改为：先补大纲 → 用户在大纲页看见"原来你打算这么演" → 改两条节拍再生成

    ## 只填空、不覆盖（默认）
    与 `settings_backfill` 同一套安全原则：已有的 `beats` 不覆盖、契约逐**键**判断。
    所以重复点是安全的。`title` / `synopsis` **永不改动** —— 那是用户写的剧情。
    """
    from .outline_expand import (
        expand_episodes, expandable_orders, merge_expanded, MAX_EPISODES_PER_CALL,
    )

    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user, for_write=True)
        d = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.id == draft_id).with_for_update()
        )).scalar_one_or_none()
        if not d:
            raise HTTPException(404, "draft not found")
        outline = dict(d.outline or {})
        provider = d.model_provider or "gemini"
        # 判"哪些集值得扩写"要排除已有正文的集 —— 那些集走的是"转写正文"的路，
        # 编不了，扩写它们纯属浪费钱。
        have_text = {int(r.chapter_order) for r in (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all() if (r.full_text or "").strip()}

    # 圈定要扩写的集
    if payload.orders:
        want = [int(o) for o in payload.orders
                if int(o) > 0 and int(o) not in have_text]
    else:
        want = [o for o in expandable_orders(outline) if o not in have_text]
        if payload.start or payload.end:
            want = [o for o in want
                    if (not payload.start or o >= payload.start)
                    and (not payload.end or o <= payload.end)]

    if not want:
        eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
        if not eps:
            raise HTTPException(400, "这部剧还没有大纲，没有可以扩写的内容")
        return {
            "ok": True, "expanded": 0, "requested": 0,
            "message": "这几集都已经有场景节拍了，没有需要补的部分 —— "
                       "**没有启动任何调用**。想重做某几集的节拍，"
                       "勾选「覆盖已有节拍」再来一次。",
        }

    requested = len(want)
    if payload.limit and payload.limit > 0:
        want = want[:payload.limit]

    # 扩写：分批调用（内部已按 BATCH_SIZE 切，且单批有质量上限）
    expanded = await expand_episodes(
        outline, want, provider=provider, draft_id=draft_id)

    if not expanded:
        # 一次都没成功 —— 如实报错，绝不写空壳、绝不谎报"已完成"
        raise HTTPException(
            502,
            "扩写没有成功（模型调用或解析失败）。原有大纲**一字未改**，请稍后重试。",
        )

    merged, stats = merge_expanded(outline, expanded, overwrite=payload.overwrite)

    async with session_scope() as s:
        d = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.id == draft_id).with_for_update()
        )).scalar_one_or_none()
        if not d:
            raise HTTPException(404, "draft not found")
        # ⚠️ 必须**重读**再合并：扩写期间用户可能同时改了别的集。
        # 直接写 merged 会把那段并发修改整段盖掉（与 paste/apply 同款考量，
        # 那里是靠 with_for_update 串行化，这里再加上"只写我们碰过的集"）。
        cur = dict(d.outline or {})
        cur_eps = [e for e in (cur.get("chapters") or []) if isinstance(e, dict)]
        new_by_order = {int(e.get("order") or 0): e
                        for e in (merged.get("chapters") or []) if isinstance(e, dict)}
        for i, e in enumerate(cur_eps):
            o = int(e.get("order") or 0)
            if o in expanded and o in new_by_order:
                cur_eps[i] = new_by_order[o]
        # 全新补进来的集（原 outline 里没有的）也带上
        known = {int(e.get("order") or 0) for e in cur_eps}
        for o, e in new_by_order.items():
            if o in expanded and o not in known:
                cur_eps.append(e)
        cur_eps.sort(key=lambda e: int(e.get("order") or 0))
        cur["chapters"] = cur_eps
        d.outline = cur
        flag_modified(d, "outline")
        await s.commit()

    missing = [o for o in want if o not in expanded]
    try:
        from .log_helper import save_log
        await save_log(
            draft_id, "outline",
            f"扩写大纲 {len(expanded)}/{requested} 集"
            + (f"（未成功：{'、'.join(str(o) for o in missing[:10])}）" if missing else ""),
            "done", 0,
        )
    except Exception:  # noqa: BLE001
        pass

    # 人物越界审计汇总：把各集 `_char_audit` 收上来。
    # ⚠️ 这是**提醒**不是拦截 —— 模型产出照常写入，只是告诉用户"这里可能不对劲"。
    # 实测（2026-10-09）强模型会编出全剧不存在的人名，用户不看就发现不了。
    char_issues: dict[int, list[str]] = {}
    for o, rec in expanded.items():
        for msg in (rec.get("_char_audit") or []):
            char_issues.setdefault(o, []).append(msg)

    msg = f"已为 {len(expanded)} 集补出场景节拍与戏剧契约。"
    if missing:
        msg += f" 有 {len(missing)} 集没能补上，可以再点一次重试。"
    if char_issues:
        msg += (f" ⚠️ 有 {len(char_issues)} 集的出场人物在大纲里找不到出处，"
                f"请核对后再生成（详情见下方）。")

    return {
        "ok": True,
        "expanded": len(expanded),
        "requested": requested,
        "missing": missing,
        "filled": stats.get("filled"),
        "beats_added": stats.get("beats_added"),
        "beats_trimmed": stats.get("beats_trimmed"),
        "char_issues": {str(k): v for k, v in sorted(char_issues.items())},
        "orders": sorted(expanded.keys()),
        "message": msg,
    }


@router.get("/drafts/{draft_id}/outline/density", dependencies=[Depends(require_draft_access)])
async def get_outline_density(draft_id: int, user: User = Depends(get_current_user)):
    """这部草稿的「大纲可生成度」—— 每集属于哪一档、直接生成剧本会不会被大量补写。

    零 LLM：只是把"这一集有没有正文/有没有节拍/梗概够不够长"数一遍。
    前端拿它在**生成剧本之前**如实告诉用户风险（见 outline_density 模块说明）。
    """
    from .outline_density import assess_draft

    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    return await assess_draft(draft_id)


class PatchChapterIn(BaseModel):
    title: str | None = None
    full_text: str | None = None
    summary: str | None = None
    locked: int | None = None


@router.get("/drafts/{draft_id}/chapters", dependencies=[Depends(require_draft_access)])
async def list_chapters(draft_id: int, fields: str | None = None):
    """列出草稿章节。

    fields=meta 时只返回集号/标题/锁状态等轻量字段，不含 full_text。
    调用方若只要集号或锁状态（改编室的空卡片、对话工坊的锁判断），
    走全量会把每章正文一并传过去再丢掉 —— 实测单草稿 1.6 MB，
    生产是纯 HTTP/1.1（无多路复用、每源约 6 连接），这类大传输
    只能排队，正是"卡片要等很久才出来"的直接原因。
    """
    async with session_scope() as s:
        if fields == "meta":
            rows = (await s.execute(
                select(
                    ScriptChapter.chapter_order,
                    ScriptChapter.title,
                    ScriptChapter.locked,
                )
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )).all()
            return [
                {"chapter_order": o, "title": t, "locked": lk}
                for o, t, lk in rows
            ]
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id).order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        return [_row_to_dict(c) for c in chs]


@router.post("/drafts/{draft_id}/chapters/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def run_chapter(draft_id: int, chapter_order: int):
    """生成第 chapter_order 章。

    流程：
      1. 取 draft.outline + 前面章节的 summary/full_text
      2. 调 LLM 生成本章正文
      3. 调 LLM 生成本章摘要
      4. 人物名漂移检测
      5. 写入/更新 script_chapters 行
      6. 返回 chapter dict + name_drift_warnings
    """
    # 取 draft
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        outline = draft.outline or {}
        # 不再要求"手动锁定大纲": 有大纲(含 chapters)即可生成章节;
        # 首次生成时自动置 outline_locked=1 (沿用既有状态信号)。
        if not (isinstance(outline, dict) and outline.get("chapters")):
            raise HTTPException(409, "请先生成大纲")
        if not draft.outline_locked:
            draft.outline_locked = 1
            if draft.status == "outline_done":
                draft.status = "outline_locked"
            await s.flush()
        word_target = draft.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET

        # 前面的章节（用于滚动记忆）
        prev_rows = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order < chapter_order)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        prev_chapters = [_row_to_dict(c) for c in prev_rows]
        model_provider = draft.model_provider or "gemini"

    # 调 LLM 生成（session 外，防长事务）
    try:
        full_text = await generate_chapter(
            outline=outline,
            chapter_order=chapter_order,
            word_target=word_target,
            prev_chapters=prev_chapters,
            provider=model_provider,
            draft_id=draft_id,
        )
    except Exception as e:
        logger.warning("chapter %s generation failed: %s", chapter_order, e)
        raise HTTPException(500, f"chapter generation failed: {e}")

    # 生成摘要
    try:
        summary = await summarize_chapter(full_text)
    except Exception as e:
        logger.warning("chapter %s summary failed: %s", chapter_order, e)
        summary = ""

    # 人物名漂移检测
    known_names = [c.get("name", "") for c in (outline.get("characters") or [])]
    drift_warnings = detect_name_drift(full_text, known_names)

    # 取本章 outline 元数据
    ch_meta = next((c for c in (outline.get("chapters") or []) if c.get("order") == chapter_order), {})

    # 写入 DB
    async with session_scope() as s:
        existing = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        if existing:
            existing.title = ch_meta.get("title", existing.title)
            existing.full_text = full_text
            existing.summary = summary
            existing.word_count = len(full_text)
            row = existing
        else:
            row = ScriptChapter(
                draft_id=draft_id,
                chapter_order=chapter_order,
                title=ch_meta.get("title", f"第{chapter_order}章"),
                full_text=full_text,
                summary=summary,
                word_count=len(full_text),
            )
            s.add(row)
        await s.flush()
        await s.refresh(row)
        result = _row_to_dict(row)

    # 章节生成完成:清除自身过期标记,标记剧本过期
    async with session_scope() as s:
        from sqlalchemy import update as _upd2
        await s.execute(_upd2(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order).values(is_stale=0))
        await s.execute(_upd2(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))

    result["name_drift_warnings"] = drift_warnings
    return result


@router.patch("/drafts/{draft_id}/chapters/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def patch_chapter(draft_id: int, chapter_order: int, payload: PatchChapterIn):
    """手动编辑/锁定章节。

    Phase 3 §37.4.1: 当 full_text 变更时,把"修改前"内容写入 script_episode_history,
    支持后续从历史版本侧栏一键恢复。
    """
    from .router_m5_enhanced import _save_episode_history
    async with session_scope() as s:
        row = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        data = payload.model_dump(exclude_unset=True)
        if not row:
            # 该集尚无章节记录 → 直接新建(upsert)。
            # 目的: 让"空态卡片"也能直接粘贴保存 —— 用户常在对话工坊生成内容后
            # 想贴进一个还没生成过的集, 若这里 404, 就必须先跑一次生成才能编辑。
            # 与 adapt_products 的 _upsert_adaptation 行为对齐(那边本来就会新建)。
            if data.get("full_text") is None and data.get("title") is None:
                raise HTTPException(404, "chapter not found")
            # 「从无到有」同样要留一版空快照。否则用户在空集上一键替换后想撤销,
            # 会因为查不到任何历史而卡死(前端报"没有可回退的历史版本")。
            # 存 v1=空 → 内容落在 v2, 撤销即回到替换前的空白态, 与"已有行"路径同形。
            await _save_episode_history(
                draft_id=draft_id,
                episode_order=chapter_order,
                stage="chapter",
                content={"full_text": "", "title": data.get("title") or f"第{chapter_order}章"},
                version=1,
                created_by="user_edit",
            )
            row = ScriptChapter(
                draft_id=draft_id,
                chapter_order=chapter_order,
                title=data.get("title") or f"第{chapter_order}章",
                full_text=data.get("full_text") or "",
                # 没给摘要就留空（不要用正文前 200 字冒充）。读取侧遇空退全文。
                summary=(data.get("summary") or ""),
                word_count=len(data.get("full_text") or ""),
                version=2,
            )
            s.add(row)
            await s.flush()
            await s.refresh(row)
            return _row_to_dict(row)

        # Phase 3: 在 full_text 真的发生变化时,先把"修改前"快照写入历史,版本号 +1
        will_save_history = (
            "full_text" in data
            and data["full_text"] is not None
            and data["full_text"] != (row.full_text or "")
        )
        if will_save_history:
            old_version = int(row.version or 1)
            await _save_episode_history(
                draft_id=draft_id,
                episode_order=chapter_order,
                stage="chapter",
                content={"full_text": row.full_text or "", "title": row.title or ""},
                version=old_version,
                created_by="user_edit",
            )

        for k, v in data.items():
            if hasattr(row, k):
                setattr(row, k, v)
        if "full_text" in data and data["full_text"] is not None:
            row.word_count = len(data["full_text"])
            # 章节内容修改,标记对应剧本为过期
            from sqlalchemy import update as _upd
            await s.execute(_upd(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))
        if will_save_history:
            row.version = int(row.version or 1) + 1
        await s.flush()
        await s.refresh(row)
        return _row_to_dict(row)


class BatchChapterItemIn(BaseModel):
    chapter_order: int
    full_text: str
    title: str | None = None


class BatchChapterIn(BaseModel):
    items: list[BatchChapterItemIn]


@router.put("/drafts/{draft_id}/chapters/batch", dependencies=[Depends(require_draft_access)])
async def batch_save_chapters(
    draft_id: int, payload: BatchChapterIn, user: User = Depends(get_current_user),
):
    """批量保存多章正文（新版工作台右半页「整篇保存」用）。

    ## 为什么需要它
    在这之前只有逐章 `PATCH`。而新工作台右半页是**一份整篇文稿**：
    用户改了三处、点一次「保存全部」，若仍逐章发请求，
    就会出现"第 2 章存了、第 3 章失败"的半成功状态 ——
    前端既不能说清结果，用户也不知道该重试哪一章。

    这里一次事务覆盖多章，并返回 updated/skipped 明细。

    ## 与逐章 PATCH 的关系
    语义**完全对齐**（含 upsert 与历史留痕），只是不再一个一个发：
      · 已有的章 → 覆盖 full_text，变化时写一版历史，version+1
      · 不存在的章 → 新建（v1 空快照 + v2 内容），与 PATCH 的"从无到有"同形
    这样"空集上直接粘贴"在新旧两条路径上行为一致。

    ⚠️ 与 storyboards 的批量不同：那边**跳过**不存在的集
    （剧本必须依附于已有的一集），这边**新建**（正文可以从零贴进来）。
    差异是刻意的，不是漏改。
    """
    from .router_m5_enhanced import _save_episode_history
    from sqlalchemy import update as _upd

    updated: list[int] = []
    created: list[int] = []
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user, for_write=True)
        for item in payload.items:
            row = (await s.execute(
                select(ScriptChapter).where(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.chapter_order == item.chapter_order,
                )
            )).scalar_one_or_none()

            if not row:
                # 与 patch_chapter 的 upsert 分支同形：先留一版空快照，
                # 否则用户在空集上粘贴后想撤销会找不到任何历史。
                await _save_episode_history(
                    draft_id=draft_id,
                    episode_order=item.chapter_order,
                    stage="chapter",
                    content={"full_text": "", "title": item.title or f"第{item.chapter_order}章"},
                    version=1,
                    created_by="user_edit",
                )
                s.add(ScriptChapter(
                    draft_id=draft_id,
                    chapter_order=item.chapter_order,
                    title=item.title or f"第{item.chapter_order}章",
                    full_text=item.full_text or "",
                    # 没给摘要就留空（不要用正文前 200 字冒充）。读取侧遇空退全文。
                    summary="",
                    word_count=len(item.full_text or ""),
                    version=2,
                ))
                created.append(item.chapter_order)
                continue

            new_text = item.full_text or ""
            will_save_history = new_text != (row.full_text or "")
            if will_save_history:
                await _save_episode_history(
                    draft_id=draft_id,
                    episode_order=item.chapter_order,
                    stage="chapter",
                    content={"full_text": row.full_text or "", "title": row.title or ""},
                    version=int(row.version or 1),
                    created_by="user_edit",
                )
                row.version = int(row.version or 1) + 1
            if item.title:
                row.title = item.title
            row.full_text = new_text
            row.word_count = len(new_text)
            if will_save_history:
                # 正文变了 → 对应剧本标记过期（与逐章 PATCH 一致）
                await s.execute(_upd(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == item.chapter_order,
                ).values(is_stale=1))
            updated.append(item.chapter_order)
        await s.flush()
    return {"ok": True, "updated": updated, "created": created, "total": len(payload.items)}


@router.delete("/drafts/{draft_id}/chapters/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def delete_chapter(draft_id: int, chapter_order: int):
    async with session_scope() as s:
        await s.execute(
            delete(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order,
            )
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# M5.4: 剧本（Storyboard）端点
# ---------------------------------------------------------------------------
from .storyboard_gen import generate_storyboard, generate_storyboard_from_outline


class PatchStoryboardIn(BaseModel):
    shots_json: list[dict] | None = None
    locked: int | None = None



def _neighbor_text_for_rewrite(row: Any, order: int) -> str:
    """重写时给上一章/下一章看什么文字 —— 走统一口径取**原文**。

    没有这一章（如第 1 集没有上一章）或该章还没正文时返回空串，
    由调用方渲染成 `(无)`。
    """
    if row is None:
        return ""
    from .episode_text import pick_episode_text
    text, _form = pick_episode_text(
        {"order": order}, row, purpose="lookahead", budget_chars=8_000)
    return text or ""


# 🔴 2026-10-18: 6ee8a7a 在装饰器与本函数之间插入了 _neighbor_text_for_rewrite，
# 装饰器于是挂到了那个辅助函数上 —— 本接口一直返回 422（要求 query 参数 row/order），
# 草稿页「按意见重写正文」完全不可用。装饰器必须紧贴本函数。
@router.post("/drafts/{draft_id}/chapters/{chapter_order}/regenerate-with-feedback", dependencies=[Depends(require_draft_access)])
async def regenerate_chapter_with_feedback(draft_id: int, chapter_order: int, payload: FeedbackRegenerateIn):
    """根据用户修改意见重新生成章节,传入上下章节上下文确保连贯"""
    from ..models.llm import get_llm
    
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        model_provider = draft.model_provider or "gemini"
        outline = draft.outline or {}
        
        # 获取当前章节
        current = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order)
        )).scalar_one_or_none()
        current_text = current.full_text if current else ""

        # 上一章 / 下一章的**原文**
        #
        # ⚠️ 2026-10-10：原来取的是 `prev.summary` / `nxt.summary`（摘要）。
        # 重写这一集时，模型要判断"改成这样会不会和上下集撞车/断链"，
        # 靠摘要是判断不了的 —— 摘要已经把具体的动作、物件、台词压掉了，
        # 而撞车恰恰发生在这些细节上。用户已定结论："直接用原文而非梗概"。
        # 摘要兜底由 `episode_text` 统一处理（含假摘要识别、预算裁剪、不返回空）。
        prev = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id,
                                        ScriptChapter.chapter_order == chapter_order - 1)
        )).scalar_one_or_none()
        nxt = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id,
                                        ScriptChapter.chapter_order == chapter_order + 1)
        )).scalar_one_or_none()
        prev_summary = _neighbor_text_for_rewrite(prev, chapter_order - 1)
        next_summary = _neighbor_text_for_rewrite(nxt, chapter_order + 1)
    
    # 构建rewrite prompt
    from ..prompt.loader import load_active_template as _lat2
    _ch_tpl = None
    try: _ch_tpl = await _lat2("chapter_rewrite")
    except: pass
    if _ch_tpl:
        prompt = _ch_tpl.format(current_text=current_text, feedback=payload.feedback, prev_summary=prev_summary or '(无)', next_summary=next_summary or '(无)')
    else:
        prompt = f"你是资深短剧编剧。请根据用户修改意见重写章节。\n\n原文:\n{current_text}\n\n修改意见:\n{payload.feedback}\n\n上章摘要: {prev_summary or '(无)'}\n下章摘要: {next_summary or '(无)'}\n\n要求: 根据意见调整,与上下章衔接,输出完整章节正文,不要解释"

    try:
        from .log_helper import save_log
        await save_log(draft_id, "chapter", f"第{chapter_order}章根据意见重写: {payload.feedback[:50]}...", "log", chapter_order)
    except Exception:
        pass
    
    # streaming=False: 推理模型下流式聚合会提前截断长输出; 全局已不设 max_tokens
    llm = get_llm("rewrite", temperature=0.7, provider=model_provider, streaming=False)
    resp = await llm.ainvoke(prompt)
    new_text = resp.content.strip()

    # 保险丝: 截断/异常输出绝不覆盖用户章节正文(draft 1273 同款污染防线)
    from ..models.llm import looks_truncated, finish_reason_of
    if looks_truncated(resp, new_text, min_len=100):
        raise HTTPException(
            502,
            f"重写输出异常(finish_reason={finish_reason_of(resp)}, 仅{len(new_text)}字), "
            f"已保留原文未覆盖, 请重试",
        )
    
    # 生成摘要
    try:
        from .chapter_gen import summarize_chapter
        summary = await summarize_chapter(new_text)
    except Exception:
        # ⚠️ 2026-10-10：原来退化成 `new_text[:200]`（正文前 200 字）。
        # 那不是摘要，是截断 —— 会在读取侧被 `is_trustworthy_summary` 判为
        # 不可信，最终仍走全文。既然如此，不如直接写空，语义诚实：
        # **"没有摘要" ≠ "这集只讲了前 200 字"**。
        # 用户裁定：兜底应当是这一集的全文，由读取侧从 full_text 取。
        summary = ""

    # 更新章节
    async with session_scope() as s:
        ch = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order)
        )).scalar_one_or_none()
        if ch:
            ch.full_text = new_text
            ch.summary = summary
            ch.word_count = len(new_text)
        else:
            s.add(ScriptChapter(draft_id=draft_id, chapter_order=chapter_order, title=f"第{chapter_order}章", full_text=new_text, summary=summary, word_count=len(new_text)))
        # 重写成功即"新鲜": 清自身 is_stale(与单集生成路径 line 850 对齐), 同时标记剧本过期。
        # 漏清会让"按意见重写"后的章节一直挂着已过期红标, 用户以为没生效。
        from sqlalchemy import update as _upd_ch2
        await s.execute(_upd_ch2(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order).values(is_stale=0))
        await s.execute(_upd_ch2(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))
        await s.commit()
    
    try:
        await save_log(draft_id, "chapter", f"第{chapter_order}章意见重写完成({len(new_text)}字)", "done", chapter_order, {"feedback": payload.feedback})
    except Exception:
        pass
    
    return {"ok": True, "chapter_order": chapter_order, "word_count": len(new_text)}


@router.get("/drafts/{draft_id}/storyboards", dependencies=[Depends(require_draft_access)])
async def list_storyboards(draft_id: int):
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id).order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        return [_row_to_dict(r) for r in rows]


@router.post("/drafts/{draft_id}/storyboards/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def run_storyboard(draft_id: int, chapter_order: int):
    """生成第 chapter_order 集的剧本。

    优先用已生成的章节正文; 若该集没有章节正文(允许"大纲直接生成剧本"),
    则回退用大纲里本集的 synopsis + 全剧上下文扩写生成。
    """
    chapter_text = ""
    chapter_title = f"第{chapter_order}章"
    outline_synopsis = ""
    outline_context = ""
    async with session_scope() as s:
        ch = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        if ch:
            chapter_text = ch.full_text or ""
            chapter_title = ch.title or f"第{chapter_order}章"

        draft_for_model = await s.get(ScriptDraft, draft_id)
        model_provider = (draft_for_model.model_provider if draft_for_model else None) or "gemini"
        sb_word_target = int((draft_for_model.chapter_word_target if draft_for_model else 0) or 0)

        # 章节正文缺失时, 从大纲取本集梗概作为 fallback 输入
        if not (chapter_text or "").strip() and draft_for_model:
            outline = draft_for_model.outline or {}
            if isinstance(outline, dict):
                chapters = outline.get("chapters") or []
                cur = next((c for c in chapters if int(c.get("order", 0)) == chapter_order), None)
                if cur is None and 1 <= chapter_order <= len(chapters):
                    cur = chapters[chapter_order - 1]
                if cur:
                    outline_synopsis = str(cur.get("synopsis", "") or "").strip()
                    if not chapter_title or chapter_title == f"第{chapter_order}章":
                        chapter_title = str(cur.get("title", "") or "").strip() or chapter_title
                # 全剧上下文: 标题 + 全剧梗概。
                # 🔴 2026-10-09：**不再**把「上一集梗概 / 下一集梗概」放进来。
                # 用户已定结论：衔接要直接用**上下集原文**而非梗概；而梗概是模型
                # 的二次产物，偏差会被当成"已发生的事实"继承放大（草稿 2421 的
                # 第 5 章摘要污染一路传到第 19 章）。眼下若继续留着梗概，同一条
                # 信息会以两个口径（原文 + 梗概）同时进 prompt，按哪个写不确定。
                # 原文改由下方 generate_storyboard_from_outline 的 prev/next_text
                # 传入，取不到才退回梗概，两者不会同时出现。
                ctx_parts = []
                if outline.get("title"):
                    ctx_parts.append(f"【全剧标题】{outline['title']}")
                if outline.get("synopsis"):
                    ctx_parts.append(f"【全剧主线】{outline['synopsis']}")
                outline_context = "\n".join(ctx_parts)

    use_outline = not (chapter_text or "").strip()
    if use_outline and not outline_synopsis.strip():
        raise HTTPException(400, "该集既无章节正文, 大纲中也无本集梗概; 请先生成大纲或章节")

    # 🔴 2026-10-05: 与批量路径同款 —— 注入上一集实际正文 + 状态账本,
    # 否则单集端点与批量端点对同一集产出不一致(前者重演、后者不重演)。
    # 🔴 2026-10-09: 扩为**上下集都取原文**（用户已定结论；取不到才退回梗概）。
    _prev_text = ""
    _next_text = ""
    _ledger_block = ""
    if use_outline:
        try:
            from .divergence import effective_ledger
            _led = await effective_ledger(draft_id) or None
            if _led and chapter_order > 1:
                from .state_ledger import snapshot_text
                _ledger_block = snapshot_text(_led, chapter_order - 1)
        except Exception as _e:  # noqa: BLE001
            logger.warning("单集剧本: 账本获取失败: %s", _e)
        try:
            from .episode_render import collect_neighbor_originals, _synopsis_fallback
            _nb = await collect_neighbor_originals(
                draft_id=draft_id, order=chapter_order, outline=outline)
            for _k, _n in (("prev", chapter_order - 1), ("next", chapter_order + 1)):
                if not _nb.get(_k) and _n >= 1:
                    _fb = _synopsis_fallback(outline, _n)
                    if _fb:
                        _nb[_k] = _fb
            _prev_text = _nb.get("prev") or ""
            _next_text = _nb.get("next") or ""
        except Exception as _e:  # noqa: BLE001
            # 取不到只是少一层衔接上下文，不该让整集失败；但要留痕，
            # 否则会静默退化成"看不见相邻集"的老行为。
            logger.warning("单集剧本: 取相邻集原文失败(本集仍会生成): %s", _e)

    try:
        if use_outline:
            shots = await generate_storyboard_from_outline(
                episode_order=chapter_order,
                synopsis=outline_synopsis,
                chapter_title=chapter_title,
                context=outline_context,
                provider=model_provider,
                word_target=sb_word_target,
                draft_id=draft_id,
                prev_text=_prev_text,
                next_text=_next_text,
                ledger_block=_ledger_block,
                # 🔴 2026-10-09：与批量路径同款 —— 契约与节拍必须进来。
                # 单集端点与批量端点若对同一集给出不同的输入，产出就会不一致。
                contract_block=build_contract_block(outline, chapter_order),
                beats_block=build_beats_block(outline, chapter_order),
            )
        else:
            shots = await generate_storyboard(
                episode_order=chapter_order,
                chapter_text=chapter_text,
                chapter_title=chapter_title,
                provider=model_provider,
                word_target=sb_word_target,
                draft_id=draft_id,
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("storyboard %s gen failed: %s", chapter_order, e)
        raise HTTPException(500, f"storyboard generation failed: {e}")

    async with session_scope() as s:
        existing = (await s.execute(
            select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        if existing:
            # ⚠️ 2026-10-10：AI 重新生成前先留痕。此前这里直写 ——
            # 用户点一次"重新生成"，旧剧本**当场消失且无从找回**。
            # 而这正是用户报"重新生成后想切换旧版本"的那个场景（v2 工作台
            # 剧本块上的"重新生成"按钮走的就是本端点）。
            # 存**裸列表**形状，与库里 3532 条既有 storyboard 历史保持一致。
            _old_shots = existing.shots_json or []
            if _old_shots != (shots or []):
                from .candidate_store import snapshot_in
                await snapshot_in(
                    s, draft_id=draft_id, order=chapter_order, stage="storyboard",
                    content=_old_shots,
                    version=int(getattr(existing, "version", 1) or 1),
                    created_by="ai_generate",
                )
                existing.version = int(getattr(existing, "version", 1) or 1) + 1
            existing.shots_json = shots
            row = existing
        else:
            row = ScriptStoryboard(
                draft_id=draft_id,
                chapter_order=chapter_order,
                shots_json=shots,
            )
            s.add(row)
        row.is_stale = 0  # 清除过期标记
        await s.flush()
        await s.refresh(row)
        return _row_to_dict(row)


@router.patch("/drafts/{draft_id}/storyboards/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def patch_storyboard(
    draft_id: int, chapter_order: int, payload: PatchStoryboardIn,
    user: User = Depends(get_current_user),
):
    """手动编辑/锁定剧本。

    与 patch_chapter 对齐(见本文件 patch_chapter):
    shots_json 真的变化时, 先把"修改前"快照写入 script_episode_history(stage=storyboard),
    版本号 +1, 支持从历史侧栏一键恢复。

    ⚠ 补齐历史快照的原因: 对话工坊的"一键替换"是直写不确认的, 撤销完全依赖这份快照。
    在此之前本端点既无快照也无鉴权(该文件多数路由都带 _check_draft_access, 这个是漏网),
    剧本因此是四类产物里唯一不可撤销的 —— 恰恰又是唯一结构化的。
    """
    from .router_m5_enhanced import _save_episode_history
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user, for_write=True)
        row = (await s.execute(
            select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        data = payload.model_dump(exclude_unset=True)
        if not row:
            # 同 patch_chapter: 该集尚无剧本记录时直接新建, 让空态卡片可直接粘贴保存。
            if data.get("shots_json") is None:
                raise HTTPException(404, "storyboard not found")
            # 「从无到有」同样要留一版空快照。否则用户在空集上一键替换后想撤销,
            # 会因为查不到任何历史而卡死(前端报"没有可回退的历史版本")。
            # 存 v1=空 → 内容落在 v2, 撤销即回到替换前的空白态, 与"已有行"路径同形。
            await _save_episode_history(
                draft_id=draft_id,
                episode_order=chapter_order,
                stage="storyboard",
                content={"shots_json": []},
                version=1,
                created_by="user_edit",
            )
            row = ScriptStoryboard(
                draft_id=draft_id,
                chapter_order=chapter_order,
                shots_json=data.get("shots_json") or [],
                version=2,
            )
            s.add(row)
            await s.flush()
            await s.refresh(row)
            return _row_to_dict(row)

        # shots_json 真的变化时才存快照 / 升版本(只传 locked 的请求不算改动)。
        # 注: 2026-09 起**不再**因 row.locked 拒绝写入。剧本锁没有任何界面入口
        # 能打开或解除, 现网 0 行处于锁定态, 这条拦截只会把用户卡死在
        # "提示已锁定、却没有地方解锁"的死角(对话工坊一键替换首当其冲)。
        # 锁保留为记录位, 见 router_m5_enhanced.py::lock_storyboard。
        will_change_shots = (
            "shots_json" in data
            and data["shots_json"] is not None
            and data["shots_json"] != (row.shots_json or [])
        )

        if will_change_shots:
            await _save_episode_history(
                draft_id=draft_id,
                episode_order=chapter_order,
                stage="storyboard",
                content={"shots_json": row.shots_json or []},
                version=int(row.version or 1),
                created_by="user_edit",
            )

        for k, v in data.items():
            if hasattr(row, k):
                setattr(row, k, v)
        if will_change_shots:
            row.version = int(row.version or 1) + 1
        await s.flush()
        await s.refresh(row)
        return _row_to_dict(row)


class BatchStoryboardItemIn(BaseModel):
    chapter_order: int
    shots_json: list[dict]


class BatchStoryboardIn(BaseModel):
    items: list[BatchStoryboardItemIn]


@router.put("/drafts/{draft_id}/storyboards/batch", dependencies=[Depends(require_draft_access)])
async def batch_save_storyboards(
    draft_id: int, payload: BatchStoryboardIn, user: User = Depends(get_current_user),
):
    """批量保存多集 storyboard 的 shots_json (需求1「全文视图」总保存)。

    一次事务覆盖多集, 避免前端循环逐集 PATCH 的半成功问题。

    ⚠️ 2026-09-21 起**不存在的集会被创建**(upsert), 不再一律 skip:
    新版工作台把"预设集数"里还没生成的集也摆出来让用户手写/粘贴,
    若这里坚持"只更新已存在的行", 用户在空集里写完保存会被静默丢掉。

    仅在集号**超出这部剧的集数范围**时才 skip —— 那种请求只可能是脏数据,
    建出来会变成谁也看不到的孤儿行。
    """
    updated: list[int] = []
    skipped: list[int] = []
    created: list[int] = []
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user, for_write=True)
        draft = await s.get(ScriptDraft, draft_id)
        # 集数上限: episode_count 为主, 大纲已有集数兜底(旧草稿可能没写 episode_count)
        outline_eps = len(((draft.outline or {}).get("chapters") or [])) if draft else 0
        max_order = max(int(getattr(draft, "episode_count", 0) or 0), outline_eps)
        for item in payload.items:
            row = (await s.execute(
                select(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == item.chapter_order,
                )
            )).scalar_one_or_none()
            if not row:
                if item.chapter_order < 1 or (max_order and item.chapter_order > max_order):
                    skipped.append(item.chapter_order)
                    continue
                row = ScriptStoryboard(
                    draft_id=draft_id, chapter_order=item.chapter_order, shots_json=[],
                )
                s.add(row)
                created.append(item.chapter_order)
            else:
                # ⚠️ 2026-10-10：覆盖前留痕。此前这里**没有任何快照** ——
                # 单集 PATCH 有（见 patch_storyboard），批量端点却直写不确认。
                # 而工作台"点开即编辑、失焦即保存"走的正是这条批量端点，
                # 即：**用户在剧本页签改一集，改前的版本就此消失**。
                # 这恰好是用户报"少了历史版本"最实的那个洞。
                #
                # 只在内容**真的变了**时存：失焦即保存会频繁触发，内容没变也存
                # 会把每集 10 条上限迅速塞满同样的内容，把真历史挤掉。
                if (row.shots_json or []) != (item.shots_json or []):
                    from .candidate_store import snapshot_in
                    await snapshot_in(
                        s, draft_id=draft_id, order=item.chapter_order,
                        stage="storyboard", content=row.shots_json or [],
                        version=int(getattr(row, "version", 1) or 1),
                        created_by="user_edit",
                    )
                    row.version = int(getattr(row, "version", 1) or 1) + 1
            row.shots_json = item.shots_json
            if item.chapter_order not in created:
                updated.append(item.chapter_order)
        await s.flush()
    return {"ok": True, "updated": updated, "created": created, "skipped": skipped}


@router.delete("/drafts/{draft_id}/storyboards/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def delete_storyboard(draft_id: int, chapter_order: int):
    async with session_scope() as s:
        await s.execute(
            delete(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order,
            )
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# 批量生成 (SSE实时反馈)
# ---------------------------------------------------------------------------
from fastapi.responses import StreamingResponse


@router.post("/drafts/{draft_id}/storyboards/{chapter_order}/regenerate-with-feedback", dependencies=[Depends(require_draft_access)])
async def regenerate_storyboard_with_feedback(draft_id: int, chapter_order: int, payload: FeedbackRegenerateIn):
    """根据用户修改意见重新生成剧本(分镜)。

    ⚠️ 剧本(storyboard)与原文(chapter)是两套独立数据: 现代流程"大纲直接生成剧本"没有原文。
    因此本端点只以"该集剧本存在"为前置, 不再强依赖 ScriptChapter(旧 bug 会误报 404)。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        model_provider = draft.model_provider or "gemini"

        # 现有剧本(要改的对象): 这才是"重做剧本"的真正前置。剧本存在即可重做, 与原文无关。
        sb = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order)
        )).scalar_one_or_none()

        # 章节正文(可选): 有则用作更丰富的输入, 无则回退大纲梗概。
        # ⚠️ 关键修复: 现代流程"大纲直接生成剧本"没有原文, 之前强依赖 ScriptChapter 会误报 404,
        #   导致有 50 集剧本却因 0 篇原文而无法逐集重做。现在改剧本只以"剧本存在"为前置。
        ch = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order)
        )).scalar_one_or_none()

        if not sb and not ch:
            # 剧本和原文都没有这一集 → 确实没内容可改
            raise HTTPException(404, "storyboard not found: 该集尚无剧本, 请先生成剧本")

        # 组装重做输入源: 优先原文 → 否则大纲该集 synopsis + 现有剧本文本
        outline = (draft.outline or {}) if isinstance(draft.outline, dict) else {}
        ol_chapters = outline.get("chapters") or []
        ep_meta = next((c for c in ol_chapters if int(c.get("order", 0)) == chapter_order), {})
        ep_title = (ch.title if ch and ch.title else str(ep_meta.get("title", "") or f"第{chapter_order}集"))
        ep_synopsis = str(ep_meta.get("synopsis", "") or "")
        current_sb_text = json.dumps(sb.shots_json, ensure_ascii=False) if sb and sb.shots_json else "无"

        if ch and (ch.full_text or "").strip():
            # 🔴 2026-10-19：有正文时原先**只给正文、不给当前剧本**，于是"按意见修改"实际是
            # 从正文重新生成 —— 上一轮按意见改好的地方被冲掉，多轮意见无法叠加（Agent 逐集对照
            # 原文反复提意见的用法因此做不成）。现在当前剧本是底稿、正文是参照。
            source_text = ch.full_text
        else:
            # 无原文: 用大纲梗概 + 现有剧本作为改写依据(与批量"大纲直接生成剧本"同源)
            parts = []
            if outline.get("title"):
                parts.append(f"【全剧标题】{outline['title']}")
            if outline.get("synopsis"):
                parts.append(f"【全剧主线】{outline['synopsis']}")
            parts.append(f"【本集({chapter_order}) 梗概】{ep_synopsis or '(无梗概, 参照现有剧本)'}")
            parts.append(f"【本集现有剧本(在此基础上按意见修改)】\n{current_sb_text}")
            source_text = "\n".join(parts)

    from .storyboard_gen import generate_storyboard

    try:
        from .log_helper import save_log
        await save_log(draft_id, "storyboard", f"第{chapter_order}集剧本根据意见重写: {payload.feedback[:50]}...", "log", chapter_order)
    except Exception:
        pass

    # 重新生成剧本(带feedback)
    if sb and sb.shots_json:
        # 已有剧本：在它的基础上按意见修改（正文只作参照）。见 storyboard_gen.revise_storyboard。
        from .storyboard_gen import revise_storyboard
        try:
            shots = await revise_storyboard(
                current_shots=sb.shots_json, feedback=payload.feedback, title=ep_title,
                order=chapter_order,
                reference_text=(ch.full_text if ch and (ch.full_text or "").strip() else ""),
                provider=model_provider, draft_id=draft_id)
        except ValueError as e:
            raise HTTPException(502, str(e))
    else:
        prompt_extra = f"\n\n## 用户修改意见\n{payload.feedback}\n请根据以上意见调整剧本,同时保持原有格式。"
        shots = await generate_storyboard(
            episode_order=chapter_order,
            chapter_text=source_text + prompt_extra,
            chapter_title=ep_title,
            provider=model_provider,
            draft_id=draft_id,
        )
    
    # 更新剧本
    async with session_scope() as s:
        existing = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order)
        )).scalar_one_or_none()
        if existing:
            # ⚠️ 2026-10-10：按意见重写同样是**AI 覆盖**，同样要留痕 ——
            # 用户给出修改意见让 AI 重写，产出的可能是另一个走向，旧版必须能切回。
            _old_shots = existing.shots_json or []
            if _old_shots != (shots or []):
                from .candidate_store import snapshot_in
                await snapshot_in(
                    s, draft_id=draft_id, order=chapter_order, stage="storyboard",
                    content=_old_shots,
                    version=int(getattr(existing, "version", 1) or 1),
                    created_by="ai_rewrite",
                )
                existing.version = int(getattr(existing, "version", 1) or 1) + 1
            existing.shots_json = shots
            # 重做成功即"新鲜": 必须清 is_stale, 否则刚按意见重写完的剧本仍挂着
            # "已过期"红标, 用户以为没生效而反复重做。(批量路径靠 delete+insert 天然
            # 避开; 单集普通生成在 line 1149 已清, 只有这条"按意见重写"漏了。)
            existing.is_stale = 0
        else:
            s.add(ScriptStoryboard(draft_id=draft_id, chapter_order=chapter_order, shots_json=shots))
        await s.commit()
    
    try:
        await save_log(draft_id, "storyboard", f"第{chapter_order}章剧本意见重写完成({len(shots)}镜)", "done", chapter_order, {"feedback": payload.feedback})
    except Exception:
        pass
    
    return {"ok": True, "chapter_order": chapter_order, "shot_count": len(shots)}

from .batch_gen import batch_generate_chapters, batch_generate_storyboards, direct_generate_storyboards
from .progress_helper import get_progress_snapshot, is_progress_running


@router.get("/drafts/{draft_id}/chapters/batch", dependencies=[Depends(require_draft_access)])
async def batch_gen_chapters(draft_id: int):
    """批量生成所有章节 - SSE实时反馈(受并发限制)"""
    global _current_running, _current_waiting
    _current_waiting += 1
    async def _wrapped():
        global _current_running, _current_waiting
        _current_waiting -= 1
        _current_running += 1
        try:
            async with _generation_semaphore:
                async for chunk in batch_generate_chapters(draft_id):
                    yield chunk
        finally:
            _current_running -= 1
    return StreamingResponse(
        _wrapped(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/drafts/{draft_id}/storyboards/batch", dependencies=[Depends(require_draft_access)])
async def batch_gen_storyboards(draft_id: int):
    """批量生成所有剧本 - SSE实时反馈(受并发限制)"""
    global _current_running, _current_waiting
    _current_waiting += 1
    async def _wrapped():
        global _current_running, _current_waiting
        _current_waiting -= 1
        _current_running += 1
        try:
            async with _generation_semaphore:
                async for chunk in batch_generate_storyboards(draft_id):
                    yield chunk
        finally:
            _current_running -= 1
    return StreamingResponse(
        _wrapped(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


import asyncio as _asyncio
import os as _os

# ========== 全局生成队列 ==========
# 所有生成任务通过队列排队执行,防止内存爆炸
# 并发数可通过环境变量 MAX_CONCURRENT_GENERATIONS 动态调整
# 默认锁定 500: 之前默认3是最大瓶颈, 导致批量精修/生成串行、agent_batch 超时误判。
# 上层各批量模块(agent_batch/batch_create/critique)已各自限流, 这里放到500不会内存爆炸。
MAX_CONCURRENT_GENERATIONS = int(_os.environ.get("MAX_CONCURRENT_GENERATIONS", "500"))
_generation_semaphore = _asyncio.Semaphore(MAX_CONCURRENT_GENERATIONS)
_queue_counter = 0       # 累计入队数
_current_running = 0     # 当前正在运行的任务数
_current_waiting = 0     # 当前排队等待的任务数

logger.info("生成队列初始化: max_concurrent=%d", MAX_CONCURRENT_GENERATIONS)

# 全局任务跟踪(简单版)
_running_tasks: dict[int, _asyncio.Task] = {}

async def _consume_generator(gen, draft_id: int | None = None):
    """消耗异步生成器(后台运行,丢弃yield结果)。

    ## 为什么把 draft_id 和异常处理写在这里（2026-10-08）

    原来这里只有一句 `logger.error("后台任务异常: %s")`，等于把失败**扔进空气**：

    1. **应用层日志根本没进 docker logs** —— 实测这个容器的 stdout 里只有 uvicorn
       的 access log，零条 `logger.*` 输出。所以那句 error 在线上从来没人看得到。
    2. 生成器抛异常时**不会走 finish_progress**，`outline.progress.sub_stage` 就
       永远停在 `running`。前端要等 180 秒心跳超时才认为它停了，而用户在这 180 秒
       里看到的是一条**永不前进的进度条**。

    实测事故（dev 草稿 669，用户甲）：强制重写跑到第 14 集时进程被重建，任务
    凭空消失；更早两次停在第 11、13 集，**原因至今查不出来** —— 就是因为这句
    异常没有任何持久化痕迹。

    现在异常会：写 traceback 进 `generation_logs`（用户在前端「生成日志」里直接
    能看到）+ 把进度如实标 `failed`。**不许静默**。
    """
    try:
        async for _ in gen:
            pass
    except Exception as e:  # noqa: BLE001
        import traceback as _tb
        detail = _tb.format_exc()
        logger.error("后台任务异常 draft=%s: %s\n%s", draft_id, e, detail)
        if draft_id:
            # 双写：日志给用户看，progress 给状态栏看。
            # 两者都要 —— 只写日志的话进度条依旧卡在 running；
            # 只写 progress 的话用户不知道到底为什么失败。
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "system",
                    f"❌ 后台任务异常中断: {type(e).__name__}: {str(e)[:300]}",
                    "error", None,
                    {"error": str(e)[:2000], "traceback": detail[-4000:]},
                )
            except Exception:  # noqa: BLE001
                pass
            try:
                from .progress_helper import finish_progress, get_progress_snapshot, is_progress_running
                snap = await get_progress_snapshot(draft_id)
                if is_progress_running(snap):
                    await finish_progress(
                        draft_id, success=False,
                        message=f"任务异常中断: {type(e).__name__}: {str(e)[:150]}")
            except Exception:  # noqa: BLE001
                pass


@router.post("/drafts/{draft_id}/direct-storyboards/start", dependencies=[Depends(require_draft_access)])
async def start_direct_gen(draft_id: int):
    """启动直接生成剧本任务(后台运行)"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        if draft.status and "generating" in draft.status:
            raise HTTPException(409, f"任务已在运行: {draft.status}")
        user_input = draft.user_input or ""
        episode_count = draft.episode_count or 3
    
    # 启动后台任务(asyncio.create_task,不依赖HTTP连接)
    gen = direct_generate_storyboards(draft_id, user_input, episode_count)
    task = _asyncio.create_task(_consume_generator(gen, draft_id))
    _running_tasks[draft_id] = task
    
    return {"ok": True, "message": "后台任务已启动", "draft_id": draft_id}


# ---------------------------------------------------------------------------
# 后台批量生成: 章节/剧本 (持久化进度版本,刷新页面也能看到进度)
# ---------------------------------------------------------------------------

def _is_draft_task_alive(draft_id: int) -> bool:
    """进程内任务表里是否有正在跑的任务"""
    t = _running_tasks.get(draft_id)
    return bool(t) and (not t.done())


async def _check_running_or_409(draft_id: int) -> None:
    """如果该 draft 已有任务在跑，直接 409 拒绝重复触发。

    🔴 2026-10-22 生产事故修复：这里原先只看**进程内**那一套
    （`_running_tasks` + `outline.progress`），看不见队列作业（`agent_jobs`）。
    于是「Agent 建了作业 #239」与「用户在顶栏点补全」可以同时跑，互相覆盖；
    实测 2679 上批量先写完了 18~20 集，Agent 的作业被领到时待办已空，
    回 done + generated:0，用户等了一场空。

    现在统一走 `progress_helper.draft_activity`，三套机制一起看
    （进程内批量 / 队列作业 / 整本精修）。判活阈值仍由各自机制自己决定。
    """
    from .progress_helper import draft_activity

    if _is_draft_task_alive(draft_id):
        raise HTTPException(409, "该草稿仍有后台任务在运行,请等待当前任务完成")
    act = await draft_activity(draft_id)
    if act.get("busy"):
        # 报出**具体是谁**在跑 —— 只说"有任务"会让用户以为是幽灵任务。
        raise HTTPException(
            409,
            f"该草稿正在执行 {act.get('summary')}，请等它完成或先取消。",
        )


@router.post("/drafts/{draft_id}/chapters/batch/start", dependencies=[Depends(require_draft_access)])
async def start_batch_chapters(draft_id: int, force_regenerate: bool = Query(False)):
    """启动后台章节批量生成(不依赖 HTTP 连接,刷新页面也不中断)

    Args:
        force_regenerate: 是否强制重新生成所有章节
            False (默认): 只补缺失 / 重生 stale, 已存在且未过期的跳过
            True: 把**所有**章节标 stale 并强制重生

    ⚠️ 2026-10-06 修正: force 以前只标"未锁定"章节, 而 locked 是个**用户无从操作**的
    僵尸字段 —— 导入剧本时后端会无条件给每一集打 locked=1 (`:2137` / `:2284` / `:2546`
    以及 `agent/chat_skills.py:1730`), 前端却没有任何锁定/解锁入口。后果是: 对**导入的
    草稿**点「强制重写」, 日志写的是"已标记 0 个未锁定章节为过期", 然后逐集全部跳过,
    一集不写、一次模型调用都不发 —— 用户看到的就是"按钮没用"(dev 库 generation_logs
    里有大量此记录, 草稿 644 是 60 集全锁定、647 是 83 集全锁定)。
    一个用户看不见也动不了的标记, 不该静默否决一个明确的"强制"指令。
    locked 字段本身保留(导出选源要用, 见 export-source-suggest)。
    """
    await _check_running_or_409(draft_id)
    if force_regenerate:
        async with session_scope() as s:
            from sqlalchemy import update as _upd_fr
            n = (await s.execute(
                _upd_fr(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
                .values(is_stale=1)
            )).rowcount
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "chapter",
                    f"🔄 强制重新生成全部: 已标记 {n} 个章节为过期(含导入时自动锁定的), 即将批量重生",
                    "log", None, {"affected_chapters": n, "force": True},
                )
            except Exception:
                pass
    gen = batch_generate_chapters(draft_id, force=force_regenerate)
    task = _asyncio.create_task(_consume_generator(gen, draft_id))
    _running_tasks[draft_id] = task
    return {
        "ok": True,
        "draft_id": draft_id,
        "force": force_regenerate,
        "message": "章节批量生成已在后台启动" + (" (强制重写未锁定章节)" if force_regenerate else ""),
    }


@router.post("/drafts/{draft_id}/storyboards/batch/start", dependencies=[Depends(require_draft_access)])
async def start_batch_storyboards(draft_id: int, force_regenerate: bool = Query(False)):
    """启动后台剧本批量生成(不依赖 HTTP 连接,刷新页面也不中断)

    Args:
        force_regenerate: True 时把所有剧本标 stale 后强制重写; 剧本无 locked 概念, 全部覆盖
    """
    await _check_running_or_409(draft_id)
    if force_regenerate:
        async with session_scope() as s:
            from sqlalchemy import update as _upd_fr2
            n = (await s.execute(
                _upd_fr2(ScriptStoryboard)
                .where(ScriptStoryboard.draft_id == draft_id)
                .values(is_stale=1)
            )).rowcount
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "storyboard",
                    f"🔄 强制重新生成全部: 已标记 {n} 个剧本为过期, 即将批量重生",
                    "log", None, {"affected_storyboards": n, "force": True},
                )
            except Exception:
                pass
    gen = batch_generate_storyboards(draft_id, force=force_regenerate)
    task = _asyncio.create_task(_consume_generator(gen, draft_id))
    _running_tasks[draft_id] = task
    return {
        "ok": True,
        "draft_id": draft_id,
        "force": force_regenerate,
        "message": "剧本批量生成已在后台启动" + (" (强制重写所有剧本)" if force_regenerate else ""),
    }


@router.post("/drafts/{draft_id}/batch/cancel", dependencies=[Depends(require_draft_access)])
async def cancel_batch(draft_id: int):
    """请求停止该草稿正在跑的批量生成任务(正文 / 剧本)。

    为什么要这个端点: 批量任务跑在进程内(`_running_tasks` + outline.progress),
    **不建 AgentJob**, 所以队列那套 `POST /v1/agent/jobs/{id}/cancel` 覆盖不到它。
    一次 60 集的强制重写要按小时计, 用户中途想停却完全没办法 ——
    `_running_tasks` 里连一处 `.cancel()` 都没有。

    ⚠️ **不能直接 task.cancel()**: 那样会在 LLM 调用中途抛 CancelledError,
    已生成到一半的那一集走不到 save_candidate, 而 asyncio 取消又不会落
    finish_progress —— 进度会永远停在 running, 前端要等 180 秒心跳超时才
    发现停了。所以这里只**置一个标志**, 由 batch_gen 的循环在"上一集已落库、
    下一集还没发请求"的安全边界退出, 照常走完收尾。

    返回的 `stopped` 是"信号已发出", 不代表已经停了 —— 单集 LLM 调用无法中途
    打断, 最长要等这一集跑完。前端必须如实区分这两种状态。
    """
    from .progress_helper import request_cancel, is_progress_running
    snap = await get_progress_snapshot(draft_id)
    if not is_progress_running(snap):
        # 没有在跑的批量任务。可能它刚好已经结束, 也可能这次是队列作业
        # (精修/去AI味), 那种该走 /v1/agent/jobs/{id}/cancel。
        return {
            "ok": False,
            "stopped": False,
            "message": "当前没有正在跑的批量生成任务。"
                       "如果跑的是精修/去 AI 味，请用对应作业的取消。",
        }
    ok = await request_cancel(draft_id)
    return {
        "ok": True,
        "stopped": ok,
        "stage": snap.get("stage"),
        "current": snap.get("current"),
        "total": snap.get("total"),
        "message": "已请求停止，会在当前这一集跑完后停下（单集生成无法中途打断）。",
    }


# ---------------------------------------------------------------------------
# 安全审核: 关键词扫描结果查询 + AI 深度审核
# ---------------------------------------------------------------------------
from ..safety import scan_text, scan_storyboard_shots
from ..safety.scanner import format_hits_for_log


@router.get("/drafts/{draft_id}/safety/scan")
async def safety_scan_draft(
    draft_id: int,
    chapter_order: int | None = None,
    user: User = Depends(get_current_user),
):
    """对指定章节(或全部章节+剧本)做关键词扫描,实时返回结果。
    不依赖之前生成时写入的 generation_logs,每次重新扫描。
    """
    from dataclasses import asdict as _asdict
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

        ch_stmt = select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        if chapter_order is not None:
            ch_stmt = ch_stmt.where(ScriptChapter.chapter_order == chapter_order)
        chs = (await s.execute(ch_stmt.order_by(ScriptChapter.chapter_order))).scalars().all()

        sb_stmt = select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        if chapter_order is not None:
            sb_stmt = sb_stmt.where(ScriptStoryboard.chapter_order == chapter_order)
        sbs = (await s.execute(sb_stmt.order_by(ScriptStoryboard.chapter_order))).scalars().all()

    results: list[dict] = []
    for c in chs:
        hits = scan_text(c.full_text or "")
        if hits:
            results.append({
                "scope": "chapter",
                "chapter_order": c.chapter_order,
                "title": c.title,
                "hits": [_asdict(h) for h in hits],
                "summary": format_hits_for_log(hits),
            })
    for sb in sbs:
        hits = scan_storyboard_shots(sb.shots_json or [])
        if hits:
            results.append({
                "scope": "storyboard",
                "chapter_order": sb.chapter_order,
                "hits": [_asdict(h) for h in hits],
                "summary": format_hits_for_log(hits),
            })

    return {
        "ok": True,
        "draft_id": draft_id,
        "total_issues": sum(len(r["hits"]) for r in results),
        "results": results,
    }


class AIReviewIn(BaseModel):
    chapter_order: int
    scope: str = "chapter"  # chapter | storyboard
    provider: str = "deepseek"


@router.post("/drafts/{draft_id}/safety/ai-review", deprecated=True)
async def safety_ai_review(draft_id: int, payload: AIReviewIn):
    """⛔ 已下线（2026-09-21 用户裁定）。

    这个端点原来会对每一集正文/剧本调一次 LLM 做"合规审核"，判据是
    2025-11 那份《动画微短剧(漫剧)内容创作建议》。下线的两个理由：

      1. **判据过时**：那份标准不符合现在的要求，照它审出来的结论没有参考价值；
      2. **纯烧钱**：前端还有个"全量深度审核"会把整部剧逐集跑一遍（并发 5），
         一部 109 集的剧就是 109 次模型调用，换回一堆过时判断。

    返回 410 而不是直接删路由：老前端/老书签打过来能看到原因，
    而不是一个让人以为"服务坏了"的 404。
    """
    raise HTTPException(
        410,
        "AI 深度审核已下线：判据（2025-11 漫剧内容创作建议）已过时，逐集调用模型纯属浪费。"
        "如需自查可用 GET /safety/scan（本地关键词扫描，不花钱）。",
    )


@router.get("/drafts/{draft_id}/progress")
async def get_draft_progress(draft_id: int, user: User = Depends(get_current_user)):
    """查询 draft 的实时生成进度(章节/剧本批量任务的心跳数据)

    返回:
        stage:        chapters / storyboards / outline / video / idle
        sub_stage:    running / done / failed / ""
        current/total
        running:      bool, 是否仍在运行(基于 last_beat_at < 180s)
        last_message: 最近一条进度文案
        last_beat_at: 最后心跳时间(ISO)
        in_memory_running: 进程内还有任务对象
        eps:          逐集结果 [{order,state,reason}], 供状态栏展开看"哪几集成了/跳过/失败"
        cancel_requested: 是否已请求取消(等当前这一集跑完才真正停)
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

    snap = await get_progress_snapshot(draft_id)
    # 自愈：progress 说"running"但心跳早没了 → 就地收成 failed，别让横幅永远转圈。
    # 这一步是幂等的、只在确实僵尸时写库，正常跑的任务每集都在 tick，不会被碰。
    if snap.get("sub_stage") == "running" and not snap.get("running"):
        from .progress_helper import reap_stale_progress
        if await reap_stale_progress(draft_id):
            snap = await get_progress_snapshot(draft_id)
    snap["in_memory_running"] = _is_draft_task_alive(draft_id)
    # 任意一边在跑就视为运行中
    snap["running"] = bool(snap.get("running") or snap["in_memory_running"])

    # 🔴 2026-10-22：把**队列作业**也并进来。
    # 此前这个端点只反映进程内批量（outline.progress），而 Agent / 对话栏发起的生成
    # 走的是 agent_jobs —— 用户在等一个"不会出现在这里"的任务，界面全程无提示，
    # 表现就是"点了没反应"。前端此前只在底部状态栏单独读 /v1/agent/jobs，
    # 顶部进度条看不到它。
    from .progress_helper import draft_activity
    act = await draft_activity(draft_id)
    snap["activity"] = act
    snap["queue_running"] = any(x["mechanism"] == "queue" for x in act.get("sources") or [])
    snap["running"] = bool(snap["running"] or act.get("busy"))
    return snap


@router.get("/drafts/{draft_id}/direct-storyboards", dependencies=[Depends(require_draft_access)])
async def direct_gen_storyboards(draft_id: int):
    """直接生成剧本(隐式生成大纲/章节) - SSE实时反馈(保留兼容)"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        user_input = draft.user_input or ""
        episode_count = draft.episode_count or 3
    
    return StreamingResponse(
        direct_generate_storyboards(draft_id, user_input, episode_count),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


# ---------------------------------------------------------------------------
# 批量上传文件创建草稿
# ---------------------------------------------------------------------------
from fastapi import File
from typing import List
from .file_upload import parse_file


@router.post("/drafts/batch-upload/preview", dependencies=[Depends(get_current_user)])
async def batch_upload_preview(
    files: List[UploadFile] = File(...),
    prefer_firstline_title: bool = Form(False),
):
    """步骤1: 解析文件并返回预览信息(不创建草稿)
    
    返回每个文件的: title, word_count, length_category, error
    前端根据这些信息允许用户:
    - 修改title
    - 删除不想导入的文件
    - 根据length_category选择处理模式
    """
    if len(files) > 20:
        raise HTTPException(400, "最多上传20个文件")
    
    # 导入智能章节切分
    from .import_script import smart_split_chapters as _split
    
    results = []
    for f in files:
        parsed = await parse_file(f, prefer_firstline_title=prefer_firstline_title)
        content = parsed.get("content", "")
        
        # 智能检测章节数(如果文本长度>500字才检测)
        detected_chapters = 0
        if content and len(content) > 500:
            try:
                split_result = _split(content)
                detected_chapters = len(split_result)
            except Exception:
                detected_chapters = 0
        
        results.append({
            "filename": parsed.get("filename"),
            "file_type": parsed.get("file_type"),
            "title": parsed.get("title"),
            "word_count": parsed.get("word_count", 0),
            "length_category": parsed.get("length_category", ""),
            "detected_chapters": detected_chapters,  # 检测到的章节数,0表示未检测到
            "preview": content[:300] + ("..." if len(content) > 300 else ""),
            "error": parsed.get("error"),
            "content": content,
        })
    
    # 汇总
    short_count = sum(1 for r in results if r["length_category"] == "short")
    medium_count = sum(1 for r in results if r["length_category"] == "medium")
    long_count = sum(1 for r in results if r["length_category"] == "long")
    error_count = sum(1 for r in results if r["error"])
    
    return {
        "ok": True,
        "items": results,
        "summary": {
            "total": len(results),
            "short": short_count,
            "medium": medium_count,
            "long": long_count,
            "errors": error_count,
        }
    }


@router.post("/drafts/batch-upload/split-preview", dependencies=[Depends(get_current_user)])
async def batch_upload_split_preview(
    file: UploadFile = File(...),
):
    """针对单个文件进行章节切分预览,返回完整章节列表(含content)"""
    parsed = await parse_file(file)
    if parsed["error"]:
        raise HTTPException(400, parsed["error"])
    
    from .import_script import smart_split_chapters as _split
    content = parsed["content"]
    try:
        chapters = _split(content)
    except Exception as e:
        chapters = [{"order": 1, "title": "第1章", "content": content}]
    
    return {
        "ok": True,
        "filename": parsed["filename"],
        "title": parsed["title"],
        "word_count": parsed["word_count"],
        "chapters": chapters,
    }


@router.post("/drafts/create-from-chapters")
async def create_draft_from_chapters(payload: dict, user: User = Depends(get_current_user)):
    """根据用户编辑后的章节列表创建草稿(给批量上传的章节编辑器用)"""
    title = payload.get("title", "导入的剧本").strip() or "导入的剧本"
    chapters_data = payload.get("chapters") or []
    from ..models.catalog import sanitize_provider_spec
    model_provider = sanitize_provider_spec(
        payload.get("model_provider"), ("gemini", "deepseek", "gpt5", "grok"), "gemini")
    auto_storyboard = payload.get("auto_storyboard", True)
    
    if not chapters_data:
        raise HTTPException(400, "至少需要1个章节")
    
    # 规范化章节order
    for i, ch in enumerate(chapters_data):
        ch["order"] = i + 1
    
    outline = {
        "title": title,
        "synopsis": "(从已有剧本导入)",
        "characters": [],
        "world": {},
        "chapters": [
            {
                "order": ch["order"],
                "title": ch.get("title", f"第{ch['order']}集"),
                "synopsis": (ch.get("content") or "")[:200],
                "must_have": [],
                "characters": [],
            }
            for ch in chapters_data
        ],
    }
    
    async with session_scope() as s:
        draft = ScriptDraft(
            session_id=f"upload_edited_{int(time.time())}",
            user_id=user.id,
            title=title,
            user_input="(从已有剧本导入,用户编辑章节)",
            episode_count=len(chapters_data),
            model_provider=model_provider,
            status="imported",
            outline=outline,
            outline_locked=1,
        )
        s.add(draft)
        await s.flush()
        draft_id = draft.id
        
        for ch in chapters_data:
            content = ch.get("content", "") or ""
            # ⚠️ 2026-10-10：summary 不再用 `content[:500]`。
            #
            # 那写出来的不是摘要，是**正文的前 500 字**。全库实测有 2319 章
            # 是这么来的（占 29%），它们在对话上下文里被当成"这一集的实况"，
            # 于是 AI 每集只看得到开头 —— 平均可见度只有 32%。
            #
            # 现在留空，由读取侧 `stages/episode_text.pick_episode_text` 处理：
            # 空 → 判定"不可信摘要" → **退回本集全文**。这正是用户 2026-10-10
            # 的裁定："摘要失败情况下的兜底应该是这一集的全文"，不是留空、
            # 更不是截断。导入时也不必为此跑 N 次 LLM 调用。
            chapter_row = ScriptChapter(
                draft_id=draft_id,
                chapter_order=ch["order"],
                title=ch.get("title", f"第{ch['order']}集"),
                summary="",
                full_text=content,
                word_count=len(content),
                locked=1,
                version=1,
            )
            s.add(chapter_row)
    
    if auto_storyboard:
        try:
            gen = batch_generate_storyboards(draft_id)
            task = _asyncio.create_task(_consume_generator(gen, draft_id))
            _running_tasks[draft_id] = task
        except Exception:
            pass
    
    return {
        "ok": True,
        "draft_id": draft_id,
        "chapter_count": len(chapters_data),
        "title": title,
    }


@router.post("/drafts/batch-upload")
async def batch_upload_drafts(
    files: List[UploadFile] = File(...),
    episode_count: int = Form(3),  # 全局默认集数(per-file可覆盖)
    model_provider: str = Form("gemini"),
    mode: str = Form("draft_only"),  # draft_only/auto_outline/full_pipeline/import_script
    prefer_firstline_title: bool = Form(False),
    titles_override: str = Form(""),  # JSON: {"filename": "新标题"}
    episode_counts: str = Form(""),  # JSON: {"filename": 集数} 手动模式下的集数
    split_modes: str = Form(""),  # JSON: {"filename": "auto"|"manual"} 拆分模式
    user: User = Depends(get_current_user),
):
    """批量上传文件创建草稿(深度优化版)
    
    支持格式: .txt, .docx, .pdf, .md
    限制: 单文件<10MB, 批量<20个
    
    处理模式(mode):
    - draft_only: 仅创建草稿(默认,等待手动生成)
    - auto_outline: 创建草稿+自动生成大纲(后台)
    - full_pipeline: 完整流水线(大纲+章节+剧本,后台)
    - import_script: 作为已有剧本导入(智能切分章节,适合长文)
    """
    from ..models.catalog import sanitize_provider_spec
    # Form 传上来的是自由字符串, 先过白名单: 厂商非法退回 gemini, 型号非法只丢型号,
    # 免得脏值一路存进草稿, 之后每次生成都拿它去喂 get_llm
    model_provider = sanitize_provider_spec(
        model_provider, ("gemini", "deepseek", "gpt5", "grok"), "gemini")

    if len(files) > 20:
        raise HTTPException(400, "最多上传20个文件")
    
    # 解析titles_override
    title_overrides = {}
    if titles_override:
        try:
            title_overrides = json.loads(titles_override)
        except Exception:
            pass
    
    # 解析per-file episode_counts
    episode_count_overrides = {}
    if episode_counts:
        try:
            episode_count_overrides = json.loads(episode_counts)
        except Exception:
            pass
    
    # 解析per-file split_modes
    split_mode_overrides = {}
    if split_modes:
        try:
            split_mode_overrides = json.loads(split_modes)
        except Exception:
            pass
    
    created = []
    failed = []
    
    for file in files:
        parsed = await parse_file(file, prefer_firstline_title=prefer_firstline_title)
        
        if parsed["error"]:
            failed.append({
                "filename": file.filename,
                "error": parsed["error"]
            })
            continue
        
        # 应用用户自定义title/集数/拆分模式
        user_title = title_overrides.get(file.filename or "") or parsed["title"]
        user_episode_count = episode_count_overrides.get(file.filename or "") or episode_count
        user_split_mode = split_mode_overrides.get(file.filename or "", "")  # auto/manual/空
        
        # 如果用户选了auto,强制本文件使用import_script模式
        effective_mode = mode
        if user_split_mode == "auto":
            effective_mode = "import_script"
        
        try:
            if effective_mode == "import_script":
                # 作为已有剧本导入(智能切分章节)
                from .import_script import smart_split_chapters
                chapters_data = smart_split_chapters(parsed["content"])
                
                outline = {
                    "title": user_title,
                    "synopsis": "(从已有剧本导入)",
                    "characters": [],
                    "world": {},
                    "chapters": [
                        {
                            "order": ch["order"],
                            "title": ch.get("title", f"第{ch['order']}集"),
                            "synopsis": ch["content"][:200],
                            "must_have": [],
                            "characters": [],
                        }
                        for ch in chapters_data
                    ],
                }
                
                async with session_scope() as s:
                    draft = ScriptDraft(
                        session_id=f"upload_{file.filename}",
                        user_id=user.id,
                        title=user_title,
                        user_input="(从已有剧本导入)",
                        episode_count=len(chapters_data),
                        model_provider=model_provider,
                        status="imported",
                        outline=outline,
                        outline_locked=1,
                    )
                    s.add(draft)
                    await s.flush()
                    draft_id = draft.id
                    
                    for ch in chapters_data:
                        # summary 留空 = 交给读取侧退回本集全文（见上文 2026-10-10 说明）
                        chapter_row = ScriptChapter(
                            draft_id=draft_id,
                            chapter_order=ch["order"],
                            title=ch.get("title", f"第{ch['order']}集"),
                            summary="",
                            full_text=ch["content"],
                            word_count=len(ch["content"]),
                            locked=1,
                            version=1,
                        )
                        s.add(chapter_row)
                
                # 启动后台剧本生成
                try:
                    gen = batch_generate_storyboards(draft_id)
                    task = _asyncio.create_task(_consume_generator(gen, draft_id))
                    _running_tasks[draft_id] = task
                except Exception:
                    pass

                # 静默反推设定（见 _spawn_silent_backfill 的说明）——
                # 放在这里是有意的：生成剧本那步会把 outline 的
                # characters/world 读走，早一点补上锚点，第一集就吃到。
                _spawn_silent_backfill(draft_id, model_provider)

                created.append({
                    "id": draft_id,
                    "title": user_title,
                    "filename": file.filename,
                    "mode": user_split_mode == "auto" and "auto_split" or "import_script",
                    "chapter_count": len(chapters_data),
                })
            else:
                # 普通模式: draft_only / auto_outline / full_pipeline
                async with session_scope() as s:
                    row = ScriptDraft(
                        session_id=f"upload_{file.filename}",
                        user_id=user.id,
                        title=user_title,
                        user_input=parsed["content"],
                        episode_count=user_episode_count,
                        model_provider=model_provider,
                        status="draft",
                        outline={},
                    )
                    s.add(row)
                    await s.flush()
                    draft_id = row.id
                
                # auto_outline: 后台生成大纲
                if effective_mode in ("auto_outline", "full_pipeline"):
                    async def _auto_outline_task(did=draft_id, uinput=parsed["content"], ecount=user_episode_count, mp=model_provider, full=effective_mode=="full_pipeline"):
                        try:
                            outline = await generate_outline(
                                user_input=uinput,
                                chapter_count=ecount,
                                chapter_word_target=DEFAULT_CHAPTER_WORD_TARGET,
                                provider=mp,
                                draft_id=did,
                            )
                            async with session_scope() as s2:
                                d = await s2.get(ScriptDraft, did)
                                if d:
                                    d.outline = outline
                                    d.outline_locked = 1
                                    d.status = "outline_locked"
                            # full_pipeline继续生成章节和剧本
                            if full:
                                async for _ in batch_generate_chapters(did):
                                    pass
                                async for _ in batch_generate_storyboards(did):
                                    pass
                        except Exception as ex:
                            logger.warning(f"后台自动生成失败 draft={did}: {ex}")
                    task = _asyncio.create_task(_auto_outline_task())
                    _running_tasks[draft_id] = task
                
                created.append({
                    "id": draft_id,
                    "title": user_title,
                    "filename": file.filename,
                    "mode": effective_mode,
                })
        except Exception as e:
            logger.error(f"创建草稿失败 {file.filename}: {e}", exc_info=True)
            failed.append({
                "filename": file.filename,
                "error": str(e)
            })
    
    return {
        "ok": True,
        "created": created,
        "failed": failed,
        "summary": f"成功{len(created)}个, 失败{len(failed)}个",
        "mode": mode,
    }


# ---------------------------------------------------------------------------
# M6: 导入剧本 → 转写为剧本
# ---------------------------------------------------------------------------
from .import_script import (
    parse_script_file,
    smart_split_chapters,
    extract_character_names_fast,
    sanitize_text,
    sanitize_deep,
)


@router.post("/import-script/preview", dependencies=[Depends(get_current_user)])
async def preview_import_script(
    file: UploadFile = File(None),
    content: str = Form(None),
):
    """步骤1: 解析+预览章节切分(不创建草稿,仅供前端确认)

    返回: {chapters: [...], characters: [...], total_words: N, file_name: str}
    """
    # 1. 解析输入
    if file:
        try:
            text = await parse_script_file(file)
        except ValueError as e:
            raise HTTPException(400, str(e))
    elif content:
        text = sanitize_text(content)
    else:
        raise HTTPException(400, "必须提供文件或文本内容")
    
    if not text.strip():
        raise HTTPException(400, "文件内容为空")
    
    # 2. 切分章节
    chapters = smart_split_chapters(text)
    
    # 3. 快速提取角色名
    characters = extract_character_names_fast(text, max_names=30)
    
    return {
        "ok": True,
        "chapters": chapters,
        "characters": characters,
        "total_words": len(text),
        "chapter_count": len(chapters),
        "file_name": file.filename if file else "粘贴文本",
        "raw_text": text[:200] + ("..." if len(text) > 200 else ""),
    }


@router.post("/import-script/create")
async def create_from_imported_script(payload: dict, user: User = Depends(get_current_user)):
    """步骤2: 根据用户确认的章节,创建草稿+章节记录。

    payload: {title, chapters: [{order, title, content}]}

    ## 导入 = **纯原文落库**，零模型调用（2026-09-22 用户裁定）

    此前这里有两个**默认勾选**的开关，都已删除：

    | 开关 | 它做了什么 | 为什么删 |
    |---|---|---|
    | `extract_outline` | 在本请求里**同步 await** 一次 LLM 提炼大纲 | 这正是"导入页长时间卡住"的来源，且产出的大纲质量很低 |
    | `auto_storyboard` | 导入后立刻后台批量生成全剧剧本 | 用户没要就先烧一整本的钱，产出质量也低 |

    连同它们一起去掉的还有两个**无条件**起的后台任务
    （`build_character_cards` / `_spawn_auto_analysis`）——
    它们根本没有开关，每次导入都白跑。三者都有各自的手动入口
    （`phase5_routes` 角色卡、`analysis/start` 剧情分析、「生成剧本」按钮），
    要跑随时能跑，不必在导入时替用户决定。

    > 对话导入路径（`chat_skills.import_script`）**早就**是这个原则，
    > 它的注释写得很清楚："那是三笔真金白银的消耗…擅自替他起点钱的任务是越权"。
    > 本次只是让主页导入与它对齐。

    ⚠️ 大纲骨架**必须**照建（零 LLM：order/title/synopsis 取正文前 200 字）。
    v2 工作台的左侧树完全由 `outline.chapters` 驱动，
    骨架为空的话导入完打开工作台会**一集都看不到**，
    正文明明在库里 —— 这是删开关时最容易踩的坑。
    """
    title = payload.get("title", "导入的剧本").strip() or "导入的剧本"
    chapters_data = payload.get("chapters") or []

    if not chapters_data:
        raise HTTPException(400, "至少需要1个章节")

    # 消毒 + 结构校验。
    #
    # chapters 是**前端原样回传**的，不一定来自 preview（可以是手改过的，
    # 也可以是直接构造的请求）。过去这里对内容零校验，于是：
    #   ① 含 \x00 的正文 → flush 时 psycopg 报 UntranslatableCharacter → 500
    #   ② 缺 order / content 字段 → KeyError → 500
    # 两种都只会让用户看到一句「HTTP 500」（FastAPI 的 500 是纯文本，
    # 前端 res.json() 解析失败后退化成 `HTTP ${status}`）。
    # 落库前一次性挡掉，改成能看懂的 400。
    title = sanitize_text(title)
    cleaned: list[dict] = []
    for i, ch in enumerate(chapters_data):
        if not isinstance(ch, dict):
            raise HTTPException(400, f"第{i + 1}个章节格式不正确")
        body = sanitize_text(str(ch.get("content") or ""))
        if not body.strip():
            raise HTTPException(400, f"第{i + 1}个章节内容为空，请补充或删除该章节")
        try:
            order = int(ch.get("order") or (i + 1))
        except (TypeError, ValueError):
            order = i + 1
        cleaned.append({
            "order": order,
            "title": sanitize_text(str(ch.get("title") or f"第{order}集")),
            "content": body,
        })
    # 集号必须唯一：script_chapters 上有 UNIQUE(draft_id, chapter_order)，
    # 重号会在 flush 时抛 IntegrityError → 又是一个「HTTP 500」。
    # 前端允许用户手动改集号，重号是可预期的输入错误，按 400 报。
    dup = sorted({c["order"] for c in cleaned
                  if [x["order"] for x in cleaned].count(c["order"]) > 1})
    if dup:
        raise HTTPException(400, "集号重复：第" + "、".join(map(str, dup)) + "集出现了多次，请修正后再导入")
    chapters_data = cleaned
    
    # 1. 提取大纲
    outline = {
        "title": title,
        "synopsis": "(从已有剧本导入)",
        "characters": [],
        "world": {},
        "chapters": [],
    }
    
    # 大纲骨架：**零 LLM**，直接用正文前 200 字当梗概。
    # 工作台左侧树完全由 outline.chapters 驱动，这一步不能省 ——
    # 省了就会"正文在库里、界面上一集都没有"。
    # 要更好的梗概/人物/契约，导入后在「设定」面板点「从已有正文补全设定」，
    # 由用户决定何时花那笔钱。
    outline["chapters"] = [
        {
            "order": ch["order"],
            "title": ch.get("title", f"第{ch['order']}集"),
            "synopsis": ch["content"][:200],
            "must_have": [],
            "characters": [],
        }
        for ch in chapters_data
    ]
    
    # 2. 创建草稿
    async with session_scope() as s:
        draft = ScriptDraft(
            session_id=f"import_{int(time.time())}",
            user_id=user.id,
            title=title,
            user_input="(从已有剧本导入)",
            episode_count=len(chapters_data),
            status="imported",
            # outline 里混了 LLM 产出与用户正文切片，两边都可能带脏字符；
            # jsonb 同样不接受 \x00，所以整棵树再过一遍
            outline=sanitize_deep(outline),
            outline_locked=1,  # 直接锁定大纲
        )
        s.add(draft)
        await s.flush()
        draft_id = draft.id
        
        # 3. 创建章节记录(已有完整文本)
        for ch in chapters_data:
            chapter_row = ScriptChapter(
                draft_id=draft_id,
                chapter_order=ch["order"],
                title=ch.get("title", f"第{ch['order']}集"),
                # summary 留空 = 交给读取侧退回本集全文（见 2026-10-10 说明）
                summary="",
                full_text=ch["content"],
                word_count=len(ch["content"]),
                locked=1,  # 章节也锁定
                version=1,
            )
            s.add(chapter_row)
    
    # 4. **不起任何后台任务**（2026-09-22 用户裁定："导入草稿就直接原文导入即可"）。
    #    原来这里无条件起三个：批量生成剧本 / 角色卡库 / 剧情分析 ——
    #    前者要用户勾选（默认勾着），后两个连开关都没有，每次导入都白跑。
    #    它们各自都有手动入口，要跑随时能跑，不必在导入时替用户花这笔钱。
    #
    # ⚠️ 2026-10-08 补一处**例外**：静默反推世界观/角色卡。它不是上面那三个
    #    的翻版 —— 那两个是"替用户决定生成内容"（且要按集烧很多次调用），
    #    这个是**从用户自己的稿子里读出已有事实**，各一次调用，且导入的稿子
    #    本来就有素材（实测用户 9 部里 8 部这三块全空）。
    #    动机是 2026-10-07 的事故：导入草稿的 prompt 里人物表/世界观全空，
    #    模型没有锚点，一跑偏就再也拉不回来（prod 草稿 2421 第 5-19 集整段跑偏）。
    #    不阻塞、不弹窗、不建作业、失败只记日志 —— 用户说的"不该干扰其他操作"。
    _spawn_silent_backfill(draft_id)

    return {
        "ok": True,
        "draft_id": draft_id,
        "chapter_count": len(chapters_data),
        "message": f"已导入 {len(chapters_data)} 集原文",
    }


@router.post("/import-script/extract-characters", dependencies=[Depends(get_current_user)])
async def extract_characters_from_text(payload: dict):
    """从文本提取角色名(用于预览阶段的角色识别)"""
    text = payload.get("text", "")
    if not text:
        raise HTTPException(400, "text不能为空")
    names = extract_character_names_fast(text, max_names=30)
    return {"ok": True, "characters": names}


# ---------------------------------------------------------------------------
# 导入「大纲」(需求3): 解析 + AI拆解混合集 → 预览 → 入库 outline.chapters
# ---------------------------------------------------------------------------
@router.post("/import-outline/preview", dependencies=[Depends(get_current_user)])
async def preview_import_outline(
    file: UploadFile = File(None),
    content: str = Form(None),
    provider: str = Form("gemini"),
):
    """步骤1: 解析大纲文本, 区间(第X-Y集)用 AI 一次性拆解, 返回统一单集列表供预览。

    返回: {episodes:[{order,title,summary}], file_name, count}
    解析后的 order 可能断号/乱序, 交前端纠错 (空集卡片 / 倒退警示)。
    """
    from .import_script import parse_script_file
    from .import_outline import parse_and_split_outline

    if file:
        try:
            text = await parse_script_file(file)
        except ValueError as e:
            raise HTTPException(400, str(e))
    elif content:
        text = content
    else:
        raise HTTPException(400, "必须提供文件或文本内容")

    if not text.strip():
        raise HTTPException(400, "大纲内容为空")

    episodes = await parse_and_split_outline(text, provider=provider)
    if not episodes:
        raise HTTPException(400, "未能从文本中识别出任何集; 请检查集号格式(如「第3集：…」)")

    return {
        "ok": True,
        "episodes": episodes,
        "count": len(episodes),
        "file_name": file.filename if file else "粘贴文本",
    }


@router.post("/import-outline/create")
async def create_from_imported_outline(payload: dict, user: User = Depends(get_current_user)):
    """步骤2: 根据用户在预览页确认/调整后的单集列表, 创建草稿并写入 outline.chapters。

    payload: {
        title: str,
        episodes: [{order, title, summary}],   # 用户已纠错(删空集/重排), order 应连续无空
        model_provider: str,
    }
    入库校验: 不允许 summary 为空的集 (空集卡片), 否则 400 提示"第X集大纲为空"。
    """
    title = (payload.get("title") or "导入的大纲").strip() or "导入的大纲"
    episodes = payload.get("episodes") or []
    from ..models.catalog import sanitize_provider_spec
    model_provider = sanitize_provider_spec(
        payload.get("model_provider"), ("gemini", "deepseek", "gpt5", "grok"), "gemini")

    if not episodes:
        raise HTTPException(400, "至少需要 1 集大纲")

    # 章节构建收敛到 import_outline.build_outline_chapters —— 对话工坊的
    # import_outline 工具调的是同一个函数。两处各写一份的话, 一旦漂移就会出现
    # "导入成功但草稿页空白"(键名/字段名对不上, 页面读不到)这类最难查的故障。
    from .import_outline import build_outline_chapters, make_outline
    try:
        outline_chapters = build_outline_chapters(episodes)
    except ValueError as e:
        raise HTTPException(400, str(e))

    outline = make_outline(title, outline_chapters)

    async with session_scope() as s:
        draft = ScriptDraft(
            session_id=f"import_outline_{int(time.time())}",
            user_id=user.id,
            title=title,
            user_input="(从大纲导入)",
            episode_count=len(outline_chapters),
            model_provider=model_provider,
            status="outline_done",
            outline=outline,
            outline_locked=0,  # 大纲导入后不锁, 允许用户继续编辑/生成章节
        )
        s.add(draft)
        await s.flush()
        draft_id = draft.id

    return {
        "ok": True,
        "draft_id": draft_id,
        "chapter_count": len(outline_chapters),
        "title": title,
        "message": "大纲导入成功",
    }


# ---------------------------------------------------------------------------
# M6: 剧本导出为Word
# ---------------------------------------------------------------------------
from fastapi.responses import Response
from urllib.parse import quote
from .export_docx import export_storyboard_to_docx, export_all_storyboards_to_docx


@router.get("/drafts/{draft_id}/storyboards-export-docx/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def export_chapter_storyboard_docx(draft_id: int, chapter_order: int):
    """导出单章节剧本为Word文档"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        
        # 找到对应章节
        ch_stmt = select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.chapter_order == chapter_order,
        )
        chapter = (await s.execute(ch_stmt)).scalar_one_or_none()
        if not chapter:
            raise HTTPException(404, "chapter not found")
        
        # 获取该章节的剧本(用chapter_order)
        sb_stmt = select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id,
            ScriptStoryboard.chapter_order == chapter_order,
        )
        sb_row = (await s.execute(sb_stmt)).scalar_one_or_none()
        if not sb_row or not sb_row.shots_json:
            raise HTTPException(404, "storyboard not found or empty")
        
        shots = sb_row.shots_json if isinstance(sb_row.shots_json, list) else []
        draft_title = draft.title or "未命名"
        chapter_title = chapter.title or f"第{chapter_order}集"
    
    # 生成docx
    docx_bytes = export_storyboard_to_docx(
        draft_title=draft_title,
        chapter_title=chapter_title,
        chapter_order=chapter_order,
        shots=shots,
    )
    
    filename = f"{draft_title}_第{chapter_order}集_剧本.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


@router.get("/drafts/{draft_id}/os-review-export", dependencies=[Depends(require_draft_access)])
async def export_os_review(draft_id: int):
    """导出内心独白(OS)复核清单 TXT。

    转写时已对无画面价值的 OS 做了过滤(改写/转旁白/删除), 这里把剧本中
    仍保留为 mode=OS 的台词逐条列出, 供用户人工复核是否还需进一步处理。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        sbs = (await s.execute(
            select(ScriptStoryboard)
            .where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        draft_title = draft.title or "未命名"

    lines: list[str] = [f"《{draft_title}》内心独白(OS)复核清单", ""]
    total = 0
    for sb in sbs:
        shots = sb.shots_json if isinstance(sb.shots_json, list) else []
        os_items: list[str] = []
        for shot in shots:
            if not isinstance(shot, dict):
                continue
            scene_no = shot.get("scene_no") or shot.get("shot_no") or ""
            for el in (shot.get("elements") or []):
                if isinstance(el, dict) and el.get("type") == "dialogue" and (el.get("mode") or "") == "OS":
                    content = (el.get("content") or "").strip()
                    if content:
                        os_items.append(f"  [{scene_no}] {el.get('character','')}: {content}")
            # 兼容旧结构: dialogue 字段里带 (OS)
            dlg = shot.get("dialogue") or ""
            if "(OS)" in dlg or "（OS）" in dlg:
                os_items.append(f"  [{scene_no}] {dlg.strip()}")
        if os_items:
            lines.append(f"== 第{sb.chapter_order}集 ==")
            lines.extend(os_items)
            lines.append("")
            total += len(os_items)

    if total == 0:
        lines.append("（未发现保留的内心独白 OS，转写过滤效果良好）")
    else:
        lines.insert(1, f"共 {total} 处保留的 OS，请逐条复核是否需要改写/删除。")

    text = "\n".join(lines)
    filename = f"{draft_title}_内心OS复核清单.txt"
    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


#: 正在重建账本的草稿。**在进程内**去重，防止用户连点两次各跑一遍抽取（白花钱）。
#: 只有一个 orchestrator 进程，够用；真要多副本再挪到 redis。
_LEDGER_REBUILDING: set[int] = set()
#: 持有后台任务引用，避免被 GC 提前回收（asyncio 只保弱引用）
_LEDGER_TASKS: set = set()


@router.post("/drafts/{draft_id}/ledger/refresh", dependencies=[Depends(require_draft_access)])
async def refresh_ledger(draft_id: int):
    """**主动重建状态账本**（用户 2026-09-22 要求，入口在工作台「设定」面板）。

    平时账本是**惰性**更新的：只在生成前/点体检/对话点名某集时，
    按版本指纹补算改过的那几集（见 stages/divergence.py）。
    这在"改几集"的日常场景下开销为零。

    但有两种情况指纹靠不住：
      · 用户**整本导入**了一份新稿（集数与内容全换了，且导入路径根本不建账本）
      · 剧情**大改**（很多集同时变，且改的是秘密/悬念/元素这类短语事实）
    这时需要一次**全量重抽**，所以给用户一个显式按钮。

    ## ⚠️ 为什么要 shield（2026-09-22 用户发现）
    这是个几十秒到几分钟的同步端点。用户点完**刷新页面**，浏览器断开连接，
    Starlette 会取消这个请求处理器 —— 于是**已经花掉的模型调用全部白费、
    一个字都没落库**，而用户毫不知情（实测：断开后等 30 秒仍未落库）。
    用 `asyncio.shield` 把重建包成独立任务：连接断了它照样跑完并写库。

    ## 并发点两次怎么办
    用进程内 in-flight 集合挡住，返回 409 —— 否则第二次点击会再跑一遍全量抽取，
    纯属重复烧钱。
    """
    if draft_id in _LEDGER_REBUILDING:
        raise HTTPException(409, "这部剧的账本正在重建中，请稍候再试。")

    # 先确认"有没有东西可读" —— 没有正文也没有剧本时，重建必然是空的，
    # 与其返回一个让人以为坏了的 "覆盖 0 集"，不如直接说清楚。
    async with session_scope() as s:
        n_src = (await s.execute(select(func.count()).select_from(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.full_text.isnot(None), ScriptChapter.full_text != ""))).scalar() or 0
        if not n_src:
            n_src = (await s.execute(select(func.count()).select_from(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id))).scalar() or 0
    if not n_src:
        raise HTTPException(400, "这部剧还没有正文或剧本，没有可以据此重建账本的内容。")

    from .divergence import effective_ledger

    async def _run() -> dict:
        try:
            return await effective_ledger(draft_id, force=True, scanned=n_src)
        finally:
            _LEDGER_REBUILDING.discard(draft_id)

    _LEDGER_REBUILDING.add(draft_id)
    task = asyncio.ensure_future(_run())
    _LEDGER_TASKS.add(task)
    task.add_done_callback(_LEDGER_TASKS.discard)

    # shield：客户端断开只会取消"等待"，不会取消上面那个任务
    led = await asyncio.shield(task)

    cum = (led or {}).get("cumulative") or {}
    by_ep = (led or {}).get("by_episode") or {}
    return {
        "ok": True,
        "scanned": n_src,
        "episodes_tracked": len([k for k in by_ep if str(k).isdigit()]),
        "refreshed_at": (led or {}).get("refreshed_at"),
        "dead": cum.get("dead") or [],
        "revealed_secrets": cum.get("revealed_secrets") or [],
        "open_threads": cum.get("open_threads") or [],
        "used_elements": cum.get("used_elements") or [],
    }


def _spawn_silent_backfill(draft_id: int, provider: str | None = None) -> None:
    """导入后静默反推世界观 / 角色卡。

    实现已移到 `settings_backfill.spawn_silent_backfill` —— 因为对话导入路径
    (`agent/chat_skills.py`) 也要用它，而那边从本模块导入会造成循环依赖。
    这里只留一个薄转发，保持 router 内两处调用点可读。
    """
    from .settings_backfill import spawn_silent_backfill
    spawn_silent_backfill(draft_id, provider)


@router.post("/drafts/{draft_id}/settings/backfill", dependencies=[Depends(require_draft_access)])
async def backfill_draft_settings(draft_id: int):
    """**从已有稿子反推设定**（用户 2026-09-22 提问："这些没法主动补吗"）。

    「设定」面板上的世界观 / 角色卡 / 分集契约 / 伏笔，原本只有
    "从零让 AI 生成大纲"的草稿才有。导入或粘贴进来的稿子这几块全是空的 ——
    实测用户 9 部里 8 部如此，而其中 7 部有 49–109 集正文，素材一直都在。

    在此之前，唯一能填上这些字段的路径是**重新生成大纲**，
    那会盖掉用户的分集计划，属破坏性操作（`drama_gate` 里那句
    "重新生成这些集的大纲即可补齐契约字段"就是这个意思）。
    本接口是它的非破坏性替代：**只填空，绝不覆盖已有值**，
    `title` / `synopsis` 完全不碰。所以重复点是安全的。

    ⚠️ shield / 409 的理由与 `refresh_ledger` 完全相同：这是个几十秒的同步端点，
    用户点完刷新页面会取消请求处理器，让已花掉的模型调用白费（那个坑刚踩过）。

    ⚠️ 2026-10-08：守卫改用 `settings_backfill.begin_manual` —— 只认**手动**
    那一次，不认静默反推。否则用户导入后马上手动点这里，会因为后台那条静默
    任务正在跑而吃到 409，那正是用户说的"不该干扰其他操作"。
    """
    from .settings_backfill import backfill_settings, begin_manual, end_manual

    if not begin_manual(draft_id):
        raise HTTPException(409, "这部剧的设定正在补全中，请稍候再试。")

    async def _run() -> dict:
        try:
            return await backfill_settings(draft_id)
        finally:
            end_manual(draft_id)

    task = asyncio.ensure_future(_run())
    _LEDGER_TASKS.add(task)
    task.add_done_callback(_LEDGER_TASKS.discard)
    res = await asyncio.shield(task)

    if res.get("skipped") and not any(res.get("filled", {}).values()):
        # 什么都没补上时，把原因说成人话，别返回一个看不懂的全零结果
        if res.get("scanned", 0) == 0:
            raise HTTPException(400, res["skipped"][0])
    return {"ok": True, **res}


def _hook_line(ch: dict) -> str:
    """「下集钩子」的一行人话。空则给一句空态说明。

    字段来源是 `outline.chapters[].hook_out`（导入路径写在 leads_to 里，
    见 import_outline.build_outline_chapters）。三种形状都要能读：
    dict / JSON 字符串 / 干脆是空。
    """
    import json as _json
    ho = (ch or {}).get("hook_out")
    if isinstance(ho, str):
        try:
            ho = _json.loads(ho)
        except Exception:  # noqa: BLE001
            ho = {"leads_to": ho}
    if not isinstance(ho, dict):
        return "（这集没有写）"
    lead = str(ho.get("leads_to") or "").strip()
    typ = str(ho.get("type") or "").strip()
    strength = str(ho.get("strength") or "").strip()
    if not lead:
        return "（这集没有写）"
    tag = typ + (f"／{strength}" if strength else "")
    return f"{lead}" + (f"（{tag}）" if tag else "")


def _export_outline(title: str, span: str, fmt: str, outline: dict,
                    chapters: list) -> Response:
    """把大纲渲染成 docx / txt / md 并返回下载响应。

    2026-10-07 新增。此前 `kind=outline` 根本不存在 —— 用户在大纲页签点「导出」，
    前端把 outline 静默映射成 chapters，于是他拿到的是**正文**（用户报的 bug）。

    渲染尽量复用：docx 直接调 `factory.docx_export.outline_to_docx`（它已经会
    按 简介 / 人物 / 分集大纲 分节排版，是用在"工厂"产线导出上的现成件）；
    txt / md 这里自己拼 —— 仓库里没有大纲的文本渲染器，硬套剧本那套
    （storyboard_to_text）会输出 场:/景:/人物: 这些大纲里根本不存在的东西。

    ## ⚠️ 2026-10-07 二次修：docx 只剩标题
    首次修完「导出成正文」后，用户立刻反馈**导出只有标题、没有大纲内容**。
    根因不在本函数，而在被复用的 `outline_to_docx`：它逐集读的是
    `summary`/`plot`，而大纲每集正文的键是 **`synopsis`**（写入端
    `import_outline.build_outline_chapters` / `outline_gen._norm_chapters` 都造
    这个键，lint、续写、状态账本、auto_batch.docx_zip 也一律读它）。
    `summary` 只是 `parse_and_split_outline` 的中间结构键名，落库前已转写。
    于是 docx 每集只剩标题行、正文全空，**且不报错** —— 而 docx 是默认格式，
    所以只有它能被用户看到。已在 `docx_export.outline_to_docx` 与
    `factory.routes._outline_to_text` 两处补上 synopsis 优先查找。
    """
    from urllib.parse import quote

    ol = dict(outline or {})
    ol["chapters"] = chapters
    fn = f"{title}_{span}_大纲.{fmt}"
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fn)}"}

    if fmt == "docx":
        import json as _json
        from ..factory.docx_export import outline_to_docx
        data = outline_to_docx(title, _json.dumps(ol, ensure_ascii=False))
        return Response(
            content=data,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers=headers)

    parts: list[str] = []
    if fmt == "md":
        parts.append(f"# 《{title}》大纲")
        if ol.get("synopsis"):
            parts.append("## 简介\n\n" + str(ol["synopsis"]))
        chars = ol.get("characters") or []
        if chars:
            rows = []
            for c in chars:
                if isinstance(c, dict):
                    rows.append(f"- **{c.get('name', '')}**：{c.get('description', '')}")
                else:
                    rows.append(f"- {c}")
            parts.append("## 人物\n\n" + "\n".join(rows))
        if chapters:
            rows = [f"## 分集大纲"]
            for ch in chapters:
                ch = ch or {}
                rows.append(f"### 第{ch.get('order', '?')}集  {ch.get('title', '')}")
                body = ch.get("synopsis") or ch.get("summary") or ch.get("plot") or ""
                if body:
                    rows.append(str(body))
                # 「下集钩子」单列一小节 —— 它是用户点名要在大纲里看到的板块
                # （2026-10-23）。空着也照样写出来：导出件是交付物，读者要能看出
                # "这集没写钩子"，而不是以为这一版大纲没有这个概念。
                rows.append("**下集钩子**：" + _hook_line(ch))
            parts.append("\n\n".join(rows))
    else:
        parts.append(f"《{title}》大纲")
        if ol.get("synopsis"):
            parts.append("【简介】\n" + str(ol["synopsis"]))
        chars = ol.get("characters") or []
        if chars:
            rows = []
            for c in chars:
                if isinstance(c, dict):
                    rows.append(f"{c.get('name', '')}：{c.get('description', '')}")
                else:
                    rows.append(str(c))
            parts.append("【人物】\n" + "\n".join(rows))
        if chapters:
            rows = ["【分集大纲】"]
            for ch in chapters:
                ch = ch or {}
                rows.append(f"第{ch.get('order', '?')}集  {ch.get('title', '')}")
                body = ch.get("synopsis") or ch.get("summary") or ch.get("plot") or ""
                if body:
                    rows.append(str(body))
                rows.append("下集钩子：" + _hook_line(ch))
            parts.append("\n".join(rows))

    body = "\n\n".join(p for p in parts if p)
    return Response(content=body.encode("utf-8"),
                    media_type="text/markdown; charset=utf-8" if fmt == "md"
                    else "text/plain; charset=utf-8",
                    headers=headers)


def _renumber_for_export(shots: list, order: int) -> list:
    """导出用的场号纠正（见下方 export_unified 里的说明）。

    单独包一层是为了：① 只有拿到非空 order 才动；② import 失败不该让导出整单失败
    —— 渲染器自己还有 `scene_no or shot_no` 的兜底，最坏情况退回修复前的行为。
    """
    try:
        from .scene_no import renumber_scenes
        return renumber_scenes(shots, order)
    except Exception:  # noqa: BLE001
        logger.warning("导出时重排场号失败(order=%s)，按原样导出", order, exc_info=True)
        return shots


@router.get("/drafts/{draft_id}/export", dependencies=[Depends(require_draft_access)])
async def export_unified(
    draft_id: int,
    kind: str = "chapters",
    scope: str = "all",
    fmt: str = "docx",
):
    """**统一导出端点** —— v2 工作台只调这一个（PLAN-v2收编与v1退役 §5）。

    kind  : chapters(正文) | storyboards(剧本) | mixed(正文+剧本合并) | outline(大纲)
    scope : all(整本) | 具体集号
    fmt   : docx | txt | md

    ## ⚠️ kind=outline 是 2026-10-07 补的（用户报的 bug）
    在此之前**大纲根本导不出来**：这个端点只认 chapters/storyboards/mixed，而 v2 导出
    按钮是"跟着当前页签导"的 —— 在大纲页签点导出，前端只好把它静默映射成 `chapters`，
    于是用户点「导出当前这份（大纲）」拿到的是**正文**。前端那行映射
    （`kind === 'outline' ? 'chapters' : kind`）就是这个缺口的补丁，现已去掉。
    数据源是 `draft.outline`（JSON 列），不是任何一张表 —— 所以它和另外三种
    "按集从表里取"的形态不同，单独走一条分支。

    ## 为什么要新增一个，而不是再加四个一次性端点
    本文件里已经躺着 10 个各管一个组合的导出端点（单集 docx、整本 docx、
    单集 txt、单集 md…），正是 v1「功能冗余杂乱」的样本。实测覆盖是这样的：

        正文整本 docx  ✅(藏在 export-mixed-docx?mode=all_chapter 里)
        正文 txt/md    ❌ 一个都没有
        剧本整本 docx  ✅   剧本单集 txt/md ✅   剧本整本 txt/md ❌

    v2 若继续按组合加端点，就是把要扔的毛病带进新家。所以这里用三个参数
    把矩阵一次收干净，**渲染一律复用现有函数**（不重写任何已经好用的东西）。

    ⚠️ 老端点全部保留不动 —— 旧工作台还在用它们，v1 退役前不能动。
    ⚠️ 小说/推文**不走这里**：`/v1/adapt/{kind}/export/{fmt}` 三种格式本来就齐。
    """
    kind = (kind or "chapters").strip()
    fmt = (fmt or "docx").strip().lower()
    scope = (scope or "all").strip()
    if kind not in ("chapters", "storyboards", "mixed", "outline"):
        raise HTTPException(400, "kind 只能是 chapters/storyboards/mixed/outline")
    if fmt not in ("docx", "txt", "md"):
        raise HTTPException(400, "fmt 只能是 docx/txt/md")
    one: int | None = None
    if scope != "all":
        try:
            one = int(scope)
        except ValueError:
            raise HTTPException(400, "scope 只能是 all 或集号")
    if kind == "mixed" and one is not None:
        raise HTTPException(400, "mixed 只支持整本导出")

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        title = draft.title or "未命名"
        # 大纲不在任何表里，它是 script_drafts.outline 这个 JSON 列。
        # 单独取一份原始 dict（后面 docx / txt / md 三条渲染路都要用）。
        outline_raw = dict(draft.outline or {}) if kind == "outline" else {}
        # 分集标题表：剧本导出要用它当副标题（见下面 sb_rows 的注释）。
        # 在 session 内取出来，避免会话关闭后再碰 ORM 对象。
        outline_all = {"chapters": list((draft.outline or {}).get("chapters") or [])}

        ch_stmt = select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        sb_stmt = select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        if one is not None:
            ch_stmt = ch_stmt.where(ScriptChapter.chapter_order == one)
            sb_stmt = sb_stmt.where(ScriptStoryboard.chapter_order == one)
        chapters = (await s.execute(ch_stmt.order_by(ScriptChapter.chapter_order))).scalars().all()
        boards = (await s.execute(sb_stmt.order_by(ScriptStoryboard.chapter_order))).scalars().all()

    # ── 大纲：走完全独立的一条路，读完直接返回，不碰下面正文/剧本那套 ──
    # 为什么单独返回而不是塞进后面的 ch_rows/sb_rows 流程：那个流程的每个分支
    # 都按"从表里取到的集"组织，而大纲是整块 JSON（含简介/人物/分集梗概），
    # 结构完全不同。硬塞进去只会让 label/span/_resp 这些通用件被塞满 if。
    if kind == "outline":
        ol_chapters = list(outline_raw.get("chapters") or [])
        if one is not None:
            ol_chapters = [c for c in ol_chapters
                           if int((c or {}).get("order") or 0) == one]
        if not ol_chapters and not outline_raw.get("synopsis") and not outline_raw.get("characters"):
            raise HTTPException(404, "没有可导出的大纲")
        span = "全本" if one is None else f"第{one}集"
        return _export_outline(title, span, fmt, outline_raw, ol_chapters)

    # ⚠️ title 是**副标题**，不是集号 —— 渲染器会先印紫色的「第{order}集」，
    # 再把 title 印成下面那行灰字。所以这里绝不能填 f"第{order}集"：
    # 那会印出「第8集」+「第8集」两行一模一样的字（2026-10-07 用户报的就是这个，
    # 当时还叠加了 order 漏传导致的「第0集」，一共三行）。
    # 优先用大纲里给这一集起的真名（如「无声警报」），没有就留空，
    # 渲染器对空 title 不印副标题行。
    _ol_title: dict[int, str] = {}
    for _i, _c in enumerate((outline_all or {}).get("chapters") or []):
        try:
            _o = int(_c.get("order") or _i + 1)
        except (TypeError, ValueError):
            continue
        _t = str(_c.get("title") or "").strip()
        # 把「第N集」这种自动标题视为"没有真名"，别拿它当副标题
        if _t and _t != f"第{_o}集":
            _ol_title[_o] = _t

    def _sub_title(order: int) -> str:
        """副标题：大纲真名 > 正文标题 > 空（空则渲染器不印副标题行）。"""
        t = _ol_title.get(order)
        if t:
            return t
        ch = next((c for c in chapters if int(c.chapter_order or 0) == order), None)
        ct = (getattr(ch, "title", "") or "").strip()
        return ct if ct and ct != f"第{order}集" else ""

    ch_rows = [{"order": int(c.chapter_order or 0),
                "title": c.title or f"第{c.chapter_order}集",
                "text": c.full_text or ""} for c in chapters if (c.full_text or "").strip()]
    # 🔴 2026-10-23：导出前把场号重排成「真实集号-场号」。
    #
    # 生成侧原先不知道自己在生成第几集（集号不是它的入参），而提示词要求
    # scene_no "从 1-1 开始递增" → 第 2 集以后每一集都成了 1-1/1-2。
    # dev 库实测 52813 个分镜里 17780 个前缀是错的，且错的全是 1-x。
    # 生成侧已在 `storyboard_gen._normalize` 修掉，**存量**在这里纠正 ——
    # 不做全库数据迁移，但用户导出的文件立刻是对的。
    # 渲染时纠正不回写库：用户编辑时看到的仍是他存的场号。
    _shots_of = _renumber_for_export
    sb_rows = [{"order": int(b.chapter_order or 0),
                "title": _sub_title(int(b.chapter_order or 0)),
                "shots": _shots_of(b.shots_json, int(b.chapter_order or 0))
                         if isinstance(b.shots_json, list) else []}
               for b in boards if (b.shots_json or [])]

    if kind == "chapters" and not ch_rows:
        raise HTTPException(404, "没有可导出的正文")
    if kind == "storyboards" and not sb_rows:
        raise HTTPException(404, "没有可导出的剧本")

    label = {"chapters": "正文", "storyboards": "剧本", "mixed": "正文与剧本"}[kind]
    span = "全本" if one is None else f"第{one}集"
    from urllib.parse import quote

    def _resp(data: bytes, ext: str, media: str):
        fn = f"{title}_{span}_{label}.{ext}"
        return Response(content=data, media_type=media,
                        headers={"Content-Disposition":
                                 f"attachment; filename*=UTF-8''{quote(fn)}"})

    # ---- docx：一律转调既有渲染器 ----
    if fmt == "docx":
        if kind == "chapters":
            from .export_chapter_docx import export_chapter_full_text_docx, export_mixed_docx
            if one is not None:
                r = ch_rows[0]
                data = export_chapter_full_text_docx(
                    draft_title=title, chapter_title=r["title"],
                    chapter_order=r["order"], full_text=r["text"])
            else:
                data = export_mixed_docx(draft_title=title, chapters=[
                    {"chapter_order": r["order"], "chapter_title": r["title"],
                     "source": "chapter", "full_text": r["text"]} for r in ch_rows])
        elif kind == "storyboards":
            from .export_docx import export_storyboard_to_docx, export_all_storyboards_to_docx
            if one is not None:
                r = sb_rows[0]
                data = export_storyboard_to_docx(
                    draft_title=title, chapter_title=r["title"],
                    chapter_order=r["order"], shots=r["shots"])
            else:
                data = export_all_storyboards_to_docx(title, [
                    {"chapter_order": r["order"], "chapter_title": r["title"],
                     "shots": r["shots"]} for r in sb_rows])
        else:
            from .export_chapter_docx import export_mixed_docx
            by_ch = {r["order"]: r for r in ch_rows}
            merged = []
            for o in sorted({*by_ch, *{r["order"] for r in sb_rows}}):
                if o in by_ch:
                    merged.append({"chapter_order": o, "chapter_title": by_ch[o]["title"],
                                   "source": "chapter", "full_text": by_ch[o]["text"]})
                else:
                    sb = next(r for r in sb_rows if r["order"] == o)
                    merged.append({"chapter_order": o, "chapter_title": sb["title"],
                                   "source": "storyboard", "shots": sb["shots"]})
            if not merged:
                raise HTTPException(404, "没有可导出的内容")
            data = export_mixed_docx(draft_title=title, chapters=merged)
        return _resp(data, "docx",
                     "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    # ---- txt / md：纯文本拼装（剧本复用 export_text 的渲染器）----
    from .export_text import storyboard_to_text, storyboard_to_markdown
    parts: list[str] = []
    if kind in ("chapters", "mixed"):
        for r in ch_rows:
            head = f"## {r['title']}" if fmt == "md" else f"{r['title']}"
            parts.append(f"{head}\n\n{r['text']}")
    if kind in ("storyboards", "mixed"):
        done = {r["order"] for r in ch_rows} if kind == "mixed" else set()
        for r in sb_rows:
            if r["order"] in done:
                continue
            render = storyboard_to_markdown if fmt == "md" else storyboard_to_text
            parts.append(render(title, r["title"], r["shots"]))
    if not parts:
        raise HTTPException(404, "没有可导出的内容")
    body = (f"# {title}\n\n" if fmt == "md" else f"{title}\n\n") + "\n\n".join(parts)
    return _resp(body.encode("utf-8"), fmt,
                 "text/markdown; charset=utf-8" if fmt == "md" else "text/plain; charset=utf-8")


@router.get("/drafts/{draft_id}/storyboards-export-all-docx", dependencies=[Depends(require_draft_access)])
async def export_all_storyboards_docx(draft_id: int):
    """导出整剧所有章节的剧本为单个Word文档"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")

        # 修复: 以「已生成剧本(storyboards)」为导出基准, 而非章节。
        # 旧逻辑先取 ScriptChapter 再逐章找剧本, 当章节只生成了前 N 集、
        # 剧本却按大纲生成了更多集时(如章节10集/剧本50集), 会漏掉第11-50集的剧本。
        # 现在直接遍历所有有内容的剧本, 标题优先取章节, 再取大纲, 最后兜底。
        sb_rows = (await s.execute(
            select(ScriptStoryboard)
            .where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()

        # 章节标题映射(有正文的章节)
        ch_title_map: dict[int, str] = {}
        for ch in (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all():
            if ch.title:
                ch_title_map[ch.chapter_order] = ch.title
        # 大纲标题映射(兜底)
        outline_title_map: dict[int, str] = {}
        try:
            for i, c in enumerate(((draft.outline or {}).get("chapters") or [])):
                ordv = c.get("order", i + 1)
                if c.get("title"):
                    outline_title_map[int(ordv)] = c["title"]
        except Exception:
            pass

        chapters_with_shots = []
        for sb_row in sb_rows:
            shots = sb_row.shots_json if isinstance(sb_row.shots_json, list) else []
            if not shots:  # 只有有剧本的集才导出
                continue
            order = sb_row.chapter_order
            title = ch_title_map.get(order) or outline_title_map.get(order) or f"第{order}集"
            chapters_with_shots.append({
                "chapter_order": order,
                "chapter_title": title,
                "shots": shots,
            })

        if not chapters_with_shots:
            raise HTTPException(404, "no storyboards generated yet")
        
        draft_title = draft.title or "未命名"
    
    docx_bytes = export_all_storyboards_to_docx(
        draft_title=draft_title,
        chapters_with_shots=chapters_with_shots,
    )
    
    filename = f"{draft_title}_完整剧本.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )



# ---------------------------------------------------------------------------
# M6: 生成日志查询
# ---------------------------------------------------------------------------


# 纯文本和Markdown导出
from .export_text import storyboard_to_text, storyboard_to_markdown


@router.get("/drafts/{draft_id}/storyboards-export-txt/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def export_chapter_storyboard_txt(draft_id: int, chapter_order: int):
    """导出单章剧本为纯文本"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        ch = (await s.execute(select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
        sb = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order))).scalar_one_or_none()
        if not sb or not sb.shots_json:
            raise HTTPException(404, "no storyboard")
        title = draft.title or "未命名"
        ch_title = ch.title if ch else f"第{chapter_order}集"
        shots = sb.shots_json if isinstance(sb.shots_json, list) else []

    text = storyboard_to_text(title, ch_title, shots)
    from urllib.parse import quote
    filename = f"{title}_第{chapter_order}集_剧本.txt"
    return Response(content=text.encode("utf-8"), media_type="text/plain; charset=utf-8", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})


@router.get("/drafts/{draft_id}/storyboards-export-md/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def export_chapter_storyboard_md(draft_id: int, chapter_order: int):
    """导出单章剧本为Markdown"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        ch = (await s.execute(select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
        sb = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order))).scalar_one_or_none()
        if not sb or not sb.shots_json:
            raise HTTPException(404, "no storyboard")
        title = draft.title or "未命名"
        ch_title = ch.title if ch else f"第{chapter_order}集"
        shots = sb.shots_json if isinstance(sb.shots_json, list) else []

    text = storyboard_to_markdown(title, ch_title, shots)
    from urllib.parse import quote
    filename = f"{title}_第{chapter_order}集_剧本.md"
    return Response(content=text.encode("utf-8"), media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})


from ..db import GenerationLog


@router.get("/drafts/{draft_id}/logs", dependencies=[Depends(require_draft_access)])
async def get_generation_logs(draft_id: int, stage: str | None = None, limit: int = 500, since_id: int | None = None):
    """查询指定草稿的生成日志
    
    Args:
        draft_id: 草稿ID
        stage: 筛选阶段(outline/chapter/storyboard/direct,可选)
        limit: 最多返回条数(默认500)
    """
    async with session_scope() as s:
        stmt = select(GenerationLog).where(GenerationLog.draft_id == draft_id)
        if stage:
            stmt = stmt.where(GenerationLog.stage == stage)
        if since_id:
            stmt = stmt.where(GenerationLog.id > since_id)
        stmt = stmt.order_by(GenerationLog.id.desc()).limit(limit)
        rows = (await s.execute(stmt)).scalars().all()
        
        logs = [
            {
                "id": r.id,
                "stage": r.stage,
                "chapter_order": r.chapter_order,
                "log_type": r.log_type,
                "message": r.message,
                "metadata": r.log_metadata or {},
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
        # 倒序返回(最老的在前)
        logs.reverse()
        return {"ok": True, "logs": logs, "total": len(logs)}


@router.delete("/drafts/{draft_id}/logs", dependencies=[Depends(require_draft_access)])
async def clear_generation_logs(draft_id: int):
    """清除指定草稿的所有生成日志"""
    async with session_scope() as s:
        await s.execute(
            delete(GenerationLog).where(GenerationLog.draft_id == draft_id)
        )
    return {"ok": True}

# ========== 系统状态与控制 ==========



@router.post("/drafts/{draft_id}/regenerate-stale", dependencies=[Depends(require_draft_access)])
async def regenerate_stale_content(draft_id: int):
    """一键重新生成所有过期内容(章节+剧本)"""
    async with session_scope() as s:
        stale_chapters = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.is_stale == 1)
        )).scalars().all()
        stale_storyboards = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.is_stale == 1)
        )).scalars().all()
        ch_orders = [c.chapter_order for c in stale_chapters]
        sb_orders = [s2.chapter_order for s2 in stale_storyboards]
    
    return {
        "ok": True,
        "stale_chapters": ch_orders,
        "stale_storyboards": sb_orders,
        "message": f"{len(ch_orders)}章+{len(sb_orders)}剧本已过期,请使用批量生成功能重新生成"
    }

@router.post("/system/reset-stuck")
async def reset_stuck_drafts(admin: User = Depends(require_admin)):
    """重置卡在 running 的草稿状态，**并清掉僵尸进度**。

    ⚠️ 2026-10-22：此前这里只把 `ScriptDraft.status` 改回 draft，**完全没碰
    `outline.progress`**。而真正卡住用户点不动按钮的是后者 ——
    `_check_running_or_409` 读 progress，实测生产上有 20+ 部草稿的
    `sub_stage` 从 2026-07 起一直停在 running，管理员点过"重置卡死"之后
    仍然点不动补全，因为那个按钮改的是另一个字段。
    """
    from datetime import timedelta
    from .progress_helper import is_progress_running, reap_stale_progress

    reset_ids: list[int] = []
    cleared_progress: list[int] = []
    async with session_scope() as s:
        stuck = (await s.execute(
            select(ScriptDraft).where(
                ScriptDraft.status.in_(['outline_running', 'chapter_running', 'storyboard_running', 'generating_outline', 'generating_chapters', 'generating_storyboards']),
                ScriptDraft.updated_at < datetime.utcnow() - timedelta(minutes=5)
            )
        )).scalars().all()
        for d in stuck:
            d.status = 'draft'
            reset_ids.append(d.id)
        # 再扫一遍所有 sub_stage=running 的草稿：不管 ScriptDraft.status 是什么，
        # 只要心跳早就不在了，就把进度收成 failed。真在跑的任务每集都在 tick，
        # 不会被误伤（is_progress_running 会先放行）。
        rows = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.outline.isnot(None))
        )).scalars().all()
        zombie = [d.id for d in rows
                  if isinstance(d.outline, dict)
                  and (d.outline.get("progress") or {}).get("sub_stage") == "running"
                  and not is_progress_running(d.outline.get("progress"))]
        await s.commit()
    for did in zombie:
        if await reap_stale_progress(did):
            cleared_progress.append(did)
    return {"ok": True, "reset_count": len(reset_ids), "reset_ids": reset_ids,
            "cleared_progress_count": len(cleared_progress), "cleared_progress_ids": cleared_progress}


@router.post("/drafts/{draft_id}/reset-status", dependencies=[Depends(require_draft_access)])
async def reset_draft_status(draft_id: int):
    """手动重置单个草稿状态为draft"""
    async with session_scope() as s:
        row = await s.get(ScriptDraft, draft_id)
        if not row:
            raise HTTPException(404, "draft not found")
        old_status = row.status
        row.status = "draft"
        await s.commit()
    return {"ok": True, "old_status": old_status, "new_status": "draft"}

@router.get("/system/status", dependencies=[Depends(require_admin)])
async def system_status():
    """查询当前系统负载和队列状态。

    说明: 系统里有两类"运行中"的任务,以前只统计了第一类,会让管理面板显示 0:
      - SSE GET 端点 (e.g. /chapters/batch): 经过 _generation_semaphore, 计入 _current_running
      - 后台 POST 端点 (e.g. /chapters/batch/start, /extend/start):
        通过 asyncio.create_task(_consume_generator(...)) 跑, **不经过 semaphore**,
        但任务对象保存在 _running_tasks 里。

    返回字段含义:
      semaphore_running:   走 semaphore 的 SSE 任务数 (旧字段 current_running 等价)
      background_running:  后台 asyncio 任务里仍未 done 的任务数
      current_running:     上述两者之和(向后兼容字段, 也是面板里显示的"正在运行")
    """
    total_mem_gb = 0.0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_mem_gb = round(int(line.split()[1]) / 1024 / 1024, 1)
                    break
    except Exception:
        pass

    # 统计 _running_tasks 里仍存活(未 done)的后台任务
    background_running = 0
    background_alive_drafts: list[int] = []
    for did, t in list(_running_tasks.items()):
        if t and not t.done():
            background_running += 1
            background_alive_drafts.append(did)
        else:
            # 顺手清理 done 任务,避免无限累积
            _running_tasks.pop(did, None)

    total_running = _current_running + background_running

    return {
        "max_concurrent": MAX_CONCURRENT_GENERATIONS,
        # 向后兼容字段: 现在反映"实际正在跑"的总数(SSE + 后台)
        "current_running": total_running,
        "current_waiting": _current_waiting,
        "total_in_queue": total_running + _current_waiting,
        # SSE semaphore 余量(后台任务不占 semaphore)
        "available_slots": max(0, MAX_CONCURRENT_GENERATIONS - _current_running),
        # 拆分字段, 方便诊断"幽灵任务"
        "semaphore_running": _current_running,
        "background_running": background_running,
        "background_drafts": background_alive_drafts,
        "total_memory_gb": total_mem_gb,
    }


async def _persist_concurrency(value: int, admin_id: int | None) -> None:
    """把当前并发数写进 system_settings 表, 容器重启后能从这里恢复.

    复用 admin_routes 已经在用的 system_settings 表 (key/value/updated_by/updated_at).
    key = 'max_concurrent_generations'.
    """
    try:
        from sqlalchemy import text
        from ..db import session_scope
        async with session_scope() as s:
            await s.execute(
                text(
                    """INSERT INTO system_settings (key, value, updated_by, updated_at)
                       VALUES ('max_concurrent_generations', :v, :uid, NOW())
                       ON CONFLICT (key) DO UPDATE SET
                           value = :v,
                           updated_by = :uid,
                           updated_at = NOW()"""
                ),
                {"v": str(value), "uid": admin_id},
            )
    except Exception as e:  # noqa: BLE001
        # 写库失败不阻塞接口 — 内存里的并发数已经改了, 持久化失败下次重启回退默认即可
        logger.warning("持久化 max_concurrent_generations 失败: %s", e)


async def restore_concurrency_from_db() -> None:
    """容器启动时调用: 从 system_settings 读出上次保存的并发数, 覆盖默认值.

    优先级: DB system_settings > 环境变量 MAX_CONCURRENT_GENERATIONS > 默认 3.
    DB 里没记录就什么都不做 (保持 import 时已经按环境变量初始化的值).
    """
    global MAX_CONCURRENT_GENERATIONS, _generation_semaphore
    try:
        from sqlalchemy import text
        from ..db import session_scope
        async with session_scope() as s:
            row = (await s.execute(
                text("SELECT value FROM system_settings WHERE key = 'max_concurrent_generations'")
            )).first()
        if not row:
            logger.info("生成队列: system_settings 无 max_concurrent_generations, 沿用初始值 %d", MAX_CONCURRENT_GENERATIONS)
            return
        try:
            persisted = int(str(row[0]).strip())
        except Exception:
            logger.warning("生成队列: system_settings.max_concurrent_generations='%s' 不是合法整数, 忽略", row[0])
            return
        if persisted < 1 or persisted > 500:
            logger.warning("生成队列: 持久化的并发数 %d 越界 (1-500), 忽略", persisted)
            return
        if persisted == MAX_CONCURRENT_GENERATIONS:
            logger.info("生成队列: 持久化值 %d 与启动值一致, 跳过", persisted)
            return
        old_val = MAX_CONCURRENT_GENERATIONS
        MAX_CONCURRENT_GENERATIONS = persisted
        _generation_semaphore = _asyncio.Semaphore(persisted)
        logger.info("生成队列: 从 system_settings 恢复并发数 %d -> %d", old_val, persisted)
    except Exception as e:  # noqa: BLE001
        # 比如 system_settings 表还没建 (老库), 这里降级成沿用环境变量值, 不阻塞启动
        logger.warning("生成队列: 从 DB 恢复并发数失败 (沿用 %d): %s", MAX_CONCURRENT_GENERATIONS, e)


@router.post("/system/set-concurrency")
async def set_concurrency(max_concurrent: int = Query(ge=1, le=500), admin: User = Depends(require_admin)):
    """动态调整最大并发数(无需重启).

    同时写进 system_settings 表, 容器下次重启会自动恢复成这个值.
    """
    global MAX_CONCURRENT_GENERATIONS, _generation_semaphore
    old_val = MAX_CONCURRENT_GENERATIONS
    MAX_CONCURRENT_GENERATIONS = max_concurrent
    _generation_semaphore = _asyncio.Semaphore(max_concurrent)
    await _persist_concurrency(max_concurrent, getattr(admin, "id", None))
    logger.info("并发数调整: %d -> %d (已持久化)", old_val, max_concurrent)
    return {
        "old": old_val,
        "new": max_concurrent,
        "persisted": True,
        "message": f"并发数已从{old_val}调整为{max_concurrent}, 已持久化, 重启后自动恢复",
    }


# ===========================================================================
# 续写 (Continuation) — 在已有前 N 集基础上扩写到 M 集
# ===========================================================================

from .continuation import (
    extend_draft as _extend_draft,
    get_extend_meta as _get_extend_meta,
    rollback_extension as _rollback_extension,
)


@router.get("/drafts/{draft_id}/extend/meta", dependencies=[Depends(require_draft_access)])
async def extend_meta(draft_id: int):
    """续写前置元信息查询: 当前已锁集数 / 总字数 / 自动检测档位"""
    info = await _get_extend_meta(draft_id)
    if "error" in info:
        raise HTTPException(404, info["error"])
    return info


class EpisodeOutlineItem(BaseModel):
    """用户自备集纲的单集条目 (前端预览调整后提交)"""
    order: int = Field(..., ge=1, le=500)
    title: str = Field("", max_length=60)
    synopsis: str = Field(..., min_length=1, max_length=20000)


class ExtendIn(BaseModel):
    target_episode_count: int = Field(..., ge=2, le=500)
    chunk_size: int = Field(20, ge=1, le=50)
    word_target: int | None = Field(None, ge=1, le=20000)  # 不设最低值
    model_provider: str = Field("gemini", pattern=r"^(gemini|deepseek|gpt5|grok|claude)(:[A-Za-z0-9._-]{1,60})?$")
    forced_level: str | None = Field(None, pattern="^(L1|L2|L3)$")
    # 用户对续写部分的剧情走向期望(自然语言),可选。与集纲共存时只引导没有集纲的空缺集数
    user_guidance: str = Field("", max_length=200000)
    # True(默认)=只扩写大纲, 不自动写正文; 用户确认大纲后可手动"全部生成"。False=旧行为(扩写后直接续写正文)
    outline_only: bool = Field(True)
    # 用户自备集纲(逐集大纲), 可选。覆盖的集数直接采用、跳过 LLM 大纲生成
    episode_outline: list[EpisodeOutlineItem] | None = Field(None, max_length=500)


class EpisodeOutlineSplitIn(BaseModel):
    """集纲文本拆分预览请求"""
    text: str = Field(..., min_length=1, max_length=500000)


# ---------------------------------------------------------------------------
# 粘贴识别：把一段文本按集号切分并写进当前草稿（新版工作台用）
# ---------------------------------------------------------------------------

class PastePreviewIn(BaseModel):
    text: str
    kind: str = "chapters"   # chapters（原文） | outline（大纲）


class PasteApplyIn(BaseModel):
    kind: str = "chapters"
    episodes: list[dict]     # 用户确认后的结果（可直接改过）


@router.post("/drafts/{draft_id}/paste/preview", dependencies=[Depends(require_draft_access)])
async def paste_preview(draft_id: int, payload: PastePreviewIn):
    """把粘贴的文本按「第N集/第N章/一、/1、」切分，**只预览不落库**。

    ## 为什么要"预览"这一步，而不是粘完直接写
    切分是有判断的（哪一行算集头、集号从几开始、有没有重号/断号），
    判错了就把用户的稿子拆乱。所以先给用户看拆分结果、允许改，
    确认后才落库 —— 与导入剧本的流程一致（那是既有产品习惯，不另造一套）。

    ## 与导入接口的关系
    **复用同一套切分器**，不重写：
      · chapters → `import_script.smart_split_chapters`（主页导入剧本用的就是它）
      · outline  → `import_outline.parse_and_split_outline`
    只把"入口"从"建新草稿"换成"写进已有草稿"。

    ⚠️ outline 用的是 `parse_and_split_outline`，它会**调模型**处理
    "第X-Y集"这类区间表述（`import_outline.py` 的设计）。所以大纲那条路
    不是零成本的；chapters 那条是纯字符串切分，零成本。
    """
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "内容为空")

    if payload.kind == "outline":
        from .import_outline import parse_and_split_outline
        episodes = await parse_and_split_outline(text)
        return {
            "ok": True, "kind": "outline",
            "episodes": [
                # ⚠️ 键名是 `summary` 不是 `synopsis` —— `parse_and_split_outline`
                # 返回 `[{order, title, summary}]`（见 import_outline.py 的签名）。
                # 写成 synopsis 会让梗概**静默为空**：预览看着有标题、写进库只剩标题，
                # 而大纲的正文就是梗概，等于把用户贴的内容全丢了。
                {"order": e.get("order"), "title": e.get("title") or "",
                 "synopsis": e.get("summary") or "",
                 "word_count": len(e.get("summary") or "")}
                for e in (episodes or [])
            ],
        }

    from .import_script import smart_split_chapters
    # ⚠️ renumber=False：**保留用户原文里的集号**。
    # 这里是"往已有草稿里粘一段"，用户贴「第73集…第77集」就该落在 73–77，
    # 而不是被重排成 1–5 去盖掉开头五集（2026-09-22 用户报的 bug）。
    # 建新草稿的导入路径仍然重排（整本必须从第 1 集起）。
    chs = smart_split_chapters(text, renumber=False)
    return {
        "ok": True, "kind": "chapters",
        "episodes": [
            {"order": c.get("order"), "title": c.get("title") or "",
             "synopsis": (c.get("content") or "")[:200],
             "word_count": len(c.get("content") or ""),
             "_content": c.get("content") or ""}
            for c in (chs or [])
        ],
    }


@router.post("/drafts/{draft_id}/paste/apply", dependencies=[Depends(require_draft_access)])
async def paste_apply(draft_id: int, payload: PasteApplyIn, user: User = Depends(get_current_user)):
    """把**用户确认过**的切分结果写进当前草稿。

    chapters：逐集写 `script_chapters`（与「整篇保存」同一个批量端点，含 upsert 与历史留痕）
    outline ：写进 `draft.outline.chapters`（只补/覆盖这一批集，不动其它集的契约字段）

    ⚠️ outline 这条**只写 title/synopsis**，不碰 core_push/stakes/hook_out 等契约字段：
    粘贴进来的文本里本来就没有那些，凭空清空等于把用户已有的契约抹掉。
    要补契约走「生成大纲」或对话。
    """
    items = payload.episodes or []
    if not items:
        raise HTTPException(400, "没有要写入的集")

    if payload.kind == "outline":
        from sqlalchemy.orm.attributes import flag_modified
        async with session_scope() as s:
            await _check_draft_access(s, draft_id, user, for_write=True)
            # ⚠️ 必须**锁行**再读改写，不能用裸 `s.get()`。
            #
            # outline 是整份 JSON 存在 draft.outline **一列**里的（不像正文那样
            # 一集一行），所以每次保存都是"读全量 → 改一集 → 写回全量"。
            # 前端跨集删除会**并发**发出多个请求（每集一个）—— 两个事务若都读到
            # 同一份旧 chapters，后提交的那个就把另一个的改动整段覆盖掉。
            # 2026-10-09 实测：跨集删除第 1、2 集，前端发了 2 个请求都返回 200，
            # 但重新加载后只有第 1 集的删除留下，第 2 集原样回来了。
            #
            # `with_for_update()` 让同一草稿的保存串行化，后到的事务读到的是
            # 前一个已提交的结果。对"同一集被同时改两次"也一并解决。
            draft = (await s.execute(
                select(ScriptDraft).where(ScriptDraft.id == draft_id).with_for_update()
            )).scalar_one_or_none()
            if not draft:
                raise HTTPException(404, "draft not found")
            outline = dict(draft.outline or {})
            chapters = list(outline.get("chapters") or [])
            by_order = {c.get("order"): i for i, c in enumerate(chapters)}
            written = []
            for e in items:
                o = int(e.get("order") or 0)
                if o <= 0:
                    continue
                patch = {"synopsis": (e.get("synopsis") or "").strip()}
                title = (e.get("title") or "").strip()
                if title:
                    patch["title"] = title
                elif o not in by_order:
                    # 新增的集才需要占位名。
                    # ⚠️ 已存在的集**没给标题 = 不动标题**，绝不能补成 "第N集"：
                    # 调用方可能只是在改梗概（工作台的大纲编辑就是这样），
                    # 那样一改就把用户起的标题「反击」冲成「第2集」（2026-09-21 实测）。
                    patch["title"] = f"第{o}集"
                if o in by_order:
                    _ep = chapters[by_order[o]]
                    _old_syn = str(_ep.get("synopsis") or "")
                    _old_title = str(_ep.get("title") or "")
                    _new_syn = str(patch.get("synopsis") or "")
                    _new_title = str(patch.get("title") or _old_title)
                    # 🔴 2026-10-10：覆写前先留痕。
                    #
                    # 大纲此前**没有任何写入点**存历史 —— 实测草稿 654 有 60 集
                    # 历史（storyboard 3997 条 / chapter 507 条），但 outline 一条
                    # 都没有，用户在大纲页签下永远看不到"历史"入口。
                    # 粘贴/手动改梗概是最常走的大纲写入路径，就从这里开始。
                    #
                    # ⚠️ 只在**真的改了**的时候存：工作台的失焦保存会频繁触发，
                    # 内容没变也存一条会让历史面板迅速被同样的内容塞满
                    # （每集每阶段上限 10 条，等于把真历史挤掉）。
                    if _new_syn != _old_syn or _new_title != _old_title:
                        from .candidate_store import snapshot_in
                        # 存的是**改之前**的整集 dict（含契约字段），不是只存梗概 ——
                        # 回滚要能把这一集完整还原，只存梗概会丢掉 core_push /
                        # stakes / beats 等字段。
                        await snapshot_in(
                            s, draft_id=draft_id, order=o, stage="outline",
                            content=dict(_ep),
                            version=int(_ep.get("version") or 1),
                            created_by="user_edit",
                        )
                    _ep.update(patch)      # 只覆盖这两个字段
                    # 2026-11-07：粘贴/失焦保存改了正文 => 老草稿身上的契约字段与
                    # beats 已经和新正文不一致。原先只打 `_beats_stale` 让节拍失效，
                    # 但 core_push/stakes/plant 这些照样进 prompt —— 模型仍按旧内容写。
                    # 现在一律清掉，与 update_outline_episode / 按意见重写两条路一致：
                    # 正文是唯一事实，历史版本里留着改之前的整集可回退。
                    if str(patch.get("synopsis") or "") != _old_syn:
                        from .outline_fields import STALE_AFTER_REWRITE as _STALE
                        for _k in _STALE:
                            _ep.pop(_k, None)
                else:
                    chapters.append({"order": o, **patch})
                written.append(o)
            chapters.sort(key=lambda c: int(c.get("order") or 0))
            outline["chapters"] = chapters
            draft.outline = outline
            flag_modified(draft, "outline")
            await s.commit()
        return {"ok": True, "kind": "outline", "written": written, "total": len(chapters)}

    # chapters：复用批量端点（upsert + 历史留痕 + 标记剧本过期）
    chapter_items = [
        {"chapter_order": int(e.get("order") or 0),
         "full_text": e.get("_content") or e.get("synopsis") or "",
         "title": (e.get("title") or "").strip() or None}
        for e in items if int(e.get("order") or 0) > 0
    ]
    if not chapter_items:
        raise HTTPException(400, "没有有效的集号")
    return await batch_save_chapters(
        draft_id, BatchChapterIn(items=[BatchChapterItemIn(**c) for c in chapter_items]), user,
    )


# ---------------------------------------------------------------------------
# 逐集历史版本（工作台 v2）
# ---------------------------------------------------------------------------
#
# 历史**早就一直在记**了（`ScriptEpisodeHistory`，dev 库 4702 条：storyboard
# 3997 / chapter 507 / novel 109 / tweet 67 / outline 22），写入点散在
# `router_m5_enhanced._save_episode_history`、`candidate_store.snapshot_in`、
# `rewrite/service`、`check/fixer`、`adapt_products/service` —— 每集每阶段封顶 10 版。
# 缺的**只是 v2 的读/切入口**，所以这里不加任何新的存储，只把已有的读出来。
#
# ⚠️ 别和 `features/user_features_routes.py` 里那三个 /history 端点搞混：
#    它们查的是 **content_history** 表（另一张表，dev 库只有 4 行，且列名是
#    `chapter_order`、还被 users 外键约束）。两者名字像、表不同，改的时候看清楚。
#
# ⚠️ 各 stage 的 `content` 结构**不统一**（历史原因，不能想当然）：
#    outline    → dict（order/title/synopsis/must_have/characters）
#    chapter    → dict {full_text, title?, summary?}
#    novel/tweet→ dict {content}
#    storyboard → **两种都有**：dict {shots_json} 与裸数组 [shot…]
#                 （dev 库实测 object 465 条 / array 3532 条）
#    所以下面统一用 `_history_text` 归一成"给人看的文本"，再交给前端渲染。
#    前端若自己去猜结构，遇到那 465 条 object 形态就会显示成空白。

#: 工作台的 tab → 历史表里的 stage。⚠️ 只用于**写**（restore）与问题定位，
#: 读的时候不按它过滤 —— 见 list_episode_history 里为什么放宽。
TAB_TO_STAGE: dict[str, tuple[str, ...]] = {
    "outline": ("outline",),
    "chapters": ("chapter",),
    "storyboards": ("storyboard",),
    "novel": ("novel",),
    "tweet": ("tweet",),
}


def _history_text(stage: str, content: Any, order: int = 0, draft_title: str = "") -> str:
    """把一条历史记录的 content 归一成"给人看的文本"。

    尽量复用**渲染侧的既有函数**，避免这里和导出/正文显示出现两套口径：
      storyboard → export_text.storyboard_to_text（与导出 docx/txt 同一套）
      outline    → 梗概（工作台大纲页签显示的就是 synopsis，不是全部字段）
      chapter    → full_text
      novel/tweet→ content
    任何解析失败都退回 json 字符串，**绝不抛** —— 历史页打不开比少显示一条更糟。

    ⚠️ `order` 只是给 storyboard 当标题行用（storyboard_to_text 需要它）。
    它**不是**用来筛选的：调用方已经按集号取过数据了。
    注意别把它当成可选就漏传 —— 漏传不会报错（默认 0），只会让标题显示成
    "第0集"，属于"看着正常、实际不对"的那类问题。

    ⚠️ `draft_title` 也只为 storyboard 的标题行服务，且**必须由调用方传入**：
    列表端点一次要渲染 60 条，在这里逐条查草稿名就是 60 次额外查询。
    调用方查一次、传进来。
    """
    try:
        content = _history_content(content)
        if stage == "storyboard":
            shots = content if isinstance(content, list) else (content or {}).get("shots_json")
            # storyboard_to_text(title, ch_title, shots) 自己会拼成
            # "{title} - {ch_title} 剧本"，所以这里**只传剧名、不要再带分隔符** ——
            # 带上就是 "换命 -  - 第1集 剧本"（2026-10-10 实测踩过）。
            # 历史 record 里没有剧名（content 只有 shots_json），拿不到就传空串，
            # 退化成干净的 "第1集 剧本"。
            from .export_text import storyboard_to_text
            return storyboard_to_text((draft_title or "").strip(),
                                      f"第{order}集", shots or [])
        if isinstance(content, list):
            return json.dumps(content, ensure_ascii=False)[:20000]
        if not isinstance(content, dict):
            return str(content or "")
        if stage == "outline":
            return str(content.get("synopsis") or "")
        if stage == "chapter":
            return str(content.get("full_text") or "")
        if stage in ("novel", "tweet"):
            return str(content.get("content") or "")
        return json.dumps(content, ensure_ascii=False)[:20000]
    except Exception:  # noqa: BLE001
        try:
            return json.dumps(content, ensure_ascii=False)[:20000]
        except Exception:  # noqa: BLE001
            return ""


def _history_content(content: Any) -> Any:
    """把一条历史记录的 content 归一成**可以直接取键**的形态(读侧)。

    存在的唯一原因: storyboard 的历史在库里**有两种形态**, 且都不是"错"的 ——
      裸数组 [shot…]     3532 条(dev 实测), 是早期 _save_episode_history 的写法
      dict {"shots_json": […] } 465 条, 是现在各处新写的形态
    读侧(取正文/回滚)若假定其中一种, 另一种就会当场炸:
      · dict(...) 遇到裸数组 → ValueError: dictionary update sequence element
        #0 has length 4; 2 is required(2026-10-10 实测, 回滚一条旧剧本记录即 500)
      · 反过来按数组处理 dict → 把 {"shots_json": …} 当成一镜存回去, 剧本被写坏
    所以**读侧一律先过这里**, 把裸数组包成 {"shots_json": [...]}, 其它原样返回。
    列表以外的非 dict(如 chapter 的 12 条 string) 也包一层, 免得调用方再判一次。
    """
    if isinstance(content, dict):
        return content
    if isinstance(content, list):
        return {"shots_json": content}
    if content is None:
        return {}
    return {"content": content}


@router.get("/drafts/{draft_id}/history-summary",
            dependencies=[Depends(require_draft_access)])
async def history_summary(draft_id: int, kind: str | None = Query(None)):
    """整本的"每集有几条历史" —— 供工作台在每个块上显示"历史 N"。

    ## 为什么要有它，而不是逐集去查
    工作台一次渲染几十上百个块。逐块发一次 history 请求就是上百个并发请求，
    只为显示一个小角标 —— 那是拿请求数换一个数字，不值当。
    这里一次聚合返回，前端算一次。

    ## 路径为什么是 history-summary 而不是 history/summary
    `/drafts/{draft_id}/history/{history_id}` 已经把 `history/` 这一段占了，
    且 `{history_id}` 是 int。再注册 `history/summary` 会**按注册顺序**去匹配
    int 转换失败（405/422），取决于谁先定义 —— 这种坑很难查。
    换个没有前缀冲突的路径，从根上避开。

    返回 {"counts": {"3": 2, "7": 1}}（集号→条数，只含 >0 的）。
    """
    async with session_scope() as s:
        stmt = select(
            ScriptEpisodeHistory.episode_order,
            func.count(),
        ).where(ScriptEpisodeHistory.draft_id == draft_id)
        if kind and kind in TAB_TO_STAGE:
            stmt = stmt.where(ScriptEpisodeHistory.stage.in_(TAB_TO_STAGE[kind]))
        rows = (await s.execute(
            stmt.group_by(ScriptEpisodeHistory.episode_order)
        )).all()
        return {"counts": {str(o): int(c) for o, c in rows}}


@router.get("/drafts/{draft_id}/episodes/{order}/history",
            dependencies=[Depends(require_draft_access)])
async def list_episode_history(draft_id: int, order: int, kind: str | None = Query(None)):
    """某一集的历次版本（新的在前），供工作台"历史版本"面板。

    返回**不含正文**的摘要列表 —— 正文可能很长（一集上万字），十几条全带回
    会拖慢面板；真正要看某一条时再走 detail 端点。
    """
    async with session_scope() as s:
        stmt = select(ScriptEpisodeHistory).where(
            ScriptEpisodeHistory.draft_id == draft_id,
            ScriptEpisodeHistory.episode_order == order,
        )
        # ⚠️ kind 传了就过滤、不传就读**全部 stage**。
        # 工作台上"这一集"是个统一的实体，而同一集在不同阶段各有一条历史线
        # （原文一条、剧本一条、大纲一条）。用户在"剧本"页签下想知道"这集被谁
        # 改过"，只给他 storyboard 那一条会让他以为"没改过"—— 尤其精修同时
        # 会写 chapter 与 storyboard。传 kind 用于聚焦，不传就是全貌。
        if kind and kind in TAB_TO_STAGE:
            stmt = stmt.where(ScriptEpisodeHistory.stage.in_(TAB_TO_STAGE[kind]))
        rows = (await s.execute(
            stmt.order_by(ScriptEpisodeHistory.id.desc()).limit(60)
        )).scalars().all()

        items = []
        # 剧名只查一次，供下面所有 storyboard 行的标题行复用（见 _history_text 说明）
        _d = await s.get(ScriptDraft, draft_id)
        draft_title = str(getattr(_d, "title", "") or "") if _d else ""
        for r in rows:
            txt = _history_text(r.stage, r.content or {}, r.episode_order, draft_title)
            items.append({
                "id": r.id,
                "stage": r.stage,
                "version": r.version,
                "created_by": r.created_by,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "chars": len(txt),
                "preview": txt[:120],
            })
        return {"items": items}


@router.get("/drafts/{draft_id}/history/{history_id}",
            dependencies=[Depends(require_draft_access)])
async def get_episode_history_detail(draft_id: int, history_id: int):
    """某一条历史版本的完整文本（与当前内容并存，供左右对照）。"""
    async with session_scope() as s:
        r = await s.get(ScriptEpisodeHistory, history_id)
        if not r or r.draft_id != draft_id:
            raise HTTPException(404, "版本不存在")
        _d = await s.get(ScriptDraft, draft_id)
        return {
            "id": r.id,
            "stage": r.stage,
            "episode_order": r.episode_order,
            "version": r.version,
            "created_by": r.created_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "text": _history_text(
                r.stage, r.content or {}, r.episode_order,
                str(getattr(_d, "title", "") or "") if _d else "",
            ),
        }


@router.post("/drafts/{draft_id}/history/{history_id}/restore",
             dependencies=[Depends(require_draft_access)])
async def restore_episode_history(draft_id: int, history_id: int):
    """把某一集回滚到指定历史版本。

    ## 为什么回滚前要先存一份当前内容
    不然"回滚"本身是**不可撤销**的：用户切到旧版本、发现不对，就再也回不到
    刚才那个较新的版本了。所以先按同一套 _save_episode_history 记一条快照
    （`created_by="restore_old_version"`），让回滚自己也能被回滚。

    ⚠️ stage='outline' 的回滚是**整份大纲**：outline 在库里是一列 JSON
    （`ScriptDraft.outline`），历史存的却是**单集**那一份 dict。所以恢复时要
    只替换 chapters 里对应 order 的那一集，**不能**把整列换成这一集的 dict ——
    那会把全剧的 story_bible / state_ledger / 其它集全抹掉。
    """
    from .router_m5_enhanced import _save_episode_history

    async with session_scope() as s:
        r = await s.get(ScriptEpisodeHistory, history_id)
        if not r or r.draft_id != draft_id:
            raise HTTPException(404, "版本不存在")
        stage, order, content = r.stage, r.episode_order, _history_content(r.content)

        if stage in ("chapter", "storyboard"):
            model = ScriptChapter if stage == "chapter" else ScriptStoryboard
            row = (await s.execute(
                select(model).where(model.draft_id == draft_id,
                                    model.chapter_order == order)
            )).scalars().first()
            if not row:
                raise HTTPException(409, f"第 {order} 集不存在，无法回滚")

            if stage == "chapter":
                # 先把当前内容存成历史（让回滚可撤销），再覆盖
                await _save_episode_history(
                    draft_id, order, "chapter",
                    {"full_text": row.full_text or "", "title": row.title or ""},
                    int(getattr(row, "version", 1) or 1), "restore_old_version")
                row.full_text = str(content.get("full_text") or "")
                if content.get("title") is not None:
                    row.title = content.get("title") or row.title
                # ⚠️ 不动 summary：摘要是另一条独立流水线的产物，回滚正文时
                # 把它一起改掉会让"摘要与正文对不上"且用户无从察觉。
                if hasattr(row, "version"):
                    row.version = int(getattr(row, "version", 1) or 1) + 1
            else:
                shots = content if isinstance(content, list) else content.get("shots_json")
                await _save_episode_history(
                    draft_id, order, "storyboard",
                    {"shots_json": row.shots_json or []},
                    int(getattr(row, "version", 1) or 1), "restore_old_version")
                row.shots_json = shots or []
                if hasattr(row, "version"):
                    row.version = int(getattr(row, "version", 1) or 1) + 1

        elif stage == "outline":
            draft = await s.get(ScriptDraft, draft_id)
            if not draft:
                raise HTTPException(404, "草稿不存在")
            outline = dict(draft.outline or {})
            chapters = list(outline.get("chapters") or [])
            idx = next((i for i, c in enumerate(chapters)
                        if int(c.get("order") or 0) == order), None)
            if idx is None:
                raise HTTPException(409, f"大纲里没有第 {order} 集，无法回滚")
            await _save_episode_history(
                draft_id, order, "outline", dict(chapters[idx]),
                int(chapters[idx].get("version") or 1), "restore_old_version")
            # 只换这一集：其余字段（含 story_bible / state_ledger）原样保留
            merged = dict(chapters[idx])
            merged.update(content)
            merged["order"] = order
            chapters[idx] = merged
            outline["chapters"] = chapters
            draft.outline = outline
            flag_modified(draft, "outline")

        elif stage in ("novel", "tweet"):
            # ⚠️ ChapterAdaptation 不在 db.models 里，它属于 adapt_products 自己的
            # 模块（chapter_adaptations 表的定义处）。
            from ..adapt_products.models import ChapterAdaptation
            row = (await s.execute(
                select(ChapterAdaptation).where(
                    ChapterAdaptation.draft_id == draft_id,
                    ChapterAdaptation.kind == stage,
                    ChapterAdaptation.chapter_order == order)
            )).scalars().first()
            if not row:
                raise HTTPException(409, f"第 {order} 章不存在，无法回滚")
            await _save_episode_history(
                draft_id, order, stage, {"content": row.content or ""},
                int(getattr(row, "version", 1) or 1), "restore_old_version")
            row.content = str(content.get("content") or "")
            row.word_count = len(row.content)
            if hasattr(row, "version"):
                row.version = int(getattr(row, "version", 1) or 1) + 1

        else:
            raise HTTPException(400, f"暂不支持回滚该阶段: {stage}")

        await s.flush()
    return {"ok": True, "stage": stage, "episode_order": order}


@router.post("/drafts/{draft_id}/extend/episode-outline/split", dependencies=[Depends(require_draft_access)])
async def split_episode_outline_preview(draft_id: int, payload: EpisodeOutlineSplitIn):
    """把用户粘贴的集纲文本拆分为逐集条目 (预览用, 不落库)。

    识别 "第N集/第1集/一、/1、" 等分集标注(与导入剧本的识别方案同源)。
    前端展示拆分结果供用户确认/手动调整后, 随 /extend/start 的
    episode_outline 字段提交。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
    from .episode_outline import split_episode_outline
    result = split_episode_outline(payload.text)
    return result


@router.post("/drafts/{draft_id}/extend/start", dependencies=[Depends(require_draft_access)])
async def start_extend(draft_id: int, payload: ExtendIn):
    """启动续写后台任务"""
    await _check_running_or_409(draft_id)

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")

    gen = _extend_draft(
        draft_id,
        target_episode_count=payload.target_episode_count,
        chunk_size=payload.chunk_size,
        word_target=payload.word_target,
        provider=payload.model_provider,
        forced_level=payload.forced_level,  # type: ignore[arg-type]
        user_guidance=payload.user_guidance,
        outline_only=payload.outline_only,
        episode_outline=[e.model_dump() for e in (payload.episode_outline or [])] or None,
    )
    task = _asyncio.create_task(_consume_generator(gen, draft_id))
    _running_tasks[draft_id] = task
    return {
        "ok": True,
        "draft_id": draft_id,
        "target_episode_count": payload.target_episode_count,
        "message": "续写已在后台启动",
    }


@router.get("/drafts/{draft_id}/extend/stream", dependencies=[Depends(require_draft_access)])
async def extend_stream(
    draft_id: int,
    target_episode_count: int = Query(..., ge=2, le=500),
    chunk_size: int = Query(20, ge=1, le=50),
    word_target: int | None = Query(None, ge=1, le=20000),  # 不设最低值
    model_provider: str = Query("gemini", pattern=r"^(gemini|deepseek|gpt5|grok|claude)(:[A-Za-z0-9._-]{1,60})?$"),
    forced_level: str | None = Query(None, pattern="^(L1|L2|L3)$"),
    user_guidance: str = Query("", max_length=200000),
):
    """SSE 实时流式续写 (浏览器 EventSource 用)。

    与 /extend/start 二选一: start 是后台任务+轮询进度, stream 是实时推送但断线即停。
    建议: 由前端先调 /extend/start 启动后台任务, 然后轮询 /progress 看进度。
    """
    global _current_running, _current_waiting
    _current_waiting += 1

    async def _wrapped():
        global _current_running, _current_waiting
        _current_waiting -= 1
        _current_running += 1
        try:
            async with _generation_semaphore:
                async for chunk in _extend_draft(
                    draft_id,
                    target_episode_count=target_episode_count,
                    chunk_size=chunk_size,
                    word_target=word_target,
                    provider=model_provider,
                    forced_level=forced_level,  # type: ignore[arg-type]
                    user_guidance=user_guidance,
                ):
                    yield chunk
        finally:
            _current_running -= 1

    return StreamingResponse(
        _wrapped(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/drafts/{draft_id}/extend/rollback", dependencies=[Depends(require_draft_access)])
async def rollback_extend(draft_id: int):
    """回滚最近一次续写: 删除 N+1 之后的章节, outline 恢复到续写前的状态。

    注意: 只在没有正在跑的续写任务时才允许回滚。
    """
    if _is_draft_task_alive(draft_id):
        raise HTTPException(409, "续写任务正在执行, 请等待结束后再回滚")
    snap = await get_progress_snapshot(draft_id)
    if snap.get("running") and snap.get("stage") == "continuation":
        raise HTTPException(409, "续写任务正在执行, 请等待结束后再回滚")

    result = await _rollback_extension(draft_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "回滚失败"))
    return result


# ===========================================================================
# 章节原文 / 双源混合 Word 导出
# ===========================================================================
from .export_chapter_docx import (
    export_chapter_full_text_docx as _export_chapter_full_text_docx,
    export_mixed_docx as _export_mixed_docx,
)


@router.get("/drafts/{draft_id}/chapters-export-docx/{chapter_order}", dependencies=[Depends(require_draft_access)])
async def export_chapter_full_text(draft_id: int, chapter_order: int):
    """导出单章正文(full_text)为 Word 文档, 保留原始剧本格式。

    与 /storyboards-export-docx 不同, 这里直接把 ScriptChapter.full_text
    渲染到 docx, 不走 LLM 剧本化, 适合"导入的剧本"或"用户手动改过的章节"。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        ch = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order,
            )
        )).scalar_one_or_none()
        if not ch:
            raise HTTPException(404, "chapter not found")
        full_text = ch.full_text or ""
        ch_title = ch.title or f"第{chapter_order}集"
        draft_title = draft.title or "未命名"

    if not full_text.strip():
        raise HTTPException(404, "本章正文为空")

    docx_bytes = _export_chapter_full_text_docx(
        draft_title=draft_title,
        chapter_title=ch_title,
        chapter_order=chapter_order,
        full_text=full_text,
    )
    filename = f"{draft_title}_第{chapter_order}集_原文.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


class ExportMixedIn(BaseModel):
    """混合导出请求 body。

    mode = "auto"   : 自动选源, 已锁定章节用 chapter, 其他用 storyboard
    mode = "all_chapter"   : 全部用章节正文
    mode = "all_storyboard": 全部用剧本
    mode = "manual" : 完全手动, 必须提供 chapters 字典
    """
    mode: str = Field("auto", pattern="^(auto|all_chapter|all_storyboard|manual)$")
    # mode=manual 时使用: { "1": "chapter", "2": "storyboard", ... }
    chapter_sources: dict[str, str] | None = None


@router.post("/drafts/{draft_id}/export-mixed-docx", dependencies=[Depends(require_draft_access)])
async def export_mixed_docx_endpoint(draft_id: int, payload: ExportMixedIn):
    """整剧混合导出 Word: 每集自由选择'章节正文'或'AI 剧本'作为内容源。

    返回二进制 docx 流。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")

        chapters = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()

        # 一次性把所有 storyboards 拉出来构建 order -> shots 索引
        sb_rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all()
        sb_by_order: dict[int, list] = {}
        for sb in sb_rows:
            shots = sb.shots_json if isinstance(sb.shots_json, list) else []
            sb_by_order[sb.chapter_order] = shots

        # 合成"伪章节"以覆盖只有剧本、没有章节记录的集。
        # 场景1 改编草稿: 完全没有章节, 只有剧本(分镜)。
        # 场景2 章节数<剧本数: 章节只生成了前 N 集, 剧本按大纲生成了更多集(如章节10/剧本50),
        #        多出的第 N+1..M 集若不补进来, 导出就会漏集(与前端剧本页同源 bug)。
        ol = dict(draft.outline or {})
        title_by_order = {
            int(c.get("order") or 0): c.get("title", "")
            for c in (ol.get("chapters") or [])
        }

        class _PseudoChapter:
            def __init__(self, order: int, title: str):
                self.chapter_order = order
                self.title = title
                self.full_text = ""
                self.locked = 0

        existing_orders = {ch.chapter_order for ch in chapters}
        extra_orders = sorted(o for o in sb_by_order if o not in existing_orders)
        chapters = list(chapters) + [
            _PseudoChapter(o, title_by_order.get(o) or f"第{o}集") for o in extra_orders
        ]
        chapters.sort(key=lambda c: c.chapter_order)

        if not chapters:
            raise HTTPException(404, "尚无章节或剧本,无法导出")

        draft_title = draft.title or "未命名"

    # 决定每集来源
    items: list[dict] = []
    src_map = payload.chapter_sources or {}
    for ch in chapters:
        order = ch.chapter_order
        order_str = str(order)
        chapter_locked = bool(getattr(ch, "locked", 0))
        has_full_text = bool((ch.full_text or "").strip())
        has_storyboard = bool(sb_by_order.get(order))

        # 决定 source
        if payload.mode == "all_chapter":
            source = "chapter"
        elif payload.mode == "all_storyboard":
            source = "storyboard"
        elif payload.mode == "manual":
            source = src_map.get(order_str) or ("chapter" if chapter_locked else "storyboard")
        else:  # auto
            source = "chapter" if chapter_locked else "storyboard"

        # fallback 兜底: 如果选的源没内容就退到另一个
        if source == "chapter" and not has_full_text and has_storyboard:
            source = "storyboard"
        elif source == "storyboard" and not has_storyboard and has_full_text:
            source = "chapter"

        items.append({
            "chapter_order": order,
            "chapter_title": ch.title or f"第{order}集",
            "source": source,
            "full_text": ch.full_text or "",
            "shots": sb_by_order.get(order, []),
        })

    docx_bytes = _export_mixed_docx(draft_title=draft_title, chapters=items)
    src_counts = {"chapter": 0, "storyboard": 0}
    for it in items:
        src_counts[it["source"]] += 1
    suffix = f"原文{src_counts['chapter']}集_剧本{src_counts['storyboard']}集"
    filename = f"{draft_title}_完整剧本_{suffix}.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/drafts/{draft_id}/export-source-suggest", dependencies=[Depends(require_draft_access)])
async def export_source_suggest(draft_id: int):
    """前端导出弹窗用: 返回每集的"建议来源"和可选项,
    让用户在 UI 上能看到默认值并可逐集切换。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        chapters = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        sb_rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all()
        sb_orders = {sb.chapter_order for sb in sb_rows if sb.shots_json}

        # 改编草稿等场景: 没有章节正文, 只有剧本(分镜)。
        # 用 outline.chapters 提供标题 + storyboards 的集号合成伪章节, 供导出弹窗列出。
        if not chapters and sb_orders:
            ol = dict(draft.outline or {})
            title_by_order = {
                int(c.get("order") or 0): c.get("title", "")
                for c in (ol.get("chapters") or [])
            }
            items = []
            for o in sorted(sb_orders):
                items.append({
                    "chapter_order": o,
                    "title": title_by_order.get(o) or f"第{o}集",
                    "locked": False,
                    "has_full_text": False,
                    "has_storyboard": True,
                    "word_count": 0,
                    "suggested_source": "storyboard",
                })
            return {
                "ok": True,
                "draft_id": draft_id,
                "title": draft.title or "未命名",
                "total": len(items),
                "items": items,
            }

    items = []
    for ch in chapters:
        has_full_text = bool((ch.full_text or "").strip())
        has_storyboard = ch.chapter_order in sb_orders
        chapter_locked = bool(getattr(ch, "locked", 0))
        suggested = "chapter" if chapter_locked else ("storyboard" if has_storyboard else "chapter")
        items.append({
            "chapter_order": ch.chapter_order,
            "title": ch.title or f"第{ch.chapter_order}集",
            "locked": chapter_locked,
            "has_full_text": has_full_text,
            "has_storyboard": has_storyboard,
            "word_count": ch.word_count or 0,
            "suggested_source": suggested,
        })

    # 补充"只有剧本、没有章节记录"的集(章节数<剧本数场景, 如章节10/剧本50)。
    # 否则导出弹窗只列出前 N 个有章节的集, 用户无法勾选第 N+1..M 集的剧本导出。
    existing_orders = {it["chapter_order"] for it in items}
    ol = dict(draft.outline or {})
    title_by_order = {
        int(c.get("order") or 0): c.get("title", "")
        for c in (ol.get("chapters") or [])
    }
    for o in sorted(sb_orders - existing_orders):
        items.append({
            "chapter_order": o,
            "title": title_by_order.get(o) or f"第{o}集",
            "locked": False,
            "has_full_text": False,
            "has_storyboard": True,
            "word_count": 0,
            "suggested_source": "storyboard",
        })
    items.sort(key=lambda it: it["chapter_order"])

    return {
        "ok": True,
        "draft_id": draft_id,
        "title": draft.title or "未命名",
        "total": len(items),
        "items": items,
    }


# ===========================================================================
# 改编 (Adaptation) — 把现有剧目改写成逻辑自洽、情绪曲线贴合原作的新作
# ===========================================================================
from .adaptation import (
    analyze_source as _adapt_analyze_source,
    suggest_changes as _adapt_suggest_changes,
    propose_blueprint as _adapt_propose,
    get_adapt_meta as _adapt_get_meta,
)


@router.get("/drafts/{draft_id}/adapt/meta")
async def adapt_meta(draft_id: int, user: User = Depends(get_current_user)):
    """改编面板初始化: 原作概况 + 已缓存蓝图(若有)。"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    info = await _adapt_get_meta(draft_id)
    if "error" in info:
        raise HTTPException(404, info["error"])
    return info


@router.post("/drafts/{draft_id}/adapt/analyze")
async def adapt_analyze(draft_id: int, user: User = Depends(get_current_user)):
    """步骤一: 调 LLM 提炼原作改编蓝图(同步返回)。"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    result = await _adapt_analyze_source(draft_id)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


class AdaptSuggestIn(BaseModel):
    origin: dict = Field(default_factory=dict)            # 原作蓝图
    draft_blueprint: dict = Field(default_factory=dict)   # 用户改编草案
    scope: str = Field("overall", pattern="^(field|overall)$")
    changed_field: str | None = None


@router.post("/drafts/{draft_id}/adapt/suggest")
async def adapt_suggest(draft_id: int, payload: AdaptSuggestIn, user: User = Depends(get_current_user)):
    """步骤二: 基于用户改动给连带修改建议(scope=field 即时 / overall 整体)。"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    result = await _adapt_suggest_changes(
        draft_id,
        origin=payload.origin,
        draft_blueprint=payload.draft_blueprint,
        scope=payload.scope,
        changed_field=payload.changed_field,
    )
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


class AdaptProposeIn(BaseModel):
    origin: dict = Field(default_factory=dict)   # 原作蓝图
    guidance: str = Field("", max_length=200000)   # 用户改编意向(可选)


@router.post("/drafts/{draft_id}/adapt/propose")
async def adapt_propose(draft_id: int, payload: AdaptProposeIn, user: User = Depends(get_current_user)):
    """一键生成一套全新的、与原作区分的改编设定(供用户对照编辑)。"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    result = await _adapt_propose(draft_id, origin=payload.origin, guidance=payload.guidance)
    if result.get("error"):
        raise HTTPException(400, result["error"])
    return result


class AdaptCommitIn(BaseModel):
    contract: dict = Field(..., description="改编合同: name_map/relations/era/locations/central_conflict/emotion_beats/characters/guidance/title")


@router.post("/drafts/{draft_id}/adapt/commit")
async def adapt_commit_start(
    draft_id: int, payload: AdaptCommitIn, user: User = Depends(get_current_user)
):
    """步骤三: 确认合同 → 入队后台改编作业，立即返回 job_id。

    🔴 2026-10-18 由 SSE 流改为后台作业（见 adaptation.run_adapt_commit 的说明）：
    原先关弹窗/刷新/nginx 读超时/上线重启都会中止改编，留下半成品草稿。
    进度：GET /v1/agent/jobs/{job_id}；取消：POST /v1/agent/jobs/{job_id}/cancel。
    """
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    active = await _active_adapt_job(draft_id)
    if active:
        raise HTTPException(409, {"message": "这部作品已有一个进行中的改编", "job_id": active["id"]})
    from ..agent import jobs as _jobs
    job_id = await _jobs.enqueue(kind="adapt_commit", draft_id=draft_id, user_id=user.id,
                                 payload={"source_draft_id": draft_id, "contract": payload.contract})
    return {"ok": True, "job_id": job_id}


async def _active_adapt_job(source_draft_id: int) -> dict | None:
    from ..db.models import AgentJob
    async with session_scope() as s:
        j = (await s.execute(
            select(AgentJob).where(AgentJob.kind == "adapt_commit", AgentJob.draft_id == source_draft_id,
                                   AgentJob.status.in_(("queued", "running")))
            .order_by(AgentJob.id.desc()).limit(1)
        )).scalar_one_or_none()
        return {"id": j.id, "status": j.status} if j else None


@router.get("/drafts/{draft_id}/adapt/jobs/active")
async def adapt_active_job(draft_id: int, user: User = Depends(get_current_user)):
    """改编弹窗打开时调用：这部作品有没有进行中的改编作业（有就接上进度）。"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
    return {"job": await _active_adapt_job(draft_id)}
