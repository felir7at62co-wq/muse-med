"""视频模型 → 提示词框架名（**只剩这一个查表函数**）。

## 这个包原来是什么

镜流自带的「提示词优化服务」：`optimize_full` 等函数拿镜头的剧本原文，套上
`skill_assets/<framework>/` 里的技能文档与 `house_rules.py` 的出品规则，调文本
模型写出视频提示词。拆解后的预生成、「重新生成提示词」、出片时的兜底、
「AI 改写」四条路径都走它。

## 2026-11-19：整套删除

用户裁定「镜头脚本的撰写整体移交 Muse，镜流只负责存与出片」。于是
`optimize_full` / `optimize_to_prompt(_detailed)` / `build_system_prompt` /
`get_status`、`house_rules.py` 与 `skill_assets/` 全部删除。

## 为什么还留着 `framework_for_model`

它不写提示词，只回答「这个视频模型属于哪一族」，而这件事还有**与写稿无关**的
调用方：

  · `jobs.run_shot_videos`：下发前要不要把正文里的裸名字绑成 `名字@图片N`
    —— 只有 seedance2 这一族认 `@图片N` 语法；
  · `prompt_health.project_has_framework`：存量数据里「提示词 == 剧本原文」
    算不算降级（没有框架的模型本来就直通原文）；
  · Agent 工具 `get_prompt_rules`：给出该族提示词的排版说明。

框架"就绪"与否（原 `_framework_ready`，看 `SKILL.txt` 在不在）随技能文档一起
没有了意义：三处调用方现在只看有没有框架名。
"""
from __future__ import annotations

from typing import Optional


# model_id → 框架名（None=无框架）
def framework_for_model(model_id: str) -> Optional[str]:
    """取该视频模型所属的提示词框架（`seedance2` / `minimax_h3` / None）。

    **优先问注册表里那条 Provider 自己声明的** `prompt_framework`：能力是渠道
    属性，靠 model_id 前缀猜在三方渠道接进来之后就不再成立（官方是
    `seedance-2.5`、三方是 `seedance-lowcost-2.5`，两者都属 seedance2 这一族，
    但第三方渠道的 model_id 将来未必再带 "seedance" 这个词）。

    前缀匹配只作为**兜底**保留：给那些不该被注册表依赖的调用方用（例如离线
    脚本直接传一个尚未注册的 model_id）。
    """
    m = (model_id or "").lower()
    try:
        from ..providers.registry import registry
        p = registry.get_video(model_id) if model_id else None
        declared = getattr(p, "prompt_framework", None) if p is not None else None
        if declared:
            return str(declared)
    except Exception:  # noqa: BLE001
        pass          # 注册表不可用（离线脚本/循环导入）时退回前缀判定
    if m.startswith("seedance"):
        return "seedance2"
    if m.startswith("minimax"):
        return "minimax_h3"
    return None  # veo 及未知模型：无框架
