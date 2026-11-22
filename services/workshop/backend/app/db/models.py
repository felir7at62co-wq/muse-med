"""SQLAlchemy ORM 模型（Orchestrator 业务 + Admin 共享同库）。"""
from __future__ import annotations

from datetime import datetime
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    ForeignKey,
    Integer,
    String,
    Text,
    Float,
    JSON,
    DateTime,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase

from ..defaults import DEFAULT_CHAPTER_WORD_TARGET


class Base(DeclarativeBase):
    pass


class Prompt(Base):
    """元提示词框架（服务端保管，用户不可见）。"""

    __tablename__ = "prompts"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    stage = Column(String(32), default="outline", index=True)
    version = Column(Integer, default=1)
    template = Column(Text, nullable=False)
    variables = Column(String(512), default="")
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Script(Base):
    """精品脚本库（全文 + 元数据 + RAGFlow doc 绑定）。"""

    __tablename__ = "scripts"
    id = Column(Integer, primary_key=True)
    title = Column(String(256), nullable=False)
    genre = Column(String(64), default="", index=True)        # legacy 单题材，保留兼容
    tags = Column(JSON, default=list)                         # 多题材标签
    auto_tagged = Column(Integer, default=0)                  # 是否被 AI 打过标 0/1
    tags_confirmed_at = Column(DateTime, nullable=True)       # 人工确认/编辑标签时间
    content = Column(Text, nullable=False)
    license_note = Column(String(512), default="")
    status = Column(String(32), default="draft")  # draft | indexing | indexed | tagging | tagged
    ragflow_doc_id = Column(String(128), default="")
    ragflow_dataset_id = Column(String(128), default="")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class StyleModule(Base):
    """风格模块 / 触发器规则。"""

    __tablename__ = "style_modules"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), nullable=False)
    tags = Column(JSON, default=list)
    keywords = Column(JSON, default=list)
    language = Column(Text, default="")
    scenes = Column(Text, default="")
    weight = Column(Float, default=1.0)
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Generation(Base):
    """生成审计日志。"""

    __tablename__ = "generations"
    id = Column(Integer, primary_key=True)
    session_id = Column(String(64), index=True)
    user_input = Column(Text)
    outline = Column(Text, default="")
    final_script = Column(Text, default="")
    quality_score = Column(Float, default=0.0)
    matched_modules = Column(JSON, default=list)
    duration_ms = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())



# ---------------------------------------------------------------------------
# M5: 三阶段创作（大纲 / 编剧 / 剧本）—— 草稿 + 章节 + 剧本
# ---------------------------------------------------------------------------

