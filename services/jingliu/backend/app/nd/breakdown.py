"""拆解：一集剧本 → 镜头序列，每镜是一串「拍」（旁白 / 台词 / 画外音 / 音效）。

LLM 只负责**改编**（哪些动作压成旁白、怎么分镜、画面怎么写）；
**台词是否忠于原文由代码判定**，不靠模型自觉（用户裁定：对白必须逐字还原）：

  1. 每句台词/画外音必须逐字出现在原文里（去括号表演提示后、按拼音比）；
  2. 原文的每句台词都必须出现，且顺序一致；
  3. 不合格 → 带着问题清单重拆一次；仍不合格 → 确定性修复：
     改过的台词换回最接近的原文句、漏掉的原文台词按原顺序插回去、重复的删掉。

旁白「不加情节」机械上判不了，靠提示词约束 + 前端把每句旁白摆在原文旁边给人看。
"""
from __future__ import annotations

import json
import logging
import math
import uuid

from ..db import Asset, Shot, get_session
from . import textutil as T

log = logging.getLogger(__name__)

NARR_CPS = 5.5        # 旁白 TTS 实测 5.5 字/秒（解说音色，2026-10-30）
DLG_CPS = 4.3         # 视频模型念台词实测 4–4.5 字/秒
SHOT_PLAN_MAX = 12.0  # 拆解时一镜的估时上限；TTS 出来后超 14.5s 的再按拍切
SHOT_MIN = 4.0        # Seedance 最短 4s

KINDS = {"旁白": "narr", "台词": "dlg", "画外音": "vo", "音效": "sfx",
         "narr": "narr", "dlg": "dlg", "vo": "vo", "sfx": "sfx"}

_SYS = """你是解说剧的分镜编辑。任务：把一集剧本改编成「旁白推进情节 + 角色当场开口说台词」的镜头序列。

只输出一个 JSON 对象：{"shots": [镜头, ...]}
每个镜头：
{
  "location": "场景名（同一个地点全集用同一个叫法，如：超市门口）",
  "characters": ["画面里出现的角色名（含动物），用剧本里的叫法"],
  "props": ["推动情节的关键道具，可为空"],
  "beats": [按时间顺序的拍子]
}
拍子有四种：
  {"t":"旁白","text":"旁白文字","画面":"这一拍拍什么"}
  {"t":"台词","who":"说话人","text":"台词原文","画面":"说话时的表演与画面"}
  {"t":"画外音","who":"说话人","text":"原文逐字","画面":"这一拍拍什么"}   ← 原文标 VO / OS 的话
  {"t":"音效","who":"发声者","text":"拟声原文，如 喵呜——","画面":"..."}

规则：
1. 台词、画外音、音效逐字照抄原文，只去掉括号里的表演提示（表演提示写进「画面」）。原文的每一句台词都出现一次，顺序与原文一致。
2. 旁白只由原文的动作描述（▲ 开头的行、小说体里引号外的叙述）压缩改写，交代推动情节的动作与结果；情节、心理、预告都以原文为准。不影响情节的小动作可以省略。每句旁白不超过 40 字，用第三人称称呼角色名。
3. 节奏：旁白按每秒 5.5 字、台词按每秒 4.3 字估时。每个镜头 4–12 秒，只在一个地点；在这一镜说台词的角色都列进 characters。
4. 画面要具体可拍：谁在做什么、表情动作、景别（特写/近景/中景/全景）。"""


async def _llm_raw(system: str, user: str, model_id: str | None, key: str = "shots") -> dict:
    """调一次文本模型拿 JSON（要求含 `key` 数组）；不合规重试一次。拆解与状态台账共用。"""
    from ..asset_dedupe_ai import _parse_json
    from ..config import get_settings
    from ..providers.llm import LLMProvider
    s = get_settings()
    mid = model_id or s.llm_model_breakdown or s.llm_model
    last: Exception | None = None
    for _ in range(2):
        # temperature=1.0：gpt-6-sol 拒绝非默认值且会让整条渠道冷却（见 asset_dedupe_ai._llm_json）
        raw = await LLMProvider(model_id=mid).complete(system, user, temperature=1.0)
        try:
            d = _parse_json(raw)
            if isinstance(d, dict) and isinstance(d.get(key), list):
                return d
            last = ValueError(f"缺少 {key} 数组")
        except (ValueError, TypeError) as e:
            last = e
    raise RuntimeError(f"文本模型两次都没返回合规结果：{last}")


