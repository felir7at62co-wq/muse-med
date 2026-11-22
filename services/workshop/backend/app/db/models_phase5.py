"""Phase 5 新增模型 (PLAN_UI_REVAMP §5.5)。

新增表:
- characters / character_relationships / character_consistency_warnings (角色管理)
- export_jobs (导出任务异步队列)
- draft_extend_configs (续写配置 - 当前已用 ScriptDraft.outline JSON 中的 extensions 字段, 这里仅做归一化扩展)
- email_verifications (邮箱验证码)
- agent_attachments / agent_artifacts (浮窗附件 + AI 产出物)
- prompt_converter_quotas (提示词速转配额)
- image_generation_quotas (image2 调用配额)
- draft_batch_jobs / draft_batch_logs (用户级工作台批量任务)

字段扩展(由 schema_extensions.py 的 ALTER TABLE 处理):
- drafts.cover_url (已存在于 ScriptDraft)
- prompts.video_prompt_struct/image_prompt_struct (已存在于 ScriptVideoPrompt)
- analyses 5 字段 + scores_json 6 维度 (在 ScriptAnalysis 上扩展)
- safety_reports 7 字段 / safety_risks 4 字段 (新建表)
- users.email/agreement_accepted_at/avatar_url (User 已有 email/avatar_url, 需补 agreement_accepted_at)
- agent_conversations.unread_count/last_read_at/model
- agent_memories.type 枚举 5 值
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean, Column, ForeignKey, Integer, String, Text, Float, JSON, DateTime, func
)
from sqlalchemy.dialects.postgresql import JSONB
from .models import Base

from ..defaults import DEFAULT_CHAPTER_WORD_TARGET


# ---------------------------------------------------------------------------
# 角色管理
# ---------------------------------------------------------------------------

class Character(Base):
    """角色信息(可生成头像/绑定外貌特征/关联关系网)。"""

    __tablename__ = "characters"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(64), nullable=False)
    role = Column(String(32), default="")              # 主角 / 男主 / 女主 / 配角 / 反派 / 路人 等
    appearance = Column(Text, default="")              # 外貌描述
    personality = Column(Text, default="")             # 性格描述
    backstory = Column(Text, default="")               # 背景故事
    avatar_url = Column(String(512), default="")       # OSS 上的头像 URL (image2 生成)
    avatar_prompt = Column(Text, default="")           # 生成头像用的 prompt
    traits = Column(JSON, default=list)                # 标签数组
    is_active = Column(Boolean, default=True)          # 是否当前剧本仍在用
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CharacterRelationship(Base):
    """角色关系图: 任意两个角色之间的关系。"""

    __tablename__ = "character_relationships"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    from_character_id = Column(Integer, ForeignKey("characters.id", ondelete="CASCADE"), nullable=False)
    to_character_id = Column(Integer, ForeignKey("characters.id", ondelete="CASCADE"), nullable=False)
    relation_type = Column(String(32), default="")     # 父子 / 夫妻 / 朋友 / 敌人 / 同事 / 师徒 等
    strength = Column(Integer, default=50)             # 0-100 关系强度
    description = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())


class CharacterConsistencyWarning(Base):
    """角色一致性警告: AI 检测到角色在不同章节中的描述矛盾。"""

    __tablename__ = "character_consistency_warnings"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False, index=True)
    character_id = Column(Integer, ForeignKey("characters.id", ondelete="CASCADE"), nullable=True)
    character_name = Column(String(64), default="")
    chapter_orders = Column(JSON, default=list)        # [3, 5, 7] 涉及的章节
    warning_type = Column(String(32), default="")      # appearance_conflict / personality_conflict / backstory_conflict
    severity = Column(String(8), default="medium")     # high / medium / low
    description = Column(Text, default="")             # 矛盾描述
    suggestion = Column(Text, default="")              # 修复建议
    resolved = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# 导出任务异步队列
# ---------------------------------------------------------------------------

class ExportJob(Base):
    """异步导出任务(大文件 / 全章节合集 / 多模型混合) — PLAN §5.5 export_jobs。

    现状: 现有 export_text/export_chapter_docx/export_mixed 是同步导出。
    本表为后续异步队列预留,允许用户提交后立即返回 job_id, 后台慢慢生成。
    """

    __tablename__ = "export_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), index=True)
    kind = Column(String(32), nullable=False)          # docx_chapter / docx_mixed / pdf / html / zip
    config_json = Column(JSON, default=dict)           # 导出配置
    status = Column(String(16), default="pending", index=True)  # pending / running / done / failed
    progress = Column(Integer, default=0)              # 0-100
    output_url = Column(String(512), default="")       # OSS 下载链接
    error = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


# ---------------------------------------------------------------------------
# 续写配置 (补充 ScriptDraft.outline 中 extensions 字段的归一化版本)
# ---------------------------------------------------------------------------

class DraftExtendConfig(Base):
    """每个草稿的续写偏好配置 (PLAN §5.5 draft_extend_configs)。"""

    __tablename__ = "draft_extend_configs"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), unique=True, nullable=False)
    default_target_episodes = Column(Integer, default=20)
    default_chunk_size = Column(Integer, default=20)
    default_word_target = Column(Integer, default=DEFAULT_CHAPTER_WORD_TARGET)
    default_provider = Column(String(16), default="gemini")
    forced_level = Column(String(8))                   # L1 / L2 / L3 / null=auto
    user_guidance_template = Column(Text, default="") # 用户的常用引导模板
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# 邮箱验证码 (注册流程)
# ---------------------------------------------------------------------------

class EmailVerification(Base):
    """注册/重置密码邮箱验证码。

    工作流:
      1. POST /v1/auth/email/send-code  -> 创建一行, status=pending, code 6位
      2. SMTP 发邮件 (TODO: 后续集成)
      3. POST /v1/auth/email/verify-code -> 校验 code+email, status=verified
      4. 注册时检查邮箱是否已 verified
    """

    __tablename__ = "email_verifications"
    id = Column(Integer, primary_key=True)
    email = Column(String(128), index=True, nullable=False)
    code = Column(String(8), nullable=False)
    purpose = Column(String(16), default="register")   # register / reset_password / change_email
    status = Column(String(16), default="pending")     # pending / verified / expired
    attempts = Column(Integer, default=0)              # 校验尝试次数
    ip = Column(String(45))
    created_at = Column(DateTime, server_default=func.now())
    expires_at = Column(DateTime, nullable=False)
    verified_at = Column(DateTime)


# ---------------------------------------------------------------------------
# Agent 浮窗附件 + AI 产出物
# ---------------------------------------------------------------------------

class AgentAttachment(Base):
    """用户给 Agent 上传的附件 (图片 / docx / 语音转写文本)。"""

    __tablename__ = "agent_attachments"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("agent_conversations.id", ondelete="CASCADE"), index=True, nullable=False)
    message_id = Column(Integer, ForeignKey("agent_messages.id", ondelete="CASCADE"), index=True)
    user_id = Column(Integer, index=True, nullable=False)
    kind = Column(String(16), default="image")        # image / docx / audio / text
    filename = Column(String(256))
    oss_url = Column(String(512))
    size_bytes = Column(Integer, default=0)
    mime_type = Column(String(64))
    created_at = Column(DateTime, server_default=func.now())


class AgentArtifact(Base):
    """Agent 产出的可保存物 (如生成的代码片段 / Prompt / 大纲草案)。"""

    __tablename__ = "agent_artifacts"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("agent_conversations.id", ondelete="CASCADE"), index=True, nullable=False)
    message_id = Column(Integer, ForeignKey("agent_messages.id", ondelete="CASCADE"), index=True)
    user_id = Column(Integer, index=True, nullable=False)
    kind = Column(String(16), default="text")         # text / json / outline / prompt / code / image_prompt
    title = Column(String(256), default="")
    content = Column(Text, default="")
    metadata_json = Column(JSONB)                     # 各种附加元数据
    is_pinned = Column(Boolean, default=False)        # 用户标星, 永不被压缩
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# 配额表
# ---------------------------------------------------------------------------

class PromptConverterQuota(Base):
    """提示词速转配额 (按用户按天限制调用次数)。"""

    __tablename__ = "prompt_converter_quotas"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    quota_date = Column(String(10), index=True)        # YYYY-MM-DD
    used_count = Column(Integer, default=0)
    daily_limit = Column(Integer, default=20)         # 默认每天 20 次
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ImageGenerationQuota(Base):
    """image2 / 图片生成配额 (按用户按天)。"""

    __tablename__ = "image_generation_quotas"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    quota_date = Column(String(10), index=True)
    used_count = Column(Integer, default=0)
    daily_limit = Column(Integer, default=10)         # 默认每天 10 张图
    kind = Column(String(16), default="any")          # any / cover / avatar / first_frame
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# 用户级工作台批量任务 (与 admin auto_batch_jobs 区分)
# ---------------------------------------------------------------------------

class DraftBatchJob(Base):
    """用户在某个草稿内发起的批量操作 (批量重生章节 / 批量出剧本 / 批量出视频提示词)。"""

    __tablename__ = "draft_batch_jobs"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id = Column(Integer, index=True, nullable=False)
    kind = Column(String(32), nullable=False)          # regen_chapters / gen_scripts / gen_video_prompts / etc.
    config_json = Column(JSON, default=dict)
    target_episodes = Column(JSON, default=list)       # [1,3,5] 要处理的章节号
    status = Column(String(16), default="pending", index=True)  # pending / running / done / failed / cancelled
    progress_current = Column(Integer, default=0)
    progress_total = Column(Integer, default=0)
    error = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


class DraftBatchLog(Base):
    """批量任务的逐条日志 (按 episode_order)。"""

    __tablename__ = "draft_batch_logs"
    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("draft_batch_jobs.id", ondelete="CASCADE"), index=True, nullable=False)
    episode_order = Column(Integer)
    log_type = Column(String(16), default="info")      # info / warning / error / done
    message = Column(Text)
    log_metadata = Column(JSON, default=dict)
    created_at = Column(DateTime, server_default=func.now())


# ---------------------------------------------------------------------------
# 安全报告独立化 (扩展 ScriptAnalysis 不够; 单独建表)
# ---------------------------------------------------------------------------

class SafetyReport(Base):
    """安全审核报告 (PLAN §5.5 safety_reports + 7 字段)。

    现有 SafetyPanel 是临时调用 scanner.py + ai_review.py 不入库。
    本表用于持久化每次审核结果, 并用于 KPI 中的 unresolved_count。
    """

    __tablename__ = "safety_reports"
    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), index=True, nullable=False)
    scope = Column(String(16), default="full")         # full / chapter:N / storyboard:N
    overall = Column(String(16), default="pass")       # pass / warning / fail
    summary = Column(Text, default="")
    total_issues = Column(Integer, default=0)
    high_count = Column(Integer, default=0)
    medium_count = Column(Integer, default=0)
    low_count = Column(Integer, default=0)
    unresolved_count = Column(Integer, default=0)      # 用户尚未确认/修复的数量
    scores_json = Column(JSONB)                        # 6 维度评分 (PLAN §5.5)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class SafetyRisk(Base):
    """单条安全风险记录 (PLAN §5.5 safety_risks + 4 字段)。"""

    __tablename__ = "safety_risks"
    id = Column(Integer, primary_key=True)
    report_id = Column(Integer, ForeignKey("safety_reports.id", ondelete="CASCADE"), index=True, nullable=False)
    category = Column(String(32))                      # violence / sex / politics / drug / discrimination / etc.
    severity = Column(String(8), default="medium")
    keyword = Column(String(64))
    snippet = Column(Text, default="")
    chapter_order = Column(Integer)
    position = Column(Integer)
    reason = Column(Text, default="")
    suggestion = Column(Text, default="")
    is_resolved = Column(Boolean, default=False)       # 用户标记为已处理
    resolved_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())


class AgentDocument(Base):
    """用户上传给对话工坊的**长文档**（小说原文 / 剧本全文）。

    2026-10-10 新增。在此之前，上传文件被前端整篇拼进 user message，
    随对话历史一起进上下文 —— 实测那份 40 万字的原文：

      · 占满 10 轮历史窗口，把后续轮次全挤出去；
      · 约第 33~35 轮被 prune_old_tool_outputs 剪成 200 字占位符
        （"原 375,639 字符，开头为…"），模型读不到了；
      · 第 38 轮彻底滑出窗口，而用户以为它还在 —— 于是 AI 开始自己编。

    落盘后它**不再进入对话历史**，改为每轮按需检索注入。消息里只留一行引用，
    体积问题与剪枝问题同时消失。

    为什么存全文而不是只存切好的章节：切分规则会演进（见 stages/import_script
    .smart_split_chapters），留全文才能重切；只存结果则规则一改就得让用户重传。
    """
    __tablename__ = "agent_documents"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    conversation_id = Column(Integer, ForeignKey("agent_conversations.id", ondelete="CASCADE"),
                             index=True)
    #: 挂到哪个草稿。决定这份文档能不能被该草稿的对话检索到（越权要靠它拦）。
    draft_id = Column(Integer, index=True)
    filename = Column(String(256), default="")
    char_count = Column(Integer, default=0)
    full_text = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class AgentDocumentChapter(Base):
    """上传文档切出的章节索引（按章节切，用户上传的小说都有规范章节结构）。

    ``title`` 存原文标题（"第 1 章 追杀"），``char_count`` 用于给模型看目录时
    估算篇幅。正文仍从 ``agent_documents.full_text`` 按 start/end 取，
    **不在这里再存一份**：40 万字存两遍没有必要，且两份会不同步。
    """
    __tablename__ = "agent_document_chapters"
    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey("agent_documents.id", ondelete="CASCADE"),
                         index=True, nullable=False)
    order = Column(Integer, nullable=False)          # 1..N
    title = Column(String(256), default="")
    start_offset = Column(Integer, nullable=False)   # full_text 里的字符起点
    end_offset = Column(Integer, nullable=False)
    char_count = Column(Integer, default=0)


class AgentImage(Base):
    """用户在对话工坊里发给 AI 的**图片**（截图 / 参考图 / 草图）。

    2026-10-28 新增。此前对话工坊只能传 .txt/.md/.docx/.pdf 文本文件，
    用户要"给 AI 看这张图"只能自己描述，而他们描述不清。

    ## 为什么存文件而不是 base64 进库
    图片按 3MB 上限压在磁盘上（`/app/uploads/chat-images/`），库里只留元数据。
    塞进 `agent_messages.content` 会让每条消息变成几百 KB 的字符串，
    历史加载、列表接口、SSE 全部被拖慢；而且同一条消息会被重复读取很多次。

    ## 为什么不进对话历史
    与 `AgentDocument` 同一个理由：图片一旦随历史进入上下文，**每一轮都要重新
    上传一遍给模型**（多模态消息是按轮次发的，不像文本可以只在首轮给）。
    所以只在「发送这一轮的当下」按 `message_id` 取出来喂一次，之后的历史轮次
    只保留一行文字引用（`[图片: xxx.png]`），模型靠对话文字回忆。

    这样做的代价是"第 20 轮再问那张图"，模型看不到原图 —— 但换来的是
    每轮上下文体积可控。用户真要再看，重新发一次即可，比每轮都背着几十张图便宜得多。
    """
    __tablename__ = "agent_images"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    conversation_id = Column(Integer, ForeignKey("agent_conversations.id", ondelete="CASCADE"),
                             index=True)
    #: 挂在哪条用户消息上。NULL = 已上传但还没随消息发出去（前端预览阶段）。
    message_id = Column(Integer, ForeignKey("agent_messages.id", ondelete="SET NULL"), index=True)
    filename = Column(String(256), default="")
    #: 磁盘上的文件名（uuid.jpg）。不直接用原文件名：同名覆盖、路径穿越、
    #: 以及"用户上传了带隐私的文件名"三个问题一次解决。
    stored_name = Column(String(128), nullable=False)
    mime = Column(String(64), default="image/jpeg")
    byte_size = Column(Integer, default=0)
    width = Column(Integer, default=0)
    height = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())


class DesktopReminder(Base):
    """桌面端用户要求的「任务结束时飞书提醒我」。发给创建它的人，不能指定别人。"""

    __tablename__ = "desktop_reminders"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    job_id = Column(Integer, nullable=False)
    job_kind = Column(String(24), nullable=False)
    text = Column(String(500), nullable=False)
    status = Column(String(12), nullable=False, default="pending", index=True)  # pending/sent/failed
    attempts = Column(Integer, nullable=False, default=0)
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    sent_at = Column(DateTime)


class ApiKey(Base):
    """给外部 Agent 用的长期密钥（2026-11-04）。只认 /v1/mcp，不能当登录令牌用在网页接口上。

    明文只在创建时返回一次；库里只存 SHA-256。``revoked_at`` 非空即作废，不删行（留审计）。
    """

    __tablename__ = "api_keys"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    name = Column(String(80), nullable=False)
    #: 明文前 12 位（含 ``jlk_``），列表里给人认是哪一把。
    prefix = Column(String(16), nullable=False)
    key_hash = Column(String(64), nullable=False, unique=True)
    created_at = Column(DateTime, server_default=func.now())
    last_used_at = Column(DateTime)
    revoked_at = Column(DateTime)
