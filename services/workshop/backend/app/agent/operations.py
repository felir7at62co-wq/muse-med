"""AI 提议的操作 - 创建 / 确认 / 执行 / 撤销.

15 种 op_type:
  replace_chapter, replace_chapter_section, append_to_chapter,
  replace_episode_synopsis, replace_episode_title, add_episode,
  update_world, add_character, update_character,
  replace_storyboard, add_to_snippets, add_to_memories,
  set_custom_instructions,
  apply_script_fix, apply_outline_fix

后两种是「体检 → 定点修复」的落库形式: 与前面 13 种的区别是**它不是 AI 在聊天里
提议的**, 而是对话工坊动作栏触发的批量修复。做成 operation 而不是悄悄改库, 是为了
让它在同一个操作历史里可见 —— 用户能在"操作记录"里看到"这次体检修了哪几集",
并沿用已有的确认/撤销通道, 而不是多出一套只有修复才走的影子路径。
"""
from __future__ import annotations
import json, logging, copy
from datetime import datetime, timedelta, timezone
from typing import Any
from sqlalchemy import text as sql_text, select
from sqlalchemy.orm.attributes import flag_modified
from ..db import (session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard,
                  ScriptEpisodeHistory)

logger = logging.getLogger("agent.operations")

OP_TYPES = {
    "replace_chapter", "replace_chapter_section", "append_to_chapter",
    "replace_episode_synopsis", "replace_episode_title", "add_episode",
    "update_world", "add_character", "update_character",
    "replace_storyboard", "add_to_snippets", "add_to_memories",
    "set_custom_instructions",
    "apply_script_fix", "apply_outline_fix",
}

OP_LABEL = {
    "replace_chapter": "替换整章正文",
    "replace_chapter_section": "替换章节内一段",
    "append_to_chapter": "在章节末尾追加",
    "replace_episode_synopsis": "更新分集梗概",
    "replace_episode_title": "改分集标题",
    "add_episode": "新增分集",
    "update_world": "更新世界观",
    "add_character": "新增角色",
    "update_character": "更新角色",
    "replace_storyboard": "替换剧本",
    "add_to_snippets": "加入片段库",
    "add_to_memories": "加入记忆库",
    "set_custom_instructions": "更新自定义指令",
    "apply_script_fix": "按体检报告修正文/剧本",
    "apply_outline_fix": "按体检报告修大纲",
}


async def _check_draft_owner(draft_id: int, user_id: int,
                            user_role: str | None = None) -> ScriptDraft:
    """权限校验。

    ⚠️ 2026-10-25: 加管理员放行，与 `stages/access.check_draft_access` 同一判据。
    原先这里只比 user_id。上下文层修好之后，管理员终于能让 AI 读到别人的剧本、
    AI 也会正常提出改动 —— 但那之后**一点确认就被这里拦死**（PermissionError →
    403 "draft not owned"）。用户看到的是"AI 说改好了，点确认却说没权限"。
    """
    from ..stages.access import is_admin_role
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"draft {draft_id} not found")
        if not is_admin_role(user_role) and d.user_id is not None and d.user_id != user_id:
            raise PermissionError(f"draft {draft_id} not owned")
        return d


def _calc_affected_chars(op_type: str, payload: dict) -> int:
    new = payload.get("new") or ""
    if isinstance(new, dict): new = json.dumps(new, ensure_ascii=False)
    return len(str(new))


def _calc_cascade_warnings(op_type: str, payload: dict) -> list[str]:
    warns = []
    if op_type in ("replace_chapter", "replace_chapter_section", "append_to_chapter"):
        warns.append("该章对应的剧本将被标记为过期 (is_stale=1)")
    if op_type in ("replace_episode_synopsis", "replace_episode_title", "add_episode"):
        warns.append("该集对应的章节正文将被标记为过期")
    if op_type == "replace_storyboard":
        warns.append("将覆盖已有剧本数据")
    return warns


