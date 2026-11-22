"""数据层：SQLite 持久化（dev MVP）。

选 SQLite 原因：零外部依赖、单文件、适合 MVP；SQLAlchemy 写法与 postgres 一致，
后续切 postgres 只需换 DATABASE_URL，模型/查询零改动。
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import JSON, Index, String, Text, create_engine, event, inspect
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


def iso_now() -> str:
    """当前 UTC 时刻（ISO8601，秒精度）。与 Job/Project.created_at 同格式。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _database_url() -> str:
    """库地址。**必须同时认 os.environ 与 .env**。

    ⚠️ 2026-09-24 踩到：这里原来只读 `os.environ`。systemd 单元用
    `EnvironmentFile=…/backend/.env` 注入，所以**服务进程是对的**；但任何
    从 shell 手动跑的脚本（迁移、对账、一次性修数据）拿不到那个变量，
    于是静默退回下面那个硬编码的 **dev** 路径——
    在 filmweaver-prod/backend 目录下跑脚本，读写的却是 dev 的库。

    发现过程：生产的素材迁移脚本报"已登记 8656 个"，而那是 dev 的数字；
    真按它跑下去，生产会有 292 个文件被误判成"已传过"而永远不上传。

    这与 `config.py` 里 `_ENV_FILE` 那条注释是同一类陷阱（"同一份代码在服务里
    正常、我手动跑就说没配密钥"），那边已经按模块位置定位 .env，这里补齐。

    优先级：显式环境变量 > 同目录 .env > dev 默认值。
    环境变量优先是为了保留"临时指到别的库跑一次"的能力。
    """
    v = os.environ.get("FW_DATABASE_URL")
    if v:
        return v
    env_file = Path(__file__).resolve().parent.parent / ".env"
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("FW_DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return "sqlite:////root/filmweaver-dev/backend/filmweaver_dev.db"


DATABASE_URL = _database_url()

_IS_SQLITE = DATABASE_URL.startswith("sqlite")

# 连接池：图像侧取消并发上限后，写入频率大幅上升，而 FastAPI 的 33 个同步路由
# 跑在线程池里、与 job 的 async 写**真并发**。默认 pool_size=5 会成为新瓶颈。
# ⚠️ 这是连接池容量，不是"生成并发数"——不受并发铁律约束，也不影响任何生成并发。
_ENGINE_KW: dict = {"echo": False}
if _IS_SQLITE:
    _ENGINE_KW.update(
        pool_size=20, max_overflow=30, pool_pre_ping=True,
        # 取连接的超时（**不是**下面 connect_args 里的持锁超时，两者别混）：
        # 池被占满时 `get_session()` 在这里排队。不设 = SQLAlchemy 默认 30 秒，
        # 而排队发生在**事件循环上**（大量代码是 async 里直接 get_session），
        # 于是一旦池满，整个单进程 uvicorn 被安静地按住 30 秒，没有任何报错。
        #
        # 2026-10-24 实测（占满全部 50 个连接后调 get_session）：
        #   pool_timeout=30（原值）→ 30.00 秒后抛 TimeoutError，事件循环被按住同样时长
        # 这就是"CPU 不高但整站卡住"的直接机制之一。
        #
        # 收紧到 5 秒：池满仍然会失败，但失败得快、错得明白（503/500 带
        # QueuePool limit 字样），而不是让全站在无声中等 30 秒。
        # 池满本身的正解是把持连接的慢路径挪走（见 routers/shotflow.prompt_preview
        # 的 `_brief_with_deadline`），不是把超时调大。
        pool_timeout=5.0,
        # 持锁等待：高并发写下宁可多等也别抛 database is locked。
        # 这个是 **SQLite 的 busy_timeout**，与上面的 pool_timeout 无关。
        connect_args={"timeout": 30.0, "check_same_thread": False},
    )

engine = create_engine(DATABASE_URL, **_ENGINE_KW)


if _IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record) -> None:  # noqa: ANN001
        """每条新连接建立时设好并发相关 PRAGMA。

        journal_mode=WAL：默认的 delete 模式下，写事务持有 EXCLUSIVE 锁会把**整库**
          的读和写全部挡住；WAL 允许"多读 + 单写"并行，是高并发下最关键的一项。
          WAL 是持久属性（写进库文件头），设一次即长期生效，此处仍每连接执行以便
          换库/新建库时自动带上。
        synchronous=NORMAL：commit 不再每次 fsync（原 FULL 每次都 fsync，是写入
          延迟的大头）。代价：**掉电/内核崩溃可能丢最后几秒已提交的事务**
          （WAL 模式下不会损坏数据库，只是丢尾部）。dev 可接受；若将来上 prod
          需重新评估，或届时直接切 postgres（DATABASE_URL 一换即可，模型零改动）。
        busy_timeout=30000：与 connect_args timeout 对齐，双保险。
        journal_size_limit=64MB：**WAL 文件的高水位上限**（2026-10-24 补）。
          不设（默认 -1）时，WAL 一旦被推到多大就**永远那么大**——checkpoint
          只是把帧标记为可复用，文件本身不收缩。生产实测 207 MB 停留不动、
          mtime 每 3 秒推进而字节数不变，就是这个签名。
          代价不只是磁盘：每次读都要按页偏移穿越这段 WAL，尾部的页面缓存
          永远换不出去。
          实测（500 次 × 200KB 写，然后 PASSIVE checkpoint）：
            不设   → 峰值 100.2 MB，checkpoint 后仍是 100.2 MB
            64 MB  → 峰值 100.2 MB，checkpoint 后缩到 **64.0 MB**
          ⚠️ 它**不是**"限制 WAL 能长多大"（写得多照样先长上去），
          而是"缩回去时压到哪"——所以不会截断任何未 checkpoint 的帧，
          对正确性零影响。
        """
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.execute("PRAGMA journal_size_limit=67108864")
        cur.close()


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    #: **归属用户**：主平台（上游）的用户 id，与 `auth_sessions.user_id` 同源同类型。
    #:
    #: 为什么必须有这一列：2026-10-09 之前项目**完全没有归属**，任何登录用户
    #: 都能列出并打开所有人的项目（实测 dev 库 109 个项目全平台可见）。而库里
    #: 没有第二处记录过"谁建的项目"——jobs 没存创建者，auth_sessions 只管登录态
    #: 且过期即删。**归属只能从这里长出来**。
    #:
    #: ⚠️ **NULL 的语义是"无主"，不是"公开"**。老项目在本列出现之前就存在，
    #: 无从推断归属（见 `migrations._backfill_project_owner`），一律置 NULL。
    #: 访问判定把 NULL 当作"只有管理员可见"——这是**安全侧的默认**：
    #: 猜错时宁可少显示，也不会把别人的项目漏出去。**不要**把 NULL 当成"不限制"，
    #: 那正是这条漏洞的成因。
    owner_id: Mapped[int | None] = mapped_column(nullable=True)
    base_aspect: Mapped[str] = mapped_column(String(16), default="9:16")
    default_profile: Mapped[str | None] = mapped_column(String(64), nullable=True)
    schema_version: Mapped[str] = mapped_column(String(16), default="1.0.0")
    # 剧本文本（原始/优化后），MVP 直接挂在项目上
    raw_script: Mapped[str | None] = mapped_column(Text, nullable=True)
    optimized_script: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 分集（JSON: [{order,title,word_count}]）与生产模式（drama|narration）
    episodes: Mapped[str | None] = mapped_column(Text, nullable=True)
    production_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 解说剧的解说音色（参考音频 URL）。整片共用一个声音，
    #: 所以挂在项目上而不是角色上——解说员不是剧中人物。
    #: TTS 克隆只取前 15s（RunningHub IndexTTS 工作流的 AudioCrop 写死）。
    narration_voice_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 全片**影调档案**（Look）JSON，见 `look_profile`。
    #: 决定色温/反差/饱和/黑位/颗粒/镜头质感这套"洗印厂配方"，
    #: 拼进所有资产图与首帧提示词——它是"不同图色调不统一"的主要修法。
    #: ⚠️ 它**不**决定日/夜明暗（那是各场景各镜头的光线情境），理由见 look_profile 模块头。
    look_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **画风预设** key（`style_preset.STYLES` 的键：urban/period/anime_3d/…）。
    #: 与 `production_mode` 是两件事：模式决定台词怎么配音，画风决定画面长什么样，
    #: 一个模式可对应多档画风（见 `style_preset.MODES`）。
    #:
    #: None = 老项目/没选 → `style_preset.resolve()` 给都市档 = 改动前行为。
    #: ⚠️ 这里**允许存尚未启用的档**（如古风）：那是用户的意图记录，
    #: 等它放开就自动生效；"现在实际用哪档"一律由 `resolve()` 决定，不看这一列的脸色。
    art_style: Mapped[str | None] = mapped_column(String(24), nullable=True)
    #: **分期偏移**（JSON：`[{"period":2,"label":"第二期","start_episode":31}, ...]`）。
    #:
    #: 用途：用户追加剧本时（第二季、编剧还没写完的后续集），新上传的剧本集号
    #: 从 1 开始，而项目里已经有第 1–N 集了，直接导入会产生集号冲突（`episode=1`
    #: 已被第一期占用，会被 `breakdown_by_episode` 误判为"已拆，跳过"）。
    #:
    #: 解法：导入时把新集号统一加上偏移（`start_episode - 1`），让它们在数据库里
    #: 连续排下去；而"第二期第3集"这样的**显示标签**由前端按本列换算得出，
    #: 不影响 `Shot.episode` 的数值语义（造型区间、字幕锚点、导出顺序全按整数算）。
    #:
    #: None / 空数组 = 只有一期，前端按 episode 原值显示"第N集"。
    period_offsets: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 建项目时刻（ISO8601 UTC，与 Job.created_at 同格式，可直接字典序比较）。
    #:
    #: 为什么必须显式存一列：`id` 是 `uuid.uuid4().hex[:12]`，**纯随机、不含时间**。
    #: 项目列表页曾按 id 倒序排并注释"id 是 hex 时间戳前缀，字典序即时序"——
    #: 那句话是错的，实际排出来是随机顺序，而用户完全看不出来（一屏项目名，
    #: 谁也不知道"最新的"应该是哪个）。要按时间排就必须有真正的时间。
    #:
    #: 老项目由 migrations 从 `MIN(jobs.created_at)` 回填；从没跑过任何任务的
    #: 空项目留 None（不编造时间），排序时统一沉底。
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: **回收站墓碑**：用户删除这个项目的时刻（ISO8601）。None = 在用。
    #:
    #: 与 `Asset.deleted_at` / `AssetStage.deleted_at` 同款做法，但理由更硬：
    #: 项目是所有数据的根，一次硬删要连带十来张表 + 磁盘文件，**没有任何撤销余地**。
    #: 所以删除做成两段——先打墓碑进回收站（数据与文件全留，可一键恢复），
    #: 用户在回收站里再确认一次才真正清盘（见 `project_purge.purge`）。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class ProjectCollaborator(Base):
    """项目协作者名册：一个 (项目, 用户) → 一档角色。

    ## 所有者**不在这张表里**（2026-10-16 裁定，别改）

    所有者的身份只有一个来源：`projects.owner_id`。生效角色由两处**派生**：

        owner_id == 我  ?  "owner"  :  名册里的角色

    为什么不把所有者写成名册里的 manager 行：
      · 那会产生两个互相打架的事实（"名册说我是 manager，owner_id 说我是 owner"），
        与 `routers/library.py` 模块头拒绝 `Asset.owner_id` 是同一个理由；
      · 转交项目时还要原子地搬走旧所有者的行，漏了就会留下一行**仍然生效**的
        陈旧 manager —— 前任所有者转交后照样能进这个项目；
      · 每条写入路径都要额外维护"所有者那行必须存在、必须是 manager、不可删"。
    派生则永远一致，没有任何需要同步的状态。

    ⚠️ **别为了"对称"给所有者补一行**。补了之后 `access.project_role` 就变成
    双来源，上面三条全部成立。`role` 的上限是 `manager`，`owner` 永远不写进这里
    —— "管理者不能删除项目、不能转交"正是靠这条实现的。

    ## 复合主键本身就是唯一约束

    `(project_id, user_id)` 直接做主键：不可能出现重复行，不需要代理 id，
    也不需要额外的唯一索引。查询只有两种形状 —— "一个 (项目, 用户) 对"
    与"一个项目的全部行"，复合主键的索引前缀两者都能服务。
    """

    __tablename__ = "project_collaborators"

    project_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(primary_key=True)
    #: `viewer` | `editor` | `manager`。写侧白名单校验（见 access._ROSTER_ROLES）；
    #: **读侧不认识的值一律当"不是成员"**（fail closed），而不是当成某个默认档放行
    #: —— 库里出现拼错的 role 时，宁可少给权限，也不要意外授权。
    role: Mapped[str] = mapped_column(String(16))
    #: 谁邀请的。只作留痕，**不加外键**（与 `Job.user_id` 同款）：邀请人注销后
    #: 这一行不该跟着消失，否则协作者会莫名其妙失去项目。
    invited_by: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Shot(Base):
    """镜头：拆解结果落库，切页/重启不丢。"""

    __tablename__ = "shots"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    order: Mapped[int] = mapped_column()
    script_ref: Mapped[str] = mapped_column(Text)
    link_to_prev: Mapped[str] = mapped_column(String(16), default="continuous")
    characters: Mapped[str] = mapped_column(Text, default="[]")  # JSON 数组文本
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: 本镜在场/关键的道具名（JSON 字符串数组），与 `characters` 同款。
    #:
    #: 2026-10-08 新增。此前**整条链路都没有道具这个概念**：拆解提示词的输出契约
    #: 只有 characters / locations 两个去重数组，资产行也只按这两种 kind 建，
    #: 前端要素页的道具 tab / 一键补全的道具清单全是空壳（永远为空）。
    #: 用户反馈「拆分镜头时似乎没有识别和提取道具」即指此。
    #:
    #: ⚠️ 与 characters 的**语义差异**：characters 是"在场的人"（离场要剔除，
    #: 见 present_characters 的推导），道具没有"在场"这回事——一件道具出现在
    #: 镜头的画面里就算，不存在推导与传递。所以本列只由拆解写，不做兜底推导。
    #:
    #: ⚠️ 注入是**白名单制**（见 jobs._auto_inject_refs_detailed 的 props 段）：
    #: 本列有值 ≠ 一定会注入参考图。只有已出图的道具资产才会占位，且排在
    #: 角色与场景之后、名额不足时优先被牺牲。这是刻意的——参考图位是稀缺资源，
    #: 人物一致性远比道具一致性重要。
    props: Mapped[str | None] = mapped_column(Text, nullable=True)
    video_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # 当前采用版本的视频
    # ---- R0 状态机（契约 C1）----
    episode: Mapped[int] = mapped_column(default=1)  # 所属集
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # pending | prompting | generating | review | adopted | failed
    #: 最近一次生成失败的原因（人读的摘要）+ 分类。
    #: 此前失败原因只存在 job 的 error JSON 里，镜头本身只有 status="failed"——
    #: 用户在镜头列表/时间轴上看到一个红角标，却完全不知道为什么失败，
    #: 更分不清"重试有用"（渠道故障）还是"重试必然再失败"（内容审核拒绝）。
    fail_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: moderation=内容审核拒绝 | channel=渠道/网络故障 | other
    fail_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    profile_override: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON 局部覆盖
    is_special: Mapped[int] = mapped_column(default=0)
    adopted_version: Mapped[int | None] = mapped_column(nullable=True)
    gen_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)  # 拆解后预生成的提示词
    stale: Mapped[int] = mapped_column(default=0)  # 已过期，需重做；原因见 stale_reason
    #: 过期的**原因**，取值按"补救动作"命名：rebreak(需重拆本集) /
    #: reprompt(需按新拆解重出提示词) / regen(只需重出片)。NULL = 本列上线前的老数据，
    #: 一律按最保守的 rebreak 处理。语义与全部判定规则见 app/stale.py（单一真源）。
    stale_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_sec: Mapped[float | None] = mapped_column(nullable=True)  # AI 拆镜判定时长（可覆盖）
    # 时间轴归一（P0-3）：镜头轨是唯一真源，导出按 order 消费本表。
    disabled: Mapped[int] = mapped_column(default=0)  # 1=停用，保留镜头但不参与导出
    # 外部素材（片头/片尾/转场/实拍）作为 is_special=1 的镜头入轨，与 AI 镜头同轨同导出逻辑；
    # special_name 仅用于轨道/列表展示（AI 镜头展示 #order + script_ref）。
    special_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # P1-1 缩略图体系：轨道/列表只挂 <img thumb>，<video> 仅预览器用（837 镜同屏的性能前置）。
    # 值为当前采用版本的首帧图（/fw/media/generated/thumb_*.jpg），抽帧失败留 None，前端退回占位。
    thumb_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: ⛔ **已停用字段（2026-09-11）**，只存历史数据，不再写入、不再读取。
    #:
    #: 原用途是"尾帧接力"：本镜出片后抽最后一帧，给下一个
    #: `link_to_prev="continuous"` 的镜头当参考图之一。该设计经实测确认是**净负面**
    #: （挤掉一张定妆图、模型只当它风格参考、且必被 Seedance 人脸审核拦下），
    #: 完整证据与停用决策见 `docs/DECISION-2026-09-11-尾帧接力停用.md`。
    #:
    #: 保留列而不 DROP：存量 277 条指向 `generated/tail_*.jpg`，`media_refs` 仍按
    #: 引用列登记着它们，删列会让这些文件变成无主孤儿被清缓存悄悄删掉。
    #: **不要**基于这一列新建功能，也不要重新开启注入。
    tail_frame_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # P1-2 注入覆写（L3，PLAN §4.3）：人工在资产轨拖出来的增删，与 AI 判定（L1=characters）
    # 分离存储，可一键重置。JSON: {"add":[角色],"remove":[角色],"add_loc":[场景],"remove_loc":[场景]}；
    # None/空 = 完全跟随 L1。最终注入集合 = (characters ∪ add) − remove，见 effective_characters()。
    ref_overrides: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 3.9 在场推导（L1.5）：JSON 字符串数组。
    #:
    #: 同一场连续戏里，上一镜出现过、且此后没有任何离场描写的角色，视为**仍在场**。
    #: 存在的理由是实测的一类穿帮：验证片镜 1「林母压低身子凑近林语警告」，
    #: 镜 2-4 剧本里一个字的离场描写都没有，`characters` 却只剩陆沉与林语 ——
    #: 于是她的定妆图不注入、提示词不提她，画面里人就凭空没了。
    #:
    #: 与 `characters`（拆解真值 L1）分列存放：混进去用户就分不清哪些是 AI 拆的、
    #: 哪些是我们推的，也没法单独否决推导。人工 remove 仍然压得住它，
    #: 见 effective_characters()。
    present_characters: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 3.9 走位台账：本镜**结束时刻**各在场角色的位置状态（JSON 对象）
    #: `{"角色名": {"pos": "...", "posture": "...", "facing": "..."}}`。
    #:
    #: 下一个连续镜头把它当作"开场必须与之一致"的硬事实注入提示词。
    #: 这是"人物位置在相邻镜之间跳变"的正解 —— 位置必须是**可传递的显式状态**：
    #: 尾帧图只是众多参考图之一（权重被定妆图稀释），而 `_scene_run_ctx` 里
    #: 那句"座次延续上一镜结尾"没有任何事实支撑，优化器只能自己重新编一套走位。
    #: None = 没有台账（老数据 / 抽取失败），此时退回原来的通用约束，不阻断出片。
    blocking_out: Mapped[str | None] = mapped_column(Text, nullable=True)
    # P1-2：已出片镜头的注入集合被人工改动 → 置 1 提示「参考图已变，可重新生成」；
    # 重新生成成功后清 0。不自动重生成（避免烧钱）。
    refs_stale: Mapped[int] = mapped_column(default=0)
    # 首帧流水线（i2va）：本镜当前首帧图（/fw/media/generated/img_*.png）。
    # 视频由该帧生长而来；用户可先审首帧再出视频（首帧几毛/视频几块），
    # 也是排查场景偏移的抓手。None = 未走首帧路线或尚未生成。
    first_frame_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: gen_prompt 这一稿是怎么来的（镜头卡据此显示状态标识，避免用户误以为
    #: 卡片上那段文字就是最终下发稿）：
    #:   draft    拆解时预生成——那时资产还没生成，服装/人称都是凭剧本猜的
    #:   aligned  已按当前资产（参考图造型 + 人物档案）重新对齐过
    #:   sent     出片时实际下发给视频模型的最终稿（生成成功后写回）
    #:   manual   用户在高级设置里手填了 prompt，一切自动改写都让位于它
    #: None 视同 draft（老库历史数据）。
    prompt_state: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: TB-01 镜头分割：本行在 video_url 里的取片窗口（秒）。
    #: 分割不重新转码——那要几十秒到几分钟，塞进同步接口会把请求挂死。
    #: 前后两段共用同一个 video_url，各自记住自己的 [in, in+dur) 窗口，
    #: 导出（media.py 的 -ss/-t）与预览据此取片段。
    #: None = 整段使用（绝大多数镜头，未被分割过）。
    #:
    #: 3.1 起还有第二个来源：用户在时间轴上**拖左边缘修剪入点**。
    #: 于是窗口不再只由 split 产生，而是"这一镜要用素材的哪一段"的通用表达。
    #: ⚠️ 不变式 `duration_sec == clip_dur_sec`（窗口存在时）由三处共同维持：
    #: split_shot / unsplit_shot / patch_shot_timeline。破了它的后果是
    #: 「轨道上显示 2.4s、成片里却是 5s」——导出读窗口，布局读 duration_sec。
    #: ⚠️ 窗口是**绑在当前 video_url 上**的坐标；素材一换（重新生成 / 采纳其它
    #: 版本 / 手动出片）窗口就失去意义，必须清掉，见 reset_clip_window()。
    clip_in_sec: Mapped[float | None] = mapped_column(nullable=True)
    clip_dur_sec: Mapped[float | None] = mapped_column(nullable=True)
    #: TB-03 / TB-10 画面与音频调整（JSON，导出时翻译成 ffmpeg filter 链）：
    #:   {"scale":120,"rotate":0,"x":0,"y":0,"opacity":100,
    #:    "mirrorH":false,"mirrorV":false,
    #:    "speed":1.0,               # TB-10 变速（同时改视频 setpts 与音频 atempo）
    #:    "volume":100,"muted":false,"fadeIn":0,"fadeOut":0}
    #: None/缺键 = 该项不处理（绝大多数镜头不做调整，不该为此多跑一遍滤镜）。
    #: 存 JSON 而非拆十几个列：这些参数是整体套用的一组，拆列意味着加一个
    #: 属性就要迁移一次，而它们从来只被整体读写。
    transform_meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Render V2 多视频轨：0 = 主轨（默认，参与顺序时间累加）；
    #: 1+ = Overlay 叠加层，数字越大越靠上。叠加层不参与主轨时间累加，
    #: 位置由 overlay_start_sec 显式给出——否则"叠加"就变成"插队"了。
    track_index: Mapped[int] = mapped_column(default=0)
    #: 叠加层在成片时间轴上的起点（秒）。track_index=0 时忽略。
    overlay_start_sec: Mapped[float | None] = mapped_column(nullable=True)