async def _llm(user: str, model_id: str | None) -> dict:
    return await _llm_raw(_SYS, user, model_id)


def _norm(d: dict, speakers: set[str] | None = None) -> list[dict]:
    """模型输出 → 规范结构（容错：字段名/类型不规范的拍子直接丢）。

    `speakers`：原文说话人。角色名去括号后正好是某个说话人时统一成说话人的名字
    （实测「小满」与「小满（狸花猫）」被建成两个资产）。**只在这种情况下**去括号：
    括号常常是区分个体的唯一信息（「围观村民（深灰夹克男）」），无条件去会把不同人并成一个。
    """
    speakers = speakers or set()

    def _name(n: str) -> str:
        n = str(n or "").strip()
        core = T.strip_paren(n)
        return core if core != n and core in speakers else n
    shots = []
    for s in d.get("shots") or []:
        if not isinstance(s, dict):
            continue
        beats = []
        for b in s.get("beats") or []:
            if not isinstance(b, dict):
                continue
            k = KINDS.get(str(b.get("t") or "").strip())
            text = str(b.get("text") or "").strip()
            if not k or not T.clean(text):
                continue
            if k in ("dlg", "vo", "sfx"):
                text = T.strip_paren(text)
            beats.append({"k": k, "who": _name(b.get("who")),
                          "text": text, "vis": str(b.get("画面") or b.get("visual") or "").strip()})
        if beats:
            chars = []
            for x in (s.get("characters") or []):
                x = _name(x)
                if x and x not in chars:
                    chars.append(x)
            for b in beats:   # 说话人必须在场（画外音除外）
                if b["k"] in ("dlg", "sfx") and b["who"] and b["who"] not in chars:
                    chars.append(b["who"])
            shots.append({"location": str(s.get("location") or "").strip(),
                          "characters": chars,
                          "props": [str(x).strip() for x in (s.get("props") or []) if str(x).strip()],
                          "beats": beats})
    return shots


def check(shots: list[dict], src_text: str) -> list[str]:
    """台词忠实度问题清单（空 = 合格）。"""
    sp = T.source_py(src_text)
    probs = []
    for s in shots:
        for b in s["beats"]:
            if b["k"] in ("dlg", "vo", "sfx") and not T.verbatim_in(b["text"], sp):
                probs.append(f"这句台词与原文不一致，请逐字照抄原文：「{b['text']}」")
    for who, t, _ in _missing(shots, src_text):
        probs.append(f"漏了原文台词（{who or '某人'}）：「{t}」")
    return probs


def _said(shots: list[dict]) -> list[str]:
    return [b["text"] for s in shots for b in s["beats"] if b["k"] in ("dlg", "vo", "sfx")]


def _match_source(shots: list[dict], src_pairs) -> list[int | None]:
    """每句原文台词按顺序对到镜头里的第几句（拍平后的序号），对不上为 None。"""
    said = _said(shots)
    out, cur = [], 0
    for _, t, _ in src_pairs:
        n = max(1, len(T.clean(t)))
        hit = None
        for j in range(cur, len(said)):
            if T.hits(t, said[j]) / n >= 0.9 and abs(len(T.clean(said[j])) - n) <= max(2, n * 0.2):
                hit = j
                break
        out.append(hit)
        if hit is not None:
            cur = hit + 1
    return out


def _missing(shots, src_text):
    pairs = T.source_dialogue_pairs(src_text)
    return [p for p, m in zip(pairs, _match_source(shots, pairs)) if m is None]


