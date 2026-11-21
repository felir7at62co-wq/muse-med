"""H3 提示词的中文 → 英文编译（2026-11-01 用户报：第三集字幕变多，「楼道中景」被烧进画面）。

## 根因

海螺 H3 的官方全参考指南写明：六段式「全部用英文写，**只有 `<d>` 里的台词**和
**画面里本来就有的文字**保留原文」。我们的 H3 提示词除了台词，还带着大量中文：
画面描述（`楼道中景，我低头将小满护入外套，神情紧张`）、人物状态（`外套里护着小满`）、
角色名（我/小满/李大妈）、场景名、中文画风行。H3 把这些中文当成"场景里本来就有的
文字"，直接画进了画面——第三集 39 帧里 9 帧带字幕，内容与提示词逐字吻合。

`summary` 里那句英文的 "no on-screen text" 管不住它：模型认的是"这段中文属于场景文字"。

## 做法

出片前把一集要用的中文都编译成英文，缓存进镜头 `profile_override["nd"]["en"]`：
  · 名字表（角色/场景/道具 → 英文称谓），保证同一角色全剧叫法一致
  · 每拍的画面描述、每个人物状态、画风行
之后 `build_prompt_h3` 只用英文，除了 `<d>` 里的台词一个汉字都不带。

缓存了就不再翻译；重做镜头也只翻没翻过的部分。
"""
from __future__ import annotations

import json
import logging
import re

from ..db import Project, Shot, get_session
from . import textutil as T

log = logging.getLogger(__name__)

#: 缓存格式版本。v1（11-01）把角色名翻成泛称，不同角色撞名（我/陆知夏/林倩都成了
#: "the young woman"），导致台词被安到别人嘴上——v1 缓存一律作废重编。
VER = 2

_SYS = """You compile Chinese short-drama shot descriptions into English for a video model prompt.

The first input line lists the characters with their profile (gender / age / kind / note):
  CHARACTERS: 名字1（女·青年·人·…）, 名字2（动物·狸花猫·…）, ...
Trust the profile over guessing from the name.
Then lines, each starting with a tag:
  WHO <中文名> =         what a character IS (see below)
  NAME <中文名> =        a scene / place / prop name
  STYLE =               the look of the whole film
  V <镜头号> <拍号> =     one shot beat's visual description (Chinese)
  S <镜头号> <中文名> =    a character's persistent on-screen state (Chinese)

Output one line per input line (not the CHARACTERS line), same tags, value = English:
  WHO 林倩 = named human: a young woman
  WHO 小满 = named creature: a tabby cat
  WHO 老鼠 = common creature: a diseased, rotting rat
  WHO 其他邻居 = common human: a few other neighbours
  NAME 楼道 = the apartment stairwell
  STYLE = modern urban live action, cinematic photography
  V 28 0 = a medium shot of the stairwell; {{我}} lowers {{小满}} into her jacket, tense
  S 28 我 = carrying {{小满}} inside the jacket

Rules:
- WHO: "named" if the Chinese is a personal name or nickname, "common" if it is just a common
  noun for what it is (老鼠 = rat, 邻居们 = neighbours, 队长 = captain). "human" or "creature"
  (animals, monsters, beasts). Then what it visibly is, at most 5 words: species / sex / age
  only, no personality (a young woman, a middle-aged man, a tabby cat, a diseased rat).
- Every time a character is meant, write the character's Chinese name inside double braces
  exactly as listed, e.g. {{林倩}}. Never describe a character as "the young woman", "the
  man", "the other girl" and never use he/she/they for a character - always the {{name}}.
  (Possessive is fine: {{我}}'s jacket.)
- The character in "我" lines is a person named 我; write {{我}}, never "I" or "me".
- Shot descriptions: concrete, cinematic, present tense, 10-25 words, keep the shot size
  (close-up / medium / wide) at the front.
- Apart from {{names}}, no Chinese, no pinyin, no quotes.
- Output nothing else."""


def _cjk(s: str) -> bool:
    return bool(re.search(r"[一-鿿]", s or ""))


async def _llm(system: str, user: str, model_id: str | None) -> str:
    from ..config import get_settings
    from ..providers.llm import LLMProvider
    s = get_settings()
    mid = model_id or s.llm_model_breakdown or s.llm_model
    # temperature=1.0：gpt-6-sol 拒绝非默认值（见 asset_dedupe_ai._llm_json）
    return await LLMProvider(model_id=mid).complete(system, user, temperature=1.0)