def reset_clip_window(shot: "Shot") -> bool:
    """把镜头的取片窗口清回"整段使用"。**换素材时必须调用。**

    取片窗口 `[clip_in_sec, +clip_dur_sec)` 是**相对某一个具体 video_url 的
    时间坐标**。素材一换，这组坐标就指向了另一段内容：

        用户把一个 8s 镜头修剪成"第 2.4s 起的 3s"（in=2.4, dur=3），
        然后重新生成 → 新素材只有 2.6s → 导出时 `-ss 2.4 -t 3`
        取到的是一段空白/最后 0.2s。时间轴上却仍显示 3s。

    这是**静默损坏**：用户看不出哪里错了，直到成片里出现黑帧。
    所以宁可清掉（用户看得见"入点没了"、可以重新拖），也不留着错的。

    调用点（三处 video_url 的安装位置，缺一处就会漏）：
      · jobs.py            生成成功写回 video_url
      · routes_v2.py       adopt_shot_version（采纳历史版本）
      · routes_v2.py       dev 手动出片写回

    ⚠️ 只清窗口，**不动 duration_sec**：后端不知道新素材多长，
    duration_sec 至少还是用户期望的长度（也正是刚才下发的生成时长）。

    :returns: 是否真的清掉了东西（调用方据此决定要不要提示用户）
    """
    had = shot.clip_in_sec is not None or shot.clip_dur_sec is not None
    shot.clip_in_sec = None
    shot.clip_dur_sec = None
    return had