class ScriptDraft(Base):
    """一次创作 = 一份草稿。

    生命周期 status:
      draft -> outline_running -> outline_done -> scripting -> scripted ->
      storyboarding -> done

    `outline` 结构（JSON）:
      {
        "synopsis": "全书一句话",
        "world": {"era":"", "setting":"", "rules":[...]},
        "characters": [{"name":"","role":"","traits":[],"appearance":""}],
        "episodes":   [{"order":1, "title":"", "synopsis":"", "must_have":[], "characters":[], "locked":false, "version":1}]
      }
    
    M5增强版新增字段:
      - episode_count: 总集数(1-500)
      - original_outline: 保存原初大纲,用于重新生成时的上下文
    """

    __tablename__ = "script_drafts"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)  # 所属用户
    session_id = Column(Text, index=True)
    title = Column(Text, default="")
    user_input = Column(Text, default="")
    outline = Column(JSON, default=dict)
    original_outline = Column(JSON, default=dict)  # M5增强: 原初大纲
    outline_locked = Column(Integer, default=0)  # 1 表示用户已锁定，编剧阶段不再改
    status = Column(Text, default="draft")
    episode_count = Column(Integer, default=3)
    is_favorite = Column(Boolean, default=False)
    is_deleted = Column(Boolean, default=False)
    deleted_at = Column(DateTime)
    cover_url = Column(Text, default="")  # PLAN §5.5: 草稿封面图 (image2 生成 / 用户上传)
    preview_batch_running = Column(Integer, default=0)
    model_provider = Column(String, default="gemini")  # gemini/deepseek  # M5增强: 总集数
    chapter_word_target = Column(Integer, default=DEFAULT_CHAPTER_WORD_TARGET)  # 用户可调每章字数
    # 评审精修 v2: 常驻设定圣经(world/characters/name_whitelist/address_matrix/core_drive/trope_labels)
    # 由总览页"构建圣经"生成并可人工微调; 精修时优先读取, 避免每次重抽。
    story_bible_json = Column(JSON, default=dict)
    # 自动批量产线相关
    auto_batch_job_id = Column(Integer, index=True)  # 关联批次,NULL=用户手动创建
    auto_generated = Column(Boolean, default=False)
    parent_draft_id = Column(Integer, index=True)    # 转交副本指向原稿
    # 视频反推剧本: 原始视频在 OSS 上的 key (如果是从视频上传创建的)
    source_oss_key = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class UploadSession(Base):
    """大文件 OSS 直传会话。

    工作流:
      1. POST /v1/oss/init           创建会话, 返回 upload_id + (single 模式: 直接 PUT URL / multipart 模式: oss_upload_id)
      2. PUT  <预签名 URL>           浏览器分片直传到 OSS (服务端不参与流量)
      3. POST /v1/oss/complete       完成: 校验 OSS 实际有这个对象, status -> 'completed'
      4. (可选) POST /v1/oss/abort   主动取消, 调 OSS abort 释放分片

    安全:
      - oss_key 由后端生成 (drama/{user_id}/{yyyymm}/{uuid}_{filename}), 防恶意覆盖
      - 仅 owner 可 complete/abort
      - expires_at 后由 cleanup_worker 清理, 调 OSS abort 释放分片
    """

    __tablename__ = "upload_sessions"
    id = Column(Text, primary_key=True)        # 我们的 upload_id (uuid)
    user_id = Column(Integer, index=True, nullable=False)
    filename = Column(Text, nullable=False)    # 原始文件名(展示用)
    total_size = Column(BigInteger, nullable=False)
    sha256 = Column(Text, nullable=True)       # 客户端可选预计算
    oss_key = Column(Text, nullable=False)     # OSS 中的对象 key
    oss_upload_id = Column(Text, nullable=True)  # multipart 模式才有
    upload_kind = Column(Text, nullable=False, default="single")    # 'single' | 'multipart'
    status = Column(Text, nullable=False, default="pending")        # 'pending' | 'completed' | 'aborted' | 'expired'
    parts_completed = Column(JSON, nullable=False, default=list)    # multipart 已完成分片清单 [{number,etag,size}]
    extra = Column(JSON, nullable=False, default=dict)              # 业务元数据 {episode_index, draft_title, ...}
    created_at = Column(DateTime, server_default=func.now())
    expires_at = Column(DateTime, nullable=False)
    completed_at = Column(DateTime, nullable=True)


