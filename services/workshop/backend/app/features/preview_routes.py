"""大纲预览:多模型并行生成候选,用户对比后选择一份作为初始大纲"""
import asyncio
import json
import logging
import re
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text, select

from ..db import session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..auth import get_current_user, User
from ..models.llm import get_llm

router = APIRouter(prefix="/v1/stages", tags=["preview"])
logger = logging.getLogger("preview")

# 并行的模型列表(可扩展)
# name展示给用户,不泄露具体模型名
PREVIEW_MODELS = [
    {"provider": "gemini", "name": "跨世界观模型"},
    {"provider": "deepseek", "name": "通用模型"},
    {"provider": "gpt5", "name": "逻辑专项模型"},
]

STYLE_PRESETS = ["默认", "温柔", "犀利", "轻快", "沉稳"]


class GenerateIn(BaseModel):
    style_preference: str | None = None  # 预设词或自由文本


class CandidateEditIn(BaseModel):
    outline: dict


class CandidateFeedbackIn(BaseModel):
    feedback: str


class SelectIn(BaseModel):
    confirm_discard_downstream: bool = False


async def _check_draft_access(s, draft_id: int, user: User):
    """权限检查"""
    row = await s.get(ScriptDraft, draft_id)
    if not row:
        raise HTTPException(404, "draft not found")
    if user.role not in ("admin", "superadmin") and row.user_id != user.id:
        raise HTTPException(403, "无权访问此草稿")
    return row


def _build_preview_prompt(user_input: str, chapter_count: int, word_target: int, style_preference: str | None) -> str:
    """构造带文风的prompt"""
    style_instr = ""
    if style_preference and style_preference != "默认":
        style_instr = f"\n\n【文风要求】: {style_preference}\n"
    
    return f"""你是资深短剧编剧。请根据以下用户输入,生成一份完整的短剧大纲。

## 用户输入
{user_input}

## 规格
- 共 {chapter_count} 集
- 每集目标字数 {word_target}{style_instr}

## 输出格式(严格JSON)
请在输出开头用一行自述你采用的文风,格式为:
【本文风格】: (一句话描述,不超过30字)

然后输出完整JSON大纲,结构:
```json
{{
  "title": "剧名",
  "synopsis": "全剧梗概(200字内)",
  "world": {{"era": "", "setting": "", "rules": []}},
  "characters": [
    {{"name": "", "role": "主角/反派/配角", "traits": [], "appearance": ""}}
  ],
  "chapters": [
    {{"order": 1, "title": "", "synopsis": "", "must_have": [], "characters": []}}
  ]
}}
```

仅输出【本文风格】一行 + ```json代码块```,不要其他解释。"""


def _extract_style_and_outline(raw: str) -> tuple[str, dict]:
    """从模型输出中提取文风描述和outline JSON"""
    style_desc = ""
    m = re.search(r'【本文风格】[:：]\s*(.+?)[\r\n]', raw)
    if m:
        style_desc = m.group(1).strip()[:100]
    
    # 提取JSON
    code_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', raw, re.DOTALL)
    json_str = code_match.group(1) if code_match else raw
    
    # fallback: 查找第一个完整的大括号块
    if not code_match:
        start = json_str.find('{')
        if start >= 0:
            depth = 0
            end = -1
            for i, ch in enumerate(json_str[start:], start=start):
                if ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
            if end > start:
                json_str = json_str[start:end+1]
    
    try:
        outline = json.loads(json_str)
    except Exception:
        # LLM 常在 JSON 字符串值里直接写裸换行/制表符 (Invalid control character),
        # 或尾随逗号 → 复用 adaptation 的健壮解析 (去围栏/截取/去尾逗号/转义控制字符/strict=False)
        try:
            from ..stages.adaptation import _extract_json
            outline = _extract_json(json_str if json_str else raw)
        except Exception:
            # 最后兜底: 宽松解析 (strict=False 允许字符串内控制字符)
            try:
                outline = json.loads(json_str, strict=False)
            except Exception as e2:
                # 记下出错位置前后的原文 —— 只有 300 字开头的话根本看不出病在哪
                # （2026-10-09 用户甲的失败出在第 24055 字，开头 300 字完全正常）。
                pos = getattr(e2, "pos", None)
                if isinstance(pos, int):
                    logger.warning("大纲 JSON 解析失败 @%d/%d, 附近原文: %r",
                                   pos, len(json_str), json_str[max(0, pos - 150):pos + 150])
                raise ValueError(f"JSON解析失败: {e2}; raw={raw[:300]}")

    return style_desc, outline


