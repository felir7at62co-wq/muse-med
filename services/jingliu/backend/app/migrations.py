"""幂等 DB 迁移（IMPL 契约 C1）。

SQLite 无 alembic，用"检查列/表是否存在→缺则补"的幂等脚本，启动时自动执行，
可重复运行。新列同时也已声明在 db.py 模型上（create_all 只建新表不改旧表，
所以旧库靠本脚本补列）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re

from sqlalchemy import inspect, text

from .db import engine

logger = logging.getLogger(__name__)

# 表 -> [(列名, DDL 片段)]
_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # 短剧编导云端转写改用百炼 Paraformer（2026-11-05）：百炼自己的任务号
    "drama_asr_jobs": [("provider_task_id", "provider_task_id VARCHAR(64)")],
    # 飞书机器人（2026-10-31）：没选项目时说的那句话先存着，选好项目后接着办
    "feishu_bot_chats": [("pending_text", "pending_text TEXT"),
                         # 接剧本平台（2026-11-01）：一个聊天同一时刻只连一个平台
                         ("platform", "platform VARCHAR(12)"),
                         ("script_conversation_id", "script_conversation_id INTEGER"),
                         ("script_run_id", "script_run_id INTEGER")],
    # 从视频剥离出来的音频段（kind="shot"）要记住来源镜头：
    # 它同时是导出时"该静音哪个镜头的原音轨"的唯一依据，见 db.py AudioClip。
    "audio_clips": [
        ("source_shot_id", "source_shot_id VARCHAR(16)"),
        # 6.9 修剪窗口。与 shots 的同名两列同构，NULL = 整段使用。
        # 刻意**不**给 DEFAULT 0：0 和 NULL 在这里含义不同 ——
        # NULL 是"没剪过（播满 duration）"，0 是"从头开始剪了"，
        # 而 clip_dur_sec 为 0 更是"一帧都不播"。给了默认值，
        # 老数据会一夜之间全部变成"已修剪成 0 秒"，即全体静音。
        ("clip_in_sec", "clip_in_sec REAL"),
        ("clip_dur_sec", "clip_dur_sec REAL"),
        # 配乐音量与淡入淡出（2026-10-20，超级 Agent 的自动配乐要用）：
        #   volume NULL = 1.0（与改动前行为完全一致，老数据不用回填）
        #   fade_* NULL = 0（硬切，也是改动前的行为）
        # 为什么必须有这三列：BGM 必须能压低到台词之下（否则盖住人声），
        # 且段尾要淡出（硬切很突兀）。剪映导出侧的 AudioSegment 早就支持
        # volume 与 add_fade，缺的只是数据层存不住。
        ("volume", "volume REAL"),
        ("fade_in_sec", "fade_in_sec REAL"),
        ("fade_out_sec", "fade_out_sec REAL"),
    ],
    # 字幕的素材身份与时间口径（2026-11-21，Muse 逐字字幕），见 db.SubtitleClip。
    # 都不给默认值：NULL 就是「老数据，不知道按哪份素材做的」（状态 unverified）。
    "subtitle_clips": [
        ("source_shot_id", "source_shot_id VARCHAR(16)"),
        ("source_video_url", "source_video_url TEXT"),
        ("source_version", "source_version INTEGER"),
        ("source_sha256", "source_sha256 VARCHAR(64)"),
        ("time_base", "time_base VARCHAR(8)"),
        ("origin", "origin VARCHAR(8)"),
    ],
    # 做字幕时的台词摘要（2026-11-21），见 db.SubtitleSource.lines_sha256
    "subtitle_sources": [("lines_sha256", "lines_sha256 VARCHAR(64)")],
    "jobs": [
        ("created_at", "created_at VARCHAR(32)"),
        ("updated_at", "updated_at VARCHAR(32)"),
        # B30：从 payload JSON 冗余出来的索引列，见 db.py Job.project_id
        ("project_id", "project_id VARCHAR(16)"),
        # 提交者（2026-10-13）：用量与预算归属。旧行 NULL，不回填（推不出来）。
        ("user_id", "user_id INTEGER"),
    ],
    # 超级 Agent 的三张表由 create_all 建出；这里只负责给**已有库**补新列
    # （create_all 只建新表、不改旧表）。
    "agent_runs": [
        # 结构化范围 / 阶段上限 / 自主程度（2026-10-21，§11 四段选择器）。
        # 老行 scope 为 NULL 时读取侧按 {"kind": "project"} 兜底 —— 那正是
        # 改动前的语义（不限制），所以无需回填，也不能给 NOT NULL 默认值
        # 之外的约束。
        ("scope", "scope TEXT"),
        ("until", "until VARCHAR(24)"),
        ("autonomy", "autonomy VARCHAR(16)"),
    ],
    "projects": [
        ("episodes", "episodes TEXT"),                       # JSON: [{order,title,word_count}]
        ("production_mode", "production_mode VARCHAR(16)"),  # drama | narration
        # 解说剧的解说音色（整片共用，不挂角色）
        ("narration_voice_url", "narration_voice_url TEXT"),
        # 全片影调档案（Look）：色温/反差/饱和/黑位/颗粒/镜头质感，见 look_profile
        ("look_json", "look_json TEXT"),
        # 画风预设 key（urban/period/anime_3d/thick_paint/guoman，见 style_preset）。
        # 与 production_mode 分工：模式管配音，画风管画面。NULL = 都市档（改动前行为）。
        ("art_style", "art_style VARCHAR(24)"),
        # 建项目时刻（ISO8601）。id 是随机 uuid，不含时间，不加这列就没法按时间排序。
        # 老库由 _backfill_project_created_at 从 jobs 回填。
        ("created_at", "created_at VARCHAR(32)"),
        # 回收站墓碑（ISO8601）。NULL = 在用。见 db.Project.deleted_at
        ("deleted_at", "deleted_at VARCHAR(32)"),
        # 归属用户（上游用户 id）。NULL = 无主，**默认只有管理员可见**。
        # 见 db.Project.owner_id 与 access.can_access_project。
        #
        # ⚠️ **刻意不回填**（用户 2026-10-09 裁定「存量全部划给管理员」）：
        # 这一列加出来之后，109 个存量项目的 owner_id 天然是 NULL，而 NULL 的
        # 语义正是"仅管理员可见"——裁定**已经由列语义本身实现了**，再写一段
        # 回填只是把 NULL 换成管理员的 user_id，效果完全相同却引入两个新问题：
        #   ① 迁移要猜一个 uid（dev 是 1，生产的未必），猜错就把 109 个项目
        #      送给一个不相干的人；NULL 则两个环境都对；
        #   ② 从此"无主"这个状态不复存在，管理员**无法**把某个项目交还给
        #      原作者时不慎交成归属某个具体人。
        # 真要交还，走 `access.transfer_owner()`（管理员端点），一个一个来。
        ("owner_id", "owner_id INTEGER"),
        # 追加剧本 / 分期（2026-11-03）：存分期偏移供前端换算"第二期第X集"等显示标签。
        # Shot.episode 本身仍是纯递增整数，造型区间/字幕锚点/导出顺序全不变。
        ("period_offsets", "period_offsets TEXT"),
    ],
    "shots": [
        ("fail_reason", "fail_reason TEXT"),
        ("fail_kind", "fail_kind VARCHAR(16)"),
        ("episode", "episode INTEGER DEFAULT 1"),
        ("status", "status VARCHAR(16) DEFAULT 'pending'"),
        # pending | prompting | generating | review | adopted | failed
        ("profile_override", "profile_override TEXT"),       # JSON 局部覆盖
        ("is_special", "is_special INTEGER DEFAULT 0"),
        ("adopted_version", "adopted_version INTEGER"),
        ("gen_prompt", "gen_prompt TEXT"),                   # 拆解后预生成的提示词
        ("stale", "stale INTEGER DEFAULT 0"),                # 所属集剧本已改→过期
        # P2-15 过期原因：rebreak(需重拆本集) | reprompt(需重出提示词) | regen(只需重出片)。
        # 老库回填 NULL——不猜原因，读的地方按最保守分支处理（见 app/stale.py）。
        ("stale_reason", "stale_reason TEXT"),
        ("duration_sec", "duration_sec REAL"),               # AI 拆镜判定的镜头时长
        ("disabled", "disabled INTEGER DEFAULT 0"),          # P0-3 停用（保留但不导出）
        ("special_name", "special_name VARCHAR(255)"),       # P0-3 外部素材镜头展示名
        ("thumb_url", "thumb_url TEXT"),                     # P1-1 当前采用版本首帧图
        ("ref_overrides", "ref_overrides TEXT"),             # P1-2 注入覆写 JSON（L3）
        ("refs_stale", "refs_stale INTEGER DEFAULT 0"),      # P1-2 参考图已变待重生成
        # 本镜在场/关键的道具名（JSON 数组）。老库存量一律 NULL——
        # 不猜、不回填：历史镜头没拆过道具，凭空推断会伪造出用户没确认的资产。
        ("props", "props TEXT"),
        # 首帧流水线（i2va）：本镜当前采用的首帧图（图生图产出，视频由它生长）
        ("first_frame_url", "first_frame_url TEXT"),
        # ⛔ 已停用（2026-09-11）：原「尾帧接力」的存储列，现只保留历史数据。
        # 不再写入，也不要基于它新建功能 —— 见 db.Shot.tail_frame_url 与
        # docs/DECISION-2026-09-11-尾帧接力停用.md。列保留是为了不让存量文件变孤儿。
        ("tail_frame_url", "tail_frame_url TEXT"),
        # gen_prompt 的来源：draft(拆解初稿) | aligned(已按资产对齐) |
        # sent(出片实际下发稿) | manual(用户手填)。NULL 视同 draft。
        ("prompt_state", "prompt_state VARCHAR(16)"),
        # TB-01 镜头分割：在 video_url 中的取片窗口（秒）。分割不重新转码，
        # 前后两段共用同一个 video_url，各自记住自己的窗口，导出时 -ss/-t 取片段。
        # NULL = 整段使用（未被分割过的镜头）。
        ("clip_in_sec", "clip_in_sec REAL"),
        ("clip_dur_sec", "clip_dur_sec REAL"),
        # 变速/音量/淡入淡出。导出时翻译成 ffmpeg filter 链。NULL = 不做任何处理。
        ("transform_meta", "transform_meta TEXT"),
        # Render V2 多视频轨：0 = 主轨（默认），1+ = Overlay 层，数字越大越靠上。
        # 叠加轨的镜头不参与主轨时间累加，用 overlay_start_sec 定位。
        ("track_index", "track_index INTEGER DEFAULT 0"),
        ("overlay_start_sec", "overlay_start_sec REAL"),
        # ---- 3.9 镜头连贯性 ----
        # 在场推导（L1.5）：同一场连续戏里，**上一镜出现过且没有离场描写**的角色
        # 视为仍在场。JSON 字符串数组，由 continuity.derive_present_characters 写入。
        #
        # 为什么不直接改 characters：那一列是**拆解真值**（L1），人工 add/remove
        # 靠它对消（见 routes_v2 的 patch_shot_refs）。把推导结果混进去，
        # 用户就再也分不清"AI 拆出来的"和"我们猜的"，也没法单独否决推导。
        # 最终注入 = ((L1 ∪ L1.5) ∪ 人工add) − 人工remove，见 db.effective_characters。
        ("present_characters", "present_characters TEXT"),
        # 走位台账：本镜**结束时刻**各在场角色的位置/姿态/朝向（JSON 对象）。
        # 下一个连续镜头把它作为"开场必须与之一致"的硬事实注入提示词 ——
        # 这是"人物位置在相邻镜之间跳变"的正解：位置必须是可传递的显式状态，
        # 光靠尾帧图（只是众多参考图之一）和一句"延续上一镜"是钳不住的。
        # 见 jobs._blocking_ctx / prompt_opt.extract_blocking。
        ("blocking_out", "blocking_out TEXT"),
    ],
    # shot_versions 建表走 _TABLES（IF NOT EXISTS），旧库新增列必须在此补，否则老库读不到
    "shot_versions": [
        ("thumb_url", "thumb_url TEXT"),                     # P1-1 该版本首帧图
    ],
    # 角色参考音色（资产卡上传音频；TTS 合成时作该角色音色）
    # profile_json：角色形象档案（结构化五官/骨相/气质，见 character_profile）
    "assets": [
        ("voice_url", "voice_url TEXT"),
        ("profile_json", "profile_json TEXT"),
        # 场景设定板拼版图（只给人看，永不注入镜头，见 db.Asset.board_url）
        ("board_url", "board_url TEXT"),
        # 用户手动删除的墓碑（ISO 时刻）。NULL = 在用。见 db.Asset.deleted_at：
        # 真删会被三处自动流程原地建回来，故用墓碑而非 DELETE。
        ("deleted_at", "deleted_at VARCHAR(32)"),
        # 火山私域虚拟人像库（角色通用定妆图，见 jobs._to_trusted_assets）。
        # 用户上传的角色图只落在这里、没有造型阶段，此前无处挂 asset_id，
        # 于是原图直送 Seedance、被真人检测拦（100009 项目 11/16 镜失败）。
        ("volc_asset_id", "volc_asset_id VARCHAR(64)"),
        ("volc_asset_status", "volc_asset_status VARCHAR(16)"),
        # 入库时的源图地址：换图后据此判定缓存作废，否则会继续引用旧脸
        ("volc_asset_src", "volc_asset_src TEXT"),
        # 共享可见性：public | private。NULL 一律按 public 处理，见 db.Asset.visibility。
        # ⚠️ 刻意**不回填**存量行为 'public'：一是 4276 行全刷一遍纯属浪费，
        # 二是 NULL 已经表示"没设过 = 公开"，回填只是把同一个意思写两遍。
        # 将来若要加第三档（如"仅本团队"），NULL 的语义仍成立。
        ("visibility", "visibility VARCHAR(16)"),
        # 当前采用哪一版（asset_image_versions.version_no）。见 db.Asset.adopted_version：
        # 此前前端靠 "版本行 URL == 资产 URL" 猜当前版，而同一 URL 可以有多行
        # （切回旧版会新增一行），于是同一张图有几行就同时打几个勾 —— 用户实测
        # 「勾了四个版本而且无法取消」。NULL = 补这一列之前的存量，读侧回退按 URL 比。
        ("adopted_version", "adopted_version INTEGER"),
        # 建立时刻（ISO8601）。此前 assets 没有这一列，`query(Asset)` 又不带
        # order_by，于是前端拿到的资产清单顺序**不稳定**——同一个项目两次
        # GET /detail 都可能不同序，"刚建的那个去哪了"无从回答。
        # ⚠️ 老库一律 NULL（**不回填**）：从 jobs/镜头号凑一个时刻出来是伪造
        # 事实；NULL 已诚实表示"早于这一版"，读侧把它排到最后即可。
        ("created_at", "created_at VARCHAR(32)"),
        # AI 生成的要素描述，与用户可编辑的整段终稿 `prompt` 分列。
        # 见 db.Asset.desc_auto：拆列之前两者共用 `prompt`，导致「场景描述写进
        # prompt 后，预览返回的就不再是完整提示词而是那 160 字描述」。
        # ⚠️ **不回填**：存量 `prompt` 两义并存，靠形状迁移只会把终稿误当描述。
        # 读侧用 `db.desc_of()` 做回退（它认得出两者）。
        ("desc_auto", "desc_auto TEXT"),
        # 角色人称档案（{"gender","age","brief"}），拆解末尾落库，
        # 提示词预览只读库、不再现场调 LLM。见 db.Asset.brief_json。
        ("brief_json", "brief_json TEXT"),
    ],
    # 服装继承（"同一场景下同一人物服装相同"）：
    #   location    该造型绑定的**归一场景名**（canonical，见 scene_aliases）
    #   scene_bound 1=场景决定型服装（睡衣@卧室/浴袍@浴室/泳装@泳池），可跨集沿用；
    #               0=事件型服装（婚纱@教堂/晚礼服@宴会厅），只在自己的镜号区间生效
    "asset_stages": [
        ("location", "location VARCHAR(255)"),
        ("scene_bound", "scene_bound INTEGER DEFAULT 0"),
        ("source_stage_id", "source_stage_id VARCHAR(16)"),
        # 火山私域虚拟人像库：入库后用 asset:// 引用，绕过 Seedance 人脸审核
        ("volc_asset_id", "volc_asset_id VARCHAR(64)"),
        ("volc_asset_status", "volc_asset_status VARCHAR(16)"),
        # 入库时的源图地址（同 assets.volc_asset_src）。老行为 NULL = 按旧行为信任缓存
        ("volc_asset_src", "volc_asset_src TEXT"),
        # 当前采用哪一版。语义与坑同 assets.adopted_version。
        ("adopted_version", "adopted_version INTEGER"),
        # 造型阶段的软删墓碑（老库全是 NULL = 在用），见 stage_gate.py
        ("deleted_at", "deleted_at VARCHAR(32)"),
    ],
    # 补审批冲抵额（2026-10-17，见 db.BudgetRequest.offset_fen）
    "budget_requests": [
        ("offset_fen", "offset_fen INTEGER"),
    ],
    # 用户名录的飞书统一身份（审批单发起人 → 镜流账号）。老行 NULL，下次登录补上。
    "known_users": [
        ("feishu_union_id", "feishu_union_id VARCHAR(64)"),
        # 飞书审批接口给的是租户 user_id，换算成 union_id 后把原值也记下来，下次不再换算
        ("feishu_user_id", "feishu_user_id VARCHAR(64)"),
    ],
    # 场景锚定图改按**归一场景**共享：同一个房间跨集必须是同一张基准帧
    "scene_anchors": [
        ("canonical", "canonical VARCHAR(255)"),
    ],
    # 场景多视角参考图（建表走 _TABLES；将来加列写这里，否则老库读不到）
    "scene_views": [
        ("qc_json", "qc_json TEXT"),
    ],
    # 资产图版本历史。⚠️ **它的建表语句在 _TABLES 里，但加列必须写在这里**：
    # `_TABLES` 走的是 CREATE TABLE IF NOT EXISTS，对**已经存在**的表是空操作
    # —— 老库（dev/prod 都已建表）永远拿不到新列，读侧一 SELECT 就 OperationalError。
    "asset_image_versions": [
        # 可编辑输入的快照（造型=着装描述；资产留空）。见 db.AssetImageVersion.desc_in：
        # 回退要还的是当初的**输入**，不是产物。此前拿 prompt（857 字复合稿）覆盖
        # 造型的 description，下次预览再套一层 → 每切一次翻一倍（实测 1.99×）。
        ("desc_in", "desc_in TEXT"),
    ],
}

_TABLES: dict[str, str] = {
    # 飞书登录票据持久化（2026-11-06）：替代进程内 _TICKETS 内存字典，
    # 后端重启后用户扫码仍能找到对应票据，不再报"超过 10 分钟"。
    "login_tickets": """
        CREATE TABLE IF NOT EXISTS login_tickets (
          ticket VARCHAR(64) PRIMARY KEY,
          created REAL NOT NULL,
          claim VARCHAR(64) NOT NULL,
          ip VARCHAR(64) NOT NULL DEFAULT '',
          result TEXT
        )
    """,
    # 资产图版本历史（角色/场景/造型共用）。镜头早有 shot_versions，资产一直没有，
    # 于是"重新生成"= 直接覆盖、旧图找不回来——而资产生图是花钱的。
    "asset_image_versions": """
        CREATE TABLE IF NOT EXISTS asset_image_versions (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          kind VARCHAR(16) NOT NULL,
          target_id VARCHAR(16) NOT NULL,
          version_no INTEGER NOT NULL,
          image_url TEXT,
          prompt TEXT,
          desc_in TEXT,
          model_id VARCHAR(64),
          source VARCHAR(16),
          label VARCHAR(255),
          created_at VARCHAR(32)
        )
    """,
    # 素材对象台账：本地盘降级为缓存后，"这个文件到底传上桶了没有"必须有据可查。
    #
    # 为什么不靠"HEAD 一下桶"临时判断：淘汰缓存前每个文件都要问一次桶，
    # 8000 多个文件就是 8000 次往返；而且 HEAD 失败（网络抖动）会被误判成
    # "没传上去"从而**不敢删**，或更糟——误判成"传上去了"然后删掉本地原件。
    #
    # width/height/duration_us 是给剪映导出用的：草稿构造原本靠 ffprobe 读本地
    # 文件，素材进桶后那条路断了。在**上传时**（文件还在本地）把元数据记下来，
    # 导出时直接读表，既不用把几十 GB 拉回来也不用改导出逻辑的形状。
    "media_objects": """
        CREATE TABLE IF NOT EXISTS media_objects (
          rel_path VARCHAR(512) PRIMARY KEY,
          obj_key VARCHAR(768) NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          etag VARCHAR(64),
          width INTEGER,
          height INTEGER,
          duration_us INTEGER,
          uploaded_at VARCHAR(32),
          last_used_at VARCHAR(32)
        )
    """,

    # 场景多视角参考图：一个场景资产 8 行（方位 4 + 景别 4），见 scene_view.VIEWS。
    # 单独建表而不是塞 asset_stages：那张表每一列都是"角色×造型×集区间"语义，
    # 场景视图一列都用不上，且按 character_name 过滤的既有查询会莫名捞到场景行。
    "scene_views": """
        CREATE TABLE IF NOT EXISTS scene_views (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          asset_id VARCHAR(16) NOT NULL,
          view_key VARCHAR(32) NOT NULL,
          kind VARCHAR(16) NOT NULL,
          label VARCHAR(64) NOT NULL,
          sort INTEGER DEFAULT 0,
          image_url TEXT,
          prompt TEXT,
          qc_json TEXT
        )""",
    "shot_versions": """
        CREATE TABLE IF NOT EXISTS shot_versions (
          id VARCHAR(16) PRIMARY KEY,
          shot_id VARCHAR(16) NOT NULL,
          version_no INTEGER NOT NULL,
          video_url TEXT,
          thumb_url TEXT,
          model_id VARCHAR(64),
          prompt TEXT,
          meta TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    "asset_stages": """
        CREATE TABLE IF NOT EXISTS asset_stages (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          character_name VARCHAR(255) NOT NULL,
          stage_name VARCHAR(255) NOT NULL,
          ep_from INTEGER NOT NULL,
          ep_to INTEGER NOT NULL,
          shot_from INTEGER,
          shot_to INTEGER,
          image_url TEXT,
          description TEXT,
          location VARCHAR(255),
          scene_bound INTEGER DEFAULT 0,
          source_stage_id VARCHAR(16),
          status VARCHAR(16) DEFAULT 'draft'
        )""",
    # P1-3 素材池落库（修 E4）：上传素材元数据入项目维度，刷新/换设备不丢
    "media_clips": """
        CREATE TABLE IF NOT EXISTS media_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          name VARCHAR(255) NOT NULL,
          url TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          kind VARCHAR(16) NOT NULL,
          duration REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # P2-4 音频轨（修 D5）：TTS 旁白/配乐段，锚定镜头 order+镜内偏移
    "audio_clips": """
        CREATE TABLE IF NOT EXISTS audio_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          kind VARCHAR(16) DEFAULT 'tts',
          text TEXT,
          url TEXT,
          duration REAL DEFAULT 0,
          start_shot_order INTEGER DEFAULT 1,
          start_offset_sec REAL DEFAULT 0,
          voice_ref_url TEXT,
          source_shot_id VARCHAR(16),
          status VARCHAR(16) DEFAULT 'pending',
          error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # Render V2 转场：锚在两个镜头的接缝上，而非绝对时间点
    "transitions": """
        CREATE TABLE IF NOT EXISTS transitions (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          type VARCHAR(32) DEFAULT 'fade',
          duration REAL DEFAULT 0.5,
          from_shot_id VARCHAR(16) NOT NULL,
          to_shot_id VARCHAR(16) NOT NULL,
          params TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # TB-02 字幕轨：文本/字幕段，时间定位与 audio_clips 同构（锚定镜头 + 镜内偏移）
    "subtitle_clips": """
        CREATE TABLE IF NOT EXISTS subtitle_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          text TEXT DEFAULT '',
          kind VARCHAR(16) DEFAULT 'subtitle',
          start_shot_order INTEGER DEFAULT 1,
          start_offset_sec REAL DEFAULT 0,
          duration REAL DEFAULT 3,
          style TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          source_shot_id VARCHAR(16),
          source_video_url TEXT,
          source_version INTEGER,
          source_sha256 VARCHAR(64),
          time_base VARCHAR(8),
          origin VARCHAR(8)
        )""",
    # 一镜的字幕最近一次按哪份素材做的（2026-11-21），见 db.SubtitleSource
    "subtitle_sources": """
        CREATE TABLE IF NOT EXISTS subtitle_sources (
          shot_id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          source_video_url TEXT,
          source_version INTEGER,
          source_sha256 VARCHAR(64),
          origin VARCHAR(8),
          cues INTEGER DEFAULT 0,
          review_pending INTEGER DEFAULT 0,
          job_id VARCHAR(16),
          updated_at VARCHAR(32),
          lines_sha256 VARCHAR(64)
        )""",
    # segments 任务删掉的老字幕的存档（2026-11-21），见 db.SubtitleClipArchive
    "subtitle_clip_archive": """
        CREATE TABLE IF NOT EXISTS subtitle_clip_archive (
          id VARCHAR(16) PRIMARY KEY,
          clip_id VARCHAR(16) NOT NULL,
          project_id VARCHAR(16) NOT NULL,
          text TEXT DEFAULT '',
          kind VARCHAR(16) DEFAULT 'subtitle',
          start_shot_order INTEGER DEFAULT 1,
          start_offset_sec REAL DEFAULT 0,
          duration REAL DEFAULT 3,
          style TEXT,
          created_at TEXT,
          source_shot_id VARCHAR(16),
          source_video_url TEXT,
          source_version INTEGER,
          source_sha256 VARCHAR(64),
          time_base VARCHAR(8),
          origin VARCHAR(8),
          job_id VARCHAR(16),
          archived_at VARCHAR(32),
          reason VARCHAR(16)
        )""",
    # 首帧流水线防偏移核心：每 (项目,集,场景) 一张"场景基准帧"。
    # 同场景所有镜头的首帧都以它为参考图 → 陈设/光线/机位基调统一，
    # 避免各镜各自生图导致同一场景在不同镜头间漂移。
    "scene_anchors": """
        CREATE TABLE IF NOT EXISTS scene_anchors (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          episode INTEGER NOT NULL DEFAULT 1,
          location VARCHAR(255) NOT NULL,
          canonical VARCHAR(255),
          image_url TEXT,
          prompt TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # 场景归一字典：Shot.location 原值 → 归一场景名。
    #
    # 为什么必须有这张表：拆解出来的 location 是**每集各写一遍**的自由文本，
    # 同一个物理空间在不同集里叫法不同（实测项目 36c691b20387 的 22 个场景名
    # **跨集复用率为 0**）：
    #   「金诚律所 密室会客室」ep2 / 「夜 内 沈修杰律所办公室」ep5
    #   「顾氏集团 总裁办走廊」ep3 / 「日 内 鼎盛集团 总裁办走廊」ep4
    # 于是"同一场景下同一人物服装相同"这条规则用字符串相等根本判不出来，
    # 场景锚定图也会让同一个房间在每集长成不同样子。
    #
    # source='manual' 的行由用户在资产页手改过，AI 重跑归一时**不覆盖**。
    "scene_aliases": """
        CREATE TABLE IF NOT EXISTS scene_aliases (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          raw_name VARCHAR(255) NOT NULL,
          canonical VARCHAR(255) NOT NULL,
          time_of_day VARCHAR(16),
          int_ext VARCHAR(8),
          source VARCHAR(16) DEFAULT 'ai'
        )""",
    # 角色归一字典（N2）：与 scene_aliases 同构。见 db.py CharacterAlias 的说明——
    # 「陆明」与「少年陆明」是同一人（该合并），但「陆明父亲」不是（合了就是数据损坏），
    # 所以判定走 LLM 语义而非字面子串。
    "character_aliases": """
        CREATE TABLE IF NOT EXISTS character_aliases (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          raw_name VARCHAR(255) NOT NULL,
          canonical VARCHAR(255) NOT NULL,
          age_stage VARCHAR(16),
          source VARCHAR(16) DEFAULT 'ai'
        )""",
    # 上游用量流水（P0 计价基建，2026-10-13）。见 db.py UsageEvent。
    "usage_events": """
        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts VARCHAR(32) NOT NULL,
          category VARCHAR(16) NOT NULL,
          model_id VARCHAR(64),
          channel VARCHAR(32),
          job_id VARCHAR(16),
          job_kind VARCHAR(32),
          project_id VARCHAR(16),
          user_id INTEGER,
          ok INTEGER DEFAULT 1,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          gen_seconds REAL,
          media_seconds REAL,
          units INTEGER,
          resolution VARCHAR(16),
          vendor_money VARCHAR(32),
          cost_fen INTEGER DEFAULT 0,
          meta TEXT
        )""",
    # 积分账户（P1）：四层组织用单一上级自引用表达。见 db.py UserBudget。
    "user_budget": """
        CREATE TABLE IF NOT EXISTS user_budget (
          user_id INTEGER PRIMARY KEY,
          name VARCHAR(64),
          org_role VARCHAR(16) DEFAULT '生成师',
          manager_id INTEGER,
          is_platform_admin INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          created_at VARCHAR(32),
          updated_at VARCHAR(32)
        )""",
    "org_nodes": """
        CREATE TABLE IF NOT EXISTS org_nodes (
          id VARCHAR(16) PRIMARY KEY,
          user_id INTEGER NOT NULL,
          name VARCHAR(64),
          members JSON,
          parent_id VARCHAR(16),
          created_at VARCHAR(32),
          updated_at VARCHAR(32)
        )""",
    "budget_pools": """
        CREATE TABLE IF NOT EXISTS budget_pools (
          pool_id VARCHAR(32) PRIMARY KEY,
          label VARCHAR(64),
          balance_fen INTEGER DEFAULT 0,
          created_at VARCHAR(32),
          updated_at VARCHAR(32)
        )""",
    "budget_ledger": """
        CREATE TABLE IF NOT EXISTS budget_ledger (
          id VARCHAR(16) PRIMARY KEY,
          ts VARCHAR(32) NOT NULL,
          pool_id VARCHAR(32) NOT NULL,
          user_id INTEGER,
          entry VARCHAR(16) NOT NULL,
          amount INTEGER DEFAULT 0,
          job_id VARCHAR(16),
          note VARCHAR(255)
        )""",
    # 项目协作者名册（多用户协作，2026-10-16）。所有者**不在**这张表里——
    # 他的身份只在 projects.owner_id，理由见 db.ProjectCollaborator 的注释。
    # 复合主键即唯一约束，重名重邀请不可能发生。
    "project_collaborators": """
        CREATE TABLE IF NOT EXISTS project_collaborators (
          project_id VARCHAR(16) NOT NULL,
          user_id INTEGER NOT NULL,
          role VARCHAR(16) NOT NULL,
          invited_by INTEGER,
          created_at VARCHAR(32),
          updated_at VARCHAR(32),
          PRIMARY KEY (project_id, user_id)
        )""",
    # 某人在某项目里的界面偏好（2026-10-23，提示词引用块开关）。
    # 为什么是 (项目, 用户) 而不是项目列：同一项目的协作者不该被我的观感偏好
    # 绑架。为什么不是 localStorage：换设备/清缓存就丢，「这个项目的设置」
    # 在另一台机器上不成立。详见 db.ProjectUserPref。
    #
    # ⚠️ 必须显式建：`Base.metadata.create_all` 只对**新库**有效，
    # dev/prod 都是已存在的库，不写在这里老库永远没有这张表，
    # 读侧一查就 OperationalError。
    "project_user_prefs": """
        CREATE TABLE IF NOT EXISTS project_user_prefs (
          project_id VARCHAR(16) NOT NULL,
          user_id INTEGER NOT NULL,
          prefs_json TEXT,
          updated_at VARCHAR(32),
          PRIMARY KEY (project_id, user_id)
        )""",
}