class ScriptChapter(Base):
    """编剧阶段产物：每章一行。

    summary 是章末自动摘要（喂给下一章生成，控制上下文长度）。
    locked=1 表示用户已确认本章，后续重生不会动它。
    
    M5增强版新增:
      - version: 版本号,每次重新生成递增
    """

    __tablename__ = "script_chapters"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True)
    chapter_order = Column(Integer)
    title = Column(Text, default="")
    summary = Column(Text, default="")
    full_text = Column(Text, default="")
    word_count = Column(Integer, default=0)
    locked = Column(Integer, default=0)
    is_stale = Column(Integer, default=0)  # 0=最新, 1=上游已修改需重新生成
    version = Column(Integer, default=1)  # M5增强: 版本号
    is_stale = Column(Integer, default=0)  # 0=最新, 1=上游已修改需重新生成
    #: 生成后自动校验的结论（PLAN §3.3 / B8）。
    #:
    #: 形状：[{level, episode, code, message, auto}]，与 lint_report 的 issue 对齐，
    #: 前端复用同一套标注组件。为空 = 未跑或没问题。
    #:
    #: 为什么存这里而不是 check_reports：那张表是**用户主动体检**的报告（按草稿一行），
    #: 而这是**每章生成后自动跑的筛查**（按章一行）。粒度不同 —— 混在一张表里
    #: 会让"这章有没有问题"变成一个要 JOIN 的查询，而它是列表页每行都要用的信息。
    auto_checks = Column(JSONB, default=None)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ScriptStoryboard(Base):
    """剧本阶段产物：每章一行。shots_json 是剧本列表。
    
    M5增强版新增:
      - version: 版本号
      - updated_at: 更新时间
    """

    __tablename__ = "script_storyboards"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True)
    chapter_order = Column(Integer)
    shots_json = Column(JSON, default=list)
    locked = Column(Integer, default=0)
    is_stale = Column(Integer, default=0)  # 0=最新, 1=上游已修改需重新生成
    version = Column(Integer, default=1)  # M5增强: 版本号
    is_stale = Column(Integer, default=0)  # 0=最新, 1=上游已修改需重新生成
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ScriptEpisodeHistory(Base):
    """M5增强: 剧集历史版本表。

    保存每次重新生成的历史版本,支持版本回滚。
    每集每阶段最多保留10个版本。

    `job_id`（2026-10-11 新增）: 写入这条快照时正在跑的 agent_jobs.id。
    加它的唯一目的是回答"**这次作业**改了哪几集、改前什么样" ——
    在此之前表里没有任何列能关联到作业，`/jobs/{id}/changes` 只能按 draft
    取"最近 N 条"，于是点任意作业的「看改动」看到的是同一份（实测 job #107
    大纲修复与 #110 整本精修返回内容 md5 完全相同）。
    由 `agent/jobs.py:run_job` 用 contextvar 注入，写入侧不改 33 个调用点。
    存量行为 NULL（迁移前的历史无法回溯归因，读侧有按时间窗的兜底）。
    """

    __tablename__ = "script_episode_history"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, nullable=False, index=True)
    episode_order = Column(Integer, nullable=False)
    stage = Column(String(32), nullable=False)  # 'outline' / 'chapter' / 'storyboard'
    content = Column(JSON, nullable=False)
    version = Column(Integer, nullable=False)
    created_by = Column(String(32), default="ai_generate")  # 'ai_generate' / 'user_edit'
    job_id = Column(Integer, nullable=True, index=True)     # 见类 docstring
    created_at = Column(DateTime, server_default=func.now())



class GenerationLog(Base):
    """生成过程日志,用于持久化展示+审计"""
    __tablename__ = "generation_logs"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True)
    stage = Column(String)        # outline/chapter/storyboard/direct
    chapter_order = Column(Integer, default=0)
    log_type = Column(String)      # log/progress/error/rag_hit/done
    message = Column(Text)
    log_metadata = Column(JSON, default=dict)  # sources/details
    created_at = Column(DateTime, server_default=func.now())


class ScriptAnalysis(Base):
    """剧本分析结果(综合评级/爆点/风险/建议)。

    每个 draft 最多保留最近 5 次,启动新分析时若超出会删除最老的。
    """
    __tablename__ = "script_analyses"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)
    scope = Column(String(20), default="full")           # full / chapter:N
    status = Column(String(20), default="pending")       # pending/running/done/failed
    progress_step = Column(String(50), default="")       # 当前步骤标签(metrics/overall/hooks/risks)
    progress_current = Column(Integer, default=0)        # 当前进度(用于 step3 爆点扫描)
    progress_total = Column(Integer, default=0)
    overall_grade = Column(String(2))                    # S/A/B/C/D
    overall_score = Column(Integer)                      # 0-100
    summary = Column(Text)
    scores_json = Column(JSON, default=dict)             # {completeness, character, pacing, market}
    hooks_json = Column(JSON, default=list)              # 爆点数组
    risks_json = Column(JSON, default=list)              # 风险列表
    audience_json = Column(JSON, default=dict)           # 受众画像
    suggestions_json = Column(JSON, default=list)        # 改进建议
    metrics_json = Column(JSON, default=dict)            # 程序化指标
    report_md = Column(Text, default="")                 # 总编诊断报告(Markdown 长文)
    llm_raw = Column(Text)                               # LLM 原始输出留底(可选)
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# 全自动批量产线(管理员专用)
# ---------------------------------------------------------------------------

class AutoBatchJob(Base):
    """批次任务,代表一次"管理员发起的批量生成"。"""
    __tablename__ = "auto_batch_jobs"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), default="")
    config_json = Column(JSON, default=dict)             # 入参快照
    status = Column(String(20), default="pending")       # pending|running|done|partial_failed|cancelled|failed
    total_dramas = Column(Integer, default=0)
    finished_dramas = Column(Integer, default=0)
    failed_dramas = Column(Integer, default=0)
    draft_ids = Column(JSON, default=list)               # 生成的 ScriptDraft.id 数组
    current_step = Column(Text, default="")
    llm_calls_estimated = Column(Integer, default=0)
    llm_calls_actual = Column(Integer, default=0)
    error = Column(Text)
    created_by = Column(Integer, index=True)             # 触发的 admin user_id
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