async def _generate_single_candidate(
    draft_id: int, candidate_id: int, provider: str,
    user_input: str, chapter_count: int, word_target: int,
    style_preference: str | None,
):
    """后台任务:为单个candidate生成大纲"""
    try:
        prompt = _build_preview_prompt(user_input, chapter_count, word_target, style_preference)
        llm = get_llm("generate", temperature=0.8, provider=provider, max_tokens=8192)
        resp = await llm.ainvoke(prompt)
        raw = resp.content.strip()
        
        style_desc, outline = _extract_style_and_outline(raw)
        
        async with session_scope() as s:
            await s.execute(
                text("""UPDATE outline_candidates
                        SET style_description=:sd, outline=:ol, status='ready', updated_at=NOW()
                        WHERE id=:id"""),
                {"sd": style_desc, "ol": json.dumps(outline, ensure_ascii=False), "id": candidate_id}
            )
        logger.info(f"candidate {candidate_id} ({provider}) 完成")
    except Exception as e:
        logger.warning(f"candidate {candidate_id} ({provider}) 失败: {e}")
        async with session_scope() as s:
            await s.execute(
                text("UPDATE outline_candidates SET status='failed', error_message=:em, updated_at=NOW() WHERE id=:id"),
                {"em": str(e)[:500], "id": candidate_id}
            )
    finally:
        # 检查本batch是否全部完成,若是则清理preview_batch_running
        async with session_scope() as s:
            cid_row = (await s.execute(
                text("SELECT batch_id, draft_id FROM outline_candidates WHERE id=:id"), {"id": candidate_id}
            )).first()
            if cid_row:
                batch_id, did = cid_row[0], cid_row[1]
                # ⚠️ 必须同时按 draft_id 过滤：batch_id 是**每个草稿各自**从 1 起编号的，
                # 只按 batch_id 数会把**别的草稿**的 generating 候选也算进来。
                # 2026-10-09 实测：草稿 279 有一条卡了 100 天的 generating（batch 1），
                # 于是全库所有草稿的第 1 批都"永远没跑完"，preview_batch_running 再也
                # 清不掉 —— 8 个草稿被锁死，再点「生成」只会 409「上一批预览尚未完成」。
                pending = (await s.execute(
                    text("SELECT COUNT(*) FROM outline_candidates "
                         "WHERE draft_id=:d AND batch_id=:b AND status='generating'"),
                    {"d": did, "b": batch_id}
                )).scalar()
                if pending == 0:
                    await s.execute(
                        text("UPDATE script_drafts SET preview_batch_running=0 WHERE id=:id AND preview_batch_running=:b"),
                        {"id": did, "b": batch_id}
                    )


# ============ API ============

@router.get("/drafts/{draft_id}/preview/models")
async def list_preview_models(draft_id: int, user: User = Depends(get_current_user)):
    """返回将用于预览的模型清单"""
    return {
        "models": PREVIEW_MODELS,
        "style_presets": STYLE_PRESETS,
    }