#: 额外索引（IF NOT EXISTS 幂等）。场景锚点按 (项目,集,场景) 唯一，
#: 用唯一索引在 DB 层兜底并发重复插入（应用层另有每场景锁）。
_INDEXES: list[str] = [
    # 缓存淘汰按最久未用排序，8000+ 行全表扫会让每轮巡检都卡一下
    "CREATE INDEX IF NOT EXISTS ix_media_objects_last_used "
    "ON media_objects (last_used_at)",
    # 按目标取版本列表是最常用的查询（进资产页就查一次）
    "CREATE INDEX IF NOT EXISTS ix_asset_version_target "
    "ON asset_image_versions (target_id, version_no)",
    # 协作者名册的**按人查**那一侧："我参与的项目"（visible_projects_query 的
    # EXISTS 走的是复合主键 (project_id, user_id) 的前缀，那是另一侧）。
    "CREATE INDEX IF NOT EXISTS ix_collab_user "
    "ON project_collaborators (user_id)",
    # projects.owner_id **此前没有索引**（2026-10-16 实测 sqlite_master 只有
    # sqlite_autoindex_projects_1 那条主键自增索引）。项目列表页每次加载都跑
    # `owner_id = ? OR EXISTS(...)`：没有外层这条索引就是全表扫，而 EXISTS 是
    # **逐行**相关子查询——行数一多会明显变慢。projects 的写入很少
    # （改名 / 改画风 / 改影调），索引的写代价可以忽略。
    "CREATE INDEX IF NOT EXISTS ix_projects_owner ON projects (owner_id)",

    # 剥离原声的反查：导出前要按 source_shot_id 判断哪些镜头该静音。
    # 必须显式建——模型上的 index=True 只在 create_all 建新表时生效，
    # 老库走的是 ALTER TABLE ADD COLUMN，不会带出索引。
    "CREATE INDEX IF NOT EXISTS ix_audio_clips_source_shot "
    "ON audio_clips (source_shot_id)",
    # 字幕按来源镜头找（2026-11-21）：Muse 逐字字幕按镜头替换、按镜头算新旧
    "CREATE INDEX IF NOT EXISTS ix_subtitle_clips_source_shot "
    "ON subtitle_clips (source_shot_id)",
    "CREATE INDEX IF NOT EXISTS ix_subtitle_sources_project_id "
    "ON subtitle_sources (project_id)",
    "CREATE INDEX IF NOT EXISTS ix_subtitle_clip_archive_project_id "
    "ON subtitle_clip_archive (project_id)",

    # ---- 巡检的瞬时态扫描（2026-10-24 审计）----
    #
    # `main.py` 的 5 分钟巡检 `maintenance.sweep_orphaned_states` 要查
    # `shots.status IN ('prompting','generating')` 和
    # `jobs.status IN ('pending','running')`。两条**都没有索引**，
    # 生产实测 EXPLAIN 是 `SCAN shots`（37,250 行 / 251.9 MB）与 `SCAN jobs`
    # （8,251 行），裸扫分别 34.5 ms / 3.4 ms —— 每 5 分钟一次，且**无条件跑**
    # （不管有没有孤儿）。代价不只是这点耗时：它把 2 MB 的页缓存冲成冷的
    # （`cache_size` 默认 -2000 即 2 MB），紧接着的所有读写都变慢。
    #
    # 这两列区分度低（都是少数几个取值），但 WHERE 只命中极少数瞬时态行，
    # 索引的选择性反而很高。写入侧的维护成本可忽略：
    # shots 几乎只在拆解/出片时写，jobs 只在任务流转时写。
    "CREATE INDEX IF NOT EXISTS ix_shots_status ON shots (status)",
    "CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs (status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_anchors_key "
    "ON scene_anchors (project_id, episode, location)",
    # 归一场景锚点：一个归一场景全剧只保一张基准帧（同一个房间跨集不再漂）。
    # canonical 为 NULL 的旧行不受约束（SQLite 唯一索引视多个 NULL 为互不相同）。
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_anchors_canon "
    "ON scene_anchors (project_id, canonical)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_aliases_raw "
    "ON scene_aliases (project_id, raw_name)",
    # 角色归一（N2）：同 scene_aliases，一个原始写法在一个项目里只有一条映射
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_character_aliases_raw "
    "ON character_aliases (project_id, raw_name)",
    # 服装继承的查询主路径：按 (项目,角色) 取候选阶段，再在应用层按特异性排序
    "CREATE INDEX IF NOT EXISTS ix_asset_stages_char "
    "ON asset_stages (project_id, character_name)",
    # 场景视图：注入时按 asset_id 取全部 8 行（scene_view.list_views 的唯一查询路径）
    "CREATE INDEX IF NOT EXISTS ix_scene_views_asset "
    "ON scene_views (asset_id, sort)",
    # 一个场景资产的一个视角只能有一行——重复行会让"补齐缺失视角"反复生成同一张
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_views_key "
    "ON scene_views (asset_id, view_key)",
    # B30 任务面板：按 (项目, 状态) 筛 job，避免全表载入后再逐行解析 payload
    "CREATE INDEX IF NOT EXISTS ix_jobs_project "
    "ON jobs (project_id, status)",
    # 用量报表的三个主查询维度：按项目 / 按人 / 按任务
    "CREATE INDEX IF NOT EXISTS ix_usage_project_ts ON usage_events (project_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_usage_user_ts ON usage_events (user_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_usage_job ON usage_events (job_id)",
    # 只按时间的查询（2026-11-05，统计页）：管理员的汇总不带 user/project 过滤，
    # 上面两条复合索引都用不上（前导列不匹配），EXPLAIN 是 `SCAN usage_events`。
    # 生产 30 万行时 0.28s 尚可，但这是**纯线性**的，且每次看板刷新都要跑一遍
    # —— 索引的选择性正合适：日期区间通常只命中最近 30 天。
    "CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_events (ts)",
    # 积分账户：按上级查下属（下拨时校验"是不是我的直系"最常用）
    "CREATE INDEX IF NOT EXISTS ix_user_budget_manager ON user_budget (manager_id)",
    # 流水按池查是最热的路径（账户页一进去就查一次）
    "CREATE INDEX IF NOT EXISTS ix_budget_ledger_pool ON budget_ledger (pool_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_budget_ledger_job ON budget_ledger (job_id)",
    "CREATE INDEX IF NOT EXISTS ix_org_nodes_parent ON org_nodes (parent_id)",
]


