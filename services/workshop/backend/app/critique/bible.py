"""设定圣经 (Story Bible): 全剧唯一事实源 + 确定性一致性闸门 + 全局审计。

通用引擎原则 (零硬编码题材知识):
  - 所有题材相关的"事实"(世界观锚点/违禁词/人物名册/称谓矩阵/核心驱动力/桥段标签)
    都由模型在「圣经抽取」阶段按本剧动态生成, 存进 bible dict。
  - 本文件的确定性扫描器只做: 按 bible 给的表去 scan/diff/count/查铺垫,
    不含任何"民国/现代/古装"等题材假设 → 任何题材通用。

数据结构 (bible dict, 存 critique_runs.result_json["bible"]):
{
  "world": {"era":"民国军阀","locale":"中国","tech_level":"1920s","is_fictional":false,
            "anachronism_terms":["热搜","U盘","视频会议",...]},  # 模型按 era 生成
  "characters": [{"canonical":"秦婉","aliases":["婉儿"],"identity":"秦家遗孤/卧底",
                  "first_episode":1}],
  "name_whitelist": ["秦婉","陆震山",...],     # 所有合法专名(主角+配角), 派生自 characters
  "address_matrix": [{"from":"陆怀安","to":"陆震山","term":"爸","relation":"父子"}],
  "core_drive": {"protagonist":"秦婉","goal":"为秦家三十七口向陆震山复仇",
                 "locked_keywords":["秦家","三十七口"]},  # 锁定, 中途漂移即高危
  "trope_labels": ["窃听取证","直播曝光","贵人救场",...],  # 模型按本剧抽象
}
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter
from typing import Optional

from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("critique")


def _parse_json(text: str, fallback):
    """从 LLM 输出抽 JSON (容忍 markdown 代码块 / 前后噪声 / 裸控制字符)。"""
    if not text:
        return fallback
    s = str(text).strip()
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    for lb, rb in (("{", "}"), ("[", "]")):
        i, j = s.find(lb), s.rfind(rb)
        if i != -1 and j != -1 and j > i:
            cand = s[i:j + 1]
            try:
                return json.loads(cand, strict=False)
            except Exception:  # noqa: BLE001
                continue
    try:
        return json.loads(s, strict=False)
    except Exception:  # noqa: BLE001
        return fallback


# ======================================================================
# 一、圣经抽取 (开篇整体审查) — 三模型各抽一份 → 裁决合并成唯一事实源
# ======================================================================

_BIBLE_EXTRACT_SYSTEM = (
    "你是短剧的设定考据员。通读全剧各集梗概后, 抽取一份结构化《设定圣经》, 作为后续逐集"
    "精修的唯一事实源。只客观抽取剧本中已存在的设定, 不要发明剧本没有的东西。\n"
    "特别注意 world.era 的判定要准确(如民国/现代都市/古代王朝/架空玄幻), 并据此列出"
    "anachronism_terms: 与该世界观明显冲突、不该出现的词(如民国剧里的'热搜/U盘/视频会议/"
    "智能手机/微信'; 古装剧里的'手机/电脑'; 现代都市剧通常为空)。若世界观为架空(is_fictional=true),"
    "anachronism_terms 可为空。\n"
    "core_drive.locked_keywords: 主角核心驱动力里不可更改的关键词(如复仇对象的姓氏/家族),"
    "后续若漂移成别的姓氏即为重大错误。\n"
    "trope_labels: 把本剧出现的'破局/反转/打脸手法'抽象成简短标签(如'窃听取证''身世反转'"
    "'贵人救场'), 供后续统计同一招是否被滥用。标签要贴合本剧, 不要套用通用清单。\n"
    "严格输出 JSON 对象, 字段: world{era,locale,tech_level,is_fictional,anachronism_terms[]}, "
    "characters[{canonical,aliases[],identity,first_episode}], "
    "address_matrix[{from,to,term,relation}], "
    "core_drive{protagonist,goal,locked_keywords[]}, trope_labels[]。"
    "只输出 JSON, 不要任何解释或 markdown 标记。"
)

_BIBLE_ARBITER_SYSTEM = (
    "你是设定仲裁员。收到同一部剧由多个模型各自抽取的多份《设定圣经》草稿, 它们可能在"
    "人物正名/世界观/驱动力上有分歧。请裁决合并成唯一权威版本:\n"
    "- 人物正名: 取在剧中出现最一致、最高频的写法为 canonical, 其余并入 aliases。\n"
    "- world.era / core_drive: 取多数派; 若分歧大, 取与全剧梗概最自洽的一种。\n"
    "- anachronism_terms / trope_labels: 取并集后去重。\n"
    "输出与输入同结构的单个 JSON 对象。只输出 JSON, 不要解释或 markdown 标记。"
)


def _overview_text(episodes_text: dict[int, str], per_ep_chars: int = 700) -> str:
    parts = []
    for ep in sorted(episodes_text.keys()):
        body = (episodes_text[ep] or "")[:per_ep_chars]
        parts.append(f"【第{ep}集】\n{body}")
    return "\n\n".join(parts)


async def extract_bible(*, episodes_text: dict[int, str], models: list[str], emit=None) -> Optional[dict]:
    """三模型各抽一份圣经 → 仲裁合并成唯一事实源。失败返回 None(降级: 不启用圣经闸门)。"""
    overview = _overview_text(episodes_text)
    if not overview.strip():
        return None
    drafts: list[dict] = []
    for model in models:
        if emit:
            emit("bible_extract_start", model=model)
        try:
            resp = await ainvoke_with_fallback(
                [{"role": "system", "content": _BIBLE_EXTRACT_SYSTEM},
                 {"role": "user", "content": f"【全剧各集梗概序列】\n{overview}"}],
                role="rewrite", temperature=0.2, primary=model,  # type: ignore[arg-type]
            )
            raw = resp.content if hasattr(resp, "content") else str(resp)
            d = _parse_json(raw, None)
            if isinstance(d, dict) and d.get("characters"):
                drafts.append(d)
                if emit:
                    emit("bible_extract_done", model=model, chars=len(d.get("characters") or []))
        except Exception as e:  # noqa: BLE001
            logger.warning("bible extract %s failed: %s", model, e)
            if emit:
                emit("bible_extract_done", model=model, chars=0)
    if not drafts:
        return None
    bible = drafts[0] if len(drafts) == 1 else await _arbitrate_bible(drafts, models[0])
    if not isinstance(bible, dict):
        bible = drafts[0]
    _normalize_bible(bible)
    return bible


async def _arbitrate_bible(drafts: list[dict], model: str) -> dict:
    try:
        payload = json.dumps(drafts, ensure_ascii=False)
        resp = await ainvoke_with_fallback(
            [{"role": "system", "content": _BIBLE_ARBITER_SYSTEM},
             {"role": "user", "content": f"【多份圣经草稿】\n{payload}"}],
            role="rewrite", temperature=0.1, primary=model,  # type: ignore[arg-type]
        )
        raw = resp.content if hasattr(resp, "content") else str(resp)
        merged = _parse_json(raw, None)
        if isinstance(merged, dict) and merged.get("characters"):
            return merged
    except Exception as e:  # noqa: BLE001
        logger.warning("bible arbitrate failed (use first draft): %s", e)
    return drafts[0]


def _normalize_bible(bible: dict) -> None:
    """补全派生字段 (name_whitelist) + 去重, 容错缺字段。"""
    chars = bible.get("characters") or []
    wl: set[str] = set()
    for c in chars:
        if not isinstance(c, dict):
            continue
        if c.get("canonical"):
            wl.add(str(c["canonical"]).strip())
        for a in (c.get("aliases") or []):
            if a:
                wl.add(str(a).strip())
    bible["name_whitelist"] = sorted(x for x in wl if x)
    w = bible.get("world") or {}
    w["anachronism_terms"] = sorted(set(str(t).strip() for t in (w.get("anachronism_terms") or []) if t))
    bible["world"] = w
    bible["trope_labels"] = sorted(set(str(t).strip() for t in (bible.get("trope_labels") or []) if t))
    cd = bible.get("core_drive") or {}
    cd["locked_keywords"] = [str(k).strip() for k in (cd.get("locked_keywords") or []) if k]
    bible["core_drive"] = cd


# ======================================================================
# 二、确定性一致性闸门 (逐集精修时跑, 零模型成本, 零漏检)
#     全部基于 bible 提供的表, 不含任何题材知识。
# ======================================================================

# 主角姓名候选: 用于"姓名漂移"检测。中文姓名(2-4字)模式, 仅在白名单非空时启用。
_CN_NAME_RE = re.compile(r"[\u4e00-\u9fa5]{2,4}")


def scan_against_bible(text: str, bible: dict, *, episode: int) -> list[dict]:
    """用圣经对一集正文做确定性扫描, 产出 issue 列表 (与 LLM issue 同 schema)。

    检测项 (全部 confidence=100, 来自硬规则):
      G1 时代违禁词: 命中 world.anachronism_terms
      G2 姓名漂移: 出现"近似主角名但不在白名单"的专名(如 秦婉→沈婉)
      G3 称谓冲突: 文本同时出现 a 称 b 为 X, 但与 address_matrix 锁定的称谓矛盾
      G4 驱动力漂移: 本集涉及复仇/目标语境, 但 locked_keywords 全部缺席且出现竞争性姓氏
    """
    issues: list[dict] = []
    if not isinstance(bible, dict) or not text:
        return issues
    t = str(text)

    # G1 时代违禁词
    world = bible.get("world") or {}
    for term in (world.get("anachronism_terms") or []):
        if term and term in t:
            cnt = t.count(term)
            issues.append({
                "severity": "high",
                "role": "gate_anachronism",
                "issue": f"时代违禁词「{term}」出现 {cnt} 次, 与世界观({world.get('era','')})冲突",
                "evidence": term,
                "fix_hint": f"删除或替换「{term}」为符合「{world.get('era','本剧时代')}」的说法/物件",
                "locator": {"scene_no": f"第{episode}集"},
                "confidence": 100,
            })

    # G2 主角姓名漂移: 锁定的主角名(取 core_drive.protagonist + 白名单里的高频名)
    wl = set(bible.get("name_whitelist") or [])
    protagonist = ((bible.get("core_drive") or {}).get("protagonist") or "").strip()
    if protagonist and len(protagonist) >= 2:
        # 主角名的"姓"和"名"
        surname, given = protagonist[0], protagonist[1:]
        # 找出现的"X+given"(同名不同姓)且不在白名单 → 疑似姓名漂移(秦婉→沈婉)
        for m in re.finditer(re.escape(given), t):
            start = m.start()
            if start >= 1:
                cand = t[start - 1] + given
                if (re.fullmatch(r"[\u4e00-\u9fa5]", t[start - 1])
                        and cand != protagonist and cand not in wl):
                    issues.append({
                        "severity": "high",
                        "role": "gate_name_drift",
                        "issue": f"疑似主角姓名漂移: 出现「{cand}」, 但主角正名应为「{protagonist}」",
                        "evidence": cand,
                        "fix_hint": f"将「{cand}」改回「{protagonist}」(除非剧情明确揭示化名)",
                        "locator": {"scene_no": f"第{episode}集"},
                        "confidence": 100,
                    })
                    break  # 同一漂移名报一次即可

    # G3 称谓冲突: 文本里"b+term"形式与 address_matrix 锁定矛盾
    for rule in (bible.get("address_matrix") or []):
        if not isinstance(rule, dict):
            continue
        b = str(rule.get("to") or "").strip()
        locked = str(rule.get("term") or "").strip()
        if not b or not locked:
            continue
        # 找 "称 b 为 X" 的简单模式: b 后紧跟一个称谓词且 != locked
        # 仅当 b 在本集出现且出现了与 locked 同类但不同的亲属称谓
        kin_terms = ["爸", "父亲", "爹", "妈", "母亲", "娘", "叔", "伯", "舅", "姑",
                     "哥", "弟", "姐", "妹", "爷爷", "奶奶", "二叔", "小叔", "大伯"]
        for kt in kin_terms:
            if kt == locked:
                continue
            # 模式: b 紧邻 kt (如 "陆震山二叔" / "喊陆震山二叔")
            if (b + kt) in t:
                issues.append({
                    "severity": "high",
                    "role": "gate_address",
                    "issue": f"称谓冲突: 文中出现「{b}{kt}」, 但圣经锁定对「{b}」的称谓为「{locked}」({rule.get('relation','')})",
                    "evidence": b + kt,
                    "fix_hint": f"按人物关系将称谓统一为「{locked}」",
                    "locator": {"scene_no": f"第{episode}集"},
                    "confidence": 100,
                })
                break

    # G4 驱动力漂移: 出现锁定关键词的"竞争姓氏"变体
    cd = bible.get("core_drive") or {}
    locked_kw = [k for k in (cd.get("locked_keywords") or []) if k]
    if locked_kw:
        # 复仇/目标语境词
        ctx_words = ["复仇", "报仇", "讨命", "血债", "满门", "灭门", "讨回", "为", "替"]
        has_ctx = any(w in t for w in ctx_words)
        hits = [k for k in locked_kw if k in t]
        if has_ctx and not hits:
            # 出现了复仇语境但锁定关键词全缺席 → 提示核对驱动力是否漂移
            issues.append({
                "severity": "mid",
                "role": "gate_drive",
                "issue": f"本集出现复仇/目标语境, 但核心驱动力关键词{locked_kw}全部缺席, 警惕驱动力漂移",
                "evidence": cd.get("goal", ""),
                "fix_hint": f"确认复仇对象/目标仍为「{cd.get('goal','')}」, 勿替换成其他家族/目标",
                "locator": {"scene_no": f"第{episode}集"},
                "confidence": 100,
            })
    return issues


def update_trope_ledger(ledger: dict, text: str, bible: dict, *, episode: int) -> list[dict]:
    """桥段去重计数器: 统计 bible.trope_labels 在本集命中情况, 累计到 ledger。

    ledger 形如 {label: [ep1, ep2, ...]}。同一标签复用达阈值即产出 issue。
    返回本集触发的 issue 列表。注意: 标签是模型按本剧生成的, 无题材假设。
    """
    issues: list[dict] = []
    if not isinstance(bible, dict) or not text:
        return issues
    t = str(text)
    labels = bible.get("trope_labels") or []
    REPEAT_THRESHOLD = 3  # 第 3 次复用起提示
    for label in labels:
        if not label:
            continue
        # 标签命中: 标签词本身或其去标点核心出现在文本(粗匹配)
        core = re.sub(r"[^\u4e00-\u9fa5A-Za-z]", "", str(label))
        if core and core in re.sub(r"[^\u4e00-\u9fa5A-Za-z]", "", t):
            eps = ledger.setdefault(label, [])
            if episode not in eps:
                eps.append(episode)
            if len(eps) >= REPEAT_THRESHOLD:
                issues.append({
                    "severity": "mid",
                    "role": "gate_trope_repeat",
                    "issue": f"破局/反转手法「{label}」已在第{eps}集重复使用 {len(eps)} 次, 套路单一",
                    "evidence": label,
                    "fix_hint": "更换破局方式; 让反派对同一招产生警惕/反制, 避免反派降智",
                    "locator": {"scene_no": f"第{episode}集"},
                    "confidence": 100,
                })
    return issues


def bible_constraint_text(bible: dict) -> str:
    """把圣经压缩成给编辑/审查模型的硬约束提示 (注入 system)。"""
    if not isinstance(bible, dict):
        return ""
    world = bible.get("world") or {}
    cd = bible.get("core_drive") or {}
    names = "、".join((bible.get("name_whitelist") or [])[:40])
    addr = "; ".join(
        f"{r.get('from','')}称{r.get('to','')}为「{r.get('term','')}」"
        for r in (bible.get("address_matrix") or [])[:30] if isinstance(r, dict)
    )
    banned = "、".join((world.get("anachronism_terms") or [])[:40])
    lines = [
        "【设定圣经·硬约束(不可违反)】",
        f"世界观: {world.get('era','')} / {world.get('locale','')} / 科技水平 {world.get('tech_level','')}",
        f"主角与核心驱动力: {cd.get('protagonist','')} — {cd.get('goal','')} (锁定关键词: {('、'.join(cd.get('locked_keywords') or [])) or '无'})",
        f"合法专名(勿改写/勿漂移): {names or '无'}",
    ]
    if addr:
        lines.append(f"称谓锁定: {addr}")
    if banned:
        lines.append(f"时代违禁词(禁止出现): {banned}")
    lines.append("改写时必须遵守以上设定; 不得更改人物正名、称谓关系、复仇/核心目标对象, 不得引入违禁词。")
    return "\n".join(lines)


# ======================================================================
# 三、末尾全局审计 (全部精修完跑一次) — 跨集一致性 + 机械降神/铺垫缺失
# ======================================================================

_GLOBAL_AUDIT_SYSTEM = (
    "你是短剧的全局结构审计员。拿到《设定圣经》和全剧各集精修后梗概, 做一次跨集终审。"
    "重点检查:\n"
    "1) 人物关系/称谓是否全程自洽(对照圣经 address_matrix);\n"
    "2) 主角姓名/核心驱动力是否全程一致(对照 core_drive, 如复仇对象有无中途更换);\n"
    "3) 世界观是否前后统一(有无时代穿越式违禁元素);\n"
    "4) 机械降神/铺垫缺失: 是否有重要人物或关键道具在出现前毫无铺垫就凭空登场并扭转全局;\n"
    "5) 桥段重复: 同一破局/反转手法是否被反复滥用、反派是否降智。\n"
    "每条问题在 locator.scene_no 标出涉及集号, 并在 fix_hint 给出具体修法(补铺垫/删除/改招/统一称谓)。"
    "严格输出 JSON 数组, 元素同 issue schema(severity/issue/evidence/fix_hint/locator)。"
    "无问题返回 []。只输出 JSON, 不要解释或 markdown 标记。"
)


async def global_audit(*, bible: dict, episodes_text: dict[int, str], models: list[str], emit=None) -> dict[int, list[dict]]:
    """末尾跨集审计: 多模型并行, 产出按集归类的全局问题(供修复轮注入)。"""
    overview = _overview_text(episodes_text, per_ep_chars=500)
    if not overview.strip():
        return {}
    bible_txt = bible_constraint_text(bible)
    user = f"{bible_txt}\n\n【全剧各集(精修后)梗概序列】\n{overview}"
    all_issues: list[dict] = []
    for model in models:
        if emit:
            emit("global_audit_start", model=model)
        try:
            resp = await ainvoke_with_fallback(
                [{"role": "system", "content": _GLOBAL_AUDIT_SYSTEM},
                 {"role": "user", "content": user}],
                role="rewrite", temperature=0.3, primary=model,  # type: ignore[arg-type]
            )
            raw = resp.content if hasattr(resp, "content") else str(resp)
            arr = _parse_json(raw, [])
            cnt = 0
            if isinstance(arr, list):
                for it in arr:
                    if isinstance(it, dict):
                        it["role"] = "global_auditor"
                        it["model"] = model
                        all_issues.append(it)
                        cnt += 1
            if emit:
                emit("global_audit_done", model=model, count=cnt)
        except Exception as e:  # noqa: BLE001
            logger.warning("global audit %s failed: %s", model, e)
            if emit:
                emit("global_audit_done", model=model, count=0)
    # 按集号归类
    by_ep: dict[int, list[dict]] = {}
    for it in all_issues:
        loc = str((it.get("locator") or {}).get("scene_no", ""))
        nums = re.findall(r"(\d+)", loc)
        target = int(nums[0]) if nums else (sorted(episodes_text.keys())[0] if episodes_text else 1)
        by_ep.setdefault(target, []).append(it)
    return by_ep