@router.post("/drafts/{draft_id}/preview/generate")
async def generate_preview(
    draft_id: int,
    payload: GenerateIn,
    user: User = Depends(get_current_user),
):
    """触发新一批预览(并行N个模型)"""
    async with session_scope() as s:
        draft = await _check_draft_access(s, draft_id, user)
        
        if draft.preview_batch_running and draft.preview_batch_running > 0:
            # 锁是"本批还有候选在生成"的缓存标记，真相在 outline_candidates 里。
            # 后台任务若随进程重启蒸发（asyncio 任务不持久），finally 永远不会跑，
            # 锁和 generating 行就一起僵死。所以这里以真相为准自愈：
            #   · 本草稿没有 generating 行 → 锁是陈旧的，直接放行
            #   · 有，但都超过 STALE 分钟没动 → 判死，标 failed 后放行
            #   · 有且新鲜 → 确实在跑，409
            stale_min = 30
            alive = (await s.execute(
                text("SELECT COUNT(*) FROM outline_candidates WHERE draft_id=:d "
                     "AND status='generating' AND updated_at > NOW() - make_interval(mins => :m)"),
                {"d": draft_id, "m": stale_min}
            )).scalar_one()
            if alive:
                raise HTTPException(409, "上一批预览尚未完成,请等待")
            await s.execute(
                text("UPDATE outline_candidates SET status='failed', "
                     "error_message='生成中断（超时未完成，可能是服务重启）', updated_at=NOW() "
                     "WHERE draft_id=:d AND status='generating'"),
                {"d": draft_id}
            )
            logger.info("草稿 %s 的预览锁已陈旧，自动解除", draft_id)
        
        user_input = draft.user_input or ""
        chapter_count = draft.episode_count or 3
        word_target = draft.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET
        
        if not user_input.strip():
            raise HTTPException(400, "草稿的user_input为空,无法生成预览")
        
        # 确定下一个batch_id
        max_batch = (await s.execute(
            text("SELECT COALESCE(MAX(batch_id), 0) FROM outline_candidates WHERE draft_id=:d"),
            {"d": draft_id}
        )).scalar_one() or 0
        next_batch = max_batch + 1
        
        # 创建N个candidate记录(status=generating)
        candidate_ids = []
        for m in PREVIEW_MODELS:
            result = await s.execute(
                text("""INSERT INTO outline_candidates
                        (draft_id, batch_id, model_provider, user_style_preference, status)
                        VALUES (:d, :b, :p, :sp, 'generating') RETURNING id"""),
                {"d": draft_id, "b": next_batch, "p": m["provider"], "sp": payload.style_preference}
            )
            candidate_ids.append(result.scalar_one())
        
        # 标记draft.preview_batch_running
        await s.execute(
            text("UPDATE script_drafts SET preview_batch_running=:b WHERE id=:d"),
            {"b": next_batch, "d": draft_id}
        )
    
    # 并行启动N个后台任务
    tasks = []
    for cid, m in zip(candidate_ids, PREVIEW_MODELS):
        task = asyncio.create_task(_generate_single_candidate(
            draft_id, cid, m["provider"],
            user_input, chapter_count, word_target, payload.style_preference
        ))
        tasks.append(task)
    
    return {
        "ok": True,
        "batch_id": next_batch,
        "candidate_ids": candidate_ids,
    }


@router.get("/drafts/{draft_id}/preview/candidates")
async def list_candidates(
    draft_id: int,
    batch_id: int | None = Query(None, description="不传返回全部,传则返回指定batch"),
    user: User = Depends(get_current_user),
):
    """获取候选大纲列表"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
        
        where = ["draft_id=:d"]
        params = {"d": draft_id}
        if batch_id is not None:
            where.append("batch_id=:b")
            params["b"] = batch_id
        
        rows = (await s.execute(
            text(f"""SELECT id, batch_id, model_provider, style_description, user_style_preference,
                     outline, is_selected, status, error_message, created_at, updated_at
                     FROM outline_candidates
                     WHERE {' AND '.join(where)}
                     ORDER BY batch_id DESC, id"""),
            params
        )).mappings().all()
        
        items = []
        for r in rows:
            d = dict(r)
            if d["created_at"]:
                d["created_at"] = d["created_at"].isoformat()
            if d["updated_at"]:
                d["updated_at"] = d["updated_at"].isoformat()
            items.append(d)
        
        # 批次列表
        batches = sorted(set(r["batch_id"] for r in rows), reverse=True)
        
        return {
            "items": items,
            "batches": batches,
            "latest_batch": batches[0] if batches else None,
        }


@router.get("/drafts/{draft_id}/preview/status")
async def preview_status(draft_id: int, user: User = Depends(get_current_user)):
    """轻量状态查询(供前端轮询)"""
    async with session_scope() as s:
        draft = await _check_draft_access(s, draft_id, user)
        generating_count = (await s.execute(
            text("SELECT COUNT(*) FROM outline_candidates WHERE draft_id=:d AND status='generating'"),
            {"d": draft_id}
        )).scalar_one()
        return {
            "preview_batch_running": draft.preview_batch_running or 0,
            "generating_count": generating_count,
            "is_idle": generating_count == 0,
        }


@router.patch("/drafts/{draft_id}/preview/candidates/{cid}")
async def edit_candidate(
    draft_id: int, cid: int,
    payload: CandidateEditIn,
    user: User = Depends(get_current_user)
):
    """手动编辑候选大纲。若此候选已被采用,同步到draft.outline并标记下游过期"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
        # 先查is_selected
        row = (await s.execute(
            text("SELECT is_selected FROM outline_candidates WHERE id=:id AND draft_id=:d"),
            {"id": cid, "d": draft_id}
        )).first()
        if not row:
            raise HTTPException(404, "candidate not found")
        is_selected = bool(row[0])
        
        outline_json = json.dumps(payload.outline, ensure_ascii=False)
        await s.execute(
            text("""UPDATE outline_candidates
                    SET outline=:ol, updated_at=NOW()
                    WHERE id=:id"""),
            {"ol": outline_json, "id": cid}
        )
        
        synced = False
        if is_selected:
            # 同步到draft.outline + 标记下游过期
            await s.execute(
                text("UPDATE script_drafts SET outline=:ol, updated_at=NOW() WHERE id=:d"),
                {"ol": outline_json, "d": draft_id}
            )
            await s.execute(
                text("UPDATE script_chapters SET is_stale=1 WHERE draft_id=:d"),
                {"d": draft_id}
            )
            await s.execute(
                text("UPDATE script_storyboards SET is_stale=1 WHERE draft_id=:d"),
                {"d": draft_id}
            )
            synced = True
        
        return {"ok": True, "synced_to_draft": synced}