async def create_operation(
    *, conversation_id: int, message_id: int | None, user_id: int,
    op_type: str, target_draft_id: int | None = None, target_chapter_order: int | None = None,
    target_field: str | None = None, payload: dict, confidence: float = 0.8,
) -> dict:
    """创建一个 pending 状态的 OperationCard."""
    if op_type not in OP_TYPES:
        raise ValueError(f"unknown op_type: {op_type}")
    affected = _calc_affected_chars(op_type, payload)
    warnings = _calc_cascade_warnings(op_type, payload)
    expires = datetime.now(timezone.utc) + timedelta(minutes=30)
    async with session_scope() as s:
        r = await s.execute(sql_text("""
            INSERT INTO agent_operations
              (conversation_id, message_id, user_id, op_type, target_draft_id, target_chapter_order,
               target_field, payload, status, confidence, affected_chars, cascade_warnings,
               reversible, expires_at)
            VALUES (:c, :m, :u, :t, :td, :tc, :tf, :pl, 'pending', :cf, :ac, :cw, TRUE, :ex)
            RETURNING id, created_at"""),
            {"c": conversation_id, "m": message_id, "u": user_id, "t": op_type,
             "td": target_draft_id, "tc": target_chapter_order, "tf": target_field,
             "pl": json.dumps(payload, ensure_ascii=False), "cf": confidence,
             "ac": affected, "cw": json.dumps(warnings), "ex": expires})
        row = r.first()
    return {
        "id": row[0], "op_type": op_type, "label": OP_LABEL.get(op_type, op_type),
        "target_draft_id": target_draft_id, "target_chapter_order": target_chapter_order,
        "target_field": target_field, "payload": payload, "status": "pending",
        "confidence": confidence, "affected_chars": affected, "cascade_warnings": warnings,
        "expires_at": expires.isoformat(), "created_at": row[1].isoformat() if row[1] else None,
    }


async def get_operation(op_id: int, user_id: int) -> dict | None:
    async with session_scope() as s:
        r = (await s.execute(sql_text("""
            SELECT id, conversation_id, message_id, user_id, op_type, target_draft_id,
                   target_chapter_order, target_field, payload, status, confidence,
                   affected_chars, cascade_warnings, reversible, expires_at,
                   confirmed_at, applied_at, applied_result, rolled_back_at, created_at
            FROM agent_operations WHERE id=:i AND user_id=:u"""), {"i": op_id, "u": user_id})).mappings().first()
        if not r: return None
        d = dict(r)
        d["label"] = OP_LABEL.get(d["op_type"], d["op_type"])
        return d


async def list_operations(user_id: int, conversation_id: int | None = None, status: str | None = None, limit: int = 50) -> list[dict]:
    where = ["user_id=:u"]; params = {"u": user_id, "lim": limit}
    if conversation_id: where.append("conversation_id=:c"); params["c"] = conversation_id
    if status: where.append("status=:s"); params["s"] = status
    async with session_scope() as s:
        rows = (await s.execute(sql_text(f"""
            SELECT id, conversation_id, message_id, op_type, target_draft_id, target_chapter_order,
                   target_field, payload, status, confidence, affected_chars, cascade_warnings,
                   reversible, expires_at, applied_at, rolled_back_at, created_at
            FROM agent_operations WHERE {' AND '.join(where)}
            ORDER BY id DESC LIMIT :lim"""), params)).mappings().all()
    return [{**dict(r), "label": OP_LABEL.get(r["op_type"], r["op_type"])} for r in rows]


async def reject_operation(op_id: int, user_id: int) -> bool:
    async with session_scope() as s:
        r = await s.execute(sql_text("""
            UPDATE agent_operations SET status='rejected'
            WHERE id=:i AND user_id=:u AND status='pending'"""), {"i": op_id, "u": user_id})
        return (r.rowcount or 0) > 0


# ===========================================================================
# 执行
# ===========================================================================

