"""角色卡库自动抽取 worker (v2)。

与"设定圣经"区分:
- 圣经: 侧重主要角色的正名/称谓/驱动力, 服务一致性校验。
- 角色卡库: 全盘扫描剧情内所有角色, 抽取人物卡(身份/性格/外貌/背景) +
  全量人际关系网, 服务展示与人物关系分析。

入口: build_character_cards(draft_id) — 后台 task。
读 chapters(优先)或 storyboards, 调 LLM 抽取, 落库 Character + CharacterRelationship。
幂等: 重跑前清空该 draft 旧的自动卡(标记 source='auto'), 保留用户手动新增的。
"""
from __future__ import annotations

import json
import logging
import re

from sqlalchemy import select, delete

from ..db.session import session_scope
from ..db.models import ScriptDraft, ScriptChapter, ScriptStoryboard
from ..db.models_phase5 import Character, CharacterRelationship
from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("char_cards")

_SYS = (
    "你是剧本人物分析师。给你一部短剧的全文(或各集梗概), 请全盘扫描并抽取剧中出现的"
    "全部有名有姓/有明确身份的角色(含次要角色), 以及他们之间的人际关系网。\n"
    "严格输出 JSON: {\n"
    '  "characters": [{"name":"角色名","role":"主角/反派/配角等","identity":"身份(如总裁/医生)",'
    '"personality":"性格(一句话)","appearance":"外貌(一句话)","backstory":"背景/动机(一两句)",'
    '"importance":1-100 数字, 越大越核心}],\n'
    '  "relationships": [{"from":"角色名A","to":"角色名B","type":"关系(如父女/情敌/上下级)",'
    '"strength":0-100 亲密/冲突强度,"description":"一句话说明"}]\n'
    "}\n"
    "要求: 角色名用全文最常用的称呼; 关系覆盖主要人物之间的全部重要连接; 只输出 JSON, 不要解释。"
)


def _parse(raw: str):
    s = (raw or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i != -1 and j != -1 and j > i:
        s = s[i:j + 1]
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        return None


async def _load_text(draft_id: int) -> str:
    """读全剧文本: 优先章节正文; 否则用剧本 shots 拼; 按窗口控制总长。

    ⚠️ 2026-10-10：不再硬编码 `每集[:1200]` / `总量[:48000]`。
    那两个数字让 80 集的剧只用到 4.8 万字（不到全文的 10%），
    而角色卡的依据恰恰是"这个角色在整部剧里做过什么" —— 只看每集开头
    会漏掉大量人物行为，抽出来的性格/关系自然不准。
    现在按模型窗口算总预算，每集按分配额度取。
    """
    budget = _cards_budget_chars()
    async with session_scope() as s:
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        parts = []
        if chs:
            per_cap = max(1_200, budget // max(1, len(chs)))
            for c in chs:
                body = (c.full_text or "")
                if len(body) > per_cap:
                    from ..stages.episode_text import clip as _clip
                    body = _clip(body, per_cap, keep="both")
                if body.strip():
                    parts.append(f"【第{c.chapter_order}集 {c.title or ''}】\n{body}")
        else:
            sbs = (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
                .order_by(ScriptStoryboard.chapter_order)
            )).scalars().all()
            per_cap = max(1_200, budget // max(1, len(sbs)))
            for sb in sbs:
                try:
                    shots = sb.shots_json or []
                    txt = json.dumps(shots, ensure_ascii=False)
                    if len(txt) > per_cap:
                        from ..stages.episode_text import clip as _clip
                        txt = _clip(txt, per_cap, keep="both")
                except Exception:  # noqa: BLE001
                    txt = ""
                if txt:
                    parts.append(f"【第{sb.chapter_order}集】\n{txt}")
        return "\n\n".join(parts)[:budget]


#: 取不到窗口配置时的总量兜底（沿用改前的 48000）。
_CARDS_BUDGET_FALLBACK = 48_000


def _cards_budget_chars() -> int:
    """角色卡抽取的总预算 —— 按模型窗口算。"""
    try:
        from ..config import get_settings
        from ..stages.text_budget import text_budget_chars
        return text_budget_chars(
            get_settings().llm_generate_model or "", purpose="polish")
    except Exception:  # noqa: BLE001
        return _CARDS_BUDGET_FALLBACK


async def build_character_cards(draft_id: int, model: str = "gemini") -> dict:
    """抽取并落库角色卡 + 人际关系。返回 {characters, relationships} 计数。"""
    text = await _load_text(draft_id)
    if not text.strip():
        logger.warning("char_cards: draft %d no text", draft_id)
        return {"characters": 0, "relationships": 0}

    try:
        resp = await ainvoke_with_fallback(
            [{"role": "system", "content": _SYS},
             {"role": "user", "content": f"【剧情全文/梗概】\n{text}"}],
            role="rewrite", temperature=0.3, primary=model,  # type: ignore[arg-type]
        )
        raw = resp.content if hasattr(resp, "content") else str(resp)
        data = _parse(raw)
    except Exception as e:  # noqa: BLE001
        logger.exception("char_cards LLM failed for draft %d: %s", draft_id, e)
        return {"characters": 0, "relationships": 0, "error": str(e)}

    if not isinstance(data, dict):
        return {"characters": 0, "relationships": 0, "error": "parse_failed"}

    chars = [c for c in (data.get("characters") or []) if isinstance(c, dict) and c.get("name")]
    rels = [r for r in (data.get("relationships") or []) if isinstance(r, dict)]

    async with session_scope() as s:
        # 幂等: 删除旧的自动卡(traits 含标记 'auto') 及其关系; 保留手动卡
        old = (await s.execute(
            select(Character).where(Character.draft_id == draft_id)
        )).scalars().all()
        auto_ids = [c.id for c in old if "auto" in (c.traits or [])]
        if auto_ids:
            await s.execute(delete(CharacterRelationship).where(
                CharacterRelationship.draft_id == draft_id,
                CharacterRelationship.from_character_id.in_(auto_ids),
            ))
            await s.execute(delete(Character).where(Character.id.in_(auto_ids)))

        # 写新卡, 建立 name->id 映射
        name2id: dict[str, int] = {}
        for idx, c in enumerate(sorted(chars, key=lambda x: -int(x.get("importance", 0) or 0))):
            obj = Character(
                draft_id=draft_id,
                name=str(c.get("name"))[:64],
                role=str(c.get("role", ""))[:64],
                appearance=str(c.get("appearance", "")),
                personality=str(c.get("personality", "")),
                backstory=str(c.get("backstory", "")),
                traits=["auto"],  # 标记为自动抽取
                sort_order=idx,
            )
            s.add(obj)
            await s.flush()
            name2id[obj.name] = obj.id

        n_rel = 0
        for r in rels:
            fid = name2id.get(str(r.get("from", "")))
            tid = name2id.get(str(r.get("to", "")))
            if not fid or not tid or fid == tid:
                continue
            s.add(CharacterRelationship(
                draft_id=draft_id,
                from_character_id=fid,
                to_character_id=tid,
                relation_type=str(r.get("type", ""))[:40],
                strength=max(0, min(100, int(r.get("strength", 50) or 50))),
                description=str(r.get("description", "")),
            ))
            n_rel += 1

    logger.info("char_cards: draft %d -> %d chars, %d rels", draft_id, len(name2id), n_rel)
    return {"characters": len(name2id), "relationships": n_rel}