def parse(raw: str) -> dict[str, str]:
    """「NAME 我 = the young woman」「V 28 0 = ...」「S 28 我 = ...」→ {键: 英文}。"""
    out: dict[str, str] = {}
    for line in (raw or "").splitlines():
        m = re.match(r"\s*(WHO|NAME|STYLE|V|S)\s+(.+?)\s*[=＝]\s*(.+)$", line) if not line.strip().startswith("STYLE") \
            else re.match(r"\s*(STYLE)\s*[=＝]\s*(.+)$", line)
        if not m:
            continue
        kind = m.group(1)
        if kind == "STYLE":
            out["STYLE"] = m.group(2).strip()
        else:
            key = f"{kind} {' '.join(m.group(2).split())}"
            out[key] = m.group(3).strip().strip('"“”')
    return out


def _cache(nd: dict) -> dict:
    """本镜已编译的英文；旧版本（v1，角色名翻成泛称会撞名）当作没有。"""
    en = nd.get("en")
    return en if isinstance(en, dict) and en.get("ver") == VER else {}


async def compile_episode(project_id: str, episode: int, model_id: str | None = None) -> int:
    """把这一集还用得上的中文都编译成英文，缓存进镜头 nd["en"]。返回翻了多少条。

    **角色名不翻译**：译文里写成 `{{名字}}` 占位，build_prompt_h3 再按本镜绑成 `<Subject N>`。
    只有地点/道具名翻成英文。只翻没缓存过的；翻译失败不打断出片（那一镜退回中文描述）。
    """
    from .. import style_preset as sp
    from .pipeline import nd_of, nd_shots, save_nd

    with get_session() as session:
        proj = session.get(Project, project_id)
        all_rows = nd_shots(session, project_id)
        rows = [s for s in all_rows if (s.episode or 1) == episode]
        # 角色称呼全项目共用一份：同一个人每集叫法不同，模型会当成不同的人
        known_who: dict = {}
        for s in all_rows:
            known_who.update(_cache(nd_of(s)).get("who") or {})
        st = sp.resolve(proj.production_mode, proj.art_style)
        people: list[str] = []
        places: dict[str, str] = {}
        want: dict[str, str] = {}
        for s in rows:
            nd = nd_of(s)
            en = _cache(nd)
            v = list(en.get("v") or [])
            stt = dict(en.get("s") or {})
            try:
                chars = json.loads(s.characters or "[]")
            except (ValueError, TypeError):
                chars = []
            for c in chars + [w for w in (nd.get("states") or {})] + \
                    [b.get("who") or "" for b in nd.get("beats") or []]:
                if c and c not in people:
                    people.append(c)
                if c and c not in known_who:
                    places[f"WHO {c}"] = c
            loc = s.location or ""
            if _cjk(loc) and loc not in (en.get("names") or {}):
                places[f"NAME {loc}"] = loc
            try:
                props = json.loads(s.props or "[]")
            except (ValueError, TypeError):
                props = []
            for pr in props if isinstance(props, list) else []:
                if isinstance(pr, str) and _cjk(pr) and pr not in (en.get("names") or {}):
                    places[f"NAME {pr}"] = pr
            for k, b in enumerate(nd.get("beats") or []):
                if _cjk(b.get("vis") or "") and not (k < len(v) and v[k]):
                    want[f"V {s.order} {k}"] = b["vis"]
            for who, val in (nd.get("states") or {}).items():
                if _cjk(val) and who not in stt:
                    want[f"S {s.order} {who}"] = val
        style_zh = st.video_line if _cjk(getattr(st, "video_line", "")) else ""
    if not places and not want:
        return 0
    with get_session() as session:
        from .voice import profiles as _profiles
        from ..db import Asset
        prof = _profiles(session, project_id)
        notes = {a.name: (json.loads(a.brief_json or "{}") or {}).get("brief", "")
                 for a in session.query(Asset).filter(Asset.project_id == project_id,
                                                      Asset.kind == "character",
                                                      Asset.deleted_at.is_(None)).all()}

    def _desc(c: str) -> str:
        p = prof.get(c) or {}
        bits = [x for x in (p.get("gender") if p.get("gender") in ("男", "女") else "", p.get("age"),
                            ("动物" if p.get("form") == "动物" else "非人" if p.get("form") == "非人" else "人")
                            if p else "", p.get("species"), notes.get(c) or "") if x]
        return f"{c}（{'·'.join(bits)}）" if bits else c
    lines = ["CHARACTERS: " + ", ".join(_desc(c) for c in people)] + [f"{k} =" for k in places] + \
            ([f"STYLE = {style_zh}"] if style_zh else []) + [f"{k} = {v}" for k, v in want.items()]
    try:
        raw = await _llm(_SYS, "\n".join(lines), model_id)
    except Exception:  # noqa: BLE001 — 翻译失败不能拦住出片
        log.exception("[nd] 第 %s 集 H3 英文编译失败，本集沿用中文提示词", episode)
        return 0
    got = parse(raw)
    if not got:
        log.warning("[nd] 第 %s 集 H3 英文编译没返回可用结果", episode)
        return 0
    n = 0
    with get_session() as session:
        for s in nd_shots(session, project_id):
            if (s.episode or 1) != episode:
                continue
            nd = nd_of(s)
            en = _cache(nd)
            v = list(en.get("v") or [])
            stt = dict(en.get("s") or {})
            nm = dict(en.get("names") or {})
            for k, _b in enumerate(nd.get("beats") or []):
                while len(v) <= k:
                    v.append("")
                if not v[k] and ok_text(got.get(f"V {s.order} {k}")):
                    v[k] = got[f"V {s.order} {k}"]
                    n += 1
            for who in (nd.get("states") or {}):
                if who not in stt and ok_text(got.get(f"S {s.order} {who}")):
                    stt[who] = got[f"S {s.order} {who}"]
                    n += 1
            who = {**known_who, **dict(en.get("who") or {})}
            for k2, val in got.items():
                if k2.startswith("WHO ") and val:
                    w = parse_who(val)
                    if w:
                        who[k2[4:].strip()] = w
            loc = s.location or ""
            try:
                props = json.loads(s.props or "[]")
            except (ValueError, TypeError):
                props = []
            for name in [loc] + [x for x in (props if isinstance(props, list) else []) if isinstance(x, str)]:
                if name and ok_text(got.get(f"NAME {name}")):
                    nm[name] = got[f"NAME {name}"]
            if style_zh and ok_text(got.get("STYLE")):
                nm["__style__"] = got["STYLE"]
            nd["en"] = {"ver": VER, "v": v, "s": stt, "names": nm, "who": who}
            save_nd(s.id, nd)
    log.info("[nd] 第 %s 集 H3 英文编译：%d 条", episode, n)
    return n


