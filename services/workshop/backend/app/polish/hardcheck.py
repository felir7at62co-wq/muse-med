"""硬伤检查: 整合多种来源产出统一"硬伤工单", 供定向修复。

来源:
  1. 世界观规则扫描(复用 critique.bible.scan_against_bible): 只取 G1 时代违禁词。
  2. 事实账本跨集检测(polish.ledger): 死人复活 / 设定冲突。
  3. **全文自由审阅(LLM 通读全剧)**: 缝合怪/事件重复循环/暗线崩塌/称谓矛盾/主线断裂
     —— 这是机械规则和窄账本查不出的结构性灾难的主力检测(补上的关键能力)。
世界观圣经: 有则复用 draft.story_bible_json; 无则单模型现抽一版。
"""
from __future__ import annotations

import json as _json
import logging

from sqlalchemy import select

from ..db import session_scope, ScriptDraft, ScriptStoryboard, ScriptChapter
from ..critique.bible import extract_bible, scan_against_bible
from ..models.llm import get_llm
from .ledger import build_ledger, detect_ledger_issues

logger = logging.getLogger("polish.hardcheck")

# 全文自由审阅上限(与 analysis Step5 一致): 超出按集均匀截断
_FREEFORM_MAX_CHARS = 120_000

# 只采纳可靠的规则闸门。经真实剧验证:
#   - G1 时代违禁词: 精确字符串匹配, 可靠, 保留。
#   - G2 姓名漂移 / G3 称谓冲突 / G4 驱动力漂移: 易误报, 剔除(称谓矛盾改由全文审阅抓)。
#     2026-09-19: 场景名不一致**也走全文审阅**(`_FREEFORM_PROMPT` 第 4 条),
#     同样不新做规则闸门 —— 理由与 G2/G3 一致: 靠字面判"两个名字是不是同一个房间"
#     必然误报("客厅"与"卧室"会被判成同一个地点)。由 LLM 通读判语义, 零新增调用。
_ACCEPTED_GATES = {"gate_anachronism"}
_GATE_TYPE = {
    "gate_anachronism": "anachronism",  # 时代穿帮(唯一保留的规则闸门)
}


async def load_episodes_text(draft_id: int) -> dict[int, str]:
    """读一部剧的逐集正文。优先用 storyboard(剧本), 无则用 chapter(正文)。"""
    texts: dict[int, str] = {}
    async with session_scope() as s:
        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        if sbs:
            for sb in sbs:
                texts[int(sb.chapter_order)] = _shots_to_text(sb.shots_json or [])
            return texts
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        for ch in chs:
            texts[int(ch.chapter_order)] = ch.full_text or ""
    return texts


def _shots_to_text(shots) -> str:
    """把分镜 JSON 拼成可读文本(容错)。"""
    parts = []
    for sh in (shots or []):
        if not isinstance(sh, dict):
            continue
        chars = sh.get("characters")
        if isinstance(chars, list) and chars:
            parts.append("出场角色: " + "、".join(str(c) for c in chars if c))
        loc = sh.get("location")
        if loc:
            parts.append(f"[场景: {loc}]")
        for k in ("action", "dialogue", "line", "desc", "content", "text"):
            v = sh.get(k)
            if v:
                parts.append(str(v))
    return "\n".join(parts)


