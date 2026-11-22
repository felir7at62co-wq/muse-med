"""M5增强版API扩展。

新增功能:
- 单集锁定/解锁 (大纲/章节/剧本)
- 单集修改 + 历史版本保存
- 区间重新生成
- 单集独立重新生成
- 历史版本查询/恢复
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, and_, desc, func

from ..auth import get_current_user, User
from .access import require_draft_access

from ..db import (
    ScriptChapter,
    ScriptDraft,
    ScriptStoryboard,
    ScriptEpisodeHistory,
    session_scope,
)

router = APIRouter(prefix="/v1/stages", tags=["stages-m5-enhanced"])
logger = logging.getLogger("stages.m5")


def _row_to_dict(row: Any) -> dict:
    """序列化ORM row"""
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


async def _save_episode_history(
    draft_id: int,
    episode_order: int,
    stage: str,
    content: dict,
    version: int,
    created_by: str = "ai_generate"
):
    """保存历史版本,限制每集每阶段最多10个版本

    job_id 由当前作业上下文自动带上（见 app/job_context.py）—— 这条入口
    自开事务、逐集提交，所以同一作业的多条历史时间戳各不相同，
    只有 job_id 能可靠地把它们归到一起。
    """
    from ..job_context import current_job_id
    async with session_scope() as s:
        # 检查现有版本数
        count = (await s.execute(
            select(func.count()).select_from(ScriptEpisodeHistory).where(
                and_(
                    ScriptEpisodeHistory.draft_id == draft_id,
                    ScriptEpisodeHistory.episode_order == episode_order,
                    ScriptEpisodeHistory.stage == stage
                )
            )
        )).scalar_one()

        # 如果超过10个,删除最旧的
        if count >= 10:
            oldest = (await s.execute(
                select(ScriptEpisodeHistory).where(
                    and_(
                        ScriptEpisodeHistory.draft_id == draft_id,
                        ScriptEpisodeHistory.episode_order == episode_order,
                        ScriptEpisodeHistory.stage == stage
                    )
                ).order_by(ScriptEpisodeHistory.created_at).limit(1)
            )).scalar_one_or_none()
            if oldest:
                await s.delete(oldest)

        # 保存新版本
        history = ScriptEpisodeHistory(
            draft_id=draft_id,
            episode_order=episode_order,
            stage=stage,
            content=content,
            version=version,
            created_by=created_by,
            job_id=current_job_id()
        )
        s.add(history)
        await s.flush()


# ---------------------------------------------------------------------------
# Phase 2.2: 单集锁定API
# ---------------------------------------------------------------------------

@router.post("/drafts/{draft_id}/outline/episodes/{order}/lock", dependencies=[Depends(require_draft_access)])
async def lock_outline_episode(draft_id: int, order: int, locked: bool = Query(True)):
    """锁定/解锁单集大纲"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        
        outline = draft.outline or {}
        episodes = outline.get("episodes") or outline.get("chapters") or []
        
        episode = next((e for e in episodes if e.get("order") == order), None)
        if not episode:
            raise HTTPException(404, f"episode {order} not found in outline")
        
        episode["locked"] = locked
        draft.outline = outline
        await s.flush()
        await s.refresh(draft)
        
        # 统计锁定状态
        locked_count = sum(1 for e in episodes if e.get("locked"))
        return {
            "episode": episode,
            "locked_count": locked_count,
            "total_count": len(episodes),
            "all_locked": locked_count == len(episodes)
        }


@router.post("/drafts/{draft_id}/chapters/{order}/lock", dependencies=[Depends(require_draft_access)])
async def lock_chapter(draft_id: int, order: int, locked: bool = Query(True)):
    """锁定/解锁单集章节"""
    async with session_scope() as s:
        chapter = (await s.execute(
            select(ScriptChapter).where(
                and_(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.chapter_order == order
                )
            )
        )).scalar_one_or_none()
        
        if not chapter:
            raise HTTPException(404, "chapter not found")
        
        chapter.locked = 1 if locked else 0
        
        # 如果解锁章节,同时解锁对应剧本(级联)
        if not locked:
            sb = (await s.execute(
                select(ScriptStoryboard).where(
                    and_(
                        ScriptStoryboard.draft_id == draft_id,
                        ScriptStoryboard.chapter_order == order
                    )
                )
            )).scalar_one_or_none()
            if sb and sb.locked:
                sb.locked = 0
        
        await s.flush()
        await s.refresh(chapter)
        
        # 统计锁定状态
        total = (await s.execute(
            select(func.count()).select_from(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id
            )
        )).scalar_one()
        
        locked_count = (await s.execute(
            select(func.count()).select_from(ScriptChapter).where(
                and_(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.locked == 1
                )
            )
        )).scalar_one()
        
        return {
            "chapter": _row_to_dict(chapter),
            "locked_count": locked_count,
            "total_count": total,
            "all_locked": locked_count == total
        }


