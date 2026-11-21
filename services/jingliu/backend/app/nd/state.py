"""人物状态台账：每一镜里每个在场角色**看得见的持续状态**（随身物品、衣着变化、伤）。

## 为什么要有（2026-11-01 用户报穿帮）

「前面主角拿着铁锹背着背包，画面里没有」。每一镜是**单独**交给视频模型生成的，模型只知道
这一镜提示词里写了什么。原文只在第一个 ▲ 写了「背着巨大的背包，手拿着一把铁锹」，之后的
镜头画面描述里不会再重复——于是第 2 镜起铁锹和背包就没了。参考图里给了铁锹，但提示词
没说谁拿着它，模型只当成场景里的一件东西。

真人剧那边由「走位台账」(continuity.blocking_text) 承担这件事；本模式没有经过那条提示词
优化链，所以单独补一份：

  1. 一集一次 LLM：读原文 + 镜头清单 → 每镜每个在场角色的状态（≤30 字，只写看得见的）
  2. 代码向后顺延：某镜没写某角色状态 → 沿用该角色上一次出场的状态（同一集内）
  3. 提示词里写成「陆知夏（图片1）：背着帆布背包，右手握着短柄铁锹（图片5）」并要求全程保持

状态存在镜头 `profile_override["nd"]["states"]`：{角色名: 状态}。已拆好的项目在下次出片时
自动补算，不需要重拆。
"""
from __future__ import annotations

import json
import logging

from ..db import Project, Shot, get_session
from . import textutil as T

log = logging.getLogger(__name__)

_SYS = """你是影视剧的场记，负责「人物状态台账」：保证每个镜头里角色的随身物品与外观前后一致。

输入：一集剧本原文 + 按顺序的镜头清单（每镜的地点、在场角色、这一镜的内容）。
输出：每个镜头一行，格式严格为
[镜头序号] 角色名=状态；角色名=状态
例：[3] 陆知夏=背着黑色大背包，右手握着短柄铁锹；周浩=双手空着，衣服沾满灰
不要输出任何其他文字。

状态写法：
- 只写**画面上看得见、而且会持续**的东西：手里拿着什么、背着/挎着什么、穿着上的明显特征或变化、伤、怀里抱着什么。
- 按原文推：原文交代了谁拿起/背上/穿上什么，从那一镜起一直保持；原文写了放下/扔掉/换下/交给别人，从那一镜起改掉。
- 每个在场角色都要写（动物也写，如「瘦弱脏兮兮，被陆知夏抱在怀里」）；没有可写的写「无」。
- 状态要和这一镜的动作合得上：这一镜要用双手做事（抱、擦、端、开门）时，手里的工具写成放在身边的样子（如「铁锹靠在沙发旁」）；进了家门、放下了的东西，写它在哪。
- 每条不超过 30 字，写具体（「右手握着短柄铁锹」，不写「拿着工具」），物品用剧本里的叫法。
- 只根据原文，不添加原文没有的物品。"""


def _shot_line(i: int, sh, nd: dict) -> str:
    chars = "、".join(json.loads(sh.characters or "[]")) or "无"
    body = "；".join((b.get("vis") or b["text"])[:60] for b in nd.get("beats") or [])
    return f"[{i}] 地点：{sh.location or '-'}｜在场：{chars}｜内容：{body}"