def _backfill_job_project_id(conn) -> int:
    """把历史 job 的 project_id 从 payload JSON 里回填出来（B30）。

    不回填的话，加了列也没用：老任务这一列全是 NULL，按项目筛就查不到它们，
    「AI 任务」面板的历史记录会**整片消失** —— 比不加这个列更糟。

    SQLite 3.38+ 才有 ->> 运算符，版本不定，所以在 Python 侧解析后逐条更新。
    只在存在 NULL 行时才跑，跑完即幂等（下次启动 0 行待回填）。
    """
    rows = conn.execute(text(
        "SELECT id, payload FROM jobs WHERE project_id IS NULL")).fetchall()
    if not rows:
        return 0
    done = 0
    for jid, payload in rows:
        try:
            data = json.loads(payload or "{}")
            pid = data.get("project_id") if isinstance(data, dict) else None
        except (ValueError, TypeError):
            pid = None
        if not pid:
            continue      # 无归属的 job（如 compose）保持 NULL，属正常
        conn.execute(text("UPDATE jobs SET project_id = :p WHERE id = :i"),
                     {"p": pid, "i": jid})
        done += 1
    return done


def _migrate_production_modes(conn) -> int:
    """2026-08：生产模式从「技术参数预设」改为「配音策略」。

    旧值 fast/consistent/premium/first_frame/custom 全部映射到 drama（真人剧）——
    它们描述的是画质/链路档位，与配音无关，而既有项目跑的都是"人物说人物的台词"，
    正是 drama 的语义。

    同时把旧预设隐含的技术参数**显式写进 default_profile**：
    改版后 resolver 优先读 default_profile，不写的话老项目会丢失
    模型/分辨率/生成方式设定，静默退回全局默认（换模型 = 换风格，用户看不出原因）。
    custom 项目本来就有 default_profile，不覆盖。
    """
    legacy = {
        "fast":        {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "720p"},
        "consistent":  {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "1080p"},
        "premium":     {"video_model": "seedance-2.0", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "1080p"},
        "first_frame": {"video_model": "seedance-2.0", "image_model": "nano-banana-pro",
                        "generation_mode": "i2va", "resolution": "1080p"},
    }
    rows = conn.execute(text(
        "SELECT id, production_mode, default_profile FROM projects "
        "WHERE production_mode IN ('fast','consistent','premium','first_frame','custom')"
    )).fetchall()
    done = 0
    for pid, mode, profile in rows:
        params = legacy.get(mode)
        # 老项目没写过 default_profile 才补；custom 的已有配置必须原样保留
        if params and not (profile or "").strip():
            conn.execute(
                text("UPDATE projects SET production_mode='drama', "
                     "default_profile=:p WHERE id=:i"),
                {"p": json.dumps(params, ensure_ascii=False), "i": pid})
        else:
            conn.execute(
                text("UPDATE projects SET production_mode='drama' WHERE id=:i"),
                {"i": pid})
        done += 1
    return done


