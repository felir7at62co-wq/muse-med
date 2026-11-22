"""审批策略：哪些工具调用需要用户确认。

权限开关沿用 user_profiles.agent_permissions（原超级 Agent 的 9 档开关，用户已有设置继续有效）。
业务规则在开关之上：
  · 删除类永远要确认；
  · 批量操作超过 5 部草稿或开启自动采纳时强制确认；
  · 开了"全自动"(auto_continue) → 除删除外都免确认；
  · 其余按风险等级对应的开关决定；读取类永不打断。
"""
from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import InterruptOnConfig

from .tools import AGGREGATES, META, resolve_tool

DEFAULT_PERMISSIONS: dict[str, bool] = {
    "read": True, "meta": True, "generate": False, "overwrite": False, "export": False,
    "delete": False, "auto_image": False, "auto_video": False, "auto_continue": False,
}
PERMISSION_LABELS: dict[str, str] = {
    "read": "读取类免确认",
    "meta": "元数据类免确认（改标题等）",
    "generate": "生成类免确认（大纲/正文/剧本/改编）",
    "overwrite": "覆盖类免确认（重写/精修/修复/批量）",
    "export": "导出类免确认",
    "delete": "删除类免确认（删除始终需要确认，此项不生效）",
    "auto_image": "自动生成图片（会扣费）",
    "auto_video": "自动处理视频（扣费/耗时）",
    "auto_continue": "全自动模式（除删除外全部免确认）",
}
BATCH_CONFIRM_THRESHOLD = 5


def merge_permissions(user_perms: dict | None) -> dict[str, bool]:
    merged = dict(DEFAULT_PERMISSIONS)
    for k, v in (user_perms or {}).items():
        if k in merged:
            merged[k] = bool(v)
    return merged


def needs_approval(tool: str, args: dict, perms: dict) -> bool:
    # 聚合工具按它实际会执行的老工具判断：draft(action=delete) 就是 trash_draft。
    tool, args = resolve_tool(tool, args)
    meta = META.get(tool)
    if meta is None:
        return False            # 中间件自带的工具（如 write_todos）
    if meta.risk == "read":
        return False
    if meta.risk == "delete":
        return True
    # 取消别人正在跑的任务：**永远要确认**，与开关无关（2026-10-22）。
    # 理由同 delete —— 它停掉的是用户正在等的一批稿子，且不可撤销；
    # 而 auto_continue（全自动）恰好是最容易在无人看管时把它误触发的开关。
    if tool == "cancel_draft_tasks":
        return True
    if tool == "submit_batch_job":
        if len(args.get("draft_ids") or []) > BATCH_CONFIRM_THRESHOLD or args.get("auto_apply"):
            return True
    if perms.get("auto_continue"):
        return False
    return not perms.get(meta.risk, False)


_TOOL_LABEL = {
    "create_draft": "新建草稿", "generate_outline": "生成分集大纲", "generate_chapters": "批量生成正文",
    "generate_storyboards": "批量生成剧本", "patch_outline_episode": "改某集大纲的某个要素",
    "regenerate_outline_episode": "按意见重写某集大纲", "expand_outline_beats": "补齐场景节拍",
    "extend_outline": "续写大纲", "regenerate_chapter": "按意见重写某集正文",
    "regenerate_storyboard": "按意见重写某集剧本", "regenerate_product": "按意见重写某章小说/推文", "start_rewrite": "整本精修（覆盖剧本）",
    "start_fix": "按体检问题定点修复", "start_deai": "去AI味（改原稿或建副本）", "adapt_commit": "执行改编（建新草稿）",
    "submit_batch_job": "批量处理草稿", "update_draft_title": "修改草稿标题", "trash_draft": "删除草稿（进回收站）",
    "restore_version": "回退某集到历史版本", "edit_storyboard_text": "精确修改某集剧本文字",
    "edit_chapter_text": "精确修改某集正文文字", "build_story_bible": "重建设定圣经", "refresh_ledger": "重建状态账本",
    "rebalance_timeline": "重排全剧事件节奏（改写大纲）", "regenerate_outline_range": "区间重写大纲",
    "extract_characters": "重新抽取角色（覆盖角色页）", "build_character_cards": "生成角色卡与关系网",
    "replace_character_names": "全剧批量改人名", "generate_novel": "生成小说版", "generate_tweet": "生成推文版",
    "export_docx": "导出 Word 文档", "start_spawn": "裂变生成多部新剧", "batch_create_drafts": "批量新建草稿并自动生成",
    "cancel_draft_tasks": "取消这部草稿上正在跑的任务",
}


def describe(tool: str, args: dict) -> str:
    """给用户看的审批说明：做什么 + 关键参数（不展示超长内容）。"""
    tool, args = resolve_tool(tool, args)
    label = _TOOL_LABEL.get(tool, tool)
    shown = {}
    for k, v in (args or {}).items():
        s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
        shown[k] = s if len(s) <= 300 else s[:300] + f"…（共 {len(s)} 字）"
    return f"{label}\n" + "\n".join(f"· {k}：{v}" for k, v in shown.items())


def interrupt_config() -> dict[str, InterruptOnConfig]:
    """给 HumanInTheLoopMiddleware 的配置：每个非只读工具一条，由 when 按运行时上下文动态判断。"""
    cfg: dict[str, InterruptOnConfig] = {}
    for name, meta in META.items():
        # 风险登记为 read 的聚合工具（draft）也能删稿、建稿：一并交给 when 按解析后的老工具判断。
        if meta.risk == "read" and name not in AGGREGATES:
            continue

        def _when(req: Any, _name: str = name) -> bool:
            ctx = req.runtime.context
            return needs_approval(_name, req.tool_call.get("args") or {}, ctx.permissions)

        def _desc(tool_call: Any, state: Any, runtime: Any, _name: str = name) -> str:
            return describe(_name, tool_call.get("args") or {})

        cfg[name] = InterruptOnConfig(allowed_decisions=["approve", "reject"], description=_desc, when=_when)  # type: ignore[typeddict-unknown-key]
    return cfg