async def ensure_bible(draft_id: int, episodes_text: dict[int, str]) -> dict:
    """有圣经则复用, 无则单模型现抽一版并存回 draft。返回 bible dict(可能为空dict)。"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        existing = (draft.story_bible_json if draft else None) or {}
    if isinstance(existing, dict) and existing.get("world"):
        return existing
    bible = await extract_bible(episodes_text=episodes_text, models=["gemini"])
    if not isinstance(bible, dict):
        return {}
    try:
        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            if draft:
                draft.story_bible_json = bible
                await s.flush()
    except Exception as e:  # noqa: BLE001
        logger.warning("save bible for draft %d failed: %s", draft_id, e)
    return bible


def _scan_world_issues(episodes_text: dict[int, str], bible: dict) -> list[dict]:
    """跑规则闸门(时代穿帮), 转成统一硬伤工单。0 次 LLM。"""
    issues: list[dict] = []
    if not bible:
        return issues
    for ep, txt in episodes_text.items():
        for raw in scan_against_bible(txt or "", bible, episode=ep):
            role = raw.get("role")
            if role not in _ACCEPTED_GATES:
                continue
            issues.append({
                "type": _GATE_TYPE.get(role, "world"),
                "severity": "P0",
                "title": raw.get("issue", ""),
                "episodes": [ep],
                "anchor": raw.get("fix_hint", ""),
                "evidence": raw.get("evidence", ""),
            })
    return issues


# ============================================================
# 全文自由审阅 (LLM 通读全剧, 抓结构性硬伤)
# ============================================================

def _build_fulltext_block(episodes_text: dict[int, str]) -> str:
    """把全剧逐集正文拼成一段(超上限则按集均匀截断), 供 LLM 通读。

    ⚠️ 2026-10-10：上限改为按模型窗口算（`_freeform_cap()`），不再硬编码 120000。
    体检要"通读全剧"，它是最该给足上下文的用途（109 集全文约 24 万字，
    70 万口径下装得下）。
    """
    eps = sorted(episodes_text.keys())
    if not eps:
        return ""
    cap = _freeform_cap()
    total = sum(len(episodes_text[e] or "") for e in eps)
    per_cap = None
    if total > cap:
        per_cap = max(800, cap // len(eps))
    parts = []
    for e in eps:
        t = episodes_text[e] or ""
        if per_cap and len(t) > per_cap:
            # 保头 + 保尾并**显式标注**：硬伤常出现在集尾卡点附近，
            # 只留开头会漏掉断点处的矛盾。
            from ..stages.episode_text import clip
            t = clip(t, per_cap, keep="both")
        parts.append(f"【第{e}集】\n{t}")
    return "\n\n".join(parts)


def _freeform_cap() -> int:
    """全文通读的字数上限 —— 按模型窗口算，取不到则退回保守值。"""
    try:
        from ..config import get_settings
        from ..stages.text_budget import text_budget_chars
        return text_budget_chars(
            get_settings().llm_generate_model or "", purpose="check")
    except Exception:  # noqa: BLE001
        return _FREEFORM_MAX_CHARS


_FREEFORM_PROMPT = """你是顶级短剧总编审。请**通读下面整部剧本全文**, 像专业编审一句句核对逻辑, 找出会导致"无法开机/必须重构"的**硬伤(P0)**。

重点排查(这些最致命, 机械规则查不出来, 全靠你通读全剧):
1. **同一事件重复/鬼打墙循环**: 同一冲突反复发生(如"被开除"出现多次、"断水断电"多次、"法庭宣判"多次), 通常是不同稿子拼接的"缝合怪"。
2. **暗线/伏笔逻辑崩塌**: 关键暗线(身世/仇恨/车祸/火灾等)前后交代自相矛盾、断裂或说不通。
3. **人物称谓/关系前后矛盾**: 同一角色的称呼、身份、关系在不同集里冲突。
4. **场景名前后不统一**: 同一个地点被写成两个名字(如第 3 集叫"林家客厅"、
   第 12 集叫"林家大厅"; 或"顾氏集团大厅"与"顾氏大楼大堂"),
   会导致场景资产/参考图各出一份、统筹混乱。
   ⚠️ **只报同一个地点的两种叫法**。本来就是两个不同房间的(如"客厅"与"卧室")
   不算, 不要凑数。
5. **主线因果断裂**: 剧情推进缺乏因果、关键转折硬凑、人物动机不成立。
6. **结构性缝合**: 明显是多个不同版本强行拼接, 整体不自洽。

只报**确凿的硬伤**, 不要报文风/节奏/优化建议这类非硬伤。若整体确实自洽无硬伤, 返回空数组 []。