class AgentBatchJob(Base):
    """超级Agent批量运营作业: 对筛选出的一批草稿, 顺序执行一条动作链。

    典型: "把7月2号创建、评分85+的草稿全量精修并自动采纳" →
      filter快照 + 目标 draft_ids + action_chain=[critique, apply_critique] + auto_apply=1
    """
    __tablename__ = "agent_batch_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)                 # 发起用户
    title = Column(String(200), default="")               # 人话描述(给用户看)
    filter_json = Column(JSON, default=dict)              # 筛选条件快照(created_on/min_score/batch_id等)
    action_chain = Column(JSON, default=list)             # 动作链, 如 ["critique","apply_critique"]
    params_json = Column(JSON, default=dict)              # 动作参数(feedback/intensity/source等)
    auto_apply = Column(Integer, default=0)               # 全自动模式(免确认自动采纳/覆盖)
    status = Column(String(20), default="pending")        # pending|running|done|partial_failed|failed|cancelled
    total = Column(Integer, default=0)                    # 目标草稿总数
    finished = Column(Integer, default=0)                 # 已完成草稿数
    failed = Column(Integer, default=0)                   # 失败草稿数
    items_json = Column(JSON, default=list)               # 每个草稿的逐项进度 [{draft_id,title,status,step,detail}]
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


class AutoBatchGenre(Base):
    """题材库(admin 可增删)。"""
    __tablename__ = "auto_batch_genres"
    id = Column(Integer, primary_key=True)
    key = Column(String(40), unique=True, nullable=False)  # 内部 key
    label = Column(String(40), nullable=False)              # 展示名
    description = Column(Text, default="")
    prompt_hint = Column(Text, default="")                  # 给 LLM 的提示
    is_builtin = Column(Boolean, default=False)
    display_order = Column(Integer, default=0)
    use_count = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AutoBatchTransfer(Base):
    """转交记录(支持一对多)。"""
    __tablename__ = "auto_batch_transfers"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)        # 原 draft(模板)
    source_user_id = Column(Integer, nullable=False)              # 来源(admin)
    target_user_id = Column(Integer, index=True, nullable=False)
    copied_draft_id = Column(Integer, nullable=False)             # 复制出的新 draft.id
    job_id = Column(Integer, index=True)                          # 关联批次
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# Agent 助手浮窗 (全局对话)
# ---------------------------------------------------------------------------

class AgentConversation(Base):
    """Agent 会话: 一个用户可有多个会话, 可关联具体草稿。"""
    __tablename__ = "agent_conversations"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    draft_id = Column(Integer, index=True)                        # 关联草稿(草稿页打开时填)
    title = Column(String(120), default="新对话")
    # 来源: studio=对话工坊, agent=Agent 引擎(原超级 Agent)。两边共用本表,
    # 原先没有区分字段, 历史列表互相串, 超级 Agent 还会硬删对话工坊的空会话。
    source = Column(String(16), nullable=False, server_default="studio", index=True)
    is_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AgentMessage(Base):
    """Agent 消息: 用户/助手对话记录, 关联 conversation。

    问答版本化(编辑重发): 用户编辑已发消息后, 旧的"用户消息+回复"问答对
    标记 is_active=False 保留为历史版本(v1/v2... 可切换), 新版本继承原槽位 seq。
    """
    __tablename__ = "agent_messages"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, index=True, nullable=False)
    role = Column(String(16), nullable=False)                     # user | assistant
    content = Column(Text, nullable=False)
    tokens_in = Column(Integer, default=0)
    tokens_out = Column(Integer, default=0)
    # ---- 问答版本化字段 ----
    group_id = Column(Integer, index=True)   # 版本组 id (= 该槽位首版用户消息 id); NULL=从未被编辑
    version = Column(Integer, default=1)     # 组内版本号, 从 1 开始
    is_active = Column(Boolean, default=True)  # 当前生效版本(展示+参与 LLM 上下文); 旧版本置 False
    seq = Column(Integer)                    # 槽位排序值; 新版本继承原消息位置 (NULL=按 id 排序)
    # 挂在这条消息上的体检报告(assistant 消息专用, 普通消息为 NULL)。
    # 前端把它渲染成报告卡; 点"让 AI 改这个"时**只回传 issue_id**, 内容以
    # check_reports 为准 —— 前端被篡改也不可能让引擎去修一条凭空捏造的问题。
    report_json = Column(JSONB, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class CheckReport(Base):
    """体检报告快照 —— 每跑一次体检存一行。

    report      : 完整报告(前端卡片直接渲染这个)
    issue_index : {issue_id: {level,code,episode,message,fix_hint,kind}}
                  扁平索引, 专供**定点修复**按 id 取回原始问题内容。
    scope       : 本次体检范围 {"start_ep":int|null,"end_ep":int|null}; null = 整本

    为什么单独一张表而不是只挂在 agent_messages.report_json 上:
    体检可以脱离某条消息发生(自动体检 / 从报告卡上"重新体检"), 而修复必须能按
    issue_id 找回**那一份**报告。索引 ix_check_reports_draft 正是为"取该草稿最新一份"。
    """
    __tablename__ = "check_reports"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, default=0)
    kinds = Column(JSONB, default=list)
    scope = Column(JSONB, nullable=True)
    report = Column(JSONB, default=dict)
    issue_index = Column(JSONB, default=dict)
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# 视频提示词生成模块: 模板库 + 任务持久化
# ---------------------------------------------------------------------------

