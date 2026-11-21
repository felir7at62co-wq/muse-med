"""审计与修复工具（§13）—— 三个只读 + 一个受限写 + 一个看图读名。

## 为什么单独一个模块而不是塞进 tools_read / tools_write

它们是**同一件事的三个面**：判据都在 `agent/audit.py`，处置都遵循同一张表
（能改的只有基础造型的集区间；引用与在场角色只报告）。放在一起才能一眼看出
"哪些会写库、哪些不会"。混在 21 个写工具里，读者看不出这条边界。

## 处置分级（改这里之前先读 `audit.py` 顶部）

| 工具 | risk | 写库 | 需要人点 |
|---|---|---|---|
| `audit_stage_coverage` | read | 否 | 否 |
| `audit_ref_integrity` | read | 否 | 否 |
| `audit_present_characters` | read | 否 | 否 |
| `extend_stage_coverage` | write | 是（只延长基础造型的集区间） | 否（agent 可自主，但受下面判据限制） |
| `read_asset_names_from_images` | generate | 否（只退回候选名，由调用方再对一遍） | 否 |

`extend_stage_coverage` **不走硬确认**（它不改画面内容，只让一套已有的基础造型
覆盖到它本该覆盖的集）。但它在工具层自己再做一次 `_is_plain_base` 校验：
审批卡是给人看的，工具自己也得守住"变体/场景/情境不许外溢"这条，
否则模型学会绕过审计直接调它，就等于那条判据不存在。
"""
from __future__ import annotations

import json
import logging

from .executor import ToolCtx
from .registry import engine_tool

logger = logging.getLogger("fw.agent.tools.audit")


@engine_tool(
    name="audit_stage_coverage",
    risk="read",
    role="viewer",
    description="体检 A 类：逐镜找出「这个角色有造型图，但没有一套对本镜适用」的情况。"
                "返回的每条都带 last_stage（上一段是哪套）与 safe_to_extend"
                "（能不能安全延长集区间）。**不改任何数据**。",
)
async def audit_stage_coverage(ctx: ToolCtx, project_id: str,
                               episodes: list[int] | None = None) -> dict:
    from . import audit
    return audit.audit_stage_coverage(project_id, episodes=episodes)


@engine_tool(
    name="audit_ref_integrity",
    risk="read",
    role="viewer",
    description="体检 B 类：报告提示词里 @图片N 的三类问题——编号指错（出片时已被自动纠正）、"
                "指向未下发素材、以及**声明了一个不在本镜下发清单里的角色**（现有纠错救不了"
                "这一类）。只报告，**不要**去改提示词里的编号。",
)
async def audit_ref_integrity(ctx: ToolCtx, project_id: str,
                              episodes: list[int] | None = None) -> dict:
    from . import audit
    return audit.audit_ref_integrity(project_id, episodes=episodes)


@engine_tool(
    name="audit_present_characters",
    risk="read",
    role="viewer",
    description="体检 C 类：找出可能被误判为在场角色的名字（画外音/独白说话人、"
                "只出现在引号或物件文字上的名字）。只报告；要改必须调 "
                "set_ref_overrides(remove=[...]) 并由用户按批确认。",
)
async def audit_present_characters(ctx: ToolCtx, project_id: str,
                                   episodes: list[int] | None = None) -> dict:
    from . import audit
    return audit.audit_present_characters(project_id, episodes=episodes)


@engine_tool(
    name="extend_stage_coverage",
    risk="write",
    role="manager",
    description="体检 A 类里 safe_to_extend=true 的那些，把它们上一段**基础造型**的集区间"
                "延长到指定集。只能延长基础造型（无镜号区间、不绑场景、非变体、非情境服装），"
                "其余会被拒绝并说明原因。先用 audit_stage_coverage 拿到 stage_id。",
)
async def extend_stage_coverage(ctx: ToolCtx, project_id: str, stage_id: str,
                                ep_to: int,
                                character: str | None = None) -> dict:
    """把一套基础造型的 `ep_to` 拉到 `ep_to`。

    ## 为什么在工具层再校验一次

    `audit._is_plain_base` 是给**报告**用的判据；本工具会被模型直接调用，
    它可能根本没跑过审计（或者跑完记错了 stage_id）。只靠报告那一层，
    模型一条 `extend_stage_coverage(stage_id=<婚纱>, ep_to=9)` 就能让角色
    在第 9 集穿上婚纱 —— 而这正是 §13.1 明确要避免的事。

    校验与写库**在同一个 session 里**做，中间不留窗口。
    """
    from ..db import AssetStage, Project, get_session
    from .audit import _is_plain_base

    new_to = int(ep_to)
    if new_to < 1:
        return {"ok": False, "error": "ep_to 必须 ≥ 1"}

    with get_session() as s:
        st = s.get(AssetStage, stage_id)
        if st is None or st.project_id != project_id:
            return {"ok": False, "error": "阶段不存在或不属于本项目"}
        if st.deleted_at:
            return {"ok": False, "error": "这套造型已被删除，请先恢复"}
        if character and character.strip() != st.character_name:
            return {"ok": False,
                    "error": f"stage_id 属于「{st.character_name}」，"
                             f"与你给的「{character}」不一致"}

        ok, why = _is_plain_base(st)
        if not ok:
            return {"ok": False,
                    "error": f"不能延长「{st.stage_name}」：{why}。"
                             f"这类造型只报告、不改库。"}

        old = [st.ep_from, st.ep_to]
        if new_to <= st.ep_to:
            return {"ok": True, "stage_id": st.id, "ep": old,
                    "note": "目标集区间已经覆盖到了，没有改动"}

        # 与同角色其它阶段的区间冲突检查：走的是 patch 路由那一套（单一判据）。
        # 这里不复刻它 —— 复刻必然漂移，而漂移的表现是"agent 改成功了、
        # 界面上那两套造型重叠了"。
        proj = s.get(Project, project_id)
        episodes = json.loads(proj.episodes) if proj and proj.episodes else []
        from ..db import Shot
        max_ep = max([len(episodes)]
                     + [sh.episode for sh in s.query(Shot)
                        .filter(Shot.project_id == project_id).all()],
                     default=1) or 1
        if new_to > max_ep:
            return {"ok": False,
                    "error": f"ep_to 超出全剧集数（共 {max_ep} 集）"}

        st.ep_to = new_to
        # 一镜只归一套：延长只填空白，不抢别的造型的镜头（要抢用 upsert_stage，并先告诉用户）
        from ..stage_coverage import _alive, overlaps
        hit = [b if a.id == st.id else a for a, b in overlaps(_alive(s, project_id, st.character_name))
               if st.id in (a.id, b.id)]
        if hit:
            s.rollback()
            return {"ok": False, "error": f"延长到第 {new_to} 集会和造型「{hit[0].stage_name}」"
                                          f"（第{hit[0].ep_from}–{hit[0].ep_to}集）重叠，没有改动"}
        s.commit()
        return {"ok": True, "stage_id": st.id,
                "character": st.character_name, "stage": st.stage_name,
                "ep_before": old, "ep_after": [st.ep_from, st.ep_to],
                "note": "集区间已延长；这套造型会在新覆盖的集里生效，无需重新出图"}