def repair(shots: list[dict], src_text: str) -> tuple[list[dict], list[str]]:
    """确定性修复：改过的换回原文、重复的删掉、漏掉的按原顺序插回。返回 (镜头, 修复记录)。"""
    notes: list[str] = []
    pairs = T.source_dialogue_pairs(src_text)
    sp = T.source_py(src_text)
    # ① 改过的台词 → 最接近的原文句；完全对不上的（模型编的）删掉
    for s in shots:
        keep = []
        for b in s["beats"]:
            if b["k"] in ("dlg", "vo", "sfx") and not T.verbatim_in(b["text"], sp):
                best = max(pairs, key=lambda p: T.hits(p[1], b["text"]) /
                           max(len(T.clean(p[1])), len(T.clean(b["text"])), 1), default=None)
                sc = (T.hits(best[1], b["text"]) / max(len(T.clean(best[1])), len(T.clean(b["text"])), 1)
                      if best else 0)
                if best and sc >= 0.6:
                    notes.append(f"台词换回原文：「{b['text']}」→「{best[1]}」")
                    b["text"] = best[1]
                else:
                    notes.append(f"删掉原文没有的台词：「{b['text']}」")
                    continue
            keep.append(b)
        s["beats"] = keep
    # ② 重复：每句原文**出现几次就最多留几次**（短句也一样——原文里两次「谁？」就留两次）
    from collections import Counter
    quota = Counter(T.clean(t) for _, t, _ in pairs)
    for s in shots:
        keep = []
        for b in s["beats"]:
            if b["k"] in ("dlg", "vo", "sfx"):
                key = T.clean(b["text"])
                if quota[key] <= 0:
                    notes.append(f"删掉重复台词：「{b['text']}」")
                    continue
                quota[key] -= 1
            keep.append(b)
        s["beats"] = keep
    shots = [s for s in shots if s["beats"]]
    # ③ 漏掉的：插在「上一句原文台词」所在拍之后；没有上一句就插在开头
    match = _match_source(shots, pairs)
    flat = [(si, bi) for si, s in enumerate(shots) for bi, b in enumerate(s["beats"])
            if b["k"] in ("dlg", "vo", "sfx")]
    inserts: list[tuple[int, int, dict]] = []
    for i, ((who, t, vo), m) in enumerate(zip(pairs, match)):
        if m is not None:
            continue
        prev = next((match[j] for j in range(i - 1, -1, -1) if match[j] is not None), None)
        si, bi = (flat[prev][0], flat[prev][1] + 1) if prev is not None else (0, 0)
        k = "vo" if vo else ("sfx" if T.is_sfx(t) else "dlg")
        inserts.append((si, bi, i, {"k": k, "who": who, "text": t,
                                 "vis": f"{who}说话" if who else "", "_inserted": True}))
        notes.append(f"补回漏掉的原文台词：「{t}」")
    # 从后往前插；**同一位置**的几句按原文倒序插（后插的落在前面），最终才是原文顺序。
    # （只按位置排序时，Python 的稳定排序让同位置的几句保持正序插入 → 结果整段倒过来）
    for si, bi, _i, b in sorted(inserts, key=lambda x: (x[0], x[1], x[2]), reverse=True):
        if not shots:
            shots.append({"location": "", "characters": [], "props": [], "beats": []})
        shots[si]["beats"].insert(bi, b)
        if b["k"] in ("dlg", "sfx") and b["who"] and b["who"] not in shots[si]["characters"]:
            shots[si]["characters"].append(b["who"])
    return shots, notes


def est_sec(b: dict) -> float:
    n = len(T.clean(b["text"]))
    if b["k"] in ("narr", "vo"):
        return n / NARR_CPS + 0.2
    if b["k"] == "sfx":
        return 1.2
    return n / DLG_CPS + 0.5


#: 并成长镜后参考图（角色 + 道具 + 场景）不超过万相的 10 张，留 1 张余量（pipeline.merge_for_long）
WAN_MAX_REFS = 9


def split_long(shots: list[dict], cap: float = SHOT_PLAN_MAX) -> list[dict]:
    """估时超上限的镜头按拍切开（不切断任何一拍）。"""
    out = []
    for s in shots:
        cur, t = [], 0.0
        for b in s["beats"]:
            e = est_sec(b) + 0.15
            if cur and t + e > cap:
                out.append({**s, "beats": cur})
                cur, t = [], 0.0
            cur.append(b)
            t += e
        if cur:
            out.append({**s, "beats": cur})
    return out