class ShotVersion(Base):
    """镜头版本历史：每次生成落一条，可回退/复现（seed 等参数在 meta）。"""

    __tablename__ = "shot_versions"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    shot_id: Mapped[str] = mapped_column(String(16), index=True)
    version_no: Mapped[int] = mapped_column()
    video_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumb_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # P1-1 该版本首帧图
    model_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)  # 优化后最终喂模型的稿
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)    # JSON: seed/分辨率/帧数
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AssetImageVersion(Base):
    """资产图版本历史（角色 / 场景 / 造型三种目标共用一张表）。

    ## 为什么镜头有版本而资产没有（2026-10-05 补上）

    `ShotVersion` 一直存在，但资产图与造型图**没有**对应记录：重新生成 = 直接
    覆盖 `AssetStage.image_url` / `Asset.image_url`，旧图立刻找不回来。
    而资产生图是要花钱的，用户点「重新生成」往往只是想换一张试试——
    试坏了就永久丢了，这是不可接受的。

    ## 三种目标共用一张表

    `kind` 区分：`character` / `location` / `prop` 落在 `Asset.image_url` 上，
    `stage` 落在 `AssetStage.image_url` 上。合成一张表而不是两张，是因为
    「取某个目标的版本列表」「回退到某版」这两件事的语义完全一样，
    分表只会让上层写两遍。

    ## 为什么存 label 快照

    `character_name` / `stage_name` 直接冗余进来：造型行被删（软删）之后
    它的版本历史仍然可读——用户至少还能看到"当时那张图长什么样"。
    从被删的行里 join 名字是一堆 LEFT JOIN 加判空，不值得。
    """

    __tablename__ = "asset_image_versions"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 三选一：stage / character / location / prop
    kind: Mapped[str] = mapped_column(String(16))
    #: 目标行 id：kind=stage → asset_stages.id；其余 → assets.id
    target_id: Mapped[str] = mapped_column(String(16), index=True)
    version_no: Mapped[int] = mapped_column()
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **实际喂给模型的那份稿**（资产：用户改过的整段；造型：自动拼出的复合稿）。
    #: 给人看的——悬浮在版本上时显示"这一版当时用的是哪份稿"。
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **可编辑输入的快照**（2026-10-15 修）。造型填 `asset_stages.description`
    #: （着装描述），资产留空（资产的 `Asset.prompt` 本身就是可编辑的整段稿，
    #: 与 `prompt` 同义）。
    #:
    #: 为什么必须与 `prompt` 分开：造型的 `prompt` 是 `character_prompt()` 拼出的
    #: **复合稿**（实测 857 字），而 `description` 是那份复合稿里的一句话输入
    #: （"黑色皮夹克"）。此前回退时把 `prompt` 整个写进 `description`，下一次预览
    #: 再拿它当输入套一层 —— 实测 857 → 1708 字（1.99×），每切一次翻一倍。
    #: 回退要还的是**输入**，不是当初的产物。
    desc_in: Mapped[str | None] = mapped_column(Text, nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 生成时的来源标记：ai=模型生成 / upload=用户上传 / adopt=回退自某一版
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 人类可读标签快照（角色名 · 造型名）
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AssetStage(Base):
    """人物资产阶段（R1 资产时间轴用，R0 仅建表）：集×镜头双层轴。"""

    __tablename__ = "asset_stages"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    character_name: Mapped[str] = mapped_column(String(255))
    stage_name: Mapped[str] = mapped_column(String(255))
    #: 集区间可选（2026-11-04）：两列**同时**为 None = 这套造型「仅供手动 @ 引用」，
    #: 不参与出片时的自动挑选（判据见 stage_coverage.covers / stage_pick.rank）。
    #: ⚠️ 旧库里这两列是 NOT NULL，去掉约束靠 migrations._migrate_asset_stages_nullable_ep
    #: 重建表完成（SQLite 不支持 ALTER COLUMN DROP NOT NULL）。只改这里不改迁移，
    #: 界面会照常允许留空、保存时撞 IntegrityError。
    ep_from: Mapped[int | None] = mapped_column(nullable=True)
    ep_to: Mapped[int | None] = mapped_column(nullable=True)
    shot_from: Mapped[int | None] = mapped_column(nullable=True)  # 可选集内精修
    shot_to: Mapped[int | None] = mapped_column(nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 该造型绑定的**归一场景名**（canonical，见 SceneAlias）。None = 不绑场景。
    #: 与 scene_bound 一起实现"剧本没写服装时，同一场景下同一人物服装相同"。
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: 1 = 场景决定型服装（睡衣@卧室 / 浴袍@浴室 / 泳装@泳池）：只要人物再次进入
    #:     这个归一场景、且剧本没另写衣着，就沿用本造型的**同一张图**，跨多少集都行。
    #: 0 = 事件型服装（婚纱@教堂 / 晚礼服@宴会厅）：只在自己的镜号区间内生效，
    #:     不因为"又到了这个场景"而重新穿上。
    #: 判定由 AI 给出，用户可在资产页改（改后 status 视为人工确认，不被重识别推翻）。
    scene_bound: Mapped[int] = mapped_column(default=0)
    #: 指针行：本阶段与 `source_stage_id` 指向的阶段是**同一件衣服**，共用它那张图。
    #:
    #: 为什么需要：同一件衣服可能在相隔很远的镜头段里各出现一次（婚纱在第 3 集
    #: 婚礼、第 9 集回忆），而 shot_from/shot_to 是**全局镜号**的单一闭区间，一行
    #: 表达不了两段。若各建一行各自出图，同一件婚纱就会长成两个样子——这正是要
    #: 消灭的不一致。所以后出现的那段建成指针行：不参与生图（readiness 会跳过），
    #: 注入时解析到源阶段的图。None = 本行自己就是源。
    source_stage_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | confirmed
    #: 火山私域虚拟人像库的资产 ID（入库后用 asset://<id> 引用，可绕过人脸审核）。
    #: 存在这里而不是单开一张表：当前只有定妆图需要入库，一对一映射最直接，
    #: 查询不用 join；将来若用户上传的参考图也要入库，再抽独立表不迟。
    volc_asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: Active=可用 | Processing=还在异步处理（下次可继续轮询）| Failed=审核不过（别重试）
    volc_asset_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 入库时用的源图地址。图被替换（重新生成/上传）后与 image_url 不一致，
    #: 缓存的 asset_id 即作废——否则会一直引用**旧脸**，且不报任何错。
    #: None = 该字段上线前入库的老缓存，按原行为继续信任。
    volc_asset_src: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **当前采用的是哪一版**（`asset_image_versions.version_no`）。NULL = 未知。
    #: 语义与坑同 `Asset.adopted_version`，见那边的长注释。
    adopted_version: Mapped[int | None] = mapped_column(nullable=True)
    #: 墓碑：用户删掉这个造型阶段的时刻（ISO8601）。None = 在用。
    #: 与 `Asset.deleted_at` 同款理由——真删没法撤销，而"服装识别"重跑时会按
    #: 剧本重新规划阶段，用户删掉的造型会以新行的形式回来。详见 `stage_gate.py`。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Asset(Base):
    """资产：角色定妆/场景参考图。

    voice_url：角色参考音色（用户上传音频/视频）；TTS 旁白合成时作为
    该角色的音色候选（语音克隆参考，取前 15s 人声）。

    profile_json：角色**形象档案**（结构化五官/骨相/气质），仅 kind='character' 用。
    见 `character_profile`：它是"这个人长什么样"的唯一事实来源，全剧一份，
    与逐造型变化的 `AssetStage.description`（服装/发型）分工明确。

    `prompt` / `desc_auto` 的分工（2026-10-20 拆开）见 `desc_auto` 的列注释；
    `brief_json` 是 `character_brief` 落库的缓存，见该列注释。
    """

    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # character | location | custom
    name: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **AI 生成的要素描述**（场景的空间陈设 / 道具的形制 / 角色的外貌特征）。
    #:
    #: 为什么必须与 `prompt` 分列（2026-10-20 拆）：此前两者共用一列，
    #: `prompt` 同时承担两个互斥的角色——
    #:   ① `asset_prompt.scene_prompt(description=...)` 的**输入**（一句空间描述）
    #:   ② 「提示词与生成」弹窗里**可编辑的整段终稿**（画风前缀+构图+…，600~900 字）
    #: 于是 `prompt_preview` 只能写成「有 `prompt` 就直接返回它」——一旦场景描述
    #: 写进这一列，预览返回的就成了那 160 字描述片段，画风/构图/空镜头要求/影调
    #: 全丢。反过来场景描述只能挂在别处，拆解后也就拿不到完整提示词。
    #:
    #: 拆开后的口径：
    #:   · `desc_auto` = 系统写的描述，是拼装**输入**，用户一般不碰；
    #:   · `prompt`    = 用户改过的整段终稿；非空才覆盖拼装结果。NULL = 没改过。
    #: 读描述一律走 `desc_of(asset)`（`prompt` 为空时回退 `desc_auto`，兼容存量）。
    desc_auto: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: `character_brief` 的结果落库（JSON：{"gender","age","brief"}），仅 character 用。
    #:
    #: 为什么落库（2026-10-20）：该模块的缓存是**进程内** `_CACHE`，
    #: 只认 (project, episode, 剧本指纹)。后果有两处：
    #:   ① 重启进程就清空，`prompt_preview` 打开角色的提示词窗口时**现场调 LLM**；
    #:   ② `_LOCK` 是模块级 `asyncio.Lock()`，全项目角色**串行**排队；
    #: 生产实测 nginx 504（300s 超时）29 次、客户端主动断开 18 次。
    #: 拆解末尾本来就调过一次（`_collect_briefs`），把它存下来，预览就只读一行库。
    brief_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 场景设定板（多视角/景别/材质/色彩拼版图）的 URL，仅 kind='location' 用。
    #: ⚠️ **只给人看，永不作为参考图注入镜头**——拼版图一进参考位，模型会把
    #: 格子线和中文标注一起抄进画面。注入用的是 `scene_views` 里的单幅图。
    board_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 火山私域虚拟人像库缓存（仅 kind='character'），语义同 AssetStage 的同名三列。
    #: 用户上传的角色图往往**只有这一张、没有造型阶段**，注入时回退到它；
    #: 没有这三列时它无处挂 asset_id，只能原图直送，被 Seedance 判真人拦下。
    volc_asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    volc_asset_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    volc_asset_src: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **墓碑**：用户手动删除这条资产的时刻（ISO 字符串）。None = 正常在用。
    #:
    #: 为什么不真删行（用户 2026-09-09 需求 4「删掉的资产不该再在后面的生成过程中
    #: 可见、被调用」）：真删完全达不到这个效果——有**三处**会把它原地建回来，
    #: 每一处都不知道"用户是故意删的"：
    #:   ① `routes_v2` 拆解完成后的资产增量合并（剧本里还有这个角色 → 补一行）
    #:   ② `scenes.ensure_location_asset`（镜头还挂着这个场景名 → 补一行）
    #:   ③ 资产 upsert（任何写入路径按 name 找不到就新建）
    #: 还有第四处更隐蔽的坑：`readiness.locations_no_image` 是从 `Shot.location`
    #: 算的、**根本不看资产表**，所以真删之后依然报"缺图"，用户点一次"补齐"
    #: 就又花钱把它画回来了。
    #:
    #: 墓碑让这四处都能认出"这是用户删掉的"，从而跳过。
    #: 语义边界（用户决策「只断资产链，不动剧本」）：镜头里该角色/场景照旧存在、
    #: 已生成的图与磁盘文件全部保留、可随时恢复；断掉的只是"当资产用"这条链。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: **共享可见性**：`public` | `private`。默认 `public`——用户 2026-10-09 裁定
    #: 「资产库全平台共享，用户可给自己的资产设为隐私或公开（默认公开）」。
    #:
    #: ⚠️ 与 `deleted_at` 是两回事，别互相当替代品：
    #:   · `deleted_at` = 我不再要它了（本项目的链断掉，别人也不要看见）；
    #:   · `visibility` = 我还要它，但**不想给别的用户看/用**。
    #: 私有资产在拥有者自己的项目里一切照旧（照常注入、照常生成），
    #: 只是不出现在别人的共享资产库里、也不能被别人导入。
    #:
    #: ⚠️ NULL 一律按 `public` 处理（见 `access.asset_is_public`）。这一列是
    #: 后加的，存量 4276 行全是 NULL；语义上它们本来就"人人可见"（共享库此前
    #: 不存在，这个开关一出现，用户看到的就是存量全公开）。若把 NULL 当私有，
    #: 用户会发现共享库**空的**，而没有任何一处做过"藏起来"的动作。
    #: 这与 `Project.owner_id` 的 NULL 处理**方向相反**，两边都是各自语境下
    #: 更安全的默认：资产是"默认给人看"的东西，项目不是。
    visibility: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: **当前采用的是哪一版**（`asset_image_versions.version_no`）。NULL = 未知。
    #:
    #: 为什么必须有一列指针（2026-10-15 修）：此前"当前是哪一版"是前端拿
    #: `版本行.image_url == 资产.image_url` **猜**出来的。而版本表允许同一个
    #: image_url 存在多行（切回旧版会新增一行、上传与回填也可能撞出同图的行），
    #: 于是同一张图有几行、界面就同时打几个勾——用户实测在一个造型上看到
    #: v4/v6/v8/v10 四个勾，点哪个都"取消不掉"（点它只会再加一行）。
    #: 打勾判据必须是"哪一版被采用了"，不是"哪几行的图恰好长得一样"。
    #:
    #: 镜头侧一直有这个字段（`Shot.adopted_version`），资产侧是漏了。
    #: 写入点**只有一处**：`asset_versions.record()` —— 它正是"图被写进这一行"
    #: 的唯一汇聚点；散在十几处各写一遍迟早漏（`desub_jobs` / `upscale_jobs`
    #: 就都补过一次镜头侧的同类漏写）。NULL 表示"补这一列之前的存量"，
    #: 读侧回退成按 URL 比对。
    adopted_version: Mapped[int | None] = mapped_column(nullable=True)
    #: 建立时刻（ISO8601，与 Project/Job.created_at 同格式，可直接字典序比较）。
    #:
    #: 为什么需要它：`/projects/{id}/detail` 以前**没有稳定顺序**——`query(Asset)`
    #: 不带 `order_by`，拿到的就是 SQLite 的返回顺序，换个库、加个索引、删几行
    #: 都会变。前端据此渲染资产清单时，用户看到的是一份**每次都可能不同**的
    #: 排序，"我刚建的那个要素去哪了"无从回答。
    #:
    #: ⚠️ 存量行是 NULL（迁移不回填，理由同 visibility）：拿别的时刻凑一个值
    #: 出来是**伪造事实**，而 NULL 诚实地表示"早于这一版"。读的地方一律把 NULL
    #: 排到最后，不猜（见 routes_v2 的 detail 与 routers/library.py 的排序）。
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


@event.listens_for(Asset, "before_insert")
def _asset_created_at(_mapper, _conn, target) -> None:  # noqa: ANN001
    """新建资产时补上建立时刻。

    ⚠️ 用 ORM 事件而不是逐个改调用点：`Asset(...)` 全库有 **10 处**创建
    （拆解增量合并 / ensure_location_asset / ensure_prop_asset /
    character_profile / 资产路由两处 / 库导入 / 镜头侧两处），漏掉任何一处
    都会造出一批 created_at 为 NULL 的"新资产"，而它们会被排序扔到最后——
    表现就是"刚建的要素排在最后面"，与不修这一列没有区别。
    挂在 flush 上，新老调用点一并覆盖，也不需要每个调用方记得传。

    ⚠️ 形参是 `(mapper, connection, target)`（SQLAlchemy 的固定顺序），
    写成 `(mapper, target, connection)` 会把 Connection 当 target 用，
    新建第一行资产就抛 `'Connection' object has no attribute 'created_at'`——
    即资产功能整个挂掉。

    已显式给了 created_at 的不覆盖（将来要按历史时刻回填时留口子）。"""
    if target.created_at is None:
        target.created_at = iso_now()


#: 装报错原文的列：存库前按 `app.redact.redact_text` 脱敏。
_REDACTED_TEXT_COLUMNS = ("error", "fail_reason", "provider_failure")
#: 装 JSON 的列：存库前按 `app.redact.redact_json_text` 脱敏（预签名地址保留）。
_REDACTED_JSON_COLUMNS = ("result", "meta")


@event.listens_for(Session, "before_flush")
def _redact_secrets_before_flush(session, _flush_context, _instances) -> None:  # noqa: ANN001
    """任何表的报错列、结果列在写库前去掉密钥。

    ⚠️ 挂在 flush 上而不是逐个写入点：报错由 jobs/镜头/配音/语音识别/Agent 等
    几十处写入，网页任务中心会原样展示；漏掉一处，供应商回显的密钥就进了库、
    进了浏览器。这里新老调用点一并覆盖。只处理本次新增或改过的列。"""
    from .redact import redact_json_text, redact_text
    for obj in (*session.new, *session.dirty):
        state = inspect(obj)
        columns = state.mapper.column_attrs
        for names, redact in ((_REDACTED_TEXT_COLUMNS, redact_text),
                              (_REDACTED_JSON_COLUMNS, redact_json_text)):
            for name in names:
                if name not in columns:
                    continue
                if not state.pending and not state.attrs[name].history.has_changes():
                    continue
                value = getattr(obj, name)
                if isinstance(value, str):
                    cleaned = redact(value)
                    if cleaned != value:
                        setattr(obj, name, cleaned)


class SceneView(Base):
    """场景资产的一张**单视角参考图**（多视角 4 + 景别 4 = 8 行 / 场景）。

    为什么不复用 `AssetStage`：那张表的主键语义是"角色 × 造型 × 集/镜区间"
    （`character_name` / `ep_from` / `scene_bound` / `source_stage_id`），
    场景视图一个都用不上，塞进去等于让每一列都名不副实、且 readiness/注入
    那些按 `character_name` 过滤的查询会莫名把场景行捞进来。

    视图的**定义**（有哪 8 个、各自什么机位句）在 `scene_view.VIEWS`，
    本表只存"这个场景的这个视角，图在哪"。label/sort 是定义的冗余副本，
    每次 `ensure_views` 按代码回写——标签由代码定，不由老数据定。
    """

    __tablename__ = "scene_views"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: → `assets.id`（kind='location'）
    asset_id: Mapped[str] = mapped_column(String(16), index=True)
    #: `scene_view.VIEWS` 里的 key（angle_n / frame_wide / …）
    view_key: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))     # angle | framing
    label: Mapped[str] = mapped_column(String(64))
    sort: Mapped[int] = mapped_column(default=0)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 生成这张图时实际下发的提示词（排查"为什么这张不对"的唯一依据）
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 视觉体检结论 JSON（见 asset_qc）：这张图里有没有人、有没有多余文字。
    qc_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class BlockingImage(Base):
    """站位图：一场戏里各角色站在哪、朝哪的**全景参考图**（2026-11-21）。

    由客户端 Agent 自己生成、自己决定什么时候做；本表只登记「这张图叫什么、属于哪个
    场景」。它用在哪几镜**不存在这里**：绑定就是把图地址写进镜头
    `profile_override.refs`（与用户手动加到镜头上的参考图同一条路），适用镜头由镜头
    反查。所以删镜头、整集重写之后不会留下指向不存在镜头的记录。读写只走
    `app/blocking_images.py`。

    为什么不是 `assets` 里的一种 kind：`Asset.name` 是角色 / 场景 / 道具与镜头之间的
    连接键，全库 80 处查询按它做注入、去重、合并、改名迁移、缺图统计。站位图一样都
    不参与，放进去就得逐处排除，漏一处就是「站位图被当成场景图注入」这类静默错误。

    与 `blocking.py`（文字版开场站位，2026-11-19 起无调用方）无关。
    """

    __tablename__ = "blocking_images"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 项目内唯一，且不与在用的角色 / 场景 / 道具同名：提示词里用 `@名字` 引用它，
    #: 同名时编号会落到别的图上。
    name: Mapped[str] = mapped_column(String(255))
    image_url: Mapped[str] = mapped_column(Text)
    #: 生成这张图用的提示词或说明，只给人和 Agent 看，出片不读。
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 所属场景的**名字**（不是资产 id）：场景资产被删除、合并后，这里不会变成
    #: 指向不存在行的 id；场景改名时由 `asset_rename` 一起改。
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class SceneAnchor(Base):
    """场景锚定图：首帧流水线的防偏移核心。

    每个**归一场景**（canonical）一张"场景基准帧"，由该场景首个镜头生成后落库；
    同场景后续镜头把它当作额外参考图去生成各自首帧，从而共享同一套陈设/光线/
    机位基调——这是"同场景多镜头各自生图会漂"的解法。

    ⚠️ 曾按 (project_id, episode, location) 建键，于是同一个房间在第 1 集和第 10 集
    各有一张互不相干的基准帧，跨集必漂（拆解出的 location 每集写法还不一样，
    见 SceneAlias 的注释）。现在按 canonical 共享，episode/location 只留作
    首次建立锚点时的来源记录与旧库兼容。

    唯一性由 migrations._INDEXES 的唯一索引 + jobs 层每场景锁双重保证。
    """

    __tablename__ = "scene_anchors"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    episode: Mapped[int] = mapped_column(default=1)
    location: Mapped[str] = mapped_column(String(255))
    #: 归一场景名。旧库遗留行为 None，此时退回 (episode, location) 精确匹配。
    canonical: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)