@router.post("/drafts/{draft_id}/preview/candidates/{cid}/rewrite")
async def rewrite_candidate(
    draft_id: int, cid: int,
    payload: CandidateFeedbackIn,
    user: User = Depends(get_current_user)
):
    """意见重写:基于当前candidate让同一模型重写"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
        row = (await s.execute(
            text("""SELECT model_provider, outline, user_style_preference
                    FROM outline_candidates WHERE id=:id AND draft_id=:d"""),
            {"id": cid, "d": draft_id}
        )).first()
        if not row:
            raise HTTPException(404, "candidate not found")
        provider, current_outline, style_pref = row[0], row[1], row[2]
        prev_status = (await s.execute(
            text("SELECT status FROM outline_candidates WHERE id=:id"), {"id": cid}
        )).scalar_one()

        # 标记为generating（updated_at 一并刷新：生成接口靠它判断 generating 是否已僵死）
        await s.execute(
            text("UPDATE outline_candidates SET status='generating', updated_at=NOW() WHERE id=:id"),
            {"id": cid}
        )
    
    prompt = f"""你是资深短剧编剧。请根据用户修改意见重新生成大纲。

## 当前大纲
{json.dumps(current_outline, ensure_ascii=False)}

## 用户修改意见
{payload.feedback}

## 要求
1. 根据意见调整,但保持整体结构
2. 可以大幅修改人设、剧情、世界观
3. 在输出开头用一行自述文风:
【本文风格】: (一句话,不超过30字)

