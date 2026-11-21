"""按**意图**改写**资产生图提示词**，返回改前改后对照。

## 这个模块现在只剩图片（资产）这一半

2026-11-19 之前这里还有 `revise_shot_prompt`：按意图让文本模型重写某镜的**视频**
提示词（内部调 `prompt_opt.optimize_full`）。用户裁定「镜头脚本的撰写整体移交
Muse，镜流只负责存与出片」之后，那个函数连同 `POST /v2/shots/{id}/prompt/revise`
（现恒回 410）和 Agent 工具 `revise_shot_prompt` 一起删除了。

资产生图提示词不是镜头脚本，不在那条裁定之内：`revise_asset_prompt` 保留，
调用方仍是 `POST /v2/assets/prompt/revise` 与 Agent 工具 `revise_asset_prompt`
（两处都只是薄壳，改写逻辑只在这里一份）。
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger("fw.prompt_revise")

#: 图片提示词的改写系统段。与视频侧共用同一条原则：只写"要什么"。
_IMAGE_REVISE_SYSTEM = (
    "你是资产生图提示词的编辑。用户会给你一段现有的生图提示词和一句修改要求，"
    "你要在**保留其余全部内容**的前提下落实那句要求，输出修改后的完整提示词。\n"
    "规则：\n"
    "· 只改用户点名的地方；没提到的构图、画风、材质、光线、背景描述原样保留。\n"
    "· 保持原有的分句方式与信息密度，不要缩短成一句概述，也不要扩写成文章。\n"
    "· 修改要求若与原有描述冲突，以修改要求为准，并删掉被它取代的旧描述。\n"
    "· 直接输出修改后的提示词正文，不要解释、不要加标题、不要用代码块围栏。"
)


def _auto_asset_prompt(session, proj, asset) -> str:
    """这个资产**此刻**会用的生图提示词（拼装结果，不看用户终稿）。

    与 `routers/shotflow.prompt_preview` 同一口径、同一批拼装函数。
    影调与画风**只读库**（`look_json` / `style_preset.load`），不触发任何生成：
    预览/改写都是同步路径，为了一句提示词去跑 LLM 补档案会把请求拖到超时。
    """
    from .asset_prompt import character_prompt, prop_prompt, scene_prompt
    from .character_brief import brief_for_image, creature_of, load_brief
    from .db import desc_of
    from .jobs import _profile_of_asset, _style_of

    title = proj.title or ""
    try:
        look = json.loads(proj.look_json) if proj.look_json else None
    except (ValueError, TypeError):
        look = None
    style = _style_of(asset.project_id)

    if asset.kind == "character":
        # ⚠️ `load_brief` 在没有档案时返回 **None**，而 `brief_for_image` 签名要
        # `dict[str, dict]`，直接传 None 会 AttributeError: 'NoneType' has no 'get'。
        # 老项目里绝大多数角色没有档案（实测覆盖率约 20%），所以这条路径必然被走到。
        brief = load_brief(asset.project_id, asset.name) or {}
        return character_prompt(
            title, asset.name, description=desc_of(asset),
            brief=brief_for_image(brief, asset.name),
            creature=creature_of(brief, asset.name),
            profile=_profile_of_asset(session, asset.project_id, asset.name),
            look=look, style=style, aspect=proj.base_aspect)
    if asset.kind == "prop":
        return prop_prompt(asset.name, description=desc_of(asset),
                           title=title, look=look, style=style)
    return scene_prompt(asset.name, description=desc_of(asset),
                        title=title, look=look, style=style)


async def revise_asset_prompt(asset_id: str, instruction: str,
                              *, save: bool = False) -> dict:
    """按意图改资产的生图提示词。

    ## 写哪一列

    写 `Asset.prompt`（用户终稿），**不写 `desc_auto`**。两者互斥：
      · `desc_auto` 是拼装函数的**输入**（一句空间/着装描述，几十字）；
      · `prompt` 是用户改过的**整段终稿**（几百字，含画风/构图/兜底参数）。
    把一段整稿塞进 `desc_auto` 会让下一次拼装把它当描述再包一层，
    画风前缀与构图句重复两遍。

    ## 与造型（AssetStage）的关系

    造型有自己的 `prompt` 与 `description`。本函数只改**资产级**终稿；
    造型级改写走同一个入口、传 stage_id 即可（暂未开放，见 KNOWN 缺口）。
    """
    from .db import Asset, Project, get_session, final_prompt_of
    from .prompt_sanitize import strip_editor_chrome
    from .providers.llm import LLMProvider

    text_in = strip_editor_chrome(instruction or "").strip()
    if not text_in:
        return {"ok": False, "error": "说说要怎么改"}

    with get_session() as session:
        asset = session.get(Asset, asset_id)
        if asset is None:
            return {"ok": False, "error": "资产不存在"}
        proj = session.get(Project, asset.project_id)
        if proj is None:
            return {"ok": False, "error": "项目不存在"}
        auto = _auto_asset_prompt(session, proj, asset)
        before = (final_prompt_of(asset) or auto or "").strip()
        name, kind = asset.name, asset.kind
        # ⚠️ session 一关，`proj` 就脱离会话了（Properties 访问会抛 DetachedInstanceError）。
        # pid 必须在这里取出来，事后再用。
        pid = asset.project_id
        if not before:
            return {"ok": False, "error": "这个资产没有可改的提示词"}

    from .config import get_settings
    s = get_settings()
    llm = LLMProvider(model_id=s.llm_model_prompt or s.llm_model)
    human = (f"现有提示词：\n{before}\n\n"
             f"修改要求（优先于上面的描述，冲突时以它为准）：\n{text_in}")
    try:
        after = await llm.complete(_IMAGE_REVISE_SYSTEM, human, temperature=0.3)
    except Exception as e:  # noqa: BLE001 — 改写失败不该让整个页面报错
        logger.warning("[asset %s] 提示词改写失败：%r", asset_id, e)
        return {"ok": False, "error": f"改写失败：{type(e).__name__}: {str(e)[:160]}"}

    after = (after or "").strip()
    if not after:
        return {"ok": False, "error": "模型没有返回内容，请重试或换个说法"}
    # 模型偶尔会用代码块围栏包住正文（尽管提示词说了不要）
    if after.startswith("```"):
        lines = [ln for ln in after.splitlines() if not ln.strip().startswith("```")]
        after = "\n".join(lines).strip()

    from . import charge
    charge.charge_sync("reprompt", {"project_id": pid},
                       desc="图片提示词改写", project_id=pid)

    if save:
        with get_session() as session:
            a = session.get(Asset, asset_id)
            if a is not None:
                a.prompt = after
                session.commit()

    return {"ok": True, "asset_id": asset_id, "kind": kind, "name": name,
            "saved": bool(save), "before": before, "after": after}