def _backfill_project_created_at(conn) -> int:
    """给老项目回填 `projects.created_at`（项目列表按时间排序的前置）。

    为什么需要回填、而不是"新项目才有时间就行"：`created_at` 是 NULL 的项目
    在"按创建时间排序"里只能沉底，而现存项目**全部**是 NULL —— 排序功能
    上线当天就等于对老项目失效，用户看到的是"新建的一个在最上面，其余几十个
    仍是一团乱麻"。

    时间源取 `MIN(jobs.created_at)`：那是这个项目第一次跑任务的时刻，
    与真实建项目时间相差通常在分钟级，用于排序完全够。
    ⚠️ 只用 jobs 这一个源 —— 它是 `datetime.now(timezone.utc).isoformat()`
    格式，与新写入的值同构、可直接字典序比较。`shot_versions.created_at`
    走的是 SQLite `datetime('now')`（`YYYY-MM-DD HH:MM:SS`，无 T 无时区），
    混进来会排出一堆乱序，宁可不取。

    从没跑过任何任务的空项目回填不到，保持 NULL —— **不编造一个假时间**，
    排序时按"缺失值沉底"处理（见前端 projectSort）。
    """
    n = conn.execute(text(
        "UPDATE projects SET created_at = ("
        "  SELECT MIN(j.created_at) FROM jobs j"
        "  WHERE j.project_id = projects.id AND j.created_at IS NOT NULL)"
        " WHERE created_at IS NULL"
        "   AND EXISTS (SELECT 1 FROM jobs j2"
        "               WHERE j2.project_id = projects.id"
        "                 AND j2.created_at IS NOT NULL)"
    )).rowcount
    return int(n or 0)