class PromptTemplate(Base):
    """模型模板库 (admin 管理).

    每个目标视频/图片模型一条 (Seedance / 快乐马 / Flux 等), 用于:
      1. 渲染阶段把任务素材填入 template
      2. 给规划/渲染阶段的 LLM 提供 ai_instruction (告诉 AI 该模型偏好什么)

    与 prompts 表区分:
      - prompts: 给 LLM 用的"元提示词"(生成大纲/章节的指令)
      - prompt_templates: 给视频/图片模型用的输出模板(最终给 Seedance API 喂的字符串)
    """

    __tablename__ = "prompt_templates"
    id = Column(Integer, primary_key=True)
    key = Column(String(64), unique=True, nullable=False)        # 'seedance_2.0' / 'kuaile_ma_1.0' / 'flux_first_frame'
    label = Column(String(64), nullable=False)                   # 用户可见名: "Seedance 2.0"
    kind = Column(String(16), nullable=False, index=True)        # 'video' | 'image'
    provider = Column(String(32))                                # 'volc' | 'aliyun' | 'flux' | ...
    template = Column(Text, nullable=False)                      # 含 {{var}} 占位符
    duration_min = Column(Integer, default=1)
    duration_max = Column(Integer, default=15)
    duration_default = Column(Integer, default=5)
    aspect_ratio = Column(String(16))                            # '9:16' / '16:9' / '1:1'
    example_input = Column(JSONB)
    example_output = Column(Text)
    notes = Column(Text)                                         # 模型特性说明
    ai_instruction = Column(Text)                                # 给 AI 的渲染指令
    is_builtin = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True, index=True)
    display_order = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ScriptVideoPrompt(Base):
    """草稿生成的视频任务 (合并多个分镜后的最终交付物).

    一条 = 一段独立的视频生成任务 (含视频 prompt + 可选首帧图 prompt).
    plan_json 保留 AI 规划阶段的原始输出, 方便重新渲染换模板.
    """

    __tablename__ = "script_video_prompts"
    __table_args__ = (
        UniqueConstraint("draft_id", "chapter_order", "task_index", name="uq_video_prompts_chapter_task"),
    )

    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    chapter_order = Column(Integer, nullable=False)
    task_index = Column(Integer, nullable=False)                # 该章内第几段 (1-based)
    duration_s = Column(Integer, nullable=False, default=5)     # 1-15 秒
    source_shot_nos = Column(ARRAY(Integer), nullable=False, default=list)  # 来源 shot_no 列表
    summary = Column(Text)                                      # AI 给的 1-2 句概要
    video_template_key = Column(String(64))                     # 用了哪个视频模板
    video_prompt = Column(Text)                                 # 渲染好的视频 prompt
    image_template_key = Column(String(64))                     # 用了哪个图片模板 (可选)
    image_prompt = Column(Text)                                 # 渲染好的首帧图 prompt (可选)
    plan_json = Column(JSONB)                                   # AI 规划阶段原始输出 (含 raw shots, 用于重渲染)
    status = Column(String(16), default="draft")                # 'draft' | 'edited' | 'locked'
    user_edited = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# 自动打磨工作流(分析↔优化循环至收敛)