class SceneAlias(Base):
    """场景归一字典：Shot.location 原值 → 归一场景名。

    ## 为什么必须有这张表

    拆解落库的 `Shot.location` 是**每集各写一遍**的自由文本。实测项目
    36c691b20387（测试813）的 22 个场景名**跨集复用率为 0**：

        「金诚律所 密室会客室」ep2   ←→  「夜 内 沈修杰律所办公室」ep5
        「顾氏集团 总裁办走廊」ep3   ←→  「日 内 鼎盛集团 总裁办走廊」ep4
        「高端酒店大堂/电梯间」ep1  ←→  「酒店走廊/电梯间」ep1

    很多名字还把 slug 行里的「日 内」「夜 内」原样带了进来。所以：

    - "同一场景下同一人物服装相同"用字符串相等**根本判不出来**；
    - 场景锚定图会让同一个房间在每一集长成不同样子。

    归一分两步：`scenes.normalize_location` 先做确定性清洗（剥时间/内外前缀、
    统一分隔符），再由一次 LLM 合并把剩下的别名归组。归组保守是安全的
    ——少归一只是少一次继承，绝不会产出错误画面；错归一才会让人穿错衣服。

    source='manual'：用户在资产页手动改过的映射，AI 重跑归一时**不覆盖**。
    """

    __tablename__ = "scene_aliases"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    raw_name: Mapped[str] = mapped_column(String(255))
    canonical: Mapped[str] = mapped_column(String(255))
    time_of_day: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 日|夜|晨|黄昏
    int_ext: Mapped[str | None] = mapped_column(String(8), nullable=True)       # 内|外
    source: Mapped[str] = mapped_column(String(16), default="ai")               # ai | manual


