"""novel_video 数据模型 — 小说转视频流水线。

3 张表:
- novel_video_jobs         一个小说任务(全文/画风/垫图/音色/成片规格/状态)
- novel_video_shots        分镜/分段(每段一张图: 原文段 + 图片提示词 + 生成图)
- novel_video_audio_chunks 音频分片(按"。"聚合的一批文本 → 一段配音, 防超长)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base

RETENTION_DAYS = 30


def _default_expires_at() -> datetime:
    return datetime.utcnow() + timedelta(days=RETENTION_DAYS)


class NovelVideoJob(Base):
    """一个小说转视频任务。

    status: pending | prompting | imaging | audio | compositing | succeeded | failed | canceled
    """
    __tablename__ = "novel_video_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    title = Column(Text, nullable=False, default="未命名小说")
    novel_text = Column(Text, nullable=False)          # 小说全文(也是全部配音文案)
    style_prompt = Column(Text, default="")            # 全局画风预置提示词(拼到每条前)
    ref_image_oss_key = Column(Text, nullable=True)    # 统一垫图(单张, 旧字段, 保留兼容)
    ref_image_oss_keys = Column(JSONB, nullable=True)  # 统一垫图(多张, JSON数组; 优先于单张字段)
    voice_ref_oss_key = Column(Text, nullable=True)    # 参考音色
    overlays = Column(JSONB, nullable=True)            # 画面水印配置: {"disclaimer":{"on":bool,"text":str}, "corner":{"on":bool,"text":str}} corner的{min}会替换成时长分钟
    # 成片规格
    width = Column(Integer, default=1080)
    height = Column(Integer, default=1920)
    fps = Column(Integer, default=30)
    per_image_seconds = Column(Integer, default=10)    # 每张图播放秒数(固定10s)
    image_model = Column(Text, default="gpt-image-2")  # image2

    auto_compose = Column(Integer, default=0)          # 1=全自动(生图完不暂停, 直接合成); 0=生图后停在await_confirm等确认
    bgm_category = Column(Text, nullable=True)         # BGM 类型: 古风 | 现代 | None(无)
    bgm_oss_key = Column(Text, nullable=True)          # 轮转选中的具体 BGM(创建时确定, 合成时混音)
    status = Column(Text, default="pending", nullable=False)
    progress = Column(Integer, default=0)
    error = Column(Text, nullable=True)
    image_count = Column(Integer, default=0)           # 实际图片张数
    audio_duration = Column(Integer, default=0)        # 整段配音秒数
    audio_oss_key = Column(Text, nullable=True)        # 拼接后的整段配音
    video_oss_key = Column(Text, nullable=True)        # 成片

    # 封面(视频第一帧): AI 读全文生成 标题/标签/封面图提示词, image2 生封面图, 合成时烧字放在最前一帧
    cover_enabled = Column(Integer, default=0)         # 1=生成封面
    cover_title = Column(Text, nullable=True)          # AI 生成的标题(3~5字)
    cover_tags = Column(Text, nullable=True)           # AI 生成的标签(不含"完结", 如"大女主/系统")
    cover_prompt = Column(Text, nullable=True)         # AI 生成的封面图提示词(强制无文字)
    cover_oss_key = Column(Text, nullable=True)        # 生成的封面图
    cover_overlays = Column(JSONB, nullable=True)      # 封面文字布局: {"items":[{text可含{title}/{tags}, xPct,yPct,fontPct,vertical,font,color,stroke}]}

    # 主角性别(AI 分析全文得出): 'male' | 'female' | None(未分析/无法判断)。用于"自动"音色模式选对应性别音色池。
    protagonist_gender = Column(Text, nullable=True)

    # 弹性算力 worker 待办动作: 主站不再本地跑重活(ffmpeg合成/生图), 而是置 status='pending' + pending_action,
    # 由算力机常驻 worker 认领后按此分派。取值: 'run'(全流程) | 'compose'(仅合成) | 'regen_cover'(重生成封面) | 'regen_shot'(重生成单图) | None。
    # action_params: 该动作的参数(如 regen_shot 的 shot_id/new_prompt), JSONB。
    pending_action = Column(Text, nullable=True)
    action_params = Column(JSONB, nullable=True)

    # 飞书多维表格自动化来源(为空=普通任务; 有值=从飞书表某行创建, 完成后回写该行)
    source = Column(Text, nullable=True, index=True)   # "feishu" | None
    feishu_record_id = Column(Text, nullable=True, index=True)  # 来源行 record_id(回写用 + 去重)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    expires_at = Column(DateTime, default=_default_expires_at)


class NovelVideoShot(Base):
    """一个分段 = 一张图。"""
    __tablename__ = "novel_video_shots"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("novel_video_jobs.id", ondelete="CASCADE"), index=True, nullable=False)
    idx = Column(Integer, nullable=False)              # 顺序(从0)
    text_segment = Column(Text, default="")            # 该段小说原文
    image_prompt = Column(Text, default="")            # 优化后的图片提示词
    image_oss_key = Column(Text, nullable=True)        # 生成图
    status = Column(Text, default="pending")           # pending|prompting|imaging|done|failed
    error = Column(Text, nullable=True)
    regenerate_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class NovelVideoVoice(Base):
    """参考音色库(跨任务复用)。每个用户维护自己的音色, 上传时按文件名命名。
    与 BGM 不同: 不分类、不轮转, 新建任务时下拉选一个即可。
    """
    __tablename__ = "novel_video_voices"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)                   # 展示名(上传的原文件名)
    oss_key = Column(Text, nullable=False)                # 参考音色文件
    gender = Column(Text, nullable=True)                  # 'male' | 'female' | None(未分类)。用于按性别筛选音色池(男/女/自动模式)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class NovelVideoStylePreset(Base):
    """画风提示词预设(跨任务复用)。每个用户维护自己的一组命名预设,
    新建任务时从下拉选一个把 prompt 填入风格框(仍可临时改动, 不影响预设本身)。
    """
    __tablename__ = "novel_video_style_presets"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)                   # 预设名(用户自定义)
    prompt = Column(Text, nullable=False, default="")     # 画风提示词正文
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class NovelVideoCoverPreset(Base):
    """封面样式预设(跨任务/跨批次复用)。只存布局(位置/字号/颜色/描边/竖排 + 文本模板),
    不存 AI 生成的具体文案。文本模板里用占位符 {title}/{tags}, 合成时替换成该任务实际文案。
    """
    __tablename__ = "novel_video_cover_presets"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)                   # 预设名(用户自定义)
    layout = Column(JSONB, nullable=False)                # {"items":[{text,xPct,yPct,fontPct,vertical,font,color,stroke}]}
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class NovelVideoOverlayPreset(Base):
    """画面文字/字幕样式预设(跨任务/跨批次复用)。飞书自动化按 `飞书自动化{比例}` 命名匹配。
    存 items(画面固定文字条目) + subtitle(字幕样式)。
    """
    __tablename__ = "novel_video_overlay_presets"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)                   # 预设名(用户自定义, 如 飞书自动化9:16)
    # {"items":[{text,xPct,yPct,fontPct,vertical,font,color,stroke}], "subtitle":{fontPct,yPct,font,color,stroke}}
    layout = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FeishuBitableSync(Base):
    """飞书多维表格自动化配置(每个用户可存多张表的同步配置)。

    列字段映射 field_map: {"filename":"原 小说名","doc":"附件","title":"改写剧名","tags":"类型",
                          "video":"下载链接","style":"风格","ratio":"比例","seconds":"几秒一张图"}
    (制作表格约定: filename=原 小说名, doc=附件, title=改写剧名, tags=类型, video=下载链接;
     style/ratio/seconds 为行内可选控制列, 空则用下面的 default_* 兜底)

    default_*: 这套飞书任务的默认样式/参数, 行内对应列为空时使用。
    """
    __tablename__ = "feishu_bitable_syncs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False, default="飞书自动化")   # 配置名
    app_token = Column(Text, nullable=False)              # 多维表格 app_token
    table_id = Column(Text, nullable=False)               # table_id
    field_map = Column(JSONB, nullable=False)             # 列语义→飞书字段名
    # ↓ 这套飞书任务的默认样式/参数(行内对应列为空时兜底)
    default_ratio = Column(Text, nullable=True, default="4:3")          # 默认比例
    default_style_prompt = Column(Text, nullable=True, default="")      # 默认画风提示词
    default_per_image_seconds = Column(Integer, nullable=True, default=7)  # 默认几秒一张图
    overlay_layout = Column(JSONB, nullable=True)         # 画面文字+字幕样式 {items,subtitle}
    cover_enabled = Column(Integer, nullable=True, default=1)  # 是否生成封面
    cover_layout = Column(JSONB, nullable=True)           # 封面文字布局 {items}
    voice_oss_keys = Column(JSONB, nullable=True)         # 音色轮转池(oss_key 数组; voice_mode=custom 时用)
    # 音色模式: 'custom'(默认, 用 voice_oss_keys 轮转) | 'male'(男音池轮转) | 'female'(女音池轮转) | 'auto'(按AI主角性别选池)
    voice_mode = Column(Text, nullable=True)
    bgm_category = Column(Text, nullable=True)            # 轮转 BGM 分类: 古风|现代|None
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class NovelVideoBgm(Base):
    """BGM 素材库(跨任务复用)。category: 古风 | 现代。
    上传时已用 loudnorm 统一响度并转码为 mp3, oss_key 指向标准化后的文件。
    """
    __tablename__ = "novel_video_bgm"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    category = Column(Text, nullable=False, index=True)   # 古风 | 现代
    name = Column(Text, nullable=False)                   # 展示名(原文件名)
    oss_key = Column(Text, nullable=False)                # 标准化后的 mp3
    duration = Column(Integer, default=0)                 # 秒
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class NovelVideoAudioChunk(Base):
    """音频分片(防超长: 只在"。"处拆)。"""
    __tablename__ = "novel_video_audio_chunks"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("novel_video_jobs.id", ondelete="CASCADE"), index=True, nullable=False)
    idx = Column(Integer, nullable=False)
    text_chunk = Column(Text, default="")
    audio_oss_key = Column(Text, nullable=True)
    duration = Column(Integer, default=0)              # 秒
    status = Column(Text, default="pending")           # pending|running|done|failed
    error = Column(Text, nullable=True)
    rh_task_id = Column(Text, nullable=True)
    # 算力时长口径: started_at=远端任务创建成功, finished_at=轮询到终态。
    # 不能用 created_at 反推 —— chunk 在 _AUDIO_SEM 上排队的时间不是算力。
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class FeishuRowFailure(Base):
    """飞书行处理状态追踪(长期优化: 任务队列可追踪性)。

    覆盖 NovelVideoJob 之外的两类情形:
    1) job 创建*之前*就失败(如 docx 解析失败、AI 文案生成失败、音色库为空) —
       这类失败此前完全没有留痕(只在飞书表格写"生成失败", 系统内部查不到失败原因)。
    2) 记录 processing 中间态, 用于替代"发后不管"的 asyncio.create_task 模式:
       行处理开始时先落库 processing, 成功建出 job 后更新为 success(并记 job_id),
       异常/失败时更新为 failed 并记录原因。

    status: pending | processing | success | failed
    幂等: 以 (cfg_id, record_id) 唯一定位一行的最新处理状态, 每次处理该行时更新同一条记录
    (而不是每次都插入新行), 避免同一 record_id 反复处理后表越积越大。
    """
    __tablename__ = "feishu_row_failures"

    id = Column(Integer, primary_key=True)
    cfg_id = Column(Integer, index=True, nullable=False)      # 对应 FeishuBitableSync.id
    record_id = Column(Text, index=True, nullable=False)      # 飞书行 record_id
    user_id = Column(Integer, index=True, nullable=False)
    status = Column(Text, default="pending", nullable=False)  # pending|processing|success|failed
    reason = Column(Text, nullable=True)                      # 失败原因(简要, 面向排查)
    job_id = Column(Integer, nullable=True)                   # 成功时关联的 NovelVideoJob.id
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())