# ---------------------------------------------------------------------------

class PolishJob(Base):
    """自动打磨作业: 对一批草稿做"分析→优化→再分析→再优化"循环, 直到基本解决硬伤或达最大轮数。

    每个草稿独立跑一条循环(草稿之间高并发):
      for round in 1..max_rounds:
        1. report_only 分析 → 拿 {score, p0_count}
        2. 收敛判定: p0_count==0 且 score>=target_score → 标"达标" break
        3. 否则按诊断报告优化(逐集重做)
      满 max_rounds 仍未达标 → 标"已达最大轮(仍有 N 个 P0)"
    双保险退出: 达标 OR 满轮, 绝不无限循环。

    per_draft_json 结构:
      {draft_id: {
          title, status: "优化中|达标|已达最大轮|失败",
          rounds: [{round, score_before, score_after, p0, optimized_eps, detail}]
      }}
    """
    __tablename__ = "polish_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)                  # 发起用户
    title = Column(String(200), default="")               # 人话描述
    draft_ids = Column(JSON, default=list)                 # 目标草稿ID列表
    max_rounds = Column(Integer, default=3)               # 单草稿最大打磨轮数
    target_score = Column(Integer, default=80)            # 达标综合分阈值
    target_p0 = Column(Integer, default=0)                # 达标要求的P0上限(默认0=无硬伤)
    status = Column(String(20), default="pending")        # pending|running|done|partial_failed|failed|canceled
    total = Column(Integer, default=0)                    # 草稿总数
    finished = Column(Integer, default=0)                 # 已收敛/结束的草稿数(达标或满轮或失败)
    failed = Column(Integer, default=0)                   # 失败草稿数
    # per_draft_json 用 JSONB: 支持 jsonb_set 单键原子更新, 避免高并发下"整份读改写"互相覆盖。
    per_draft_json = Column(JSONB, default=dict)          # 每草稿轨迹 {draft_id: {title,status,rounds:[...]}}
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


class DeaiJob(Base):
    """去 AI 味作业: 对整部剧本逐集"检测→LLM去味改写→注入人味瑕疵→写回"。

    per_ep_json 结构: {ep: {before_score, after_score, before, after, structure,
                            status: "处理中|完成|失败", original_text, rewritten_text}}
      · before_score / after_score 是 0-100 的**相对分**, 仅供同一文本改前改后对比
      · before / after 是密度快照 {score, level, per_kilo, a_count, b_count, cats}
        —— 看 per_kilo(每千字 A 级命中)比看 score 更有指导性
      · structure 是结构层诊断 {paragraph_count, issues: [{code,label,message,...}]}
    summary_json: {avg_before, avg_after, per_kilo_before, per_kilo_after,
                   structure_tally, note}
      · note 必须随报告一并展示: score 不代表任何检测平台的通过率。
    """
    __tablename__ = "deai_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    draft_id = Column(Integer, index=True)
    title = Column(String(256), default="")
    status = Column(String(20), default="running")        # running|done|failed|canceled
    total = Column(Integer, default=0)                    # 总集数
    finished = Column(Integer, default=0)                 # 已处理集数
    failed = Column(Integer, default=0)
    rewrite = Column(Integer, default=1)                  # 是否 LLM 去味改写(1/0)
    inject_level = Column(String(16), default="light")    # none|light|medium|heavy
    allow_typo = Column(Integer, default=1)               # 是否注入错别字(1/0)
    model = Column(String(64), default="gemini")
    per_ep_json = Column(JSONB, default=dict)
    summary_json = Column(JSONB, default=dict)
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime)