class CharacterAlias(Base):
    """角色归一字典：Shot.characters 里的原始写法 → 归一角色名（N2）。

    ## 为什么必须有这张表

    场景侧有 `SceneAlias`，角色侧此前**没有对应机制**——结构性不对称。
    而剧本本身就会给同一个人多种写法，拆解如实记录（这是对的），于是：

        '陆明' 208 镜  ←→  '少年陆明' 3 镜      （同一人的少年时期）
        '江卫东的秘书' 1 镜 ←→ '江卫东秘书' 1 镜  （同一人的两种写法）

    不归一的后果：`AssetStage` 里「陆明」43 个阶段 + 「少年陆明」3 个阶段，
    被当成两个人各画各的定妆图，同一个角色在少年戏与成年戏里长得毫不相干。

    ## ⚠️ 为什么不能用字面子串判断

    实测这些名字对**字面高度相似但绝非同一人**：

        '陆明父亲'   ⊃ '陆明'     ← 父子是两个人！
        '江卫东的秘书' ⊃ '江卫东'   ← 秘书是另一个角色！
        '审查组长'   ⊃ '审查组'    ← 组长是人，审查组是机构

    按子串合并会把父子、上下级合并成一个人，属**数据损坏**。所以判定必须走
    LLM 语义（同 `canonicalize_scenes` 的做法），且归组要保守：
    少归一只是少合并一次，错归一会让两个角色共用一张脸。

    `age_stage`：该写法对应的人生阶段（少年/青年/中年/老年）。归一到同一
    `canonical` 后，不同 `age_stage` 仍各自出图——「少年陆明」与「陆明」是同一人
    但长相不同，这正是 Q1 人物档案里年龄段的用武之地。

    source='manual'：用户手动改过的映射，AI 重跑归一时**不覆盖**。
    """

    __tablename__ = "character_aliases"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    raw_name: Mapped[str] = mapped_column(String(255))
    canonical: Mapped[str] = mapped_column(String(255))
    #: 少年 | 青年 | 中年 | 老年 | None（未区分）
    age_stage: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="ai")               # ai | manual


class Job(Base):
    """异步任务：批量生图/视频生成等长任务。桌面端提交后轮询状态。"""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # asset_batch | shot_video | ...
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|running|done|failed
    # 输入/输出/错误均存 JSON 文本，避免每种任务各建表；MVP 够用
    payload: Mapped[str] = mapped_column(Text, default="{}")
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[int] = mapped_column(default=0)  # 0-100
    # 任务面板要按时间倒序列历史任务，没有时间戳就只能按 id 排——
    # id 是随机 hex，排出来的顺序毫无意义
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 归属项目：从 payload["project_id"] 冗余出来的**索引列**（B30）。
    # payload 是 JSON 文本，按项目筛 job 原先只能全表载入 + 逐行 json.loads，
    # 而 jobs 表只增不删（实测 173 行已含 547 KiB 的 payload/result，
    # 其中 result 这个接口根本用不到，最大单条 34 KiB）。
    # 冗余一列 + 索引后，查询在 DB 层就收敛到本项目的几十行。
    # 仍以 payload 为准（写入时由 create_job 同步），本列纯为查询加速。
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True,
                                                   index=True)
    #: 提交者（主平台 user_id）。2026-10-13 起写入，用于用量与预算归属。
    #: 此前 jobs 表**根本不知道是谁提交的**；旧行为 NULL，不回填（推不出来）。
    user_id: Mapped[int | None] = mapped_column(nullable=True)


class MediaClip(Base):
    """P1-3 素材池落库（修 E4）：上传素材原先只存前端内存，刷新/换设备即丢。

    文件本体仍在 /root/filmweaver-data/uploads（上传走 /v2/media/upload），
    本表只登记项目维度的元数据；插入镜头轨仍走 is_special 特殊镜头（P0-3 归一）。
    """

    __tablename__ = "media_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(255))
    url: Mapped[str] = mapped_column(Text)          # /fw/media/uploads/xxx
    size: Mapped[int] = mapped_column(default=0)
    kind: Mapped[str] = mapped_column(String(16))   # video | audio | image | other
    duration: Mapped[float] = mapped_column(default=0.0)  # 秒；图片/未知为 0
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AudioClip(Base):
    """P2-4 音频轨（修 D5）：TTS 旁白 / 配乐段落，落库供时间轴渲染与导出混音。

    时间定位锚定镜头：start_shot_order + start_offset_sec（镜头内偏移），
    镜头增删/改序时音频跟随所锚镜头移动，比存绝对秒稳健（时长常变）。
    """

    __tablename__ = "audio_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="tts")  # tts | music | shot | narration
    text: Mapped[str | None] = mapped_column(Text, nullable=True)  # TTS 旁白文本
    url: Mapped[str | None] = mapped_column(Text, nullable=True)   # 合成产物；None=生成中/失败
    #: 音源文件的**实测总长**（ffprobe），不是它在时间轴上占多久。
    #:
    #: ⚠️ 6.9 起这两件事分开了，**修剪绝不能改这一列**：它是"这个文件到底有多长"
    #: 的唯一记录，被改掉之后用户就只能越剪越短、再也拉不回来（把 3 分钟 BGM
    #: 剪到 10 秒之后，那 3 分钟从此在库里不存在）。
    #: 修剪写的是下面的 clip_in_sec / clip_dur_sec。
    duration: Mapped[float] = mapped_column(default=0.0)           # 秒（ffprobe 实测）
    start_shot_order: Mapped[int] = mapped_column(default=1)       # 锚定镜头 order
    start_offset_sec: Mapped[float] = mapped_column(default=0.0)   # 镜头内偏移
    #: 6.9 修剪窗口：在 url 这个音源里取 [clip_in_sec, +clip_dur_sec)。
    #: NULL = 整段使用（从没被修剪过），**播放时长 = clip_dur_sec ?? duration**。
    #:
    #: 与 Shot 的同名两列同构，但**没有** Shot 那条 `duration_sec == clip_dur_sec`
    #: 不变式要维持 —— 因为音频只有一个时长列可写。Shot 之所以要维持，是它同时
    #: 存着"排版用的时长"和"取片用的窗口"两份；音频这边"排版用的时长"是**算出来的**
    #: （`clip_dur_sec ?? duration`），算出来的东西不会和自己不同步。
    clip_in_sec: Mapped[float | None] = mapped_column(nullable=True)
    clip_dur_sec: Mapped[float | None] = mapped_column(nullable=True)
    #: 音量倍数（0~1，NULL = 1.0）。配乐压在台词之下靠它。
    #:
    #: 为什么不做动态 ducking（随人声逐帧压低）：剪映草稿表达不了逐帧包络，
    #: 写进去剪映也不认。静态低音量是这一层的正确粒度。
    volume: Mapped[float | None] = mapped_column(nullable=True)
    #: 淡入 / 淡出（秒，NULL = 0 = 硬切）。段尾硬切很突兀，配乐几乎总要淡出。
    fade_in_sec: Mapped[float | None] = mapped_column(nullable=True)
    fade_out_sec: Mapped[float | None] = mapped_column(nullable=True)
    voice_ref_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # 参考音色素材
    #: kind="shot" 专用：这条音频是从哪个镜头的视频里剥出来的。
    #:
    #: 它同时是**导出时静音源视频的唯一依据** —— 只要某镜头存在
    #: source_shot_id 指向它的音频段，渲染计划就把该镜头视频的音轨静音，
    #: 否则同一段声音会响两遍（视频自带一遍 + 音频轨一遍）。
    #: 反过来，删掉这条音频段，静音随之解除，声音自动回到视频上。
    #: 用"存在性"驱动而不是给 Shot 加 muted 标记，是为了不出现
    #: "音频段删了但视频还是哑的"这种两处状态不同步的坑。
    source_shot_id: Mapped[str | None] = mapped_column(String(16), nullable=True,
                                                       index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # pending | generating | done | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class SubtitleClip(Base):
    """TB-02 字幕轨：文本 / 字幕段落，落库供时间轴渲染与导出烧录。

    时间定位与 AudioClip 同构（锚定镜头 order + 镜内偏移），理由也一样：
    镜头增删/改序时字幕跟着所锚镜头走，比存绝对秒稳健——镜头时长天天在变，
    存绝对秒的话改一个镜头时长，后面所有字幕全部错位。

    style 存 JSON（字号/颜色/描边/底框/位置/加粗），与前端 SubtitleStyle 同构。
    不拆成十几个列：字幕样式是整体套用的预设，拆列只会让加一个属性就要迁移一次。
    """

    __tablename__ = "subtitle_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    #: normal(普通文本) | subtitle(剧情字幕) | title(标题)
    kind: Mapped[str] = mapped_column(String(16), default="subtitle")
    start_shot_order: Mapped[int] = mapped_column(default=1)
    start_offset_sec: Mapped[float] = mapped_column(default=0.0)
    duration: Mapped[float] = mapped_column(default=3.0)
    #: 样式 JSON；None = 用项目默认预设
    style: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 这条字幕是按哪一份素材做的（2026-11-21，Muse 逐字字幕）。四列都为 NULL 的是老数据，
    #: 状态是 `unverified`（见 `subtitle_status`）。`source_shot_id` 有值时按它找镜头，
    #: 不按 `start_shot_order`：镜头改序后仍然锚在同一镜上。
    source_shot_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 做字幕时这一镜的 `video_url`；与镜头当前的不同 = 换过素材（重新生成、采纳别的版本），字幕过期
    source_video_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 做字幕时这一镜采用的版本号（`Shot.adopted_version`），只供人看
    source_version: Mapped[int | None] = mapped_column(nullable=True)
    #: 那份素材的 SHA-256（Muse 下载后算的），只供人看与核对
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: `source` = `start_offset_sec` / `duration` 是**源文件**里的秒（不减取片入点、不除变速，
    #: 导出时经 `shot_timing.subtitle_source_span` 换算）；NULL = 老口径（`subtitle_output_span`）
    time_base: Mapped[str | None] = mapped_column(String(8), nullable=True)
    #: `muse`（Muse 送来逐字时间）| `asr`（镜流自己转写）| `manual`（手加的）；NULL = 老数据
    origin: Mapped[str | None] = mapped_column(String(8), nullable=True)

    __table_args__ = (Index("ix_subtitle_clips_source_shot", "source_shot_id"),)


class SubtitleSource(Base):
    """一镜的字幕最近一次是按哪一份素材做的（Muse 逐字字幕每做一镜写一行，2026-11-21）。

    没有说话声的镜头一条字幕都没有，单看 `subtitle_clips` 分不出「做过、没人说话」和「还没做」；
    这一行就是「做过」的记录。状态在读取时现算（`subtitle_status`），换素材不用回头改它。
    """

    __tablename__ = "subtitle_sources"

    shot_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    source_video_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_version: Mapped[int | None] = mapped_column(nullable=True)
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    origin: Mapped[str | None] = mapped_column(String(8), nullable=True)
    #: 写进字幕轨的条数、还没人选的待核处数、写它的任务
    cues: Mapped[int] = mapped_column(default=0)
    review_pending: Mapped[int] = mapped_column(default=0)
    job_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 做字幕时这一镜会被念出来的台词的摘要（`subtitle_status.shot_lines_sha256`）；改了剧本就对不上，
    #: 状态为 `stale`。NULL = 写这一行时还没记（不按台词判断）
    lines_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)


