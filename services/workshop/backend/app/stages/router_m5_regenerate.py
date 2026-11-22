"""M5增强版 - 重新生成API。

功能:
- 区间重新生成 (大纲)
- 单集独立重新生成 (大纲)
- 使用上下文构建器,确保剧情连贯
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import ScriptDraft, session_scope
from ..models.llm import get_llm
from .access import require_draft_access
from .context_builder import build_context_for_episode, neighborhood_block

router = APIRouter(prefix="/v1/stages", tags=["stages-m5-regenerate"])
logger = logging.getLogger("stages.m5.regenerate")


def _row_to_dict(row: Any) -> dict:
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


_REGEN_PROMPT = """你是资深短剧编剧。根据下面的上下文,重新生成指定集的大纲。

{context}

# 任务
重新生成第 {order} 集的大纲。要求:
1. 严格遵循原初大纲的世界观、人物设定、总体走向
2. 与已锁定的前后集剧情连贯衔接
3. 不偏离已确定的剧情主线
4. 仅输出当前集的内容,不要包含其他集

# 输出格式(严格JSON,不要Markdown)
{{
  "title": "本集标题",
  "synopsis": "整段大纲正文，要素之间用换行分隔"
}}

# 大纲正文写成要素块
正文就是这一集的大纲本身 —— 用户在界面上读它，下游写剧本也照着它写。
每个要素一段，顺序如下。【结尾钩子】必填，其余按需取舍（这一集没有独立的转折就不写【转折】，
不要为凑要素硬写）：

【开场卡点】这一集开场时，谁被卡在什么处境上——接住上一集结尾的悬置。
【冲突】谁要什么、谁挡着，两人争的具体是哪一件事。
【期待点】观众看到这里最想看到的那一下，以及它落在哪。
【互动】本集最主要的一来一回：谁先出手、对方怎么接、局面怎么变。
【转折】本集哪个时刻局面变了，从什么变成了什么。
【爽点】本集最值回票价的那一下，写成能被拍出来的画面或台词。
【结尾钩子】这一集最后落在哪句话或哪个动作上，观众为什么非点下一集。

- 写的要是能被拍出来的东西：谁做了什么、说了哪句话。不写"她意识到事情不对"这类结论。
- 唯一必填的是【结尾钩子】。其余要素按需取舍，写少而准好过写全而空。
- 不要再加别的标签（尤其不要写"地点""时间""在场人物"）—— 地点与人物由剧本按场次决定，
  一集本就会横跨多个场景，在大纲里定死只会自相矛盾。