class RewriteJob(Base):
    """整本 AI 精修作业: 把整部剧本序列化成纯文本, 两轮同上下文(先分析→再按分析优化),
    然后无损拆回结构、整本覆写草稿。替代旧"打磨"的单稿入口。

    可靠性铁律: 要么整本成功覆写、要么整本不动(绝不部分覆写导致上下集断裂)。
    覆写前每集存入 ScriptEpisodeHistory 可回滚。

    per_ep_json: {ep: {status, before_chars, after_chars}}
    summary_json: {applied_eps, changed_chars, kind}  kind ∈ {storyboard, chapter}
    """
    __tablename__ = "rewrite_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    draft_id = Column(Integer, index=True)
    title = Column(String(256), default="")
    status = Column(String(20), default="running")   # running|analyzing|rewriting|done|failed|canceled
    model = Column(String(64), default="gpt5")
    total = Column(Integer, default=0)               # 总集数
    finished = Column(Integer, default=0)            # 已覆写集数
    per_ep_json = Column(JSONB, default=dict)
    analysis_text = Column(Text)                     # 第一轮问题清单留底(给用户看改了啥)
    summary_json = Column(JSONB, default=dict)
    # 用户参考意见(对话工坊「自动精修」模式下, 用户在发送框里写的那句话)。
    # 空串 = 没有额外意见, 走常规四维精修。留库是为了回溯"这次为什么改成这样"。
    guidance = Column(Text, default="")
    # 精修范围 {"start_ep": int|null, "end_ep": int|null}; NULL = 整本。
    # 必须落库: 精修是覆写操作且会被队列重放, 重放时若读不到范围, 第二次就会把
    # 整本悄悄重写一遍 —— 用户圈的范围被无声放大。
    scope_json = Column(JSONB, nullable=True)
    # 批次取证明细 —— 第二阶段分批精修的**原始响应留底**, 仅供后端排查。
    #
    # 形状: [{batch, of, start_ep, end_ep, wanted[], accepted_eps[], missing_eps[],
    #         attempts[{attempt, finish_reason, chars, returned[], accepted[],
    #                   missing_after[], error?}],
    #         input_chars, output_chars, raw[原始响应], raw_truncated}]
    #
    # 为什么必须落库: 2026-10-07 事故里 prod 草稿 2409 有 10 集(3-6/31-36)"模型未返回",
    # 但原始响应**哪里都没存**(generation_logs 对精修路径是空的), 事后只能确认"少了",
    # 无法确认"少的是什么", 也就无法定因。留底后才能回答"是被截断了、还是模型跳过了"。
    #
    # ⚠️ 绝不下发前端: 里面是模型原始输出(含诊断清单回显、可能夹带思维链)。
    # 面向用户的接口是 `rewrite/routes.py:_job_view` 与 agent 的 `_job_detail` ——
    # 两者都是**显式列字段**, 不会带出本列(这正是当初不用 summary_json 的原因:
    # summary_json 已经在下发且被前端当结果文案用, 塞进去就自动外泄了)。
    batch_evidence = Column(JSONB, nullable=True)
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime)
    #: 心跳：作业每次推进（换阶段、每批精修开始）都会刷新。
    #
    # 为什么需要它（2026-10-08 事故）: `has_active_job` 只看 status ∈
    # {running, analyzing, rewriting} 就认定"有任务在跑"，而**没有任何机制**把
    # 卡死的行改成终态。一次 worker 重启就能让 RewriteJob 永远停在 rewriting,
    # 此后该草稿上的「修硬伤」「精修这批」「生成」全部被拦，回一句"已有任务在跑"，
    # 而那个任务几小时前就死了 —— 用户看到的就是"按钮点了没反应/用不了"。
    #
    # 有这一列之后，"还在跑"有了可判定的依据（心跳新鲜度），而不是靠一个
    # 只能由正常收尾路径改写的 status 字段。判活窗口见
    # rewrite/service.py:REWRITE_STALE_SECONDS。
    heartbeat_at = Column(DateTime, nullable=True, index=True)


# ---------------------------------------------------------------------------
# 对话工坊 AI 编排: 长任务持久化 (Durable Jobs)
# ---------------------------------------------------------------------------

