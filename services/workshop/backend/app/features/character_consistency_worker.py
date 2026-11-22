"""角色一致性扫描 worker (Phase 5 §12.6.7).

任务: 扫描所有章节正文, 比对每个角色的 appearance 关键词, 找出"角色描写漂移"的疑似点
   - 输入: draft_id
   - 处理: 加载 characters + chapters → 简易关键词比对 + 启发式检测 → 写入 character_consistency_warnings
   - 输出: 在 phase5Warnings.list 中可见的告警列表

设计原则:
- 不调外部 LLM, 用纯启发式 (避免增加成本); LLM 增强可后续按需加
- BackgroundTasks 触发, 同步执行, 完成后告警自动入库
- 重复扫描会先清掉同 character_id 的旧 unresolved 告警

启发式规则:
1. character.appearance 字段拆词 (中文特征词: 头发/眼睛/身高/年龄/服饰/疤痕等)
2. 在每章中搜索角色名出现的位置, 取上下文 (前后 100 字)
3. 若上下文中出现与 appearance 矛盾的描述关键词 (e.g. appearance 写"短发", 章节里出现"长发飘飘"), 记一条 warning
4. 简单语义相似度: 用关键词集合差集判断
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import select, delete

from ..db.session import session_scope
from ..db.models import ScriptChapter
from ..db.models_phase5 import Character, CharacterConsistencyWarning

logger = logging.getLogger("character_consistency")


# 简单的"反义词"对(中文短剧常见外貌特征)
ANTONYMS = [
    ("短发", "长发"),
    ("黑发", "白发"),
    ("黑发", "金发"),
    ("黑发", "红发"),
    ("黑发", "银发"),
    ("瘦", "胖"),
    ("瘦削", "肥胖"),
    ("高大", "矮小"),
    ("年轻", "年迈"),
    ("年轻", "年老"),
    ("少年", "中年"),
    ("少年", "老年"),
    ("少女", "妇人"),
    ("男人", "女人"),
    ("男孩", "女孩"),
    ("白皮肤", "黑皮肤"),
    ("白皙", "黝黑"),
    ("善良", "邪恶"),
    ("活泼", "沉静"),
]

# 外貌特征关键词 (用来从 appearance 文本中抽词)
APPEARANCE_FEATURES = [
    "头发", "短发", "长发", "黑发", "白发", "金发", "红发", "银发", "卷发", "直发",
    "眼睛", "黑眼", "蓝眼", "绿眼",
    "皮肤", "白皮肤", "黑皮肤", "白皙", "黝黑",
    "高大", "矮小", "瘦", "胖", "瘦削", "肥胖",
    "年轻", "年老", "年迈", "少年", "中年", "老年", "少女", "妇人",
    "男人", "女人", "男孩", "女孩",
    "疤痕", "胎记", "纹身", "胡子", "眼镜",
    "西装", "汉服", "T恤", "牛仔裤", "长袍", "盔甲",
]


def _extract_features(text: str) -> set[str]:
    """从 appearance 描述中抽取外貌关键词集合."""
    if not text:
        return set()
    found = set()
    for kw in APPEARANCE_FEATURES:
        if kw in text:
            found.add(kw)
    return found


def _find_conflicts(appearance_features: set[str], snippet: str) -> list[tuple[str, str]]:
    """看 snippet 里有没有跟 appearance 反义的描述. 返回 [(原特征, 冲突词)]."""
    conflicts: list[tuple[str, str]] = []
    for a, b in ANTONYMS:
        if a in appearance_features and b in snippet:
            conflicts.append((a, b))
        elif b in appearance_features and a in snippet:
            conflicts.append((b, a))
    return conflicts


async def scan_character_consistency(draft_id: int) -> dict:
    """主入口: 跑一次全量扫描, 写 warnings."""
    logger.info("[char_consistency] start draft=%s", draft_id)
    written = 0
    cleared = 0

    async with session_scope() as s:
        # 1. 拉所有 active 角色
        chars = (await s.execute(
            select(Character).where(
                Character.draft_id == draft_id,
                Character.is_active.is_(True),
            )
        )).scalars().all()
        if not chars:
            logger.info("[char_consistency] no characters, skip")
            return {"written": 0, "cleared": 0, "characters": 0}

        # 2. 拉所有章节
        chapters = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()

        # 3. 清掉旧的 unresolved warnings (重新扫描)
        cleared_res = await s.execute(
            delete(CharacterConsistencyWarning).where(
                CharacterConsistencyWarning.draft_id == draft_id,
                CharacterConsistencyWarning.resolved.is_(False),
            )
        )
        cleared = cleared_res.rowcount or 0

        # 4. 对每个角色 × 章节 跑启发式
        for ch in chars:
            features = _extract_features(ch.appearance or "")
            if not features:
                continue
            # 拼接所有章节, 找名字出现的位置
            seen_conflicts: dict[str, list[int]] = {}  # conflict_key → 出现的 chapter_orders
            for chapter in chapters:
                text = chapter.full_text or ""
                if not text or not ch.name:
                    continue
                # 找 name 出现的位置, 提取上下文
                name = ch.name
                idx = 0
                while True:
                    pos = text.find(name, idx)
                    if pos < 0:
                        break
                    snippet = text[max(0, pos - 100): pos + 100]
                    confs = _find_conflicts(features, snippet)
                    for original, conflict in confs:
                        key = f"{original}|{conflict}"
                        seen_conflicts.setdefault(key, []).append(chapter.chapter_order)
                    idx = pos + len(name)

            # 把 seen_conflicts 写为 warnings (按 conflict_key 聚合 chapter_orders)
            for key, chapter_orders in seen_conflicts.items():
                original, conflict = key.split("|")
                # 去重 chapter_orders
                uniq_orders = sorted(set(chapter_orders))
                w = CharacterConsistencyWarning(
                    draft_id=draft_id,
                    character_id=ch.id,
                    character_name=ch.name,
                    chapter_orders=uniq_orders,
                    warning_type="appearance_drift",
                    severity="medium" if len(uniq_orders) >= 3 else "low",
                    description=f"{ch.name} 的设定包含「{original}」, 但在 {len(uniq_orders)} 个章节中出现了对立描述「{conflict}」",
                    suggestion=f"请检查角色 {ch.name} 的描写是否前后一致, 或修改设定",
                    resolved=False,
                )
                s.add(w)
                written += 1

        await s.flush()

    logger.info("[char_consistency] done draft=%s cleared=%s written=%s", draft_id, cleared, written)
    return {"written": written, "cleared": cleared, "characters": len(chars)}