@router.post("/drafts/{draft_id}/storyboards/{order}/lock")
async def lock_storyboard(
    draft_id: int, order: int, locked: bool = Query(True),
    user: User = Depends(get_current_user),
):
    """锁定/解锁单集剧本。

    ⚠ 本端点在 2026-09 之前**没有任何鉴权**: 拿到 draft_id 即可锁别人的剧本,
    而当时锁一旦打上, 用户没有任何界面能解除(全仓无调用方, 也无解锁入口)。
    现已补 _check_draft_access; 同批改动还摘掉了"锁 = 禁止写入"的三处拦截
    (见 restore_episode_version 与 router.py::patch_storyboard),
    锁现在只是一个记录位, 不再能把用户卡死。
    """
    # 延迟导入: 与 router.py 引用本模块 _save_episode_history 的方式对称,
    # 免得两个模块互相顶层 import 埋下循环依赖。
    from .router import _check_draft_access
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
        sb = (await s.execute(
            select(ScriptStoryboard).where(
                and_(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == order
                )
            )
        )).scalar_one_or_none()
        
        if not sb:
            raise HTTPException(404, "storyboard not found")
        
        # 检查对应章节是否锁定
        if locked:
            chapter = (await s.execute(
                select(ScriptChapter).where(
                    and_(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == order
                    )
                )
            )).scalar_one_or_none()
            
            if not chapter or not chapter.locked:
                raise HTTPException(409, "cannot lock storyboard: chapter not locked")
        
        sb.locked = 1 if locked else 0
        await s.flush()
        await s.refresh(sb)
        
        return {"storyboard": _row_to_dict(sb)}


# ---------------------------------------------------------------------------
# Phase 2.3: 单集修改API (带历史版本保存)
# ---------------------------------------------------------------------------

class UpdateOutlineEpisodeIn(BaseModel):
    """单集大纲可修改的字段。

    2026-11-07 改版：大纲正文即唯一事实，一集只有 `title` / `synopsis`。
    此前这里有 16 个字段（契约 15 个 + beats），用户改的是 `synopsis`、
    模型读的却是那些格子 —— 两份事实打架正是 `_beats_stale` 这类补丁要遮的病。
    现在直接写正文，写进去的就是用户看到的、也是模型收到的。

    ⚠️ 旧调用方若仍传契约字段，pydantic `extra="forbid"` 会 422 并点名，
    而不是静默丢弃 —— 保留这个严格性，否则又会退化成"接口 200 但什么都没改"。
    """
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    synopsis: str | None = None


def type_name(k: str) -> str:
    from .outline_fields import FIELD_SHAPE
    return {str: "文本", list: "列表", dict: "对象"}.get(FIELD_SHAPE.get(k), "未知")