"""


async def _regenerate_one_episode(
    draft: ScriptDraft,
    order: int,
    locked_episodes: list[dict],
) -> dict:
    """重新生成单集大纲"""
    import json
    import re
    
    total = draft.episode_count or len(draft.outline.get("chapters") or [])
    original = draft.original_outline or draft.outline or {}
    
    context = build_context_for_episode(
        episode_order=order,
        total_episodes=total,
        original_outline=original,
        locked_episodes=locked_episodes,
    )
    # 2026-10-28：人物与前后集不论是否锁定都要给（见 neighborhood_block 的事故说明）。
    # 取**当前**大纲：区间重写逐集保存后，下一集就能看到刚写好的上一集。
    near = neighborhood_block(draft.outline or {}, order)
    if near:
        context = context + "\n\n" + near + "\n\n人物只用上面已经出场的这些人，姓名与身份保持不变。"
    
    from ..prompt.loader import load_active_template
    db_tpl = None
    try:
        db_tpl = await load_active_template("outline_regenerate")
    except Exception:
        pass
    regen_tpl = db_tpl if db_tpl else _REGEN_PROMPT
    prompt = regen_tpl.format(context=context, order=order)
    # 草稿设定的写作模型（此前这里不传 provider，一律走平台默认）
    llm = get_llm("generate", temperature=0.7, provider=draft.model_provider or "gemini")
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    
    # 解析JSON
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except Exception:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            raise HTTPException(500, f"failed to parse LLM response for episode {order}")
        data = json.loads(match.group(0))
    
    # 2026-11-07 改版：大纲只剩 `order` / `title` / `synopsis` 三个键。
    # 此前这里还要回写契约（core_push/stakes/hook_out/plant/payoff…）与 beats，
    # 因为正文与契约是两份事实；现在正文就是唯一事实，重生成一定是整段覆盖，
    # 旧的契约/节拍由调用方一并清掉（见 `outline_fields.STALE_AFTER_REWRITE`）。
    return {
        "order": order,
        "title": str(data.get("title", f"第{order}集")).strip(),
        "synopsis": str(data.get("synopsis", "")).strip(),
    }


async def _save_regenerated(draft_id: int, new_ep: dict) -> ScriptDraft:
    """把一集新大纲写回草稿，**立即提交**，返回刷新后的草稿（供下一集取上下文）。

    2026-10-28 生产事故：原写回逻辑在读出来的 outline 对象上原地修改、再赋回同一个对象，
    SQLAlchemy 判定"值没变"，**不发 UPDATE**——接口返回成功和新内容，库里一个字没变
    （草稿 #2952 第 109–117 集生成 41 分钟，全部丢失；前端「重新生成此集」「区间重新生成」同病）。
    这里深拷贝后整体赋值并 flag_modified；已存在的集先留历史版本。
    """
    import copy
    from sqlalchemy.orm.attributes import flag_modified
    from .candidate_store import snapshot_in
    order = int(new_ep["order"])
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        outline = copy.deepcopy(draft.outline or {})
        episodes = list(outline.get("episodes") or outline.get("chapters") or [])
        existing = next((e for e in episodes if e.get("order") == order), None)
        if existing:
            await snapshot_in(s, draft_id=draft_id, order=order, stage="outline",
                              content=dict(existing), version=int(existing.get("version") or 1),
                              created_by="ai_rewrite")
            # 2026-11-07：**整集替换，不是合并**。
            # 老草稿身上带着 core_push/beats/plant 等旧契约字段，`update()` 会把它们
            # 原样留下，于是新正文与旧契约并存 —— 而下游（剧本生成）仍会读那些旧字段，
            # 等于用户重写了大纲、模型照着旧内容写。那正是本次要消灭的第二事实来源。
            # 现在：除了版本/锁定等元信息，内容一律以新产出为准。
            keep = {k: existing[k] for k in ("version", "locked") if k in existing}
            existing.clear()
            existing.update(new_ep)
            existing.update(keep)
            existing["version"] = int(keep.get("version") or 1) + 1
            existing["locked"] = False
        else:
            episodes.append({**new_ep, "version": 1, "locked": False})
        episodes.sort(key=lambda x: x.get("order", 0))
        outline["chapters"] = episodes
        if "episodes" in outline:
            outline["episodes"] = episodes
        draft.outline = outline
        flag_modified(draft, "outline")
        await s.flush()
        await s.refresh(draft)
        s.expunge(draft)
    return draft


class RegenerateRangeIn(BaseModel):
    start_order: int = Field(..., ge=1)
    end_order: int = Field(..., ge=1)


@router.post("/drafts/{draft_id}/outline/regenerate-range", dependencies=[Depends(require_draft_access)])
async def regenerate_outline_range(draft_id: int, payload: RegenerateRangeIn):
    """区间重新生成大纲(仅未锁定的集)。"""
    if payload.end_order < payload.start_order:
        raise HTTPException(400, "end_order must >= start_order")
    
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        
        outline = draft.outline or {}
        episodes = outline.get("episodes") or outline.get("chapters") or []
        
        # 保存原初大纲(首次重新生成时)
        if not draft.original_outline:
            import copy
            draft.original_outline = copy.deepcopy(outline)
        
        # 检查锁定状态
        target_episodes = [e for e in episodes if payload.start_order <= e.get("order", 0) <= payload.end_order]
        for ep in target_episodes:
            if ep.get("locked"):
                raise HTTPException(409, f"episode {ep.get('order')} is locked, please unlock first")
        
        # 已锁定的集作为上下文
        locked_episodes = [e for e in episodes if e.get("locked")]
        
        # 检测后续锁定集警告
        warning = None
        next_locked = next((e for e in episodes if e.get("order", 0) > payload.end_order and e.get("locked")), None)
        if next_locked:
            warning = f"第 {next_locked.get('order')} 集已锁定,重新生成可能导致剧情不连贯"
    
    # 逐集生成、**逐集保存**：一集失败不再连累前面已写好的集（此前整批在内存里，
    # 第 9 集失败前 8 集全丢；生成 30~60 分钟白跑，生产上连续发生两次）。
    regenerated: list[dict] = []
    failed_at, error = None, None
    for order in range(payload.start_order, payload.end_order + 1):
        try:
            new_ep = await _regenerate_one_episode(draft, order, locked_episodes)
        except Exception as e:  # noqa: BLE001
            logger.warning("regenerate episode %d failed: %s", order, e)
            failed_at, error = order, str(getattr(e, "detail", None) or e)
            break
        draft = await _save_regenerated(draft_id, new_ep)
        regenerated.append(new_ep)
    if failed_at is not None and not regenerated:
        raise HTTPException(500, f"regenerate episode {failed_at} failed: {error}")

    return {
        "regenerated_episodes": regenerated,
        "count": len(regenerated),
        "saved_orders": [e["order"] for e in regenerated],
        "failed_at": failed_at,
        "error": error,
        "warning": warning if failed_at is None else
        f"第 {failed_at} 集生成失败（{error}），已保存第 {payload.start_order}–{failed_at - 1} 集，可从第 {failed_at} 集继续",
    }


@router.post("/drafts/{draft_id}/outline/episodes/{order}/regenerate-solo", dependencies=[Depends(require_draft_access)])
async def regenerate_outline_episode_solo(draft_id: int, order: int):
    """单集独立重新生成。
    
    将其他所有集视为'已锁定'(仅在生成时,不修改实际锁定状态),
    确保新生成的内容与前后集衔接。
    """
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "draft not found")
        
        outline = draft.outline or {}
        episodes = outline.get("episodes") or outline.get("chapters") or []
        
        target = next((e for e in episodes if e.get("order") == order), None)
        if not target:
            raise HTTPException(404, f"episode {order} not found")
        if target.get("locked"):
            raise HTTPException(409, "episode is locked, please unlock first")
        
        # 保存原初大纲
        if not draft.original_outline:
            import copy
            draft.original_outline = copy.deepcopy(outline)
        
        # 临时把其他集都视为已锁定(仅用于上下文构建)
        other_episodes = [e for e in episodes if e.get("order") != order]
    
    # 调LLM
    try:
        new_ep = await _regenerate_one_episode(draft, order, other_episodes)
    except Exception as e:
        logger.warning("regenerate solo episode %d failed: %s", order, e)
        raise HTTPException(500, f"regenerate failed: {e}")
    
    # 写回（同 _save_regenerated 的事故说明：原地修改不会落库）
    await _save_regenerated(draft_id, new_ep)
    
    return {"episode": new_ep, "mode": "solo"}