严格输出 JSON 数组(不要任何解释文字、不要 markdown), 每个元素:
{{"title":"一句话说清是什么硬伤", "episodes":[涉及的集号数字], "evidence":"剧中证据(简述哪几处矛盾)", "anchor":"修复方向"}}

【剧本全文】
{fulltext}

【硬伤 JSON 数组】"""


def _parse_issues_json(text: str) -> list[dict]:
    """从 LLM 输出里稳健解析 JSON 数组。"""
    if not text:
        return []
    s = text.strip()
    if s.startswith("```"):
        # 去代码块围栏
        s = s.strip("`")
        if s[:4].lower() == "json":
            s = s[4:]
    l, r = s.find("["), s.rfind("]")
    if l >= 0 and r > l:
        s = s[l:r + 1]
    try:
        data = _json.loads(s)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


async def _llm_freeform_issues(episodes_text: dict[int, str]) -> list[dict]:
    """把全剧正文交给 LLM 自由通读, 找结构性硬伤。1 次长上下文 LLM 调用。"""
    fulltext = _build_fulltext_block(episodes_text)
    if not fulltext.strip():
        return []
    try:
        llm = get_llm("rewrite", temperature=0.2, provider="gemini", max_tokens=4096)
        resp = await llm.ainvoke(_FREEFORM_PROMPT.format(fulltext=fulltext))
        raw = getattr(resp, "content", None) or ""
        items = _parse_issues_json(raw)
    except Exception as e:  # noqa: BLE001
        logger.warning("freeform hard-issue review failed: %s", e)
        return []
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        eps = it.get("episodes") or []
        if not isinstance(eps, list):
            eps = []
        eps = [int(x) for x in eps if str(x).strip().lstrip("-").isdigit()]
        out.append({
            "type": "structural",       # 结构性硬伤(全文审阅得出)
            "severity": "P0",
            "title": title,
            "episodes": eps,
            "anchor": str(it.get("anchor") or "").strip(),
            "evidence": str(it.get("evidence") or "").strip(),
        })
    return out


async def find_hard_issues(draft_id: int) -> tuple[list[dict], dict, int]:
    """一部剧的完整硬伤检查。返回 (issues, bible, ledger_fact_count)。

    三路合并:
      1) 世界观规则扫描(时代穿帮) —— 0 次 LLM
      2) 事实账本跨集检测(死人复活/设定互斥) —— 建账本 ceil(N/10) 次 LLM
      3) **全文自由审阅(缝合怪/事件循环/暗线崩塌/称谓矛盾/主线断裂)** —— 1 次长上下文 LLM
    第 3 路是关键: 让 LLM 像人一样通读全剧挑硬伤, 修复"机械规则查不出缝合怪/鬼打墙"的盲区。
    """
    episodes_text = await load_episodes_text(draft_id)
    if not episodes_text:
        return [], {}, 0

    # 1) 世界观圣经(有则复用, 无则单模型抽)
    bible = await ensure_bible(draft_id, episodes_text)

    # 2) 规则扫描(时代穿帮) —— 0 次 LLM
    world_issues = _scan_world_issues(episodes_text, bible)

    # 3) 事实账本 + 跨集检测(死人复活/设定冲突)
    ledger = await build_ledger(episodes_text)
    ledger_issues = detect_ledger_issues(ledger)
    fact_count = len(ledger.get("char_states") or []) + len(ledger.get("facts") or [])

    # 4) 全文自由审阅(结构性硬伤)
    freeform_issues = await _llm_freeform_issues(episodes_text)

    # 合并 + 编号
    all_issues = world_issues + ledger_issues + freeform_issues
    for idx, it in enumerate(all_issues, start=1):
        it["id"] = idx
        it["status"] = "open"

    logger.info(
        "hardcheck draft %d: world=%d ledger=%d freeform=%d 合计P0=%d",
        draft_id, len(world_issues), len(ledger_issues), len(freeform_issues), len(all_issues),
    )
    return all_issues, bible, fact_count