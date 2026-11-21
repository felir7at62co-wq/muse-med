"""角色声线：提示词里写明每个说话人是什么声音 + 出片后按基频核对男女声。

## 为什么要有（2026-11-01 用户报：H3 有时女主用男声说话）

dev 实测 H3 出的 10 句台词里 3 句女角色是男声（基频 110–152Hz），全是主角
「我」/陆知夏。查提示词：H3 六段式里说话人只有 `<Subject 1> (S1) speaks quickly`，
**全程没有一个字说这个人是男是女、什么嗓音**——参考图是唯一线索，而模型从图推
声线并不可靠（同一角色前一镜女声 250Hz、后一镜男声 110Hz）。名字是「我」时更是
毫无信息。Seedance 那份同样只写「某某开口说」，也有 3/9 句错（周浩被配成女声）。

两步：
  1. 提示词写声线：从角色档案（brief_json 的 gender/age/form/species）推出
     「年轻女声，清亮」这类描述，每句台词处直接写在说话人旁边；
  2. 出片后核对：每句台词测基频（自相关），性别明确的角色与声音明显相反时
     判为「声线不对」，与台词不一致同等对待——自动重出一次、留更好的那版、
     仍不对的进核对报告。

基频判据只做「明显相反」：男 <155Hz、女 >175Hz、中间是灰区不判。动物/非人/
性别未知的角色不判（萌系猫声可高可低，判了只会误伤）。
"""
from __future__ import annotations

import json

import numpy as np

SR = 16000
MALE_MAX = 155.0      # 低于它判男声
FEMALE_MIN = 175.0    # 高于它判女声；中间灰区不下结论


def profiles(session, project_id: str) -> dict[str, dict]:
    """角色名 → {gender, age, form, species}（来自资产档案 brief_json）。"""
    from ..db import Asset
    out = {}
    for a in (session.query(Asset).filter(Asset.project_id == project_id, Asset.kind == "character",
                                           Asset.deleted_at.is_(None)).all()):
        try:
            b = json.loads(a.brief_json or "{}")
        except (ValueError, TypeError):
            b = {}
        out[a.name] = {k: (b.get(k) or "") for k in ("gender", "age", "form", "species")}
    return out


def gender_of(prof: dict | None) -> str:
    """只认「男」「女」，其余（未知、动物、非人）一律空。"""
    if not prof or prof.get("form") in ("动物", "非人"):
        return ""
    g = prof.get("gender") or ""
    return g if g in ("男", "女") else ""


_AGE_ZH = {"幼儿": "幼童", "少年": "少年", "青年": "年轻", "中年": "中年", "老年": "老年"}
_AGE_EN = {"幼儿": "small child", "少年": "teenage", "青年": "young", "中年": "middle-aged",
           "老年": "elderly"}


def voice_zh(prof: dict | None) -> str:
    """「年轻女声」「中年男声」「狸花猫的声音」；什么都推不出来返回空。"""
    if not prof:
        return ""
    if prof.get("form") in ("动物", "非人"):
        sp = prof.get("species") or ""
        return f"{sp}拟人的声音" if sp else ""
    g = gender_of(prof)
    if not g:
        return ""
    return f"{_AGE_ZH.get(prof.get('age') or '', '')}{g}声"


def voice_en(prof: dict | None) -> str:
    """H3 六段式用英文：「a young woman's voice」。"""
    if not prof:
        return ""
    if prof.get("form") in ("动物", "非人"):
        sp = prof.get("species") or ""
        return f"an anthropomorphic {sp} voice" if sp else ""
    g = gender_of(prof)
    if not g:
        return ""
    age = _AGE_EN.get(prof.get("age") or "", "")
    who = "woman" if g == "女" else "man"
    return f"{'an' if age[:1] in 'aeiou' and age else 'a'} {age + ' ' if age else ''}{who}'s voice"


def f0(seg: np.ndarray) -> float | None:
    """一段人声的中位基频（Hz）；有效帧太少返回 None。"""
    out = []
    for i in range(0, len(seg) - 1024, 400):
        fr = seg[i:i + 1024]
        if np.sqrt((fr ** 2).mean()) < 0.02:
            continue
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, "full")[1023:]
        lo, hi = SR // 400, SR // 70
        j = lo + int(np.argmax(ac[lo:hi]))
        if ac[j] > 0.3 * ac[0]:
            out.append(SR / j)
    return float(np.median(out)) if len(out) >= 5 else None


def check(x: np.ndarray, start: float, end: float, gender: str) -> dict | None:
    """这一句的声线核对。返回 {hz, heard, ok}；角色性别不明或测不出基频时返回 None。"""
    if gender not in ("男", "女"):
        return None
    hz = f0(x[int(start * SR):int(end * SR)])
    if hz is None:
        return None
    heard = "男" if hz < MALE_MAX else "女" if hz > FEMALE_MIN else ""
    return {"hz": round(hz), "heard": heard, "ok": not heard or heard == gender}
