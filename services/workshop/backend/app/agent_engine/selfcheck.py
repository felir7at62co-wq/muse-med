"""启动自检：工具引用的平台函数都存在、参数名对得上、工具 schema 能生成。

旧超级 Agent 有 7/53 个技能调用的接口早已不存在却没人知道。这里在 worker 启动时逐个核对，
任何一项不过就**拒绝启动**（不允许带病上线）。新增/改动工具时同步维护 _TARGETS。
"""
from __future__ import annotations

import importlib
import inspect
import logging

logger = logging.getLogger("agent_engine.selfcheck")

#: (模块, 属性, 工具调用时用到的参数名)
_TARGETS: list[tuple[str, str, tuple[str, ...]]] = [
    ("app.stages.router", "list_drafts", ("session_id", "limit", "offset", "all", "created_on", "min_score", "batch_id", "user")),
    ("app.stages.router", "create_draft", ("payload", "user")),
    ("app.stages.router", "CreateDraftIn", ()),
    ("app.stages.router", "FeedbackRegenerateIn", ()),
    ("app.stages.router", "regenerate_episode_with_feedback", ("draft_id", "episode_order", "payload")),
    ("app.stages.router", "regenerate_chapter_with_feedback", ("draft_id", "chapter_order", "payload")),
    ("app.stages.router", "regenerate_storyboard_with_feedback", ("draft_id", "chapter_order", "payload")),
    ("app.stages.router", "ExpandOutlineIn", ()),
    ("app.stages.router", "expand_outline_episodes", ("draft_id", "payload")),
    ("app.stages.router", "ExtendIn", ()),
    ("app.stages.router", "start_extend", ("draft_id", "payload")),
    ("app.stages.router", "_active_adapt_job", ("source_draft_id",)),
    ("app.stages.router_m5_enhanced", "update_outline_episode", ("draft_id", "order", "payload")),
    ("app.stages.router_m5_enhanced", "UpdateOutlineEpisodeIn", ()),
    ("app.stages.outline_fields", "PATCHABLE_FIELDS", ()),
    ("app.stages.access", "check_draft_access", ("s", "draft_id", "user", "for_write")),
    ("app.stages.adaptation", "analyze_source", ("draft_id",)),
    ("app.stages.adaptation", "propose_blueprint", ("draft_id", "origin", "guidance")),
    ("app.stages.adaptation", "get_adapt_meta", ("draft_id",)),
    ("app.check.engine", "run_check", ("draft_id", "kinds", "scope", "deep")),
    ("app.check.engine", "ALL_KINDS", ()),
    ("app.check.fixer", "index_issues", ("report",)),
    ("app.check.review", "mainline_review", ("draft_id", "layer", "start_ep", "end_ep")),
    ("app.check.review", "storyboard_review", ("draft_id", "start_ep", "end_ep")),
    ("app.check.review", "product_review", ("draft_id", "kind")),
    ("app.adapt_products.service", "regenerate_one", ("draft_id", "kind", "chapter_order", "model", "feedback")),
    ("app.adapt_products.models", "ChapterAdaptation", ()),
    ("app.agent.chat_jobs", "start_generate", ("draft_id", "user_id", "gen_kind", "start", "end", "guidance")),
    ("app.agent.chat_jobs", "start_rewrite", ("draft_id", "user_id", "guidance", "scope")),
    ("app.agent.chat_jobs", "start_fix", ("draft_id", "user_id", "issue_ids", "report_id")),
    ("app.agent.jobs", "enqueue", ("kind", "draft_id", "user_id", "payload")),
    ("app.agent.memory", "get_or_create_profile", ("user_id",)),
    ("app.deai.routes", "detect", ("body", "user")),
    ("app.deai.routes", "DetectBody", ()),
    ("app.deai.routes", "submit", ("body", "user")),
    ("app.deai.routes", "ApplyBody", ()),
    ("app.deai.routes", "start_deai_apply", ("draft_id", "user_id", "target", "inject_level", "model", "start_ep", "end_ep", "layer")),
    ("app.deai.models", "DeaiJob", ()),
    ("app.agent_batch.routes", "submit", ("body", "user")),
    ("app.agent_batch.routes", "SubmitBody", ()),
    ("app.db.models", "AgentBatchJob", ()),
    ("app.db.models", "AgentJob", ()),
    ("app.features.user_features_routes", "move_to_trash", ("draft_id", "user")),
    ("app.auth.models", "User", ()),
    ("app.stages.router_m5_enhanced", "restore_episode_version", ("draft_id", "order", "payload")),
    ("app.stages.router_m5_enhanced", "RestoreVersionIn", ()),
    ("app.db.models", "ScriptEpisodeHistory", ()),
    ("app.stages.router", "patch_storyboard", ("draft_id", "chapter_order", "payload", "user")),
    ("app.stages.router", "PatchStoryboardIn", ()),
    ("app.stages.router", "patch_chapter", ("draft_id", "chapter_order", "payload")),
    ("app.stages.router", "PatchChapterIn", ()),
    ("app.stages.router", "refresh_ledger", ("draft_id",)),
    ("app.stages.router", "get_draft_characters", ("draft_id", "user")),
    ("app.stages.router", "extract_draft_characters", ("draft_id", "user")),
    ("app.stages.lint_routes", "run_drama_gate", ("draft_id", "user")),
    ("app.analysis.routes", "start_analysis", ("draft_id", "user")),
    ("app.analysis.routes", "get_latest_analysis", ("draft_id", "user")),
    ("app.critique.routes", "build_bible", ("draft_id", "body", "user")),
    ("app.critique.routes", "BuildBibleBody", ()),
    ("app.narrative.routes", "diagnose_timeline", ("draft_id", "user")),
    ("app.narrative.routes", "rebalance_timeline", ("draft_id", "user")),
    ("app.stages.router_m5_regenerate", "regenerate_outline_range", ("draft_id", "payload")),
    ("app.stages.router_m5_regenerate", "RegenerateRangeIn", ()),
    ("app.features.phase5_routes", "list_characters", ("draft_id", "user")),
    ("app.features.phase5_routes", "list_relationships", ("draft_id", "user")),
    ("app.features.phase5_routes", "list_warnings", ("draft_id", "user")),
    ("app.features.character_cards_worker", "build_character_cards", ("draft_id",)),
    ("app.features.character_consistency_worker", "scan_character_consistency", ("draft_id",)),
    ("app.features.video_routes", "character_replace", ("draft_id", "payload", "user")),
    ("app.features.video_routes", "CharacterReplaceIn", ()),
    ("app.db.models_phase5", "ExportJob", ()),
    ("app.features.export_worker", "run_export_job", ("job_id",)),
    ("app.adapt_products.models", "ChapterAdaptJob", ()),
    ("app.spawn.routes", "submit", ("body", "user")),
    ("app.spawn.routes", "SubmitBody", ()),
    ("app.spawn.models", "SpawnJob", ()),
    ("app.batch_create.routes", "create_batch", ("payload", "user")),
    ("app.batch_create.routes", "BatchCreateIn", ()),
    ("app.db.models", "AutoBatchJob", ()),
]