然后输出完整大纲JSON(格式同原大纲),放在```json```代码块中。不要其他解释。"""
    
    try:
        llm = get_llm("rewrite", temperature=0.8, provider=provider, max_tokens=8192)
        resp = await llm.ainvoke(prompt)
        raw = resp.content.strip()
        style_desc, new_outline = _extract_style_and_outline(raw)
        
        async with session_scope() as s:
            outline_json = json.dumps(new_outline, ensure_ascii=False)
            await s.execute(
                text("""UPDATE outline_candidates
                        SET outline=:ol, style_description=:sd, status='ready',
                            error_message=NULL, updated_at=NOW()
                        WHERE id=:id"""),
                {"ol": outline_json, "sd": style_desc, "id": cid}
            )
            # 若被采用,同步到draft + 标记下游过期
            sel_row = (await s.execute(
                text("SELECT is_selected FROM outline_candidates WHERE id=:id"), {"id": cid}
            )).first()
            if sel_row and sel_row[0]:
                await s.execute(
                    text("UPDATE script_drafts SET outline=:ol, updated_at=NOW() WHERE id=:d"),
                    {"ol": outline_json, "d": draft_id}
                )
                await s.execute(text("UPDATE script_chapters SET is_stale=1 WHERE draft_id=:d"), {"d": draft_id})
                await s.execute(text("UPDATE script_storyboards SET is_stale=1 WHERE draft_id=:d"), {"d": draft_id})
        return {"ok": True, "candidate_id": cid}
    except Exception as e:
        # ⚠️ 重写失败**不能**把候选标成 failed。
        #
        # 重写是在一份**已经好好的**大纲上改。outline 列并没有被覆盖（新结果没解析
        # 出来就没写），但旧代码把 status 改成 failed —— 前端只在 ready 时才画大纲
        # 和「采用/编辑/重写」按钮，于是一次重写失败就让用户**看不到、也用不了**
        # 那份原本能用的 61 集大纲（2026-10-09 用户甲的候选 #39 就是这样"消失"的）。
        #
        # 恢复成重写前的状态，并把失败原因挂在 error_message 上让前端提示。
        restore = prev_status if prev_status in ("ready", "failed") else "ready"
        async with session_scope() as s:
            await s.execute(
                text("UPDATE outline_candidates SET status=:st, error_message=:em, "
                     "updated_at=NOW() WHERE id=:id"),
                {"st": restore, "em": f"上次按意见重写失败（原大纲未改动）：{e}"[:500], "id": cid}
            )
        raise HTTPException(500, f"重写失败（原大纲未改动）: {e}")


@router.post("/drafts/{draft_id}/preview/candidates/{cid}/select")
async def select_candidate(
    draft_id: int, cid: int,
    payload: SelectIn,
    user: User = Depends(get_current_user)
):
    """采用此候选作为初始大纲"""
    async with session_scope() as s:
        draft = await _check_draft_access(s, draft_id, user)
        
        # 查candidate
        row = (await s.execute(
            text("""SELECT outline, status FROM outline_candidates
                    WHERE id=:id AND draft_id=:d"""),
            {"id": cid, "d": draft_id}
        )).first()
        if not row:
            raise HTTPException(404, "candidate not found")
        if row[1] != "ready":
            raise HTTPException(400, f"candidate状态为{row[1]},不能采用")
        candidate_outline = row[0]
        
        # 检查下游
        chapter_count = (await s.execute(
            text("SELECT COUNT(*) FROM script_chapters WHERE draft_id=:d"), {"d": draft_id}
        )).scalar_one()
        storyboard_count = (await s.execute(
            text("SELECT COUNT(*) FROM script_storyboards WHERE draft_id=:d"), {"d": draft_id}
        )).scalar_one()
        has_downstream = chapter_count > 0 or storyboard_count > 0
        
        if has_downstream and not payload.confirm_discard_downstream:
            return {
                "ok": False,
                "need_confirm": True,
                "downstream": {
                    "chapter_count": chapter_count,
                    "storyboard_count": storyboard_count,
                },
                "message": f"已生成 {chapter_count}章/{storyboard_count}剧本,采用新大纲将丢弃它们"
            }
        
        # 1. 备份当前outline到content_history
        if draft.outline:
            await s.execute(
                text("""INSERT INTO content_history
                        (draft_id, chapter_order, stage, content, change_reason, created_by)
                        VALUES (:d, 0, 'outline', :c, 'preview_select_replace', :u)"""),
                {"d": draft_id,
                 "c": json.dumps({"outline": draft.outline}, ensure_ascii=False),
                 "u": user.id}
            )
        
        # 2. 清所有candidate.is_selected, 设置本candidate
        await s.execute(
            text("UPDATE outline_candidates SET is_selected=false WHERE draft_id=:d"),
            {"d": draft_id}
        )
        await s.execute(
            text("UPDATE outline_candidates SET is_selected=true WHERE id=:id"),
            {"id": cid}
        )
        
        # 3. 把candidate outline写入draft
        await s.execute(
            text("UPDATE script_drafts SET outline=:ol, outline_locked=0, status='outline_done' WHERE id=:d"),
            {"ol": json.dumps(candidate_outline, ensure_ascii=False), "d": draft_id}
        )
        
        # 4. 如需丢弃下游
        if has_downstream and payload.confirm_discard_downstream:
            await s.execute(text("DELETE FROM script_chapters WHERE draft_id=:d"), {"d": draft_id})
            await s.execute(text("DELETE FROM script_storyboards WHERE draft_id=:d"), {"d": draft_id})

    # 5. 选定大纲后异步触发 / 刷新封面 (B 方案: 标题画进画面).
    #    与 run_outline 一致, 仅当 cover_url 还为空时触发, 避免每次切换 candidate 都烧配额;
    #    用户想强制重生封面走 /v1/drafts/{id}/cover/generate?force=true.
    try:
        async with session_scope() as s_cov:
            d_cov = await s_cov.get(ScriptDraft, draft_id)
            need_cover = bool(d_cov) and not (d_cov.cover_url or "")
        if need_cover:
            import asyncio as _asyncio_cov
            from ..draft_cover.routes import _generate_one
            _asyncio_cov.create_task(_generate_one(draft_id))
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "draft_id": draft_id,
        "selected_candidate_id": cid,
        "downstream_discarded": has_downstream and payload.confirm_discard_downstream,
    }


@router.delete("/drafts/{draft_id}/preview/candidates/{cid}")
async def delete_candidate(draft_id: int, cid: int, user: User = Depends(get_current_user)):
    """删除候选(不影响已采用的draft.outline)"""
    async with session_scope() as s:
        await _check_draft_access(s, draft_id, user)
        await s.execute(
            text("DELETE FROM outline_candidates WHERE id=:id AND draft_id=:d AND is_selected=false"),
            {"id": cid, "d": draft_id}
        )
        return {"ok": True}