async def infer_episode(project_id: str, episode: int, model_id: str | None = None) -> int:
    """给一集里**还没有状态**的镜头补算状态台账。返回补了几镜。"""
    from ..script_import import smart_split_chapters
    from .pipeline import nd_of, nd_shots, save_nd
    with get_session() as session:
        proj = session.get(Project, project_id)
        chapters = {c["order"]: c["content"] for c in smart_split_chapters(proj.raw_script or "")}
        rows = [s for s in nd_shots(session, project_id) if (s.episode or 1) == episode]
        if not rows or all("states" in nd_of(s) for s in rows):
            return 0
        lines = [_shot_line(i, s, nd_of(s)) for i, s in enumerate(rows)]
        meta = [(s.id, json.loads(s.characters or "[]"), nd_of(s)) for s in rows]
    src = chapters.get(episode, "")
    user = f"剧本原文：\n{src}\n\n镜头清单：\n" + "\n".join(lines)
    # 行格式而不是 JSON：长 JSON 里正文带英文引号就整份解析失败（平台多次实测，
    # 见 drama 的「长 JSON 解析失败多半是正文英文引号」），台账一失败就整集没状态
    got: dict[int, dict] = {}
    for _attempt in range(2):
        try:
            raw = await _llm_text(_SYS, user, model_id)
        except Exception:  # noqa: BLE001 — 台账失败不能把出片打断，退回无台账（原行为）
            log.exception("[nd] 第 %s 集状态台账生成失败", episode)
            raw = ""
        got = parse_lines(raw)
        if len(got) >= max(1, len(rows) // 2):
            break
    if not got:
        log.warning("[nd] 第 %s 集状态台账为空，本次按无台账出片", episode)
        return 0
    # 顺延：同一集内，角色这一镜没写就沿用上次出场的状态
    last: dict[str, str] = {}
    n = 0
    for i, (sid, chars, nd) in enumerate(meta):
        st = {}
        for c in chars:
            v = (got.get(i) or {}).get(c) or last.get(c) or ""
            if v and v != "无":
                st[c] = v
                last[c] = v
            elif v == "无":
                last.pop(c, None)
        if "states" not in nd:
            nd["states"] = st
            save_nd(sid, nd)
            n += 1
    return n


async def _llm_text(system: str, user: str, model_id: str | None) -> str:
    from ..config import get_settings
    from ..providers.llm import LLMProvider
    s = get_settings()
    mid = model_id or s.llm_model_breakdown or s.llm_model
    return await LLMProvider(model_id=mid).complete(system, user, temperature=1.0)


def parse_lines(raw: str) -> dict[int, dict]:
    """「[3] 陆知夏=背着背包；周浩=空手」→ {3: {"陆知夏": "背着背包", "周浩": "空手"}}。"""
    import re
    out: dict[int, dict] = {}
    for line in (raw or "").splitlines():
        m = re.match(r"\s*\[?\s*(\d+)\s*[\]】.、:：]\s*(.+)$", line)
        if not m:
            continue
        st = {}
        for part in re.split(r"[；;]", m.group(2)):
            if "=" in part or "＝" in part:
                k, v = re.split(r"[=＝]", part, 1)
                k, v = k.strip(), v.strip().strip("。")
                if k and v:
                    st[k] = v[:40]
        if st:
            out[int(m.group(1))] = st
    return out


def prompt_lines(states: dict[str, str], chars: list[str], labels: list[str]) -> list[str]:
    """状态 → 提示词行。角色与道具都带上「图片N」，让模型把参考图对到人身上。"""
    img = {}
    for i, l in enumerate(labels, 1):
        # labels 形如「角色「陆知夏」」「道具「短柄铁锹」」「场景「…」（主视角）」
        if "「" in l and "」" in l:
            img[l.split("「", 1)[1].split("」", 1)[0]] = i
    props = [n for n, _ in img.items() if any(f"道具「{n}」" in l for l in labels)]
    out = []
    for c in chars:
        s = (states or {}).get(c)
        if not s:
            continue
        for p in sorted(props, key=len, reverse=True):     # 长名先换，免得「铁锹」切开「短柄铁锹」
            if f"（图片{img[p]}）" in s:
                continue
            # 台账常用短叫法（「铁锹」对资产「短柄铁锹」）：取资产名在状态里出现的最长后缀（≥2 字）
            hit = next((p[k:] for k in range(0, len(p) - 1) if p[k:] in s), None)
            if hit:
                s = s.replace(hit, f"{hit}（图片{img[p]}）", 1)
        who = f"{c}（图片{img[c]}）" if c in img else c
        out.append(f"{who}：{s}")
    return out