def run_selfcheck() -> list[str]:
    """返回问题清单（空 = 通过）。"""
    problems: list[str] = []
    for mod, attr, params in _TARGETS:
        try:
            obj = getattr(importlib.import_module(mod), attr)
        except Exception as e:  # noqa: BLE001
            problems.append(f"{mod}.{attr} 不存在：{e}")
            continue
        if params and callable(obj):
            try:
                names = set(inspect.signature(obj).parameters)
            except (TypeError, ValueError):
                continue
            missing = [p for p in params if p not in names]
            if missing:
                problems.append(f"{mod}.{attr} 缺少参数 {missing}（现有 {sorted(names)}）")
    from .policy import interrupt_config
    from .prompts import PROFILE_TOOLS
    from .tools import META, all_tools
    for name, t in all_tools().items():
        try:
            t.tool_call_schema.model_json_schema()
        except Exception as e:  # noqa: BLE001
            problems.append(f"工具 {name} 的参数 schema 生成失败：{e}")
        if not (t.description or "").strip():
            problems.append(f"工具 {name} 缺少说明")
    for prof, allow in PROFILE_TOOLS.items():
        for n in allow or ():
            if n not in META:
                problems.append(f"配置档 {prof} 引用了不存在的工具 {n}")
    interrupt_config()
    return problems


def assert_ok() -> None:
    problems = run_selfcheck()
    if problems:
        for p in problems:
            logger.error("Agent 引擎自检失败：%s", p)
        raise RuntimeError("Agent 引擎自检失败：\n" + "\n".join(problems))
    logger.info("Agent 引擎自检通过")