@router.patch("/drafts/{draft_id}/outline/episodes/{order}", dependencies=[Depends(require_draft_access)])
async def update_outline_episode(
    draft_id: int,
    order: int,
    payload: UpdateOutlineEpisodeIn
):
    """修改单集大纲,保存历史版本"""
    from .outline_fields import shape_ok

    changes: dict = {}
    for k, v in payload.model_dump(exclude_unset=True).items():
        if v is None:
            continue
        ok, val = shape_ok(k, v)
        if not ok:
            raise HTTPException(422, f"字段 {k} 的格式不对(期望 {type_name(k)})")
        changes[k] = val
    if not changes:
        raise HTTPException(422, "没有可修改的字段")

    async with session_scope() as s:
        # 行锁: outline 是单列 JSON, 并发的单集保存会互相覆盖(后提交覆盖先提交)
        draft = await s.get(ScriptDraft, draft_id, with_for_update=True)
        if not draft:
            raise HTTPException(404, "draft not found")

        outline = draft.outline or {}
        episodes = outline.get("episodes") or outline.get("chapters") or []

        episode = next((e for e in episodes if e.get("order") == order), None)
        if not episode:
            raise HTTPException(404, f"episode {order} not found")

        # 注: 不再因 episode.locked 阻挡用户手动保存。
        # locked 的语义是"防止 AI 批量重生/覆盖用户内容"(见 batch_gen / regenerate-*),
        # 而用户在文本框里手动编辑后点保存, 本身就是最明确的主动意图, 必须放行。
        # 视频反推 / 导入剧本 / 批量生成会自动把集标 locked=True, 若在此拦截会导致
        # 用户永远无法手动修订这些集(报 409 "episode is locked")。

        # 保存历史版本
        old_version = episode.get("version", 1)
        await _save_episode_history(
            draft_id, order, "outline", episode, old_version, "user_edit"
        )

        # 更新内容(只写调用方显式传入的字段; 形状已在上面校验过)
        episode.update(changes)
        episode["version"] = old_version + 1
        # 2026-11-07：正文被用户改了，旧的契约/节拍/场景卡与它必然不一致。
        # 它们模型读得到、用户界面上看不见 —— 留着就是第二事实来源。
        # 只清与正文相关的旧字段，不碰 version / locked / _history 之类。
        if "synopsis" in changes:
            from .outline_fields import STALE_AFTER_REWRITE as _STALE
            for _k in _STALE:
                episode.pop(_k, None)

        # ⚠️ 关键修复: draft.outline 是 JSON 列。上面对 outline 内嵌 dict 的原地修改,
        # SQLAlchemy 默认【不会】检测为 dirty(除非用 MutableDict), 直接 `draft.outline = outline`
        # 赋的还是同一引用, 变更不会写库 → 表现为"保存后又回到编辑前"。
        # 用 deepcopy 生成新对象再赋值, 强制标记该列已变更, 确保持久化。
        import copy as _copy
        draft.outline = _copy.deepcopy(outline)
        try:
            from sqlalchemy.orm.attributes import flag_modified as _flag_modified
            _flag_modified(draft, "outline")
        except Exception:
            pass
        # 大纲修改后,标记对应章节和剧本为过期
        from sqlalchemy import update as _upd_stale
        from ..db import ScriptChapter, ScriptStoryboard
        await s.execute(_upd_stale(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order).values(is_stale=1))
        await s.execute(_upd_stale(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == order).values(is_stale=1))
        await s.flush()
        await s.refresh(draft)
        
        return {"episode": episode}


# ---------------------------------------------------------------------------
# Phase 2.6: 历史版本API
# ---------------------------------------------------------------------------

@router.get("/drafts/{draft_id}/episodes/{order}/history", dependencies=[Depends(require_draft_access)])
async def get_episode_history(
    draft_id: int,
    order: int,
    stage: str = Query(..., pattern="^(outline|chapter|storyboard)$")
):
    """获取单集历史版本列表"""
    async with session_scope() as s:
        histories = (await s.execute(
            select(ScriptEpisodeHistory).where(
                and_(
                    ScriptEpisodeHistory.draft_id == draft_id,
                    ScriptEpisodeHistory.episode_order == order,
                    ScriptEpisodeHistory.stage == stage
                )
            ).order_by(desc(ScriptEpisodeHistory.created_at))
        )).scalars().all()
        
        return [_row_to_dict(h) for h in histories]


class RestoreVersionIn(BaseModel):
    stage: str = Field(..., pattern="^(outline|chapter|storyboard)$")
    version: int


# ---------------------------------------------------------------------------
# 历史快照的 content 形状不统一 —— 恢复时必须容忍两种写法
#
# 写快照的地方有好几处，落库形状**不一致**（2026-09-16 实测 dev 库）：
#   · storyboard：rewrite/service.py 与 critique/service.py 直接存**裸列表**
#     （`content=sb.shots_json or []`）—— 1158/1160 行都是这种；
#     只有本文件的 `_save_episode_history` 存 `{"shots_json": [...]}` —— 2 行。
#   · chapter：多数存 `{"full_text": ...}`，另有 12 行是**裸字符串**。
#
# 旧代码只认 dict（`content.get("shots_json", [])`），于是拿裸列表快照做恢复时
# `.get` 走空默认值 → **把该集分镜清成空数组**，等于"点恢复反而把内容删了"；
# chapter 裸字符串则直接 AttributeError 500。精修/评审都在界面上承诺"可回滚"，
# 而那两条路径写的恰好都是裸形状 —— 也就是说承诺的回滚对几乎所有行都是坏的。
#
# 这里按形状归一，不去改历史数据（历史是既成事实，改它等于二次破坏）。
# ---------------------------------------------------------------------------

def _history_shots(content) -> list:
    """从历史快照里取出分镜列表。兼容裸列表 / {"shots_json": [...]} / {"shots": [...]}。"""
    if isinstance(content, list):
        return content
    if isinstance(content, dict):
        for key in ("shots_json", "shots"):
            v = content.get(key)
            if isinstance(v, list):
                return v
    # 认不出的形状：宁可 400 也不要静默清空用户的一集
    raise HTTPException(422, "history snapshot shape unrecognized; refuse to restore")


def _history_chapter(content) -> tuple[str, str | None]:
    """从历史快照里取出 (正文, 标题?)。兼容 {"full_text":...} 与裸字符串。"""
    if isinstance(content, str):
        return content, None
    if isinstance(content, dict):
        return str(content.get("full_text") or ""), content.get("title")
    raise HTTPException(422, "history snapshot shape unrecognized; refuse to restore")