@engine_tool(
    name="read_asset_names_from_images",
    risk="generate",
    costs=True,
    role="editor",
    description="看图读出图上标注的资产名，用于批量导入的**第 3 级匹配**"
                "（文件名对不上、文件名含名也对不上时）。返回 {url: {name, raw_text}}。"
                "**不要**拿它的结果直接写库：必须再对一遍本项目资产表，对不上就是 unmatched。",
)
async def read_asset_names_from_images(ctx: ToolCtx, project_id: str,
                                       urls: list[str],
                                       character_names: list[str] | None = None) -> dict:
    """对一批图片读「图上写的名字」。

    ## 为什么要给候选名单

    不给名单时模型会把**任何**图上的字都当成资产名（实测：工牌上的
    「海神号VIP套房临时整理员-简糯」会被读成一行人名）。给了本项目已有的
    资产名之后，提示词可以要求"只从这些名字里挑，一个都不像就返回空"。

    ## 为什么第 3 级必须走 agent

    第 1、2 级失败的那些**运行时才知道是哪些**（要先把整批跑一遍才知道剩下几张）。
    上传页做一个按钮只能盲目对全部图片都跑视觉 —— 40 张图就是 40 次多模态调用。
    """
    from ..db import Asset, get_session
    from ..providers.llm import LLMProvider

    items = [u for u in (urls or []) if (u or "").strip()]
    if not items:
        return {"ok": False, "error": "urls 为空"}
    if len(items) > 40:
        return {"ok": False,
                "error": f"一次最多读 40 张（给 {len(items)} 张）。分批调用。"}

    if character_names:
        candidates = [c for c in character_names if c]
    else:
        with get_session() as s:
            candidates = [a.name for a in
                          s.query(Asset).filter(Asset.project_id == project_id,
                                                Asset.deleted_at.is_(None)).all()]

    llm = LLMProvider()
    out: dict[str, dict] = {}
    unknown = 0
    for url in items:
        q = (
            "这张图上如果写着人名、角色名或资产名（例如标注、工牌、手写标签），"
            "原样读出来；没有写就回答“无”。\n\n"
            f"本项目的资产名有：{'、'.join(candidates[:120])}\n\n"
            "如果图上的字与其中某个名字**完全一致**，就回答那个名字；"
            "如果不完全一致，回答“无”。不要推测、不要改写、不要补全。"
        )
        try:
            text = await llm.complete_vision(
                "你是资产图标注识别器。只回答图上**字面写着**的名字，不做推断。",
                q, url)
        except Exception as e:  # noqa: BLE001 — 单张失败不影响整批
            logger.warning("[agent] 读图失败 %s: %r", url, e)
            out[url] = {"name": None, "raw_text": "", "error": str(e)[:200]}
            unknown += 1
            continue
        raw = (text or "").strip()
        name = _pick_name(raw, candidates)
        out[url] = {"name": name, "raw_text": raw[:200]}
        if not name:
            unknown += 1

    return {
        "ok": True,
        "results": out,
        "matched": len(items) - unknown,
        "unmatched": unknown,
        "note": ("读出来的名字**还要再对一遍项目资产表**再写库；这里只负责读。"
                 "对不上的原样列给用户，不要猜。"),
    }


def _pick_name(raw: str, candidates: list[str]) -> str | None:
    """从模型回答里挑出**候选名单里**的那个名字。

    严格相等优先（去空白与引号后）；退一步只做"整句就是这个名字"的包含判断。
    绝不做模糊匹配 —— 读错一个字挂错资产，比 unmatched 难查得多。
    """
    if not raw:
        return None
    t = raw.strip().strip("“”\"'「」：:。.，, \n\t")
    if t in ("无", "none", "None", "N/A", ""):
        return None
    if t in candidates:
        return t
    for c in candidates:
        if t == c or t.strip("“”\"'") == c:
            return c
    return None