class SubtitleClipArchive(Base):
    """segments 任务删掉的老字幕的存档（2026-11-21）：每删一条先抄一份到这里，删错了能找回。

    只抄不是 Muse 自己写的行（老数据 `origin` 为空的、镜流自己转写的 `asr`）：Muse 的行随时能按
    Muse 本机的转写缓存重做。列与 `SubtitleClip` 同名同义，另加删除它的任务、时间和原因。
    """

    __tablename__ = "subtitle_clip_archive"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    #: 原来那一行的 `SubtitleClip.id`
    clip_id: Mapped[str] = mapped_column(String(16))
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(16), default="subtitle")
    start_shot_order: Mapped[int] = mapped_column(default=1)
    start_offset_sec: Mapped[float] = mapped_column(default=0.0)
    duration: Mapped[float] = mapped_column(default=3.0)
    style: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_shot_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source_video_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_version: Mapped[int | None] = mapped_column(nullable=True)
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    time_base: Mapped[str | None] = mapped_column(String(8), nullable=True)
    origin: Mapped[str | None] = mapped_column(String(8), nullable=True)
    #: 被哪个任务删的、什么时候、为什么（`replace_legacy` | `replace_asr`）
    job_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    archived_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(16), nullable=True)


class Transition(Base):
    """转场：两个相邻镜头接缝处的过渡效果（Render V2）。

    ## 为什么锚在「接缝」而不是「时间点」

    转场是**两个 clip 之间**的关系，不是时间轴上的一个独立对象。存
    from_shot_id/to_shot_id 而非绝对秒：镜头改时长、换顺序时，转场自动跟着
    那条接缝走；存绝对秒的话，改一个镜头时长就要重算后面所有转场位置。

    ## duration 的约束

    转场会"吃掉"两侧各半个时长（xfade 的重叠区），所以它不能超过任一侧镜头
    时长的一半——否则会把整个镜头吃没。落库时钳制，前端也做同样校验。

    ## renderable

    UI 里有 15 种转场，但 Render V2.1 只真正实现了 fade/fadeblack/fadewhite。
    其余落库时照存（用户的编排不该因为引擎没跟上就丢失），由编译器按
    capabilities 决定能否渲染，不能渲染的降级为硬切并在导出前提示。
    """

    __tablename__ = "transitions"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: ffmpeg xfade 的 transition 名（fade / fadeblack / wipeleft / ...）
    type: Mapped[str] = mapped_column(String(32), default="fade")
    duration: Mapped[float] = mapped_column(default=0.5)
    #: 接缝两端的镜头
    from_shot_id: Mapped[str] = mapped_column(String(16), index=True)
    to_shot_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 额外参数 JSON（方向/缓动等，按转场类型不同）
    params: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class UserBudget(Base):
    """用户的积分账户与组织归属（P1，2026-10-14）。

    设计见 docs/DESIGN-积分预算与飞书审批-2026-10-13.md。四层组织用
    `manager_id` 单一上级自引用表达，**不建四张表**——任务书本身就是这么描述的。

    ⚠️ `org_role`（总控/组长/小组长/生成师）**独立于 `auth_sessions.role`**
    （user/admin/superadmin）：后者是平台管理员权限，控制的是"能不能看别人的
    项目"；这里是生产组织角色，控制的是"能不能给别人分额度"。**两者不许互相推导。**
    """

    __tablename__ = "user_budget"

    user_id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 总控 | 组长 | 小组长 | 生成师
    org_role: Mapped[str] = mapped_column(String(16), default="生成师")
    #: 直接上级（同为主平台 user_id）。总控为 NULL。
    manager_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    #: 平台管理员白拿：借用已有 superadmin 会话判定，此处只作留痕
    is_platform_admin: Mapped[int] = mapped_column(default=0)
    active: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    @property
    def role(self) -> str:
        return self.org_role or "生成师"


class OrgNode(Base):
    """组织节点：以某个 `user_id` 为负责人、下辖固定成员的一组人（P1）。

    两级：**组**（组长下辖小组长）与**单位**（小组长下辖生成师）。
    设计文档里叫"组池/小组池"，这里统一成一个可嵌套的节点，
    避免四层写四套几乎一样的表。

    ⚠️ 成员列表存 JSON 而不是单独一行一人：这份名单是"组长名下的成员"
    这一事实的**快照**，按人分行还要处理"调组后旧行谁删"，
    而覆盖式同步（见 budget.reconfigure）天然就是这个语义。
    """

    __tablename__ = "org_nodes"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)          # 负责人
    name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: [{"user_id": int}] —— 直属成员（下级负责人）
    members: Mapped[list | None] = mapped_column(JSON, nullable=True)
    #: 上级节点 id；NULL = 顶层（组）
    parent_id: Mapped[str | None] = mapped_column(String(16), nullable=True,
                                                  index=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class BudgetPool(Base):
    """预算池：一个节点（或一个人）当前持有的积分（P1）。

    ⚠️ **刻意只存一个余额列 `balance_fen`**（唯一的金额字段，单位「分」）。

    理由是本系统的钱**只在两处流动**：
      ① 下拨：上级 −x、下级 +x，一对 UPDATE 在同一事务；
      ② 扣减：从叶子池 −x（P1 下半的生成闸门）。

    没有"冻结"这一步——下拨是即时的、生成扣减也是即时的。
    **需要退款或修正时在 `balance_fen` 上做增减并写一条 ledger 流水留痕**，不要
    去改历史流水的金额：流水是不可变的审计记录，改它就等于伪造审计。

    这样设计的代价是"看不到冻结中的钱"，但那本来就不存在。
    """

    __tablename__ = "budget_pools"

    #: root | g:<user_id>（组池/单位池，同一套机制）
    pool_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 余额（分）。可负，但只在下拨/扣减的实现出错时才会——预留告警用。
    balance_fen: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class BudgetLedger(Base):
    """额度流水：**只追加，不修改不删除**（P1）。

    每一笔下拨/回收/扣减/退款都在这里留一条。金额带符号：
    · 对某个池而言，`amount > 0` = 进账（被划拨），`< 0` = 出账（划出去 / 被花掉）。

    为什么两个池各记一条而不是记一条带 from/to 的：那样每次查"这个人收了什么"
    都要 OR 两个字段。两条对称的记录让"按池查流水"退化成一次最普通的索引扫描。
    """

    __tablename__ = "budget_ledger"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    ts: Mapped[str] = mapped_column(String(32), index=True)
    pool_id: Mapped[str] = mapped_column(String(32), index=True)
    #: 操作人（主平台 user_id）
    user_id: Mapped[int | None] = mapped_column(nullable=True)
    #: grant(划拨进) | revoke(回收) | hold/spend(扣减) | refund(退回) | adjust
    entry: Mapped[str] = mapped_column(String(16))
    amount: Mapped[int] = mapped_column(default=0)
    #: 关联的生成任务（扣减/退款时有）；划拨时为 NULL
    job_id: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)


class NotifyTemplate(Base):
    """飞书通知文案的可覆盖副本（2026-10-15）。表里没有的事件用代码里的默认文案。

    存这张表是为了"改措辞不用改代码"——和审批模板同样的理由。占位符：
    {greet} {contact} {amount} {balance} {unapproved_tail} {granter} {name} {reason} {apply_form} {offset_tail}
    写错占位符不会把通知弄丢（会退回默认文案）。
    """

    __tablename__ = "notify_templates"

    event: Mapped[str] = mapped_column(String(32), primary_key=True)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class BudgetUnapproved(Base):
    """某人"未经审批就拿到"的积分（2026-10-15）。

    用户要求：管理员直接分配额度时，要提醒对方"其中多少还没走审批"。这个数不能从
    流水反推——组长下拨和管理员下拨在同一条 grant 流水里，分不出来。所以单独记账：
    管理员直接分配时累加，之后**审批通过拨款**时冲减（那张单把垫付补上了），下限 0。
    组长从自己余额下拨不计入（那是他自己的钱，不是平台垫的）。
    """

    __tablename__ = "budget_unapproved"

    user_id: Mapped[int] = mapped_column(primary_key=True)
    fen: Mapped[int] = mapped_column(default=0)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class FeishuReminder(Base):
    """用户要求的飞书提醒（2026-11-01）：到点提醒，或某个任务结束时提醒。

    `kind`：`time` 看 `due_at`；`job` 看 `job_id`。`status`：pending|sent|failed|cancelled。
    存库而不是放内存：后端重启、客户端关着，提醒都不能丢。
    """

    __tablename__ = "feishu_reminders"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)
    kind: Mapped[str] = mapped_column(String(8))
    text: Mapped[str] = mapped_column(Text)
    #: UTC ISO 时间，`kind=time` 才有；同一种格式才能按字符串比较。
    due_at: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    job_id: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[str] = mapped_column(String(32))
    sent_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class OvernightRun(Base):
    """客户端通宵模式的一次运行（2026-11-02）：客户端每分钟报心跳，断了就飞书告诉用户。

    一个客户端会话（`session_id`）一行，重新开启时复用这一行。`status`：running | offline | done | stopped。
    `offline` 只在后端发现心跳超时、或客户端报「下线」时写入，并同时发出那条飞书通知；
    心跳恢复时回到 running 并再发一条「已恢复」，所以每次断线只通知一次。
    """

    __tablename__ = "overnight_runs"

    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 给人看的一句话：哪个项目、做什么（「《同事请客》第 3 集出片」）。
    title: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="running", index=True)
    #: 最近一次心跳带来的进度，如「12/30 镜」；通知里原样引用。
    progress: Mapped[str] = mapped_column(Text, default="")
    #: 最近一次心跳带来的「正在做什么」。
    doing: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[str] = mapped_column(String(32))
    last_beat_at: Mapped[str] = mapped_column(String(32), index=True)
    offline_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 客户端结束时发来的早上报告，已发过飞书。
    report: Mapped[str | None] = mapped_column(Text, nullable=True)