@router.post("/drafts/{draft_id}/episodes/{order}/restore", dependencies=[Depends(require_draft_access)])
async def restore_episode_version(
    draft_id: int,
    order: int,
    payload: RestoreVersionIn
):
    """恢复到指定历史版本"""
    async with session_scope() as s:
        # 查找历史版本
        history = (await s.execute(
            select(ScriptEpisodeHistory).where(
                and_(
                    ScriptEpisodeHistory.draft_id == draft_id,
                    ScriptEpisodeHistory.episode_order == order,
                    ScriptEpisodeHistory.stage == payload.stage,
                    ScriptEpisodeHistory.version == payload.version
                )
            )
        )).scalar_one_or_none()
        
        if not history:
            raise HTTPException(404, "history version not found")
        
        content = history.content
        
        # 根据stage恢复到对应位置
        if payload.stage == "outline":
            draft = await s.get(ScriptDraft, draft_id)
            if not draft:
                raise HTTPException(404, "draft not found")
            
            outline = draft.outline or {}
            episodes = outline.get("episodes") or outline.get("chapters") or []
            episode = next((e for e in episodes if e.get("order") == order), None)
            
            if not episode:
                raise HTTPException(404, "episode not found in outline")
            # 注: 恢复历史版本同样是用户主动意图, 不因 locked 阻挡(与 update_outline_episode 一致)。

            # 保存当前版本到历史
            await _save_episode_history(
                draft_id, order, "outline", episode, episode.get("version", 1), "user_edit"
            )
            
            # 恢复内容
            episode.update(content)
            episode["version"] = episode.get("version", 1) + 1
            draft.outline = outline
            await s.flush()
            
            return {"episode": episode}
        
        elif payload.stage == "chapter":
            chapter = (await s.execute(
                select(ScriptChapter).where(
                    and_(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == order
                    )
                )
            )).scalar_one_or_none()
            
            if not chapter:
                raise HTTPException(404, "chapter not found")
            # 注: 不再因 chapter.locked 阻挡历史恢复(2026-09-16)，与下方 storyboard 分支一致。
            # 原因同那条: 恢复历史版本是**用户主动意图**，锁的本意是"别被自动流程改掉"，
            # 不该连人工回滚一起挡。而且导入正文时会自动 locked=1(见 chat_skills 导入处)，
            # 实测 dev 库 2123/6403 集正文处于锁定态 —— 前端没有任何解锁入口，
            # 这条拦截等于让那三分之一的集"恢复历史版本"永远 409，界面上承诺的回滚是坏的。

            # 保存当前版本
            await _save_episode_history(
                draft_id, order, "chapter",
                {"full_text": chapter.full_text, "title": chapter.title},
                chapter.version, "user_edit"
            )
            
            # 恢复
            _text, _title = _history_chapter(content)
            chapter.full_text = _text
            chapter.title = _title if _title is not None else chapter.title
            chapter.word_count = len(chapter.full_text)
            chapter.version += 1
            await s.flush()
            await s.refresh(chapter)
            
            return {"chapter": _row_to_dict(chapter)}
        
        elif payload.stage == "storyboard":
            sb = (await s.execute(
                select(ScriptStoryboard).where(
                    and_(
                        ScriptStoryboard.draft_id == draft_id,
                        ScriptStoryboard.chapter_order == order
                    )
                )
            )).scalar_one_or_none()
            
            if not sb:
                raise HTTPException(404, "storyboard not found")
            # 注: 不再因 sb.locked 阻挡历史恢复(2026-09)。
            # 剧本锁没有任何界面入口能打开、也没有入口能解除, 现网 0 行处于锁定态;
            # 这条拦截只会在极端情况下把用户永久卡在旧版本上, 且提示无从解除。
            # 章节锁的同类拦截(本文件 chapter 分支)保留 —— 那把锁有 1900+ 行真实数据,
            # 且导出选源依赖它, 语义是"用户成品, 机器别覆盖", 与此处不同。

            # 保存当前版本
            # 存当前版本。**用裸列表**与 rewrite/critique 保持一致（库里 1158/1160
            # 行是这个形状），避免继续制造第二种形状。读取侧 `_history_shots` 两种都认。
            await _save_episode_history(
                draft_id, order, "storyboard",
                sb.shots_json or [],
                sb.version, "user_edit"
            )
            
            # 恢复
            sb.shots_json = _history_shots(content)
            sb.version += 1
            await s.flush()
            await s.refresh(sb)
            
            return {"storyboard": _row_to_dict(sb)}