async def _capture_snapshot(op: dict) -> dict:
    """落地前抓快照, 用于撤销."""
    op_type = op["op_type"]
    draft_id = op.get("target_draft_id")
    snap = {"_taken_at": datetime.now(timezone.utc).isoformat()}
    if not draft_id and op_type not in ("set_custom_instructions",):
        return snap
    async with session_scope() as s:
        if op_type in ("replace_chapter", "replace_chapter_section", "append_to_chapter"):
            ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == op["target_chapter_order"]))).scalar_one_or_none()
            if ch: snap["chapter_full_text"] = ch.full_text or ""
        elif op_type in ("replace_episode_synopsis", "replace_episode_title", "add_episode",
                         "update_world", "add_character", "update_character"):
            d = await s.get(ScriptDraft, draft_id)
            if d: snap["outline"] = copy.deepcopy(d.outline or {})
        elif op_type == "replace_storyboard":
            sb = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == op["target_chapter_order"]))).scalar_one_or_none()
            if sb: snap["storyboard_shots"] = list(sb.shots_json or [])
    return snap


async def confirm_operation(op_id: int, user_id: int,
                            user_role: str | None = None) -> dict:
    """用户点击确认: 抓快照 → 执行 → 写回."""
    op = await get_operation(op_id, user_id)
    if not op: raise ValueError("op not found")
    if op["status"] != "pending":
        raise ValueError(f"op status is {op['status']}, not pending")
    if op.get("expires_at"):
        exp = op["expires_at"]
        if isinstance(exp, str):
            try: exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except: exp = None
        if exp and exp < datetime.now(timezone.utc):
            await reject_operation(op_id, user_id)
            raise ValueError("op expired")

    # 抓快照
    snapshot = await _capture_snapshot(op)
    # 执行
    result = await _execute(op, user_id, user_role=user_role)
    # 写回
    payload_with_snap = dict(op["payload"])
    payload_with_snap["_snapshot"] = snapshot
    async with session_scope() as s:
        await s.execute(sql_text("""
            UPDATE agent_operations
            SET status='confirmed', confirmed_at=NOW(), applied_at=NOW(),
                applied_result=:res, payload=:pl
            WHERE id=:i AND user_id=:u"""),
            {"i": op_id, "u": user_id,
             "res": json.dumps(result, ensure_ascii=False, default=str),
             "pl": json.dumps(payload_with_snap, ensure_ascii=False)})
    return {"ok": True, "op_id": op_id, "result": result}