async def breakdown_episode(src_text: str, model_id: str | None = None) -> tuple[list[dict], list[str]]:
    """一集 → (镜头, 修复/告警记录)。"""
    user = f"剧本原文：\n{src_text}"
    spk = {w for w, _, _ in T.source_dialogue_pairs(src_text) if w}
    shots = _norm(await _llm(user, model_id), spk)
    probs = check(shots, src_text)
    notes: list[str] = []
    if probs:
        log.info("[nd] 拆解第一次有 %d 个台词问题，带清单重拆", len(probs))
        fb = "\n".join(f"- {p}" for p in probs[:40])
        shots2 = _norm(await _llm(f"{user}\n\n上一次改编有这些问题，请改正后重新输出完整 JSON：\n{fb}",
                                  model_id), spk)
        if shots2 and len(check(shots2, src_text)) < len(probs):
            shots = shots2
    shots, fix = repair(shots, src_text)
    notes += fix
    return split_long(shots), notes


def shot_record(s: dict) -> dict:
    """镜头 → 落库的 nd 状态（`profile_override["nd"]`）。"""
    beats = []
    for b in s["beats"]:
        beats.append({"k": b["k"], "who": b.get("who", ""), "text": b["text"],
                      "vis": b.get("vis", ""), **({"inserted": True} if b.get("_inserted") else {})})
    return {"v": 1, "beats": beats, "status": "planned", "attempts": 0}


def script_ref_of(s: dict) -> str:
    """镜头的原文摘要（资产识别、造型挑选等通用逻辑读它）。"""
    parts = []
    for b in s["beats"]:
        if b["k"] in ("dlg", "sfx"):
            parts.append(f"{b['who']}：{b['text']}" if b.get("who") else b["text"])
        else:
            parts.append(b["text"])
    return "\n".join(parts)


async def persist(project_id: str, episode: int, shots: list[dict]) -> int:
    """替换该集镜头 + 增量建资产。与真人剧拆解同一把项目级落库锁。"""
    from ..routers.shots import _breakdown_lock
    from ..scenes import canonical_of
    async with _breakdown_lock(project_id):
        with get_session() as session:
            session.query(Shot).filter(Shot.project_id == project_id,
                                       Shot.episode == episode).delete()
            last = (session.query(Shot).filter(Shot.project_id == project_id)
                    .order_by(Shot.order.desc()).first())
            base = last.order if last else 0
            for i, s in enumerate(shots):
                est = sum(est_sec(b) + 0.15 for b in s["beats"])
                session.add(Shot(
                    id=uuid.uuid4().hex[:12], project_id=project_id,
                    order=base + i + 1, episode=episode, status="pending",
                    script_ref=script_ref_of(s),
                    characters=json.dumps(s["characters"], ensure_ascii=False),
                    props=json.dumps(s["props"], ensure_ascii=False),
                    location=s["location"] or None,
                    duration_sec=float(max(SHOT_MIN, math.ceil(est + 0.6))),
                    profile_override=json.dumps({"nd": shot_record(s)}, ensure_ascii=False),
                ))
            existing = {(a.kind, a.name) for a in
                        session.query(Asset).filter(Asset.project_id == project_id).all()}
            for s in shots:
                for c in s["characters"]:
                    if ("character", c) not in existing:
                        existing.add(("character", c))
                        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                                          kind="character", name=c))
                if s["location"]:
                    cn = canonical_of(session, project_id, s["location"]) or s["location"]
                    if ("location", cn) not in existing:
                        existing.add(("location", cn))
                        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                                          kind="location", name=cn))
                for x in s["props"]:
                    xn = canonical_of(session, project_id, x) or x
                    if ("prop", xn) not in existing:
                        existing.add(("prop", xn))
                        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                                          kind="prop", name=xn))
            session.commit()
            # 镜头 order 全项目连续：按集重排（并发拆多集时先完成的会排前面）
            rows = (session.query(Shot).filter(Shot.project_id == project_id)
                    .order_by(Shot.episode, Shot.order).all())
            for k, r in enumerate(rows, 1):
                r.order = k
            session.commit()
    return len(shots)