class DramaAsrJob(Base):
    """短剧编导云端转写的一个任务（2026-11-05，见 drama_asr.py）。主键是客户端持久化的幂等 UUID。

    `status`：preparing | submitting | processing | uncertain | complete | silent | failed。
    已提交（`submitted_at` 非空）的任务只查询原任务、从不重投；`uncertain` = 提交结果未知，可能已计费。
    """

    __tablename__ = "drama_asr_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True)
    day: Mapped[str] = mapped_column(String(10), index=True)
    sha256: Mapped[str] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(String(16))
    language: Mapped[str] = mapped_column(String(8))
    service_version: Mapped[str] = mapped_column(String(16))
    format: Mapped[str] = mapped_column(String(8))
    duration: Mapped[float] = mapped_column(default=0.0)
    status: Mapped[str] = mapped_column(String(16), index=True)
    queued: Mapped[bool | None] = mapped_column(nullable=True)
    #: 只含公开分类字段的上游失败摘要（JSON），从不存上游正文。
    provider_failure: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    segments: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 标准版音频在桶里的相对路径；过了留存期删除后清空。
    audio_rel: Mapped[str | None] = mapped_column(String(128), nullable=True)
    retention_expired: Mapped[bool] = mapped_column(default=False)
    submitted_at: Mapped[float | None] = mapped_column(nullable=True)
    next_query_at: Mapped[float | None] = mapped_column(nullable=True)
    #: 百炼 Paraformer 的任务号（火山用我们自己的任务号查询，不用这一列）。
    provider_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class DramaVoiceSlot(Base):
    """剧变项目里「某角色·某人生阶段」的一个音色槽位（2026-11-05，见 drama_voice_slots.py）。

    `state`：reserved（已认领，租约到期自动释放）| submitted（已提交注册，不过期）| ready（已登记音频资产）。
    剧变令牌只在请求时用于核对，不落库。
    """

    __tablename__ = "drama_voice_slots"

    slot_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    script_id: Mapped[int] = mapped_column(index=True)
    character_id: Mapped[str] = mapped_column(String(256))
    voice_period_id: Mapped[str] = mapped_column(String(256))
    state: Mapped[str] = mapped_column(String(12))
    owner_account_id: Mapped[str] = mapped_column(String(64))
    operation_key: Mapped[str] = mapped_column(String(256))
    lease_id: Mapped[str] = mapped_column(String(64))
    lease_expires_at: Mapped[int] = mapped_column()
    updated_at: Mapped[int] = mapped_column()
    asset_id: Mapped[int | None] = mapped_column(nullable=True)


class FeishuNotifyLog(Base):
    """每一条飞书通知的留痕（2026-10-15）。没有它，"他到底收到没有"只能靠问。"""

    __tablename__ = "feishu_notify_log"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    ts: Mapped[str] = mapped_column(String(32), index=True)
    user_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    event: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(12))     # sent / failed / skipped
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)


class ApprovalTemplate(Base):
    """一个飞书审批模板怎么折算成积分申请（2026-10-15，方案 B）。

    ⚠️ **刻意不写进代码**：模板编号、金额字段、钱拨给谁、谁能申请、上限、
    哪些批准人算数——全部是这张表里的一行。原因是用户明确说过"未来很可能优化到
    方案 C（在镜流里发起申请）"，而且以后还会有小组长的申请模板。写死在代码里，
    每换一次模板就要改一次代码、发一次版。现在换模板 = 改一行配置。
    """

    __tablename__ = "approval_templates"

    #: 飞书审批定义编号（approval_code）
    approval_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    enabled: Mapped[int] = mapped_column(default=1)
    #: 表单里**金额控件的 id**（不是控件名：名字可以被人在飞书后台改掉）
    amount_widget_id: Mapped[str] = mapped_column(String(64))
    #: 金额单位：yuan(积分=元) | fen。默认 yuan，与 1 积分 = 1 元一致
    amount_unit: Mapped[str] = mapped_column(String(8), default="yuan")
    #: 钱拨给谁：initiator(发起人本人) | widget:<控件id>(表单里选的人)
    target: Mapped[str] = mapped_column(String(80), default="initiator")
    #: 允许谁申请（逗号分隔的组织角色）。默认只有大组长
    allowed_roles: Mapped[str] = mapped_column(String(64), default="大组长")
    #: 单笔上限（分）。0 = 不设上限；超出的转人工
    max_fen: Mapped[int] = mapped_column(default=0)
    #: 只认这些批准人（逗号分隔的 union_id）。空 = 飞书显示"已通过"就算
    approver_union_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 只处理这个时刻**之后**发起的审批（ISO8601）。上线前手工拨过的单不能再拨
    start_at: Mapped[str] = mapped_column(String(32))
    #: 预留给方案 C：这个模板的单是谁发起的。native(飞书里直接发) | shotflow
    source: Mapped[str] = mapped_column(String(16), default="native")
    #: 上次成功刷新时读到的"发起时间"上界（ISO）。下次只发现这之后的新单——
    #: 已知的未决单按单号逐张复查，不靠时间窗。
    synced_until: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class BudgetRequest(Base):
    """一张飞书审批单在本地的影子（2026-10-15）。**一张单一行**，主键就是审批单号。

    状态机（只能向前走）：
        pending → approved → granted        正常路径；granted 恰好一次
        pending → rejected / canceled       不拨款
        * → review                          对不上人/读不出金额/超上限/批准人不对 → 人工
        review → granted / dismissed        管理员手动处理
        granted 之后飞书侧被撤销 → revoked_after_grant（只标出来，不自动扣回）

    `instance_code` 做主键 = 同一张单无论被读多少次都只有一行，配合
    "granted 只能从 approved/review 进入、且与拨款在同一事务里"保证只拨一次。
    """

    __tablename__ = "budget_requests"

    instance_code: Mapped[str] = mapped_column(String(64), primary_key=True)
    approval_code: Mapped[str] = mapped_column(String(64), index=True)
    #: native(飞书里直接发起，方案 B) | shotflow(镜流里发起，方案 C 预留)
    source: Mapped[str] = mapped_column(String(16), default="native")
    status: Mapped[str] = mapped_column(String(24), index=True)
    #: 飞书侧的原始状态（PENDING/APPROVED/REJECTED/CANCELED/DELETED…），排查用
    feishu_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    initiator_union_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 对到的镜流用户（发起人 / 收款人）
    applicant_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    target_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    amount_fen: Mapped[int | None] = mapped_column(nullable=True)
    #: 为什么停在这里（转人工的原因、读不出金额的原文…），给管理员看
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 飞书侧的发起/结束时刻（ISO）
    submitted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    decided_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 拨款流水 id 与操作人（自动拨款时操作人为 NULL = 系统）
    ledger_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    granted_by: Mapped[int | None] = mapped_column(nullable=True)
    granted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 这张单冲抵掉的「已发未批」额（2026-10-17）。补审批时审批额先抵管理员此前
    #: 直接拨的钱，只有超出部分真到账：实际到账 = amount_fen − offset_fen。
    offset_fen: Mapped[int | None] = mapped_column(nullable=True)
    #: 最近一次读到的审批详情（JSON，截断），出问题时据此复盘
    snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class UsageEvent(Base):
    """上游用量流水（P0，2026-10-13）：**每一次真实的上游调用一行，只追加**。

    设计见 docs/DESIGN-积分预算与飞书审批-2026-10-13.md。P0 只做统计、
    不拦截任何请求；P1 的预算闸门在此之上另建账本，不改这张表的语义。

    ## 为什么记"每次调用"而不是"每个 job"
    一个 job 底层的调用次数差异极大（一次拆解 ≈ 670 次 LLM 调用），
    只记 job 级就无法回答"钱花在哪一步"。金额按调用落、按 job 汇总。

    ## cost_fen 的含义
    按 app/pricing.py 现价换算的**估算成本**（分）。文本调用恒为 0——
    文本按用户操作收费（0.5 元/次），由提交闸门收，不在单次调用上计。
    旧数据不回填：按裁定，统计从本表建立后开始算。
    """

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ts: Mapped[str] = mapped_column(String(32))
    #: llm | image | video | upscale | tts | desub
    category: Mapped[str] = mapped_column(String(16))
    model_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(32), nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    job_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    user_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    ok: Mapped[int] = mapped_column(default=1)            # 1=成功 0=失败（仍可能计费）
    prompt_tokens: Mapped[int | None] = mapped_column(nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(nullable=True)
    #: RunningHub 平台回报的生成耗时（taskCostTime，秒）
    gen_seconds: Mapped[float | None] = mapped_column(nullable=True)
    #: 产出视频/素材时长（秒）；图像为张数放在 units
    media_seconds: Mapped[float | None] = mapped_column(nullable=True)
    units: Mapped[int | None] = mapped_column(nullable=True)   # 图张数 / TTS 段数
    resolution: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 平台原样回报的金额（字符串，RunningHub consumeMoney）；只作对账参考
    vendor_money: Mapped[str | None] = mapped_column(String(32), nullable=True)
    cost_fen: Mapped[int] = mapped_column(default=0)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)


def effective_characters(shot: "Shot") -> list[str]:
    """镜头最终注入的角色集合：((L1 拆解真值 ∪ L1.5 在场推导) ∪ 人工 add) − 人工 remove。

    放在数据层：jobs._auto_inject_refs（生成时注入）与 routes_v2.list_stages（轨道渲染）
    必须走同一函数，保证「轨道显示的覆盖 = 实际注入行为」，不再各算各的。
    顺序稳定：先 L1 出场顺序，再 L1.5 推导补的，人工补充的追加在最后
    （注入截断时优先保 AI 判定，其次保推导，最后才是人工加的）。

    ## L1.5 是 3.9 加的，为什么要有它

    拆解提示词只让 LLM 列"本镜有戏份的角色"，于是坐在桌边不说话的人不会进
    `characters`。实测「真人剧-验证片」镜 1 有林母，镜 2-4 没有（剧本里毫无
    离场描写），镜 5 又有 —— 她的定妆图因此时有时无，画面上人就一会儿在
    一会儿不在。`present_characters` 就是把"她没走，还在那儿"这件事补回来。

    ⚠️ 人工 remove **压得住** L1.5：推导错了（比如剧本用了我们没识别的离场写法）
    用户在资产轨上把人拿掉，就必须真的拿掉。所以 remove 在最外层生效。
    """
    try:
        chars = [c for c in json.loads(shot.characters or "[]")
                 if isinstance(c, str) and c]
    except (ValueError, TypeError):
        chars = []
    try:
        present = [c for c in json.loads(getattr(shot, "present_characters", None) or "[]")
                   if isinstance(c, str) and c]
    except (ValueError, TypeError):
        present = []
    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    add = [c for c in ov.get("add", []) if isinstance(c, str) and c]
    remove = {c for c in ov.get("remove", []) if isinstance(c, str) and c}
    out = [c for c in chars if c not in remove]
    for c in present:
        if c not in out and c not in remove:
            out.append(c)
    for c in add:
        if c not in out and c not in remove:
            out.append(c)
    return out


def effective_locations(shot: "Shot") -> list[str]:
    """镜头最终注入的场景集合（P1-3，与 effective_characters 同契约）：
    (L1 拆解真值 Shot.location ∪ 人工 add_loc) − 人工 remove_loc。
    L1 是单值（每镜一个所属场景），人工可加多个（如同框双景参考）。
    """
    l1 = [shot.location] if shot.location else []
    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    add = [c for c in ov.get("add_loc", []) if isinstance(c, str) and c]
    remove = {c for c in ov.get("remove_loc", []) if isinstance(c, str) and c}
    out = [c for c in l1 if c not in remove]
    for c in add:
        if c not in out and c not in remove:
            out.append(c)
    return out