async def _execute(op: dict, user_id: int,
                   user_role: str | None = None) -> dict:
    op_type = op["op_type"]
    payload = op["payload"]
    draft_id = op.get("target_draft_id")
    chapter_order = op.get("target_chapter_order")
    new_val = payload.get("new")

    if op_type == "replace_chapter":
        await _check_draft_owner(draft_id, user_id, user_role)
        async with session_scope() as s:
            ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
            if not ch:
                # summary 留空 = 交给读取侧退回本集全文。
                # 原来写 `new_val[:200]`（正文前 200 字），那不是摘要。
                ch = ScriptChapter(draft_id=draft_id, chapter_order=chapter_order,
                                   title=payload.get("title", f"第{chapter_order}章"),
                                   full_text=new_val, word_count=len(new_val), summary="")
                s.add(ch)
            else:
                ch.full_text = new_val
                ch.word_count = len(new_val)
                ch.is_stale = 0
            from sqlalchemy import update as _u
            await s.execute(_u(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))
        return {"chapter_order": chapter_order, "new_word_count": len(new_val)}

    if op_type == "replace_chapter_section":
        await _check_draft_owner(draft_id, user_id, user_role)
        old_match = payload.get("old_match", "")
        async with session_scope() as s:
            ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
            if not ch: raise ValueError("chapter not found")
            text = ch.full_text or ""
            if old_match and old_match in text:
                ch.full_text = text.replace(old_match, new_val, 1)
            else:
                ch.full_text = text + ("\n\n" + new_val if text else new_val)
            ch.word_count = len(ch.full_text)
            from sqlalchemy import update as _u
            await s.execute(_u(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))
        return {"chapter_order": chapter_order, "new_word_count": len(ch.full_text)}

    if op_type == "append_to_chapter":
        await _check_draft_owner(draft_id, user_id, user_role)
        async with session_scope() as s:
            ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
            if not ch: raise ValueError("chapter not found")
            ch.full_text = (ch.full_text or "") + "\n\n" + new_val
            ch.word_count = len(ch.full_text)
            from sqlalchemy import update as _u
            await s.execute(_u(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order).values(is_stale=1))
        return {"chapter_order": chapter_order, "new_word_count": len(ch.full_text)}

    if op_type in ("replace_episode_synopsis", "replace_episode_title"):
        await _check_draft_owner(draft_id, user_id, user_role)
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline = dict(d.outline or {})
            chs = list(outline.get("chapters") or [])
            for c in chs:
                if c.get("order") == chapter_order:
                    if op_type == "replace_episode_synopsis":
                        c["synopsis"] = new_val
                    else:
                        c["title"] = new_val
                    break
            outline["chapters"] = chs
            d.outline = outline
            flag_modified(d, "outline")
            from sqlalchemy import update as _u
            await s.execute(_u(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order).values(is_stale=1))
        return {"chapter_order": chapter_order, "field": op_type}

    if op_type == "add_episode":
        await _check_draft_owner(draft_id, user_id, user_role)
        new_ep = payload.get("new_ep") or {"order": 0, "title": "新集", "synopsis": new_val or ""}
        after = payload.get("after_order")
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline = dict(d.outline or {})
            chs = list(outline.get("chapters") or [])
            if after:
                idx = next((i for i,c in enumerate(chs) if c.get("order") == after), len(chs)-1)
                chs.insert(idx+1, new_ep)
            else:
                chs.append(new_ep)
            for i, c in enumerate(chs):
                c["order"] = i + 1
            outline["chapters"] = chs
            d.outline = outline
            d.episode_count = len(chs)
            flag_modified(d, "outline")
        return {"new_episode_count": len(chs)}

    if op_type == "update_world":
        await _check_draft_owner(draft_id, user_id, user_role)
        patches = payload.get("patches", {})
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline = dict(d.outline or {})
            world = dict(outline.get("world") or {})
            world.update(patches)
            outline["world"] = world
            d.outline = outline
            flag_modified(d, "outline")
        return {"updated_keys": list(patches.keys())}

    if op_type == "add_character":
        await _check_draft_owner(draft_id, user_id, user_role)
        ch_data = payload.get("character") or {}
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline = dict(d.outline or {})
            chars = list(outline.get("characters") or [])
            chars.append(ch_data)
            outline["characters"] = chars
            d.outline = outline
            flag_modified(d, "outline")
        return {"name": ch_data.get("name"), "total": len(chars)}

    if op_type == "update_character":
        await _check_draft_owner(draft_id, user_id, user_role)
        name = payload.get("name")
        patches = payload.get("patches") or {}
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline = dict(d.outline or {})
            chars = list(outline.get("characters") or [])
            for c in chars:
                if c.get("name") == name:
                    c.update(patches); break
            outline["characters"] = chars
            d.outline = outline
            flag_modified(d, "outline")
        return {"name": name, "patched_keys": list(patches.keys())}

    if op_type == "replace_storyboard":
        await _check_draft_owner(draft_id, user_id, user_role)
        shots = payload.get("shots") or []
        async with session_scope() as s:
            sb = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order))).scalar_one_or_none()
            if sb:
                sb.shots_json = shots
                sb.is_stale = 0
            else:
                s.add(ScriptStoryboard(draft_id=draft_id, chapter_order=chapter_order, shots_json=shots, is_stale=0))
        return {"chapter_order": chapter_order, "shot_count": len(shots)}

    if op_type == "add_to_snippets":
        from .memory import insert_snippet
        sid = await insert_snippet(user_id, content=new_val, category=payload.get("category", "other"),
                                   rating=payload.get("rating", 7), tags=payload.get("tags"))
        return {"snippet_id": sid}

    if op_type == "add_to_memories":
        from .memory import insert_memory
        # draft_id 传进去：角色/世界观类记忆会据此隔离到本部剧（见 memory.py 模块文档）
        mid = await insert_memory(user_id, type=payload.get("mem_type", "preference"),
                                  content=new_val, title=payload.get("title"),
                                  importance=payload.get("importance", 6),
                                  draft_id=draft_id)
        return {"memory_id": mid}

    if op_type == "set_custom_instructions":
        from .memory import update_profile
        await update_profile(user_id, custom_instructions=new_val)
        return {"set": True}

    # ── 体检定点修复(对话工坊动作栏触发) ──
    # payload 形状: {"report_id": int, "issue_ids": [...], "episodes": [int, ...]}
    # 真正干活的是 check/fixer.run_fix —— 它自己会: 按 issue_id 从报告取回问题原文、
    # 改写前把原稿写进 script_episode_history(created_by="ai_fix")、逐集校验长度比。
    # 这里只负责"把它包成一个可确认/可撤销的操作"。
    if op_type in ("apply_script_fix", "apply_outline_fix"):
        from ..check.fixer import run_fix
        from ..check.engine import load_draft_episodes
        from ..db import CheckReport
        report_id = int(payload.get("report_id") or 0)
        issue_ids = list(payload.get("issue_ids") or [])
        if not issue_ids:
            raise ValueError("issue_ids 为空, 没什么可修的")
        async with session_scope() as s:
            rep = await s.get(CheckReport, report_id) if report_id else None
            if rep is None:
                raise ValueError(f"体检报告 {report_id} 不存在")
            if rep.draft_id != draft_id:
                raise ValueError("报告与草稿不匹配")
            idx = dict(rep.issue_index or {})
        # 这一集是正文还是剧本, 决定了回滚要回哪张表 —— 问草稿本身, 不问报告。
        data_kind = (await load_draft_episodes(draft_id)).get("kind")
        # 快照: 撤销时要知道"该回滚哪几集、回滚到哪个 stage"。
        # 正文/剧本的**原稿**另有一份在 script_episode_history 里(修复器写的),
        # 这里只存坐标 —— 存整份原稿会让 agent_operations 的 payload 膨胀到几十万字。
        all_it = [idx[x] for x in issue_ids if x in idx]
        outline_eps = sorted({int(i["episode"]) for i in all_it
                              if i.get("kind") == "structure" and i.get("episode")})
        script_eps = sorted({int(i["episode"]) for i in all_it
                             if i.get("kind") != "structure" and i.get("episode")})
        payload["_snapshot"] = {
            "report_id": report_id,
            "outline_eps": outline_eps,
            "script_eps": script_eps,
            "script_stage": "storyboard" if (data_kind == "storyboard") else "chapter",
        }
        res = await run_fix(draft_id=draft_id, issue_index=idx, issue_ids=issue_ids,
                            provider=payload.get("provider") or "gemini", user_id=user_id)
        return {"fix": res, "report_id": report_id,
                "outline_eps": outline_eps, "script_eps": script_eps,
                "script_stage": payload["_snapshot"]["script_stage"]}

    raise ValueError(f"op_type {op_type} not implemented")