#: sha256 十六进制摘要的形状。会话 token 原为 `token_urlsafe(32)`（43 字符、
#: 含 `-`/`_`），与它不可能混淆，所以"是不是已经哈希过"可以只看形状。
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _migrate_hash_session_tokens(conn) -> int:
    """把 `auth_sessions.token` 从明文原地改成 sha256（S3 的无争议项）。

    为什么原地改而不是清表：**客户端手里的明文 token 不变**，哈希一遍存回去，
    `verify_session` 下次查的就是同一个摘要 —— 所有人的登录态照旧。清表的话
    每个已登录用户都会在这次重启后被踢回登录页，而这个改动本身对用户无感，
    不该拿"全员重新扫码"当代价。

    幂等：已是 64 位小写十六进制的行跳过，所以重复启动只在第一次有动作。

    ⚠️ 若本迁移失败（放在 savepoint 里、只告警），后果是库里仍是明文而校验
    已按摘要查 → 全员会话失效、需重新登录。不会崩服务，但日志要看得见。
    """
    rows = conn.execute(text("SELECT token FROM auth_sessions")).fetchall()
    done = 0
    for (tok,) in rows:
        if not tok or _HEX64.match(tok):
            continue
        conn.execute(
            text("UPDATE auth_sessions SET token=:d WHERE token=:t"),
            {"d": hashlib.sha256(tok.encode("utf-8")).hexdigest(), "t": tok})
        done += 1
    return done


