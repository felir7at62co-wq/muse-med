"""候选保存的唯一写入口 —— 任何会覆盖正文/剧本的写操作都必须走这里。

── 为什么要有这个模块 ──
2026-09-18 的六入口核验（见 docs/PLAN-候选保存六入口核验表.md）发现：
覆盖正文的地方有十来处，各自为政。其中

  * batch_gen.py      先 DELETE 再生成 —— 生成失败旧稿就没了，且 version 归零；
  * chapter_gen.py    超长时 text[:hard_cap] 硬截断后直接返回 —— 完整稿彻底丢失；
  * continuation.py   回滚时直接 DELETE —— 删掉的正文永远拿不回来；
  * rewrite / check.fixer / critique 三处  存了历史但**裸 s.add**，没有 10 版上限。

本模块把"存历史 + 写当前行"收敛成一个函数，让上述每处都改成调它。

── 三条铁律（照抄 adapt_products/service.py:132-175 的成熟写法）──
  1. **先存历史，再写当前行**，且两者**在同一个事务里**。
     禁止"历史存了、正文没写"或反过来的半截状态。
  2. **快照无条件存**，包括"行不存在"和"行在但内容为空"这两种从无到有的情况。
     否则用户在空集上替换内容后想撤销，会因查不到历史而卡死
     （前端报"没有可回退的历史版本"）。
  3. **历史必须有上限**。统一走 stages._save_episode_history（每集每阶段封顶 10 版），
     不允许再出现裸 s.add(ScriptEpisodeHistory(...))。

── 与 _save_episode_history 的关系 ──
本模块在**同一个 session** 内内联复刻了 _save_episode_history 的"计数 + 淘汰最旧"逻辑，
而不是调用它。理由：_save_episode_history 自开一个 session_scope 并 commit，
若在这里调用它，历史会先落库，随后当前行写入若失败，历史就成了一条孤立记录 ——
正是铁律 1 要禁止的情形。裁剪口径与它保持一致（见 HISTORY_CAP）。
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from sqlalchemy import and_, func, select
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptChapter, ScriptDraft, ScriptEpisodeHistory, ScriptStoryboard, session_scope

logger = logging.getLogger("candidate_store")

#: 每集每阶段保留的历史版本数上限。与 router_m5_enhanced._save_episode_history 保持一致。
#: 前端历史面板的文案"保留最近 10 个版本"依赖这个数字，改这里要同步改文案。
HISTORY_CAP = 10

Stage = Literal["chapter", "storyboard", "outline"]

#: 各阶段的"内容字段"—— 写当前行时改哪个列。
_CONTENT_FIELD: dict[str, str] = {
    "chapter": "full_text",
    "storyboard": "shots_json",
}


class VersionConflict(Exception):
    """乐观锁冲突：调用方持有的 base_version 与库中当前版本不一致。

    调用方应当捕获它并告知用户"这一集在你编辑期间被改过了"，而不是覆盖。
    """

    def __init__(self, *, draft_id: int, order: int, expected: int, actual: int):
        self.draft_id = draft_id
        self.order = order
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"第{order}集版本冲突：期望 v{expected}，实际 v{actual}"
            f"（草稿 {draft_id}）"
        )


async def snapshot_in(s, *, draft_id: int, order: int, stage: str,
                      content: Any, version: int, created_by: str,
                      job_id: int | None = None) -> None:
    """在**调用方的事务内**写一条历史，并维持 HISTORY_CAP 上限。

    这是给"已经有一个 session、且必须保持整批原子性"的调用方用的：
      * rewrite/service.py —— 覆写循环在一个事务里，整本成功才提交；
      * check/fixer.py、critique/service.py —— 同上。
    它们不能换成 save_candidate（那会各自另开事务，破坏原子性），
    所以这里只提供"带上限的归档"这一半能力。

    不自己开 session —— 这是本函数与 _save_episode_history 的唯一区别。

    `job_id`：默认取当前作业上下文（`app/job_context.current_job_id()`），
    所以 33 个调用点都不用改；显式传入优先（`agent/operations.py` 那条
    修复路径不在 agent_jobs 表里，需要自己给一个可追溯的号）。
    """
    if job_id is None:
        from ..job_context import current_job_id
        job_id = current_job_id()

    count = (await s.execute(
        select(func.count()).select_from(ScriptEpisodeHistory).where(and_(
            ScriptEpisodeHistory.draft_id == draft_id,
            ScriptEpisodeHistory.episode_order == order,
            ScriptEpisodeHistory.stage == stage,
        ))
    )).scalar_one()

    # 留一个空位给即将写入的这条，保证最终不超过 CAP。
    if count >= HISTORY_CAP:
        # 按 (created_at, id) 排序取最旧：created_at 精度可能相同，
        # 加 id 兜底避免同秒写入时淘汰顺序不稳定。
        oldest = (await s.execute(
            select(ScriptEpisodeHistory).where(and_(
                ScriptEpisodeHistory.draft_id == draft_id,
                ScriptEpisodeHistory.episode_order == order,
                ScriptEpisodeHistory.stage == stage,
            )).order_by(ScriptEpisodeHistory.created_at, ScriptEpisodeHistory.id).limit(count - HISTORY_CAP + 1)
        )).scalars().all()
        for row in oldest:
            await s.delete(row)
        await s.flush()

    s.add(ScriptEpisodeHistory(
        draft_id=draft_id, episode_order=order, stage=stage,
        content=content, version=version, created_by=created_by,
        job_id=job_id,
    ))


async def save_candidate(
    *,
    draft_id: int,
    order: int,
    stage: Stage,
    content: Any,
    created_by: str,
    base_version: int | None = None,
    title: str | None = None,
) -> dict:
    """把 `content` 保存为第 `order` 集的**候选内容**（当前行），旧内容先归档。

    参数
      draft_id      草稿 id
      order         集号 / 章号
      stage         'chapter'（正文）| 'storyboard'（剧本分镜）
                    'outline' 不走本函数（大纲存在 draft.outline JSON 里，见
                    _fix_outline_episode），传进来会抛 ValueError。
      content       chapter 传 str；storyboard 传 list[dict]
      created_by    历史记录的来源标记。既有值：ai_generate / ai_fix / ai_rewrite /
                    critique / user_edit / user_rollback / ai_generate_truncated
      base_version  不为 None 时做乐观锁校验；不匹配抛 VersionConflict
      title         仅 chapter 用；None 表示保持原标题不动

    返回 {"order", "version", "before_chars", "after_chars", "created"}；
    `created=True` 表示这一集此前不存在（本次是"从无到有"）。

    铁律 1：整个过程在一个 session_scope 里。任何一步失败，历史与正文一起回滚，
            不会留下"历史存了、正文没改"的孤儿快照。
    """
    if stage not in _CONTENT_FIELD:
        raise ValueError(f"save_candidate 不支持 stage={stage!r}（大纲不走此入口）")

    is_sb = stage == "storyboard"
    field = _CONTENT_FIELD[stage]

    async with session_scope() as s:
        model = ScriptStoryboard if is_sb else ScriptChapter
        row = (await s.execute(
            select(model).where(model.draft_id == draft_id, model.chapter_order == order)
        )).scalars().first()

        if row is None:
            # 从无到有：先存一版空快照，让"撤销"能回到空白态（铁律 2）。
            await snapshot_in(
                s, draft_id=draft_id, order=order, stage=stage,
                content=[] if is_sb else {"full_text": "", "title": title or f"第{order}集"},
                version=0, created_by=created_by,
            )
            device: dict[str, Any] = {
                "draft_id": draft_id,
                "chapter_order": order,
                field: content,
                "version": 1,
            }
            if not is_sb:
                device["word_count"] = len(content or "")
                if title is not None:
                    device["title"] = title
            row = model(**device)
            s.add(row)
            await s.flush()
            await s.refresh(row)
            return {
                "order": order, "version": int(row.version or 1),
                "before_chars": 0, "after_chars": _size(content, is_sb),
                "created": True,
            }

        current_version = int(row.version or 1)
        if base_version is not None and int(base_version) != current_version:
            # 抛异常 → session_scope 回滚 → 什么都没写。这正是我们要的。
            raise VersionConflict(
                draft_id=draft_id, order=order,
                expected=int(base_version), actual=current_version,
            )

        before = row.shots_json if is_sb else (row.full_text or "")
        await snapshot_in(
            s, draft_id=draft_id, order=order, stage=stage,
            content=before if is_sb else {"full_text": row.full_text or "", "title": row.title or ""},
            version=current_version, created_by=created_by,
        )

        if is_sb:
            row.shots_json = content
            flag_modified(row, "shots_json")
        else:
            row.full_text = content or ""
            row.word_count = len(row.full_text)
            if title is not None:
                row.title = title
        row.version = current_version + 1
        # 正文改了 → 同集的剧本过期，需要重出。剧本是链路末端，无下游。
        if not is_sb:
            await s.execute(
                ScriptStoryboard.__table__.update().where(and_(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == order,
                )).values(is_stale=1)
            )
        await s.flush()
        await s.refresh(row)

    return {
        "order": order, "version": int(row.version or 1),
        "before_chars": _size(before, is_sb), "after_chars": _size(content, is_sb),
        "created": False,
    }


def _size(content: Any, is_sb: bool) -> int:
    """候选内容的大小度量：正文按字数，剧本按场数近似（只用于日志/回执，不做业务判断）。"""
    if is_sb:
        return len(content) if isinstance(content, list) else 0
    return len(content or "")


async def snapshot_only(
    *,
    draft_id: int,
    order: int,
    stage: Stage,
    content: Any,
    version: int,
    created_by: str,
    session=None,
) -> None:
    """只归档、不改当前行。

    给两类场景用：
      1. 入口即将删除这一集（续写回滚），删除前留一份；
      2. 入口拿到的完整稿长于将要存的截断稿（chapter_gen 超长截断）——
         完整稿以 created_by="ai_generate_truncated" 归档，截断稿走 save_candidate。

    这个函数存在的意义是：**让"只存历史"这件事也有唯一入口**，
    避免调用方为了图快又回去裸 s.add。

    session 参数：
      不传 → 自开事务，独立提交（chapter_gen 这种"先归档、后落库"的两步场景用它）。
      传了 → **在调用方的事务内**执行，不单独提交（continuation 这种
             "归档 + 删除"必须原子的场景用它）。
             ⚠️ 传 session 时不要在同一个 session 里再自开 session_scope ——
             会拿第二条连接、与自身未提交的写锁互等。
    """
    if stage not in _CONTENT_FIELD:
        raise ValueError(f"snapshot_only 不支持 stage={stage!r}")

    if session is not None:
        await snapshot_in(session, draft_id=draft_id, order=order, stage=stage,
                        content=content, version=version, created_by=created_by)
        return

    async with session_scope() as s:
        await snapshot_in(s, draft_id=draft_id, order=order, stage=stage,
                        content=content, version=version, created_by=created_by)


async def purge_history(*, draft_id: int) -> int:
    """草稿被删除时清掉它的历史。返回删除条数。

    目前 delete_draft 不删 script_episode_history，会留下孤儿行
    （draft_id 已不存在）。属"顺手修"范畴，不在 P0-1 的验收项里。
    """
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptEpisodeHistory).where(ScriptEpisodeHistory.draft_id == draft_id)
        )).scalars().all()
        for r in rows:
            await s.delete(r)
        return len(rows)
