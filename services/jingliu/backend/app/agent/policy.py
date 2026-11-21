"""代码保证的两条底线：**谁能用**、**最多花多少钱**。其余交给模型按用户的话做。

## 2026-10-21 用户裁定：约束只留真正必须由代码兜底的

此前这里有七层：角色权限、「做到哪一步」白名单、范围自动削减、三档自主程度与
授权推导、硬确认风险档、按参数升级风险、执行器里的第二道审批。后果是：

  · 同一条审批规则写在图的审批节点与执行器两处，执行器不知道刚批过 ——
    「跟着我做」档每个花钱步、任何档的删除，**批准了也执行不了**；
  · 范围、阶段、自主程度本来就是用户的要求，代码替模型判断只会与模型的判断打架。

现在：
  ① **角色权限**（executor）—— 查看者不能改、不能花钱；
  ② ~~预算上限~~ —— 2026-11-02 删除（用户：「这个没用也不该成为限制」）。
     钱由账户余额兜底；`estimate_for` 仍给审批卡和步骤记录报价。
  ③ **真正找不回来的操作要人点头**（graph 的审批节点，**只在这一处判**）——
     见 `ToolSpec.confirm`：换整个剧本、强制重新拆解。

视频与资产图每次生成都留历史版本、删资产是软删可恢复、改提示词会把旧稿记在
步骤结果里——这些都不是"覆盖"，不需要确认。
范围、做到哪一步、花钱前要不要问，写在用户那段话里，由模型遵守；越界的最坏后果
被账户余额与版本历史兜住。
"""
from __future__ import annotations

import logging

logger = logging.getLogger("fw.agent.policy")

RISK_CN = {
    "read": "只读",
    "write": "修改数据",
    "generate": "生成（花钱）",
}


def _confirm_value(spec, args: dict | None):
    c = getattr(spec, "confirm", False)
    if callable(c):
        try:
            return c(dict(args or {}))
        except Exception as e:  # noqa: BLE001 — 判不出来就按要确认处理
            logger.warning("[agent] %s 确认判定失败，按需要确认处理: %r",
                           getattr(spec, "name", "?"), e)
            return True
    return c


def needs_confirm(spec, args: dict | None = None) -> bool:
    """这一次调用要不要停下来等人点头。**全系统只有这一个判据**。"""
    return bool(_confirm_value(spec, args))


def confirm_text(spec, args: dict | None = None) -> str:
    """确认卡片上那句话：说清这一步会丢掉什么。

    `confirm` 判据可以直接返回这句话（字符串即"要确认"），例如合并资产时写出
    「把 王总、老王 合并进 王建国」—— 卡片只写工具名的话，用户无从判断该不该点。
    """
    v = _confirm_value(spec, args)
    return v if isinstance(v, str) and v.strip() else ""


def estimate_for(spec, kwargs: dict) -> tuple[int, str]:
    """这一步大概要花多少（分），以及一句人话说明。

    报价**复用 charge.estimate**，不另写一套：两处各写必然漂移，
    而漂移的方向通常是"审批卡说 5 元、实际扣 50 元"。
    """
    if not spec.costs:
        return 0, ""
    from .. import charge

    kind = getattr(spec, "job_kind", None) or _KIND_OF.get(spec.name)
    if not kind:
        return 0, ""
    payload = _payload_for(spec.name, kwargs)
    try:
        return charge.estimate(kind, payload)
    except Exception as e:  # noqa: BLE001 — 报价失败不该阻断审批流程
        logger.warning("[agent] 工具 %s 报价失败: %r", spec.name, e)
        return 0, "报价失败，实际金额以任务结算为准"


#: 工具名 → job kind。只列**会花钱**的那些；其余按 0 处理。
_KIND_OF: dict[str, str] = {
    "run_breakdown": "breakdown_all",
    "run_costume_scan": "costume_scan",
    "run_profile_fill": "profile_fill",
    "run_asset_fill": "asset_fill",
    "run_asset_generate": "asset_generate",
    "run_shot_videos": "shot_videos",
    "run_tts": "tts_batch",
    "run_desub_scan": "desub_scan",
    "run_desub_apply": "desub_apply",
    "run_upscale": "upscale",
    "run_video_upscale": "video_upscale",
    "run_auto_subtitles": "auto_subtitles",
    "export_jianying": "jianying_export",
    # 按意图改写**资产生图**提示词（2026-10-28）：按一次文本操作计价（`reprompt` 是
    # charge 里「一次文本操作」的口径名，不是已下线的那个同名任务）。
    # 不登记的话报价恒为 0，预算闸门对它**完全无效** —— 用户设 50 元上限，
    # agent 连改 200 遍提示词也撞不到。
    # ⚠️ 原先同在这里的 `run_reprompt` / `revise_shot_prompt` / `run_one_click_film`
    #    三个工具已于 2026-11-19 删除（镜头脚本改由 Muse 撰写）。
    "revise_asset_prompt": "reprompt",
    # 2026-10-28：把「网页有按钮、agent 调不到」的那批能力接进来。
    # ⚠️ 漏一条的后果与上面那句一样——报价恒为 0，闸门形同虚设。
    #    `run_video_upscale` 的键本来就在这里预留（kind 早就登记了），只是工具
    #    一直没写，所以它此前是一条死映射。
    "generate_scene_views": "asset_batch",
    "qc_asset_image": "asset_candidates_llm",
    "regenerate_project_look": "reprompt",
    # ⚠️ 原先同在这里的 `run_first_frames` / `regen_first_frame` 两个工具已于 2026-11-20
    #    删除（首帧路线下线）。
}


def _payload_for(tool: str, kwargs: dict) -> dict:
    """把工具参数折成 `charge.estimate` 认识的 payload 形状。

    只映射**计价需要的**那几个键（project_id / shot_ids / episode / items / kinds / resolution），
    多传的键 estimate 不看，少了它就只能按整片兜底估——那就贵得离谱。
    """
    p: dict = {}
    for k in ("project_id", "shot_ids", "episode", "items", "only", "kinds",
              "orders", "clip_ids", "region_ids", "resolution"):
        if k in kwargs and kwargs[k] is not None:
            p[k] = kwargs[k]
    return p