def _migrate_asset_stages_nullable_ep(conn) -> int:
    """`asset_stages.ep_from/ep_to` 允许 NULL（2026-11-04，造型「集数留空」）。

    为什么要重建表：SQLite **不支持** `ALTER COLUMN ... DROP NOT NULL`，
    想把一列的非空约束去掉，只有"建新表 → 拷数据 → 换名"这一条路。
    本次之前这两列是 `NOT NULL`，于是用户在界面上把集数留空保存时，
    INSERT 会撞 IntegrityError —— **功能在入口就建不出来**，而接口层看起来
    一切正常（Pydantic 已改为 Optional，校验也允许 None）。

    幂等：列已经可空就直接返回 0，重复启动无动作。

    拷贝用显式的列清单而不是 `SELECT *`：两张表的列顺序不一定一致，
    `INSERT ... SELECT *` 在列序不同时会**静默错位**（把 stage_name 写进
    ep_from），这是重建表最典型的翻车方式。
    """
    cols = conn.execute(text("PRAGMA table_info(asset_stages)")).fetchall()
    # PRAGMA 行：cid, name, type, notnull, dflt_value, pk
    by_name = {c[1]: c for c in cols}
    if not by_name:
        return 0                      # 表还不存在：create_all 会按新模型建
    ep = by_name.get("ep_from")
    if ep is None or not ep[3]:       # notnull == 0 → 已经可空
        return 0

    # 保留原表的全部列；只把 ep_from/ep_to 的非空去掉，其余定义照抄。
    names = [c[1] for c in cols]
    defs = []
    for cid, name, ctype, notnull, dflt, pk in cols:
        d = f'"{name}" {ctype or ""}'.strip()
        if pk:
            d += " PRIMARY KEY"
        if notnull and name not in ("ep_from", "ep_to"):
            d += " NOT NULL"
        if dflt is not None:
            d += f" DEFAULT {dflt}"
        defs.append(d)
    quoted = ", ".join(f'"{n}"' for n in names)

    # 先记下原表的索引 DDL —— 重建会连索引一起删掉。
    # 不能在这里硬编码索引名：dev 与 prod 的历史不同（dev 是
    # `ix_asset_stages_project`，prod 是 `ix_asset_stages_project_id`，
    # 因为 prod 当初按 db.py 的 index=True 建、dev 是迁移里手写的）。
    # 硬编码会在另一套环境里多建一个重复索引，且原来那个永远丢失。
    idx_ddl = [r[0] for r in conn.execute(text(
        "SELECT sql FROM sqlite_master WHERE type='index' "
        "AND tbl_name='asset_stages' AND sql IS NOT NULL")).fetchall()]

    conn.execute(text("DROP TABLE IF EXISTS asset_stages__new"))
    conn.execute(text(f"CREATE TABLE asset_stages__new ({', '.join(defs)})"))
    conn.execute(text(f"INSERT INTO asset_stages__new ({quoted}) "
                      f"SELECT {quoted} FROM asset_stages"))
    conn.execute(text("DROP TABLE asset_stages"))
    conn.execute(text("ALTER TABLE asset_stages__new RENAME TO asset_stages"))
    # 原样恢复原索引（DDL 里的表名不变，因为重建后表名相同）
    for ddl in idx_ddl:
        try:
            conn.execute(text(ddl))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[migrations] asset_stages 索引恢复失败(已跳过): %s | %s",
                           ddl[:80], exc)
    return 1


