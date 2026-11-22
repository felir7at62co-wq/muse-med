"""Runtime configuration loaded from environment variables."""
from functools import lru_cache
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "drama-orchestrator"
    env: str = Field(default="dev")
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"

    # Auth
    jwt_secret: str = "drama-dev-secret-change-me"
    admin_api_key: str = ""
    auth_required: bool = False  # dev 模式默认不强制
    novel_tts_max_chars: int | None = 2800  # 小说转视频 TTS 单批字数上限(实测RunningHub约2800字稳定; 只在"。"处拆)

    # 质量内建：把去味规则注入生成 prompt（PLAN §3.2 / B7）。
    #
    # ⚠️ **默认关**，且这是数据定的，不是保守起见。
    # 2026-09-20 跑了 8 集 A/B（同一大纲同一集各生成两遍，一组关规则一组开规则）：
    #   · AI 味分：开规则更好 4/8，双侧符号检验 p=1.000 —— 与掷硬币无异
    #   · A 级命中/千字：4/8，p=1.000
    #   · 而**组内**波动极大（关规则组 8 集的分从 18 到 54，跨 36 分）——
    #     也就是说"换一集重生成"造成的分数摆动，比规则带来的差异大一个量级
    #   · 规则瞄准的四类句式（S1 翻案腔/S2 三连排比/D1 抽象情绪壳/P1 顿号三连）
    #     本身出现率就只有 0.16/千字 —— 没有可改进的余量
    # 结论：**没有证据支持它有效**，而它会改变全平台每一次生成的产出。
    # 证据不足时不该改行为，所以默认关；留着开关是为了将来能在别的题材/模型上复验。
    deai_rules_in_generate: bool = False

    # LLM
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    deepseek_api_key: str = ""
    deepseek_model: str = "__REDACTED__"
    # kimi (Moonshot 官方直连)。2026-10-25 接入，作为 Kimi 分组的**首选渠道**，
    # 失败后才退到 kege / modelverse 两家中转（见 models/llm.py 的 kimi 分支）。
    # ⚠️ 只有 .cn 站对这把 key 有效；.ai（国际站）返回 401 —— 别把 base 改成 .ai。
    # key 走 .env 的 KIMI_API_KEY（.env 已被 git 忽略），不硬编码。
    kimi_api_key: str = ""
    kimi_base_url: str = "https://api.moonshot.cn/v1"
    kimi_model: str = "kimi-k3"
    # gpt5 (kegeai 上的 gpt-5.5, 命名上对用户暴露为"逻辑专项模型")
    # 用独立账号 key, 不与 OPENAI_API_KEY 共用, 避免配额冲突
    gpt5_api_key: str = ""
    gpt5_base_url: str = "https://duoyuanx.com/v1"
    gpt5_model: str = "gpt-5.5"
    # claude (kegeai 上的 __REDACTED__, 用作"超级 Agent"编排大脑)
    # key 走 .env 的 CLAUDE_API_KEY, 不硬编码
    claude_api_key: str = ""
    claude_base_url: str = "https://duoyuanx.com/v1"
    claude_model: str = "__REDACTED__"
    # grok (kegeai 上的 grok-4.5) - 仅短视频流水线内部使用, 不对用户暴露模型名
    grok_api_key: str = ""
    grok_base_url: str = "https://duoyuanx.com/v1"
    grok_model: str = "grok-4.5"
    # 四个文本角色的兜底值。这里必须跟 .env 实际在用的保持一致 ——
    # 以前写的是 gpt-4o-mini(中转站上根本没这个模型), .env 一旦漏配
    # 就会拿它去请求, 报的还是"模型不存在"这类跟真实原因无关的错。
    llm_generate_model: str = "gemini-3.6-flash"
    llm_rewrite_model: str = "gemini-3.6-flash"
    llm_extract_model: str = "gemini-3.6-flash"
    llm_summary_model: str = "gemini-3.6-flash"

    quality_threshold: float = 7.0

    # Timeout
    generate_timeout: int = 300  # seconds

    redis_url: str = "redis://redis:6379/0"
    database_url: str = "postgresql+psycopg://drama:drama@postgres:5432/drama"
    # ---- DB 连接池 ----
    # 主库 max_connections=100 是全局共享的: web(orchestrator) + 每台弹性算力 worker 都各自持一个池。
    # 若所有进程都用大池(20+40=60), 多进程叠加会冲破 100 → "too many clients already"(报错端口 15433 = worker 经 SSH 隧道连主库)。
    # 因此拆成可配置: web 用大池扛用户并发; worker 单任务串行(job 内并发打的是外部生图/配音 API, 不是打库), 只需极小池。
    # worker 侧通过环境变量 DB_POOL_SIZE / DB_MAX_OVERFLOW 覆盖成小值(如 3 / 5)。
    db_pool_size: int = 20
    db_max_overflow: int = 40
    db_pool_timeout: int = 30
    db_pool_recycle: int = 1800

    # ---- TikHub 短视频大数据 (抖音检索/下载/榜单/互动数据) ----
    tikhub_api_key: str = ""
    tikhub_base_url: str = "https://api.tikhub.io"
    tikhub_enable: bool = True
    tikhub_timeout: int = 60                    # 单次外部请求超时(秒)
    tikhub_cache_ttl_search: int = 1800          # 搜索结果缓存30分钟(降本)
    tikhub_cache_ttl_board: int = 7200          # 榜单/热点缓存2小时(降本, 热榜变化慢)
    tikhub_cache_ttl_detail: int = 3600         # 视频详情缓存(秒)
    tikhub_cache_ttl_comments: int = 900        # 评论缓存(秒)

    # ---- 阿里云 OSS (大文件直传) ----
    aliyun_oss_access_key_id: str = ""
    aliyun_oss_access_key_secret: str = ""
    aliyun_oss_bucket: str = ""
    aliyun_oss_region: str = "__REDACTED__"
    aliyun_oss_endpoint_internal: str = "__REDACTED__-internal.aliyuncs.com"
    aliyun_oss_endpoint_public: str = "__REDACTED__.aliyuncs.com"

    # 飞书(Lark)开放平台自建应用凭证; 用于多维表格(Bitable)读写 + 云文档附件下载
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    # 飞书开放平台域名(国内 open.feishu.cn / 海外 open.larksuite.com)
    feishu_base_url: str = "https://open.feishu.cn"
    # 飞书视频永久跳转链接的签名密钥(用于 /v1/feishu/video/{job_id}?t=... 的匿名下载 token)
    feishu_video_link_secret: str = "change-me-feishu-video-secret"
    # 飞书扫码登录的回调地址前缀(不含 /v1/auth/feishu/callback)。
    # 必须与飞书后台【开发配置→安全设置→重定向URL】登记的完全一致, 否则授权被拒。
    # 例: http://<公网地址>/api  或 http://<公网地址>:9080/api
    # 留空则按当前请求推断(反代场景下需保证 X-Forwarded-Proto/Host 正确)。
    feishu_login_redirect_base: str = ""
    # 平台对外基址(拼接写回飞书的永久视频链接); 生产应配成 http://<公网地址>
    public_base_url: str = ""
    # 飞书表格链接(.../wiki/<节点>?table=<表>): 短剧链接库(批量反推的默认表)与制作表格(飞书自动化的固定表)。
    # 留空时对应接口要求调用方给出表格链接。
    feishu_link_library_url: str = ""
    feishu_production_table_url: str = ""

    # ---- 火山方舟 ARK (豆包视频理解/反推; 视频生成暂用 RunningHub) ----
    # 实测: 视频理解走 chat/completions 多模态, video_url 传公网直链, 豆包原生理解(不需我们抽帧)
    ark_api_key: str = ""
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    # 视频理解(反推)模型真实ID(方舟控制台需开通)
    ark_video_understand_model: str = "doubao-seed-2-1-pro-260628"
    # 反推抽帧密度(传给豆包的 video_url.fps; 豆包侧抽帧, 非我们本地抽帧)
    ark_video_understand_fps: float = 1.0
    # 大视频专用 TOS 桶(仅当文件 >512MB 时启用, 走 Files API 的 tos 参数, 上限 2GB)。
    # ⚠️ 两个硬性前置: ① 桶必须在 **cn-beijing**(方舟视频理解只部署在北京,
    # 上海桶报 "this deployment only supports buckets in region cn-beijing");
    # ② 必须在方舟控制台「项目设置 → 项目授权」给该 TOS 资源授权, 否则 403。
    # 留空则大文件直接报错提示如何配置, 不会静默降级到受 50MiB 限制的 URL 直连。
    ark_tos_bucket: str = ""
    ark_tos_prefix: str = "ark-files/"

    # ---- 火山官方方舟 (统一接入 + 计费; 替代旧 ark_* key 与 RunningHub Seedance) ----
    # 视频理解(seed2.1pro)与视频生成(seedance-2.0)统一走这套官方凭证 + endpoint id。
    volc_ark_api_key: str = ""
    volc_ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    volc_seed21pro_ep: str = ""   # 视频理解/反推 endpoint id (ep-xxx)
    volc_seedance_ep: str = ""    # Seedance 2.0 视频生成 endpoint id (ep-xxx)
    aliyun_oss_key_prefix: str = "drama/"
    aliyun_oss_presign_ttl_seconds: int = 600         # 预签名 URL 有效期 10 分钟

    # ---- CDN 加速分发 (auto.jubianai.net 回源 TOS 桶) ----
    # cdn_public_base_url: 命中 cdn_public_prefixes 的 key 直接拼成 <base>/<key> 公开直链(走 CDN 加速),
    #   而非预签名 URL。空字符串=关闭(所有 key 维持现有预签名行为, 零影响)。
    # cdn_public_prefixes: 逗号分隔的 key 前缀白名单(相对 key, 含 aliyun_oss_key_prefix), 只有匹配这些前缀的
    #   对象才走 CDN 公开直链; 未命中的对象仍回退到预签名, 便于按业务/前缀灰度。
    cdn_public_base_url: str = ""
    cdn_public_prefixes: list[str] = []
    aliyun_oss_chunk_size: int = 8 * 1024 * 1024      # 分片 8MB (OSS 要求 ≥5MB)
    aliyun_oss_session_ttl_seconds: int = 24 * 3600   # 单次上传会话 24 小时过期
    aliyun_oss_max_file_size: int = 50 * 1024 * 1024 * 1024   # 单文件 50GB 上限
    aliyun_oss_max_pending_per_user: int = 20         # 单用户最多并发待上传会话
    # 2026-11-10：5 → 20。批量反推页的「同时上传」最大可选 8 个文件，上限 5 与它
    # 设计上冲突 —— 用户选 8 时第 6 个文件一 init 就 429，跟残留会话无关。
    # 配合 routes.init 只统计未过期会话之后，20 足够防刷也不会误伤正常并发。

    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]

    @field_validator("cors_origins", "cdn_public_prefixes", mode="before")
    @classmethod
    def _split_csv_or_json(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json as _json
                return _json.loads(v)
            return [x.strip() for x in v.split(",") if x.strip()]
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