def ok_text(t: str | None) -> bool:
    """译文能用：非空，且去掉 {{名字}} 之后不再含汉字。"""
    return bool(t) and not _cjk(re.sub(r"\{\{[^}]*\}\}", "", t))


def romanize(name: str) -> str:
    """角色名 → 拼音专名（Lu Zhixia）。只用在本镜没有 Subject 编号的角色上（被提到但不在画面里）。"""
    if name == "我":
        return "the protagonist"
    try:
        from pypinyin import lazy_pinyin
        py = lazy_pinyin(name)
    except Exception:  # noqa: BLE001
        return "a character"
    if not py:
        return "a character"
    return " ".join([py[0].capitalize()] + (["".join(py[1:]).capitalize()] if len(py) > 1 else []))


def bind_names(text: str, subj: dict[str, int], who: dict | None = None) -> str:
    """`{{名字}}` → 本镜的 `<Subject N>`；本镜没这个人就用称呼（专名拼音 / 普通名词的英文描述）。"""
    def rep(m):
        nm = m.group(1).strip()
        if nm in subj:
            return f"<Subject {subj[nm]}>"
        w = (who or {}).get(nm)
        return (w["desc"] if w and not w["named"] else romanize(nm))
    return re.sub(r"\{\{([^}]*)\}\}", rep, text or "")


def parse_who(val: str) -> dict | None:
    """「named human: a young woman」→ {"named": True, "creature": False, "desc": "a young woman"}。"""
    m = re.match(r"\s*(named|common)\s+(human|creature)\s*[:：]\s*(.+)$", val or "", re.I)
    if not m or _cjk(m.group(3)):
        return None
    return {"named": m.group(1).lower() == "named", "creature": m.group(2).lower() == "creature",
            "desc": m.group(3).strip().rstrip(".")}


def bare(desc: str) -> str:
    """去冠词：「a tabby cat」→「tabby cat」。"""
    return re.sub(r"^(a|an|the)\s+", "", desc or "", flags=re.I)


def label(name: str, w: dict | None) -> str:
    """角色在提示词里的称呼。专名：拼音 + 是什么（Lu Zhixia, a young woman）；
    普通名词（老鼠/邻居们）：只用英文描述——拼音会把「老鼠」变成一个叫 Lao Shu 的人（11-02 实测画成腐烂的人）。"""
    if not w:
        return romanize(name)
    if not w["named"]:
        return w["desc"]
    return f"{romanize(name)}, {w['desc']}"