def run_migrations() -> list[str]:
    """执行迁移，返回本次实际应用的变更清单（空=无需变更）。"""
    applied: list[str] = []
    insp = inspect(engine)
    with engine.begin() as conn:
        # 必须在补列之前：本迁移会重建 asset_stages 整张表。
        if "asset_stages" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _migrate_asset_stages_nullable_ep(conn)
                if n:
                    applied.append("asset_stages.ep_from/ep_to→nullable")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] asset_stages 重建失败(已跳过): %s", exc)
        for table, cols in _COLUMNS.items():
            if table not in insp.get_table_names():
                continue  # 新库由 create_all 直接建全，无需补列
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols:
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
                    applied.append(f"{table}.{name}")
        for name, ddl in _TABLES.items():
            conn.execute(text(ddl))  # IF NOT EXISTS 自身幂等
            if name not in insp.get_table_names():
                applied.append(f"table:{name}")
        # 索引是**纯性能优化**，建不出来最多是慢，不该让服务起不来。
        # 原来任何一条 DDL 抛异常都会冒出 run_migrations() → lifespan，
        # 后端直接启动失败（配合 Restart=always 就是崩溃循环）。
        # 触发场景很现实：索引引用的列因上面某次 ALTER 失败而不存在、
        # 或历史数据违反唯一索引。
        # 与之相对，上面的 ALTER/CREATE TABLE 是结构性的，缺了会让运行时
        # 报更难懂的错，那些**应该**大声失败，故只放宽索引这一段。
        for ddl in _INDEXES:
            # 每条单独开 SAVEPOINT：失败只回滚这一条，不牵连外层事务里
            # 已经做完的 ALTER / CREATE TABLE。
            # （SQLite 上失败语句不会污染事务，但 PostgreSQL 会把整个事务
            #  标记为 aborted —— 用 savepoint 两种库都安全。）
            try:
                with conn.begin_nested():
                    conn.execute(text(ddl))  # IF NOT EXISTS 自身幂等
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] 索引创建失败(已跳过): %s | %s",
                               ddl.split("ON")[0].strip()[:80], exc)
        # 回填 jobs.project_id（B30）。与索引同理：失败只影响查询性能与历史
        # 可见性，不该让服务起不来，故也放在 savepoint 里、只告警。
        if "jobs" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _backfill_job_project_id(conn)
                if n:
                    applied.append(f"backfill:jobs.project_id×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] jobs.project_id 回填失败(已跳过): %s", exc)
        # 生产模式改版（drama/narration）。同样放 savepoint：
        # 失败不该挡住服务启动——resolver 对旧值有 _LEGACY_DEFAULTS 兜底。
        if "projects" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _migrate_production_modes(conn)
                if n:
                    applied.append(f"production_mode→drama×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] production_mode 迁移失败(已跳过): %s", exc)
            # 回填 projects.created_at。必须排在 jobs.project_id 回填**之后**——
            # 它正是靠 jobs.project_id 反查时间的，顺序反了老 job 那一列还是
            # NULL，回填会一条都匹配不上。同样放 savepoint：失败只是排序退化
            # 成"缺失值沉底"，不该挡住服务启动。
            if "jobs" in insp.get_table_names():
                try:
                    with conn.begin_nested():
                        n = _backfill_project_created_at(conn)
                    if n:
                        applied.append(f"backfill:projects.created_at×{n}")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[migrations] projects.created_at 回填失败(已跳过): %s", exc)
        # 会话 token 哈希化（S3）。同样 savepoint + 只告警：失败不该挡住服务
        # 启动，代价是全员需重新登录（见 `_migrate_hash_session_tokens`）。
        if "auth_sessions" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _migrate_hash_session_tokens(conn)
                if n:
                    applied.append(f"auth_sessions.token→sha256×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] 会话 token 哈希化失败(已跳过): %s", exc)
    return applied