class AgentJob(Base):
    """持久化作业队列 —— 长任务不再跑在进程内存里。

    设计见 agent/jobs.py。核心：作业表即真相源，worker 用
    `SELECT ... FOR UPDATE SKIP LOCKED` 原子领取，租约 + 心跳判活，
    崩溃后由租约过期检测重新入队（幂等重放）。

    为什么需要：原先长任务用 asyncio.create_task 跑在 orchestrator 进程内存里，
    容器重启即蒸发且状态僵死 running（dev 库 402 条 critique_runs.interrupted 即此因）。
    """
    __tablename__ = "agent_jobs"
    id = Column(Integer, primary_key=True)
    kind = Column(String(40), nullable=False, index=True)   # 作业类型(见 jobs.register_handler)
    draft_id = Column(Integer, index=True)
    user_id = Column(Integer, index=True)
    status = Column(String(16), nullable=False, default="queued", index=True)
    # queued | running | done | failed | canceled
    payload = Column(JSONB, default=dict)      # 入参
    result = Column(JSONB, default=dict)       # 产出(供前端读取)
    error = Column(Text)
    progress = Column(Integer, default=0)      # 0-100
    progress_note = Column(Text)               # 给用户看的一句话当前状态
    # ---- 租约与心跳(判活用) ----
    lease_owner = Column(String(120))          # worker 身份
    lease_expires_at = Column(DateTime, index=True)
    heartbeat_at = Column(DateTime)
    attempt = Column(Integer, default=0)       # 已尝试次数
    max_attempts = Column(Integer, default=3)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# 公告群发（飞书私信）
# ---------------------------------------------------------------------------

class AnnouncementPush(Base):
    """一次公告群发的批次记录。

    ## 为什么要有它（2026-10-26）

    公告此前只有网页顶部横幅（`announcements` 表，手动 SQL 建的，无模型）。
    横幅只能覆盖"打开了剧本平台网页的人"，用户在织影、在生成里、几天没开网页
    就完全看不到。加上飞书私信之后，**群发不可撤回**，必须有地方回答三件事：
    这次发给了谁、谁没收到、为什么 —— 只有一张 announcements 表是回答不了的。

    ## 与 announcements 的关系

    `announcement_id` 可为空：用户明确要的是"发一条通知"，不强制先建横幅。
    非空时表示"这条横幅同时也推送了飞书"，横幅本身的可见性仍由 announcements
    的 active / start_at / end_at 控制，两者互不影响（横幅可以只挂网页，
    推送也可以不发横幅）。

    ## scope 的取值

    - `all`   —— 全平台（所有 active 且有飞书身份的账号）
    - `users` —— 指定名单（`target_ids` 里是 user_id 数组）

    ⚠️ 没有单独的"织影平台"档：织影不建用户表，它的登录身份全部来自本平台
    （见 filmweaver-dev/backend/app/auth.py），所以"全平台"本来就包含了织影用户。
    """
    __tablename__ = "announcement_pushes"
    id = Column(Integer, primary_key=True)
    announcement_id = Column(Integer, index=True)      # 关联的横幅(可空)
    title = Column(String(128), nullable=False, default="")
    text = Column(Text, nullable=False)
    scope = Column(String(16), nullable=False, default="all")   # all | users
    target_ids = Column(JSONB, default=list)           # scope=users 时的 user_id 数组
    total = Column(Integer, default=0)                 # 本次范围内应发人数
    sent = Column(Integer, default=0)                  # 成功
    failed = Column(Integer, default=0)                # 失败(暂态, 可重试)
    skipped = Column(Integer, default=0)               # 发不到(无飞书身份/已停用)
    created_by = Column(Integer, index=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)


class AnnouncementDelivery(Base):
    """群发里**逐人**一条投递记录 —— 回答"他到底收到没有"。

    为什么逐人一行而不是把结果塞进批次的 JSON：这是事后排查的唯一入口。
    塞进 JSON 就没法按人查（"小张说他没收到"要能一条 SQL 查出来），
    也没法统计"这批谁反复发不到"。

    status:
      - sent     —— 飞书返回 OK
      - failed   —— 暂态失败（网络/限流/飞书 5xx），可以重发
      - skipped  —— 这个人本来就发不到（没绑飞书 / 账号停用 / union_id 无效）
    """
    __tablename__ = "announcement_deliveries"
    id = Column(Integer, primary_key=True)
    push_id = Column(Integer, index=True, nullable=False)
    user_id = Column(Integer, index=True)
    user_name = Column(String(128), default="")
    status = Column(String(16), nullable=False, index=True)   # sent | failed | skipped
    reason = Column(String(300), default="")                  # 失败/跳过原因
    message_id = Column(String(120), default="")              # 飞书返回的 message_id
    created_at = Column(DateTime, server_default=func.now())