def desc_of(a) -> str | None:
    """资产/造型的**描述**读数口径（拼装提示词时的 description 输入）。

    ⚠️ 两个名字空间易混，见 `Asset.desc_auto` 的列注释：
      · 用户改过的整段终稿在 `Asset.prompt`，**不是描述**，别拿它当 description；
      · 描述在 `desc_auto`。存量行（拆列之前）的空间描述写在 `prompt` 里，
        所以这里回退到 `prompt` —— 但**只在它看起来还是描述时**才回退，
        判据见 `_looks_like_final_prompt`。
    """
    if a is None:
        return None
    auto = (getattr(a, "desc_auto", None) or "").strip()
    if auto:
        return auto
    legacy = (getattr(a, "prompt", None) or "").strip()
    if legacy and not _looks_like_final_prompt(legacy):
        return legacy
    return None


def final_prompt_of(a) -> str | None:
    """资产**用户改过的整段终稿**（`prompt`），没有返回 None。

    ⚠️ 与 `desc_of` 是**互斥**的两个读数口径，别互换：
      · 本题给的是"这张图该用哪段话去生成"（600~900 字的完整稿）；
      · `desc_of` 给的是"这段描述说了什么"（喂给拼装函数的输入）。

    存量行的 `prompt` 两义并存：拆列之前，场景描述也被写在这一列里
    （dev 库 1330 条 location 里有 1328 条是描述）。所以这里**必须**排除
    "看起来像描述"的那些 —— 否则预览会把那 160 字当终稿原样返回，
    画风前缀、构图句、空镜头要求、影调句全部丢失，正是本次要修的病症。
    判定见 `_looks_like_final_prompt`。
    """
    if a is None:
        return None
    p = (getattr(a, "prompt", None) or "").strip()
    if not p:
        return None
    # `desc_auto` 有值 ⇒ 这一行已经拆过名字空间，`prompt` 一定是用户终稿，
    # **不做形状判断**：用户把稿子改短成一句"角色立绘, 顾昕"也是他的稿，
    # 靠长度/关键词去否掉他会让改动静默消失。
    if (getattr(a, "desc_auto", None) or "").strip():
        return p
    # 存量行（拆列之前）：两义并存，只能靠形状排除"其实是描述"的那些。
    return None if not _looks_like_final_prompt(p) else p


def _looks_like_final_prompt(text: str) -> bool:
    """这段文本是拼装好的**整段终稿**，还是用户/AI 写的**描述**？

    存量 `prompt` 两义并存（dev 库 location 1330 条里 1328 条是描述、2 条是终稿），
    迁移不回填时只能靠形状认。终稿的特征是 `asset_prompt` 的固定骨架：
    「机位」/「空镜头，画面中空无一人」/「参考图：」这些模板句，长度也普遍 600+。
    描述则是一段中文（60~150 字，`scene_desc._SYS` 的口径）。

    宁可把一条终稿误认成描述（提示词里多一段复述），也不要把描述误认成终稿
    （预览直接退化成那 160 字）。
    """
    t = (text or "").strip()
    if len(t) >= 400:
        return True
    return any(k in t for k in ("参考图：", "空镜头，画面中空无一人", "画面构图：",
                                "禁止出现任何文字"))


def profile_of(proj) -> dict:
    """Project.default_profile（JSON 字符串列）→ dict，坏数据一律当空档案。

    ## 为什么住在 db.py 而不是 routes_v2.py

    它读的是 `Project` 这个 ORM 模型的列，**是数据层的读取口径** —— 放在路由
    文件里会让"谁想用就得 import 路由模块"，而 `jobs.py` 正是这么被迫写了个
    函数内局部 import 绕循环的（见那边 P2.2 的注记）。下沉到 db.py 后，
    路由、任务、子模块（routers/subtitle.py）都能直接拿，循环也少一处。
    """
    try:
        prof = json.loads(proj.default_profile) if (proj and proj.default_profile) else {}
    except (ValueError, TypeError):
        return {}
    return prof if isinstance(prof, dict) else {}

def init_db() -> None:
    Base.metadata.create_all(engine)

def get_session() -> Session:
    # 用带计时的 Session 子类（见 app/dbslow.py）：只多记一个 `with` 块的墙钟时长，
    # 超阈值（默认 5s）才写日志。稳态开销是一次 perf_counter，可忽略。
    # `FW_DB_SLOW_LOG=0` 时 dbslow 不挂 engine 事件，但 Session 子类仍可用——
    # 它自身也会读同一个开关（在模块内 _enabled 里），所以关掉就是全关。
    from .dbslow import SlowWatchSession
    return SlowWatchSession(engine)

# ===========================================================================
# 超级 Agent（2026-10-20）
#
# 三张表，与 LangGraph 的 checkpoint **两套并存**，职责不重叠：
#   · LangGraph checkpoint（独立的 filmweaver-agent.db）负责**恢复执行**；
#   · 这三张表负责**给人看、给对账查**。
# 为什么必须两套：checkpoint 是一个不可读的二进制 blob，用户问"这轮花了多少、
# 谁批的、第几步失败的"，从它里面挖不出来；反过来，我们的表也不该承担
# 图状态机的职责 —— 那会让"改一个字段"和"恢复执行"耦合在一起。
# ===========================================================================

class AgentRun(Base):
    """一轮 AI 制片。用户说一句话，它自己走完整个项目流程。"""

    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 发起人。与 Job.user_id 同源，用于用量归属与审计。
    user_id: Mapped[int | None] = mapped_column(nullable=True)
    goal: Mapped[str] = mapped_column(Text, default="")
    model: Mapped[str] = mapped_column(String(64), default="gpt-6.1-sol")
    #: pending | running | waiting_approval | interrupted | done | failed | cancelled
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    #: 当前大阶段（script/breakdown/assets/prompts/frames/videos/post/deliver）。
    #:
    #: ⚠️ **只用于展示与审计，不参与图路由**。阶段推进由 agent 自己用工具完成；
    #: 若把它做成硬编码状态机，agent 的自由度就被绑死了 —— 而"能跳过已完成环节、
    #: 能回头补做"正是它相对固定流水线的价值。
    stage: Mapped[str | None] = mapped_column(String(24), nullable=True)
    #: ⚠️ 以下四列 **2026-10-21 起停用**（用户裁定：范围 / 做到哪一步 / 花钱前要不要问
    #: 写在用户那段话里由模型遵守，代码只硬卡预算与找不回来的操作，见 agent/policy.py）。
    #: 不再读也不再写；列保留只是为了不做 SQLite 删列迁移，老数据照旧可读。
    grants: Mapped[str] = mapped_column(Text, default="[]")
    scope: Mapped[str] = mapped_column(Text, default='{"kind": "project"}')
    until: Mapped[str | None] = mapped_column(String(24), nullable=True)
    autonomy: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 历史列：每轮预算上限已于 2026-11-02 删除，新行写 0，不参与任何判断。保留列以免迁移。
    cap_fen: Mapped[int] = mapped_column(default=0)
    #: 已花（分）。由 agent_run_jobs 汇总 + 脑模型 token 费用。
    spent_fen: Mapped[int] = mapped_column(default=0)
    #: 脑模型累计 token（prompt+completion）。按 2 元/百万 折算进 spent_fen。
    tokens: Mapped[int] = mapped_column(default=0)
    #: 模型自己维护的待办清单（JSON: [{text, status}]）。
    todo: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 最终给用户看的汇报（人读的一段话，不是 JSON）。
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AgentStep(Base):
    """审计流水：这一步调了什么工具、花了多少、谁批的。

    ⚠️ `result` **截断到 8k**（见 agent/store.py）。全片出片的返回体可能几十 KB，
    原样存会让步骤表迅速膨胀，而用户真正要看的只有前面那几行摘要。
    """

    __tablename__ = "agent_steps"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 单调递增，**恢复时按它重放**。不用 created_at 排序：同一秒可能多步。
    seq: Mapped[int] = mapped_column(default=0)
    #: message | tool_call | tool_result | approval | note
    kind: Mapped[str] = mapped_column(String(16))
    tool: Mapped[str | None] = mapped_column(String(64), nullable=True)
    args: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    ok: Mapped[int] = mapped_column(default=1)
    #: 本步实际花费（分）。0 = 不花钱。
    cost_fen: Mapped[int] = mapped_column(default=0)
    #: 花钱前的报价（分）。审批卡片显示的就是它。
    estimate_fen: Mapped[int] = mapped_column(default=0)
    #: None（不需要审批）| pending | approved | rejected
    approval: Mapped[str | None] = mapped_column(String(16), nullable=True)
    decided_by: Mapped[int | None] = mapped_column(nullable=True)
    decided_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AgentRunJob(Base):
    """run 与它派生的 Job 的连接表。

    存在的唯一理由：**按 run 汇总花费**。`usage_events` 是按 job 记的，
    一次 run 会派生 N 个 job；没有这张表就只能扫全表 job 再从 payload 反查，
    而 payload 是 JSON 文本（jobs 表只增不删）。
    """

    __tablename__ = "agent_run_jobs"

    run_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    job_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    tool: Mapped[str] = mapped_column(String(64), default="")
    estimate_fen: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class ProjectUserPref(Base):
    """**某个人在某个项目里**的界面偏好。2026-10-23（用户需求：提示词引用块开关）。

    ## 为什么是「用户 × 项目」，而不是项目列或浏览器 localStorage

    用户原话：「这个开关应该是对这个用户的这个项目有效，不能是仅仅控制一个镜头的
    提示词文本的视觉效果」。三条要求各自排除了一种更省事的做法：

      · **不能只按项目** → 那会把我的观感偏好强加给同一个项目的协作者
        （协作三档已上线，一个项目常有 2-3 人）。所以必须有 user_id。
      · **不能只存浏览器** → 换设备/清缓存就丢，而且"这个项目的设置"
        在另一台机器上不成立。所以必须有库。
      · **不能只按镜头** → 那是 `shots` 上的字段，用户要的是"整个项目里
        我看到的提示词都这样"。所以粒度是 (project, user)。

    ## 为什么单开一张表，而不是塞进 `projects.default_profile`

    `default_profile` 是**项目级**设置（分辨率/模型/画风），对全项目人生效。
    把一个"我有他无"的个人偏好塞进去，等于默认所有人都接受我的观感。
    单表还有一个好处：新增偏好只要加一列，不动 `projects` 那条热路径。

    ## 复合主键 (project_id, user_id)

    与 `ProjectCollaborator` 同一套理由：不可能有重复行、不需要代理 id、
    也不需要额外唯一索引；两种查询形状（单个对 / 一个项目的全部行）
    都能被复合主键的前缀索引服务。

    ## 存 JSON 而不是逐列

    `prefs_json` 是一个小 dict（当前只有 `prompt_chips_hidden`）。
    逐列意味着每加一个开关就要一次 ALTER TABLE + 一次迁移；而这类偏好
    **没有查询需求**（永远按 (project, user) 整行取），拆列换不到任何东西。
    ⚠️ 但读侧必须容错：JSON 坏了/是旧版本留下的键，一律按默认值处理，
    不能让一条坏偏好把整个提示词编辑器打挂。
    """

    __tablename__ = "project_user_prefs"

    project_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(primary_key=True)
    #: 偏好 JSON（小 dict）。**不要让前端整份覆盖**：未知键要保留，
    #: 否则老前端保存一次就把新版本加的开关抹掉了。
    prefs_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