# ===========================================================================
# 撤销
# ===========================================================================

async def rollback_operation(op_id: int, user_id: int) -> dict:
    op = await get_operation(op_id, user_id)
    if not op: raise ValueError("op not found")
    if op["status"] != "confirmed":
        raise ValueError(f"only confirmed op can be rolled back (current: {op['status']})")
    if not op.get("reversible", True):
        raise ValueError("op is not reversible")
    snap = (op.get("payload") or {}).get("_snapshot") or {}
    op_type = op["op_type"]
    draft_id = op.get("target_draft_id")
    chapter_order = op.get("target_chapter_order")

    async with session_scope() as s:
        if op_type in ("replace_chapter", "replace_chapter_section", "append_to_chapter") and "chapter_full_text" in snap:
            ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == chapter_order))).scalar_one_or_none()
            if ch:
                ch.full_text = snap["chapter_full_text"]
                ch.word_count = len(ch.full_text)
        elif op_type in ("replace_episode_synopsis", "replace_episode_title", "add_episode",
                         "update_world", "add_character", "update_character") and "outline" in snap:
            d = await s.get(ScriptDraft, draft_id)
            if d:
                d.outline = snap["outline"]
                d.episode_count = len((snap["outline"].get("chapters") or []))
                flag_modified(d, "outline")
        elif op_type == "replace_storyboard" and "storyboard_shots" in snap:
            sb = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == chapter_order))).scalar_one_or_none()
            if sb:
                sb.shots_json = snap["storyboard_shots"]
        elif op_type == "add_to_memories":
            mem_id = (op.get("applied_result") or {}).get("memory_id")
            if mem_id:
                await s.execute(sql_text("UPDATE user_memories SET archived=TRUE WHERE id=:i AND user_id=:u"), {"i": mem_id, "u": user_id})
        elif op_type == "add_to_snippets":
            sid = (op.get("applied_result") or {}).get("snippet_id")
            if sid:
                await s.execute(sql_text("DELETE FROM user_snippets WHERE id=:i AND user_id=:u"), {"i": sid, "u": user_id})
        elif op_type in ("apply_script_fix", "apply_outline_fix"):
            # 回滚 = 把动过的集回填成修复前那一版。修复器每改一集都先写了一条
            # script_episode_history(created_by="ai_fix"), 这里取最新那条回填, 然后
            # 删掉它 —— 否则第二次回滚会把同一份旧稿又填回来, 把用户后来的手改冲掉。
            # stage 区分三种: outline / chapter(正文, content 是纯文本) /
            # storyboard(content 是 shots 数组)。
            outline_eps = list(snap.get("outline_eps") or [])
            script_eps = list(snap.get("script_eps") or [])
            sc_stage = snap.get("script_stage") or "chapter"

            def _latest(ep: int, stage: str):
                return (select(ScriptEpisodeHistory)
                        .where(ScriptEpisodeHistory.draft_id == draft_id,
                               ScriptEpisodeHistory.episode_order == int(ep),
                               ScriptEpisodeHistory.stage == stage,
                               ScriptEpisodeHistory.created_by == "ai_fix")
                        .order_by(ScriptEpisodeHistory.id.desc()).limit(1))

            for ep in script_eps:
                hist = (await s.execute(_latest(ep, sc_stage))).scalar_one_or_none()
                if hist is None:
                    logger.warning("回滚修复: 第%s集(%s)找不到 ai_fix 历史版本, 跳过",
                                   ep, sc_stage)
                    continue
                if sc_stage == "storyboard":
                    row = (await s.execute(select(ScriptStoryboard).where(
                        ScriptStoryboard.draft_id == draft_id,
                        ScriptStoryboard.chapter_order == int(ep)))).scalars().first()
                    if row is not None:
                        row.shots_json = copy.deepcopy(hist.content or [])
                        flag_modified(row, "shots_json")
                        row.is_stale = 0
                else:
                    row = (await s.execute(select(ScriptChapter).where(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == int(ep)))).scalars().first()
                    if row is not None:
                        # content 存的是 row.full_text 本身(纯字符串), 不是 {"full_text": ...}
                        row.full_text = hist.content if isinstance(hist.content, str) \
                            else (hist.content or {}).get("full_text", "")
                        row.word_count = len(row.full_text or "")
                        row.is_stale = 1     # 正文回退了, 下游剧本需重出
                await s.execute(sql_text("DELETE FROM script_episode_history WHERE id=:i"),
                                {"i": hist.id})

            for ep in outline_eps:
                hist = (await s.execute(_latest(ep, "outline"))).scalar_one_or_none()
                if hist is None:
                    logger.warning("回滚修复: 大纲第%s集找不到 ai_fix 历史版本, 跳过", ep)
                    continue
                d0 = await s.get(ScriptDraft, draft_id)
                if d0 is not None:
                    outline = dict(d0.outline or {})
                    key = "chapters" if outline.get("chapters") else "episodes"
                    eps = list(outline.get(key) or [])
                    old = hist.content if isinstance(hist.content, dict) else {}
                    for i, e in enumerate(eps):
                        if isinstance(e, dict) and int(e.get("order") or 0) == int(ep):
                            # 整集替换而不是逐字段回填: patch 过的字段可能不止白名单内的,
                            # 整集换回旧对象才保证"撤销 = 回到当时那一版"。
                            eps[i] = copy.deepcopy(old) if old else e
                            break
                    outline[key] = eps
                    d0.outline = outline
                    flag_modified(d0, "outline")
                await s.execute(sql_text("DELETE FROM script_episode_history WHERE id=:i"),
                                {"i": hist.id})

        await s.execute(sql_text("UPDATE agent_operations SET rolled_back_at=NOW(), status='rolled_back' WHERE id=:i"), {"i": op_id})
    return {"ok": True, "op_id": op_id}
