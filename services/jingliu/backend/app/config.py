"""FilmWeaver 后端配置。所有密钥从环境变量读取，绝不硬编码入库。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

#: .env 必须按**模块位置**定位，不能写相对路径（B36）。
#: `env_file=".env"` 是相对**进程 CWD** 解析的：systemd 单元里有
#: WorkingDirectory=…/backend 所以线上没事，但任何从别处启动的进程
#: （在仓库根跑脚本、cron、`python -m app.xxx`、pytest）都读不到这个文件，
#: 而 pydantic 缺文件不报错 —— 于是静默退回**全部默认值**：
#: API KEY 变空串（provider 显示"未配置"）、gateway 指向默认网关。
#: 表现是"同一份代码在服务里正常、我手动跑就说没配密钥"，极难定位。
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FW_", env_file=str(_ENV_FILE),
                                      extra="ignore")

    env: str = "dev"
    host: str = "127.0.0.1"
    port: int = 8002  # dev 专属端口，与 drama-dev(8001)/prod(8000) 隔离

    # 本服务的公网可达前缀（不含 /fw 或 /fwp，仅 host:port）。
    # ⚠️ 勿为此新开对外端口——复用既有 9080 即可（端口暴露规则）。
    public_base_url: str = "http://118.196.33.51:9080"

    # 媒体的公网可达前缀（**含** nginx 的环境前缀）。留空则按 env 推导：
    #   dev  → {public_base_url}/fw   （nginx location /fw/  → 8002）
    #   prod → {public_base_url}/fwp  （nginx location /fwp/ → 8003）
    # 用途：把库里存的相对地址 /fw/media/... 拼成**远端 API 能拉到**的绝对地址。
    # 仅"出网那一刻"拼接，DB 仍存相对地址（换域名/迁服务器不失效）。
    #
    # ⚠️ 为什么不能直接用 public_base_url 拼：库里的相对地址前缀恒为 `/fw`
    # （media.py 里写死，与环境无关），prod 进程照原样拼出来就是
    # http://…:9080/fw/media/… —— 那条路由指向 **dev 后端 8002**，
    # 而文件在 prod 的数据目录里，远端拉取必 404。
    # 2026-09-02 现网事故即此：火山私域素材入库报 DownloadFailed、
    # 视频生成报 `content[1].image_url … resource not found`。
    # 故默认值必须能从 env 自动推出，不能依赖 .env 里多写一行（漏写=静默复发）。
    media_public_base: str = ""

    @property
    def media_base(self) -> str:
        """媒体出网基址（含环境前缀，无尾斜杠）。"""
        if self.media_public_base:
            return self.media_public_base.rstrip("/")
        prefix = "/fwp" if self.env == "prod" else "/fw"
        return f"{self.public_base_url.rstrip('/')}{prefix}"

    # 飞书登录回调的**对外**基址（含 nginx 的 /fw 前缀）。
    # 必须与飞书后台【安全设置 → 重定向 URL】登记的地址完全一致，否则授权被拒。
    # ⚠️ 不能复用 public_base_url：那个不带 /fw，而 nginx 的
    # `location /fw/ { proxy_pass http://127.0.0.1:8002/; }` 带尾斜杠会剥掉前缀，
    # 于是"对外要带 /fw、后端收到的是不带 /fw 的路径"——两者天然不同。
    # 用户已登记：http://118.196.33.51:9080/fw/v2/auth/feishu/callback
    feishu_callback_base: str = "http://118.196.33.51:9080/fw"

    # OpenAI 兼容网关（LLM/图像/视频 Provider 共用）。
    # 2026-08 起默认 zx1.deepwl.net：原 ai.kegeai.top 网关已失联（TLS reset + key 401），
    # zx1 为 drama 系列生产在用网关，文本(grok-4)/图像(gpt-image-2) 均实测可用。
    # （该网关的视频 veo-3-1-fast/veo-3-1 已于 2026-09-19 按要求删除，不再注册。）
    gateway_base_url: str = "https://zx1.deepwl.net/v1"
    gateway_api_key: str = ""  # 文本/视频通道 KEY，从环境注入，勿写死
    #: zx1 上 **gpt 系文本模型**专用 KEY（FW_GATEWAY_GPT_API_KEY，2026-10-17）。
    #: 用户提供：这把 key 跑 gpt 相对稳定。只影响文本/视觉调用（providers/llm.py），
    #: 不影响图像与视频通道。留空 = 回退 gateway_api_key（= 加它之前的行为）。
    gateway_gpt_api_key: str = ""
    # 图像通道独立 KEY（gpt-image-2 渠道）；留空则回退 gateway_api_key
    image_api_key: str = ""

    # ---- 兼容旧变量名（FW_KEGEAI_*）：仍可注入，作为回退 ----
    kegeai_base_url: str = ""
    kegeai_api_key: str = ""

    @property
    def llm_base_url(self) -> str:
        return (self.gateway_base_url or self.kegeai_base_url).rstrip("/")

    @property
    def llm_api_key(self) -> str:
        return self.gateway_api_key or self.kegeai_api_key

    @property
    def img_api_key(self) -> str:
        return self.image_api_key or self.llm_api_key

    # ---- 火山方舟（Seedance 2.0 视频生成）----
    # ep = 方舟推理接入点 id；留空则对应模型不注册（同 RunningHub 模式）
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    ark_api_key: str = ""                # 从环境注入，勿写死
    #: 官方 Seedance 通道出片前，是否由镜流**自己**把人像参考图入进火山私域人像库
    #: （`providers/volcano_assets.py`，用下面的 AK/SK）再换成 asset:// 引用。
    #:
    #: 直连火山方舟时必须为真（默认）：不入库的人像参考图会被人脸审核拦下。
    #: 走统一网关（`FW_ARK_BASE_URL=https://gw.jubianai.net/doubao/api/v3`）时设为假
    #: （`FW_ARK_TRUSTED_ASSETS=false`）：私域人像入库由网关自动做，而镜流自己账号里的
    #: asset:// 编号在网关背后的火山账号上取不到——继续换只会让整镜被打回。
    #: 设为假时参考图按原始地址下发，AK/SK 也不必再配。
    ark_trusted_assets: bool = True

    # ---- 私域虚拟人像素材库（解决 Seedance 人脸审核拦截）----
    # AI 生成的定妆图直传会被判"疑似真人"拒绝（实测 40 镜里 39 镜栽在这），
    # 入库成可信资产后用 asset://<id> 引用即可过审。
    # 走火山原生 v4 签名（AK/SK），与 ark_api_key 的 Bearer 鉴权是两套。
    volc_access_key: str = ""            # 从环境注入，勿写死
    volc_secret_key: str = ""            # 从环境注入，勿写死
    #: 资源项目名。素材与推理接入点**必须同项目**，否则生成时取不到素材。
    volc_project_name: str = "juying"
    seedance_ep: str = ""                # Seedance 2.0 接入点
    seedance_mini_ep: str = ""           # Seedance 2.0 mini 接入点
    # ---- 数据目录（prod 与 dev 必须隔离）----
    # dev 默认 filmweaver-data，prod 由 FW_DATA_DIR 设为 filmweaver-prod-data。
    #
    # ⚠️ 这一项**只能**通过 `media.DATA_DIR` / `media.GENERATED_DIR` 使用，
    # 任何模块都不许再写 `Path(".../filmweaver-data/...")` 字面量：
    # 该设置 2026-08-28 拆 prod 时只在 prod 仓改了 media.py/main.py，
    # providers/image.py 与 providers/video.py 的硬编码被漏掉，结果生产用户
    # 生成的每一张图都写进了 **dev** 的数据目录，而库里存的 URL 由 prod 的
    # StaticFiles/_resolve_local 按 prod 目录解析 → 图全 404、出片时报
    # 「参考素材不可用」。见 2026-09-01 的修复说明。
    data_dir: str = "/root/filmweaver-data"

    # ---------------- 对象存储（火山 TOS，与剧本平台同一个桶）----------------
    # 全部留空 = 关闭，一切维持"只用本地盘"的老行为（见 storage.enabled()）。
    #
    # ⚠️ 桶与剧本平台共用（`jubian-juben`），但 **key 前缀必须互不重叠**：
    #   剧本平台 drama/          织影/镜流 dev  shotflow/dev/
    #                            织影/镜流 prod shotflow/prod/
    # dev 与 prod 分前缀不是洁癖——共用一个前缀时，dev 的清理脚本会顺手删掉
    # 生产素材，而那是不可逆的。
    tos_bucket: str = ""
    tos_endpoint: str = "tos-cn-shanghai.volces.com"
    tos_region: str = "cn-shanghai"
    tos_access_key_id: str = ""
    tos_access_key_secret: str = ""
    tos_key_prefix: str = ""          # 形如 shotflow/dev/
    #: 交给浏览器、Muse 客户端与远端服务的预签名地址用的主机（不含桶名）。
    #: 留空 = 与 `tos_endpoint` 相同。服务端自己读写桶可以走内网 endpoint，
    #: 但内网主机名在服务器之外解析不到，所以凡是交出去的地址都签这一个。
    tos_public_endpoint: str = ""

    #: 哪些子目录归桶管。appcast 刻意不在内：桌面客户端更新器读
    #: /fw/media/appcast/latest.json，改成 302 跳转未经验证，而出问题时
    #: 影响的是正式版客户端的自动更新。outputs 可再生，也不值得进桶。
    #: character-references（Muse 角色参考图）与 exports（剪映导出包，
    #: 只认 `exports/jianying/<文件>`）各占自己的前缀。
    tos_dirs: list[str] = ["generated", "uploads", "character-references", "exports"]

    #: 写进桶之后是否还留本地副本（FW_MEDIA_KEEP_LOCAL）。
    #: true = 与改动前相同：本地一直留着，只按盘水位淘汰。
    #: false = 写出文件的那一步任务结束时删本地副本（桶里确认存在才删），
    #: 不属于任何任务的文件在巡检时满 `media_cache.MIN_AGE_SEC` 再删；
    #: 之后要读本地文件的地方经 `media.ensure_local` 从桶拉回。
    #: 每个客户端都改用 `POST /v2/media/resolve` 下载之后再设为 false。
    media_keep_local: bool = True

    #: 本地缓存水位：盘用量超过 high 就开始淘汰最久未用的**已上传**文件，
    #: 降到 low 为止。按剩余空间自适应，换盘/清理后自动跟随，不必手改绝对值。
    cache_disk_high_pct: int = 80
    cache_disk_low_pct: int = 70

    #: Seedance 2.5 接入点。最大差异是**单镜可出 30s**（2.0 只有 15s），
    #: 解说剧拆镜会自动按这个上限放长（见 base.max_seconds → shot_seconds_cap）。
    seedance25_ep: str = "ep-20260831181525-qvct4"

    # ---- RunningHub（ComfyUI 工作流平台）：MiniMax H3 参考图生视频通道 ----
    # 该通道能力与 veo 互补：可吃最多 9 张参考图 + 参考音频 + 参考视频，
    # 分辨率/比例/时长/seed 均可精确控制（实测见 docs/RUNNINGHUB-MINIMAX-H3.md）。
    runninghub_base_url: str = "https://www.runninghub.cn"
    runninghub_api_key: str = ""              # 从环境注入，勿写死
    # MiniMax H3 Reference-to-Video 工作流 id
    #
    # ⚠️ 2026-10-30 换工作流：旧的 2084464684937342977 被作者改成了**无音频输入**版本
    # （代码登记的 #155 LoadAudio 已从工作流里消失，带音色参考提交直接 NODE_INFO_MISMATCH）。
    # 新工作流 2091068769136365570 起同名，图槽/提示词/时长/seed 完全一致，
    # 音频从 1 路变成 **3 路**（#161 / #155 / #162 → ref_video_audio_0..2），
    # 终于能"旁白一个音色 + 几个角色各一个音色"。
    # 映射见 providers/video_runninghub.py::REF2V_AUDIO_NODES（按工作流 id 选表）。
    runninghub_h3_workflow_id: str = "2091068769136365570"
    # ---- H3 其余生成模式的工作流 id（留空=该模式不可用，UI 置灰并提示）----
    # i2va(首帧生视频)：2026-08 接入，工作流与全参考那条**节点号完全不同**
    # （提示词 #55.text / 时长 #58 / seed #235 / 分辨率 #59 / 单图槽 #61、无音频节点），
    # 映射见 providers/video_runninghub.py::I2VA_NODES。
    runninghub_h3_i2va_workflow_id: str = "2086982586613714946"
    # fl2va(首尾帧生视频)：2026-08 接入，节点号又与上面两条都不同
    # （提示词直接写在 #332 MiniMaxH3ImageToVideo 的 **prompt** 输入上 /
    #  时长 #346 / seed #338 / 分辨率 #349 / 首帧槽 #61 + 尾帧槽 #73、无音频节点），
    # 映射见 providers/video_runninghub.py::FL2VA_NODES。
    runninghub_h3_fl2va_workflow_id: str = "2086993488448675842"
    # 尾帧(l2va)当前账号尚无对应工作流，用户提供后填环境变量即开通（代码零改动）：
    runninghub_h3_l2va_workflow_id: str = ""    # FW_RUNNINGHUB_H3_L2VA_WORKFLOW_ID
    # 机型档位：plus=48G(¥6/h，默认) / default=24G(¥4/h) / ultra=84G(¥9/h)
    # 默认走 plus：24G 只有 15 MP·s 预算（0.5MP 下单镜 30s），48G 有 20
    # （同档 40s）。多 ¥2/h 换来少 1/3 的镜头数，综合更省。ultra 与 plus
    # 实测逐点同能力（见 video_runninghub.py::_VRAM_BUDGET_MPS），别选。
    # ⚠️ 改这里会同时改变拆镜的单镜时长上限——两者刻意同源。
    runninghub_instance_type: str = "plus"
    # ---- TTS（IndexTTS-1.5 语音克隆）工作流：与主平台 audio_studio 同一工作流 ----
    # 2026-08 实测：upload→create(带 workflowJson 临时运行)→status→outputs 全链路 OK，
    # 单段约 60-70s、¥0.074/段。留空=音频轨 TTS 不可用（前端置灰提示）。
    runninghub_tts_workflow_id: str = "2065316868176564226"

    # ---- 高清放大（SeedVR2 超分）----
    # 这条与上面所有工作流有一个**协议层差异**：提交时带完整的工作流 JSON
    # （`workflow` 字段），不只传 workflowId —— 实测只传 workflow 会报
    # `code=301 must not be null`，而补上任意一个本账号私有的 workflowId 后，
    # 真正执行的是 `workflow` 那张图。
    # ⚠️ 2026-10-18 起改用**本账号保存的 SeedVR2 工作流**（2097593988688736258，
    #    节点与 providers/upscale.py 的 `_graph` 逐节点一致）。此前借用 H3 那条的 id
    #    作凭据，能跑但 RunningHub 后台按 workflowId 归类，所有高清任务都记在
    #    「海螺 H3」名下，用户在后台对不上账。
    # 留空 = 高清放大不可用（沿用 l2va 先例）。实现见 providers/upscale.py。
    runninghub_upscale_workflow_id: str = "2097593988688736258"

    # ---- 火山 AI MediaKit 画质增强（标准版 1080P，2026-11-09 接入）----
    #
    # 与 RunningHub SeedVR2 是**两条完全不同的协议**：那边传 ComfyUI 工作流图、
    # 按机时计费、产物自带音轨、输出短边 1088；这边传一个 video_url、
    # 按输出时长计费、**产物没有音轨**（由我们 mux 回原片音轨，见
    # providers/upscale_mediakit.py）、输出 1920×1080。
    #
    # 实测（2026-11-09，8 秒 720p → 1920×1080 h264 7.15Mbps）：耗时 164 秒，
    # 约 20 倍 RTF；SeedVR2 同长度约 70 倍。官方口径：≤20s 片子 RTF≈22、长片 6–10。
    #
    # ⚠️ 鉴权是 Bearer + **MediaKit 专用 api key**（`AKLT…` 开头），
    #    不是方舟的 `ark-…` key，也不是需要 SK 的 OpenAPI AK。混用会 403
    #    `InvalidAPIKey`（2026-11-09 实测：服务器上原有的 3 把火山 key 全部不可用）。
    mediakit_api_key: str = ""                    # FW_MEDIAKIT_API_KEY
    mediakit_base_url: str = "https://mediakit.cn-beijing.volces.com/api/v1"
    #: 目标分辨率。枚举：240p … 4k 6k 8k。**标准版**工具用这个字段；
    #: 极速版/大模型版是另外两个端点（/tools/enhance-video-fast / -generative）。
    mediakit_resolution: str = "1080p"            # FW_MEDIAKIT_RESOLUTION
    #: 场景提示。`aigc` = AI 生成素材（官方推荐），老片修复用 `short_series` 等。
    mediakit_scene: str = "aigc"                  # FW_MEDIAKIT_SCENE

    #: 走哪条超分通道：`mediakit`（默认）| `runninghub`。
    #:
    #: ⚠️ 这**不是**给用户选的开关，是运维级的回退路径：火山出问题（额度、审核、
    #:    上游故障）时改一个环境变量就能切回 SeedVR2，界面零变化。
    #: 刻意**不做运行时自动降级** —— 两条通道产物特性不同（1088 带音轨 vs
    #: 1080p 纯画面），静默换渠道会让同一批片子的观感不一致。见
    #: providers/upscale.py::pick_upscale_provider。
    upscale_channel: str = "mediakit"             # FW_UPSCALE_CHANNEL

    # ---- 拆解流程（2026-11-10）----
    #: legacy   = 老流程：模型一次给出 JSON（14 个键，含时长与导演意图），代码事后并碎片
    #: segments = 新流程：模型切段（散文）→ 代码按模型上限装箱，只在换场时断开
    #: 灰度开关：默认 legacy，dev 验证通过后再切。解说剧不受影响（始终走老流程）。
    breakdown_mode: str = "legacy"                # FW_BREAKDOWN_MODE

    # ---- 去字幕（擦除视频模型烧进画面的原生字幕）----
    # 用途不是擦织影自己的软字幕轨（那条根本没烧进画面，关掉即可），而是
    # **seedance 等视频模型偶尔把台词烧进成片**这一类不可逆的脏数据
    # （全库抽样实测约 5.5% 成片中招）。
    #
    # ⚠️ 2026-11-13 通道从第三方（yudian）换成**火山 MediaKit 字幕擦除（精细版）**。
    # 旧通道会改输出帧率、产物帧数不可控，而我们的拼接按帧接、音轨整条 copy，
    # 一错开就是永久的音画错位（见 docs/AUDIT-2026-11-12-去字幕音画不对应.md）。
    # 现在整条送、整条回，没有拼接环节。**复用 `mediakit_api_key`，不再有第二把钥匙**。
    #
    # 能力边界与实测结论见 providers/mediakit_erase.py。
    desub_poll_interval: float = 10.0          # FW_DESUB_POLL_INTERVAL

    # 默认模型（可用环境变量覆盖；与 zx1 网关实测可用渠道对齐）
    #
    # ⚠️ⓘ 这是一个**临时的、当前最优的**选择，不是"选定了就用下去"。
    #   它是三条渠道(zx1 / api4me / modelverse)共同上架、且实测可用的模型里
    #   性价比最高的一个，于是当初被拿来当默认值；但它是 flash 档，
    #   在需要**强结构约束**的任务上（尤其 Agent 的"只回一个 JSON 对象"）
    #   属于勉强够用 —— 见 `agent_proxy._SYSTEM_HEAD` 与 `llm.py` 的 JSON mode 注。
    #   **一旦出现更合适的模型（更强的指令跟随 / 原生 JSON mode / 更长上下文），
    #   就应该换掉这里**（改本常量或 FW_LLM_MODEL 环境变量，代码零改动）。
    #   换之前先跑 `desktop` 的 `npm run verify:agent`（提示词契约版本在
    #   `agent_proxy.AGENT_CONTRACT_VERSION`，换模型不一定要升版，换**提示词格式**才要）。
    llm_model: str = "gemini-3.6-flash"      # 缺省文本模型（未指定用途时）
    # ---- 按用途分工的文本模型（2026-10-10 基准选型）----
    #
    # 为什么分工：基准（scripts/bench_llm_models.py，同框架只换模型）实测两项的
    # **最优不是同一个模型**，且差距明显：
    #   · 提示词构建 → gpt-6-sol。唯一在"画面具体度/戏剧意图/忠实度"上同时被
    #     盲评判为最优的产出，且写出了基线完全缺失的**空间轴线保护**
    #     （"摄影机连续位于南侧…不越轴"），越轴正是人物左右突然对调的主因。
    #   · 拆解 → gpt-5.6-terra。盲评五项里四项第一（可执行 9/具体度 9/戏剧意图 9/
    #     忠实度 9），镜头切分最细（19 刀 vs 基线 13 刀）。
    #
    # ⚠️ 两者都比 flash 档慢得多（拆解 188s vs 24s），故 `llm_timeout` 必须同步抬
    # （见下）。用户已明确接受"变慢与成本增加"。
    #
    # ⚠️ 空字符串 = 回落到 `llm_model`。**回滚就是把环境变量设成空串**
    # （FW_LLM_MODEL_BREAKDOWN= / FW_LLM_MODEL_PROMPT=），不必改代码。
    # 默认值写在代码里而不是 .env：这是要随仓库走的技术选型，不是某台机器的
    # 环境差异；写在这里，换了人接手也看得出"现在跑的是哪个模型、为什么"。
    llm_model_breakdown: str = "gpt-5.6-terra"   # 拆解：do_breakdown
    llm_model_prompt: str = "gpt-6-sol"          # 提示词构建：optimize_full / _to_prompt_detailed
    # 文本调用超时（秒）。**与 request_timeout 分开**：那个还管图像/视频/ASR，
    # 给文本调到 600 会把所有路径一起拖长。gpt-6-* / gpt-5.6-* 在 2784 字切片上
    # 实测要 64~188s，而 120s 的旧值会让它们成批超时（实测 gpt-6-sol ReadTimeout）。
    llm_timeout: int = 600
    # LLM 输出上限：>0 显式随请求带输出上限字段（顶掉网关可能偏小的默认值，
    # 应设为模型输出硬上限附近）；=0 省略该字段走网关默认。
    # 注：协议上无"无限"取值——每个模型都有输出硬上限，防截断的根本手段是输入分块。
    #
    # ⚠️ 字段名由**模型**决定，不是由渠道决定：gpt-6-* / gpt-5.6-* 只认
    # `max_completion_tokens`，带 `max_tokens` 会被 modelverse 直接 400
    # （"Unsupported parameter: 'max_tokens' is not supported with this model"），
    # 而 zx1 / kege 两种都收。判定见 providers/llm.py::_max_tokens_key，
    # 且**遇到明确拒绝会记住并改口**，所以新模型上线不必先改代码。
    llm_max_tokens: int = 16384
    image_model: str = "gpt-image-2"          # 图像：资产生图
    # 视频：镜头生成。**2026-09-19 起是 minimax-h3-ref2v**（原为 veo-3-1-fast，
    # 用户要求删掉 veo 两个模型）。此值必须指向一个**已注册**的 provider：
    # 它在 5 个调用点（`routes_v2.generate_shots` / `jobs` 三处 / `readiness`）
    # 作为缺省模型下发，指向未注册的 id 会直接报「未注册的视频模型」。
    # 与前端 `ProjectList.DEFAULTS.video` 保持一致；环境变量 FW_VIDEO_MODEL 可覆盖。
    video_model: str = "minimax-h3-ref2v"

    # ---- kege 中转站（2026-10-10 接入，**替换已全线失效的 api4me**）----
    #
    # 为什么换：api4me 2026-10-09 起全线报 403「user quota is not enough」，
    # 文本/图像/ASR 三处兜底同时断掉，等于第二顺位渠道实际不存在。
    # kege 是主平台 drama 已完成测试并替换的同一家（见 drama 40e1c3b），
    # 本平台按同一套配置接入，域名与分组口径与那边一致。
    #
    # ⚠️ 与 config 顶部那个**旧的** `kegeai_*`（ai.kegeai.top，2026-08 已失联）
    #    是**两家不同的服务**，别互相回退：那边 TLS reset + key 401，早已废弃。
    #
    # 四把 key 按厂商分组，不可混用（与 drama 同口径）：
    #   gemini-*  → gemini key      gpt-*/o* → gpt key
    #   claude-*  → claude key      其余（grok/deepseek…）→ grok key
    # 选哪把由模型名自动判定，见 providers/llm.py::_kege_key。
    # ⚠️ 不给 base_url 默认值：`FW_KEGE_BASE_URL` 没配就整条渠道不存在，
    #    行为与接入前完全一致（与 modelverse 同款设计）。
    kege_base_url: str = ""               # FW_KEGE_BASE_URL

    # ---- DeepSeek 官方 API（2026-10-30，桌面端 deepseek-flash 用）----
    #: 只对 deepseek-* 模型生效，且排在所有中转站**之前**（用户裁定「官方渠道优先」）。
    #: 不配 = 这条渠道不存在；deepseek-flash 实测各中转站都没有（503/400），等于桌面端不能选它。
    deepseek_api_key: str = ""            # FW_DEEPSEEK_API_KEY
    deepseek_base_url: str = "https://api.deepseek.com/v1"

    # ---- 阿里云百炼官方渠道（2026-11-05，DeepSeek Flash 优先走它）----
    #: 只对 deepseek-flash 生效，排在 DeepSeek 官方之前（用户裁定）。百炼上的型号名与我们的模型 id 不同，
    #: 请求时按 bailian_deepseek_flash_model 改写。不配 key = 这条渠道不存在，行为与接入前一致。
    #: 与下方语音识别的 FW_BAILIAN_API_KEY 是两把不同的 key，名字分开别混用。
    bailian_llm_api_key: str = ""         # FW_BAILIAN_LLM_API_KEY
    bailian_llm_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    bailian_deepseek_flash_model: str = "deepseek-v4.1-flash-1017"
    kege_gemini_api_key: str = ""         # FW_KEGE_GEMINI_API_KEY
    kege_gpt_api_key: str = ""            # FW_KEGE_GPT_API_KEY
    kege_claude_api_key: str = ""         # FW_KEGE_CLAUDE_API_KEY
    kege_grok_api_key: str = ""           # FW_KEGE_GROK_API_KEY

    # ---- api4me 中转站（与 zx1 互为兜底，图像 + 文本共用）----
    #
    # ⚠️ **2026-10-10 起已被 kege 替换，留在此处只为回滚与 ASR**：
    #    该号 2026-10-09 起全线 403 额度不足，文本/图像渠道链里不再使用它。
    #    唯一仍在用的是 **ASR（语音识别）**——kege 没有 whisper 系模型
    #    （84 个模型全表核过，无 whisper/audio/transcribe），
    #    故 ASR 若也要恢复，得另找承载 whisper 的中转站，不是本次能解决的。
    #    两把 key 分组不同不可混用：API4ME_API_KEY=gpt-image-2/z-image/非 gemini 文本分组，
    #    API4ME_GEMINI_API_KEY=优质 gemini 分组（仅 gemini 系模型）。
    api4me_base_url: str = "https://ai.api4me.xyz"
    api4me_api_key: str = ""              # FW_API4ME_API_KEY
    api4me_gemini_api_key: str = ""       # FW_API4ME_GEMINI_API_KEY

    # ---- 阿里云百炼（Paraformer 非实时语音识别，2026-10-20）----
    #
    # 为什么需要它：ASR 的唯一通路 api4me 自 2026-10-09 全线 403 停用后，
    # **key 一直是空的**（`ASRProvider.available` 恒为 False），于是
    # 「自动生成字幕」在 dev 与 prod 都从未成功过——用户看到的
    # 「没有可识别的旁白音频」其实是「没有一条能用的识别通道」。
    #
    # 为什么选 Paraformer 而不是继续找 whisper 中转站：
    #   · 时间戳更细：句级 + 字级（whisper 只有句级），长句可按字级二次切分；
    #   · 单文件限额宽：2 GB / 12 小时（whisper 接口 25 MB）；
    #   · **无「请不吝点赞订阅转发」这类幻觉**——Paraformer 是非自回归模型，
    #     而那是 whisper 权重里的已知行为（见 docs/PLAN-本地ASR方案.md）；
    #   · 便宜：0.00008 元/秒 ≈ 0.288 元/小时。
    #
    # ⚠️ 非实时接口是**异步任务式**（提交 → 轮询 task_id → 取 transcription_url），
    #   不是同步返回。实现见 `providers/asr_bailian.py`。
    bailian_api_key: str = ""             # FW_BAILIAN_API_KEY
    bailian_asr_model: str = "paraformer-v2"
    bailian_base_url: str = "https://dashscope.aliyuncs.com/api/v1"

    # ---- 万相 wan3.0 视频生成（阿里云百炼官方，2026-11-02 接入）----
    # 与上面 ASR 是同一平台但**不同的 key**（用户单独提供），分开配置互不影响。
    # 未配 key 时不注册该模型（同 RunningHub / 方舟）。实现见 providers/video_wan.py。
    wan_api_key: str = ""                 # FW_WAN_API_KEY，从环境注入，勿写死
    wan_base_url: str = "https://dashscope.aliyuncs.com/api/v1"

    @property
    def kege_v1_base(self) -> str:
        """kege 的 OpenAI 兼容基址（补足 /v1，无尾斜杠）。

        文本(providers/llm.py)与图像(providers/image.py)共用同一份拼接逻辑，
        免得两处各写一遍、日后改基址时漏改一处。
        未配 base_url 时调用方应整条渠道跳过——本属性不负责判空。
        """
        b = (self.kege_base_url or "").rstrip("/")
        if b and not b.endswith("/v1"):
            b += "/v1"
        return b

    # ---- modelverse(UCloud) 中转站：第三条渠道，**终极兜底**（2026-09 与主平台对齐）----
    # 单 key 覆盖全部模型，没有 api4me 那种 gemini/非 gemini 分组之分。
    # ⚠️ 排在最后是**成本考量**：单价明显高于前两家，定位是"前两条都挂了才用"。
    # 留空 key = 该渠道不注册，行为与加它之前完全一致。
    modelverse_base_url: str = "https://api.modelverse.cn"
    modelverse_api_key: str = ""          # FW_MODELVERSE_API_KEY

    @property
    def modelverse_v1_base(self) -> str:
        """modelverse 的 OpenAI 兼容基址（补足 /v1，无尾斜杠）。

        文本(providers/llm.py)与图像(providers/image.py)共用同一份拼接逻辑，
        免得两处各写一遍、日后改基址时漏改一处。
        未配 key 时调用方应整条渠道跳过——本属性不负责判空。
        """
        b = (self.modelverse_base_url or "").rstrip("/")
        if b and not b.endswith("/v1"):
            b += "/v1"
        return b

    # ---- 低价 seedance2.5：三条第三方中转渠道，互为兜底（2026-09-15 接入）----
    # ⚠️ 与上面的火山方舟 seedance-2.5 **毫无关系**：不同上游、不同鉴权
    # （不用 FW_ARK_API_KEY、不进可信资产库）、不同失败模式。它是注册表里并列的
    # 另一个 model_id（`seedance-lowcost-2.5`），**不是**官方通道的兜底渠道。
    #
    # ⚠️ key 只放这里，**绝不出现在 lowcost_channels.json**——那个文件会进 git，
    # 且渠道增删是数据操作，不该顺带碰密钥。JSON 里只写变量**名**。
    # 留空 = 该渠道不参与；三条全空 = 该模型不注册，行为与加它之前完全一致。
    lowcost_gw1_key: str = ""             # FW_LOWCOST_GW1_KEY（openai-video 方言）
    lowcost_gw2_key: str = ""             # FW_LOWCOST_GW2_KEY（fw-frame 方言）
    lowcost_gw3_key: str = ""             # FW_LOWCOST_GW3_KEY（shanhai 方言）
    # 渠道被判定不可用（余额/无可用渠道/5xx/超时）后的冷却秒数：冷却期内垫底，
    # 但不剔除——宁可多撞一次，也不能出现"无渠道可用"直接失败。
    # 与 image_channel_cooldown 同语义：**只跳过已知坏渠道，不动任何并发数**。
    video_channel_cooldown: int = 300     # FW_VIDEO_CHANNEL_COOLDOWN

    # ---- 文本渠道兜底（2026-08：zx1 欠费导致拆解全失败的直接对策）----
    # 三个中转站承载同一批文本模型、能力等价，任一欠费/无可用渠道/5xx/网络故障
    # 自动切到下一条。顺序可调，逗号分隔；写在前面的优先。
    llm_channel_order: str = "zx1,kege,modelverse"   # FW_LLM_CHANNEL_ORDER
    # 某渠道被判定不可用后的冷却秒数：冷却期内直接跳过，不再逐个请求都去撞一次。
    # ⚠️ 这是"跳过已知坏渠道"，不是降并发——并发数不受影响（遵并发铁律）。
    llm_channel_cooldown: int = 120           # FW_LLM_CHANNEL_COOLDOWN

    #: 临时覆盖**全部**文本调用（含视觉）的模型。排障用：
    #: 怀疑某个模型全线出问题时，一个变量把所有路径切到备选，
    #: 不必去改三个分工字段再逐个回滚。
    #: 只在显式传入的 model_id 为空时生效（显式传参永远优先）。
    llm_model_override: str = ""              # FW_LLM_MODEL_OVERRIDE
    # RunningHub 人像专用文生图工作流（z-image 通道；与主平台同工作流）
    runninghub_portrait_workflow_id: str = "2033845190879879169"

    # ---- 可选 API Token（数据安全）：设置即启用，不设置保持 dev 开放 ----
    # 启用后所有 /v2 写操作需带 Header: X-FW-Token。为未来登录体系前的轻量门锁。
    api_token: str = ""

    # ---- 登录体系（复用主平台用户数据）：设置即启用登录 ----
    # dev 指向 drama-dev orchestrator；未来上线 prod 改为 prod 地址即可（用户数据自动对应）。
    # 启用后 /v2 全部接口（除 auth/app.latest/health/媒体静态）需带会话 token。
    auth_upstream: str = ""  # 如 http://127.0.0.1:8001

    # ---- 视频生成并发与重试（全局池；所有 job/用户共用，满了自动排队）----
    # 并发数由用户统一掌控（遵铁律不擅自降）；seedance/海螺均支持 ≥300 并发
    video_concurrency: int = 300
    # 单镜失败自动重试次数（不含首次）；重试会释放并发槽、退避后重新排队
    video_retries: int = 2
    video_retry_backoff: float = 5.0  # 首次重试退避秒数（指数递增，封顶 60s）

    # 生成任务默认并发（由用户统一掌控，不擅自降；此处仅为初始值）
    default_concurrency: int = 8

    # ---- 长阻塞线程池（与事件循环默认 executor 分开，见 app/executors.py）----
    # 默认 executor 只有 min(32, cpu+4)=20 槽，而全仓 25 处 to_thread 共用它，
    # 其中包括鉴权（每请求、~1ms）与火山人像库入库（最长 180s）。
    # 两者没有业务因果关系却排队在一起 → 出片的人把全站拖慢。
    # 这个池只装"会被外部服务挂住几十秒以上"的调用。
    long_blocking_threads: int = 32

    # ---- 图像生成并发与重试（2026-08：取消并发上限，改用渠道冷却 + 抖动退避）----
    # 0=无上限（真并发数取决于 KEY 自身承载 + 渠道冷却机制自动调节）；>0=信号量上限
    image_concurrency: int = 0
    # 单次生成失败后每个渠道的重试次数（不含首次）；429/超时等瞬态错误会抖动退避重试，
    # 全部重试仍失败→标记该渠道冷却、切下一渠道（与文本渠道同逻辑）
    image_retries: int = 3
    # 渠道被判定不可用后的冷却秒数（欠费/持续限流/5xx）；冷却期内自动跳过该渠道
    image_channel_cooldown: int = 120

    # ---- TTS 并发（解说剧一集就是几十段，串行要跑一小时）----
    # 每段 60-70s，串行是纯粹的浪费——RunningHub 侧各段互不相干，并发不影响音质。
    # 0 = **不设上限**（默认）：RunningHub 并发上限 800，实际生产很难打到，
    # 设人为上限只会白白拖慢。与 image_concurrency 同语义。
    # 需要临时限流时设 FW_TTS_CONCURRENCY=N（>0 即启用信号量）。
    tts_concurrency: int = 0

    # ---- 拆解并发（按集）----
    # 0 = **不设上限**（默认），与 image_concurrency / tts_concurrency 同语义。
    #
    # 此前这里是 `asyncio.Semaphore(6)` **硬编码在 jobs.py 里**，理由是注释里
    # 一句「防几十集同时打爆 LLM 网关」—— 没有任何实测标定，也绕过了配置系统
    # （全项目另外三处闸门都走 settings，只有它没走）。实测单集拆解要 200-250s，
    # 61 集的项目在 6 并发下要排很久。
    #
    # 为什么可以放开：**过载保护已经在 provider 层做掉了** ——
    # LLMProvider 有 429 指数退避（1s→2s，见 providers/llm.py:_post_once）、
    # 渠道级冷却熔断（`_mark_down`/`_healthy`）与健康度排序换渠道。
    # 这正是 image_concurrency / tts_concurrency 放开时的同一个理由：
    # 让 provider 自适应真实承载力，而不是在业务层拍一个数字。
    #
    # ⚠️ 遵并发铁律：这是**取消上限**（放大吞吐），不是降并发。
    # 若仍被网关限流，正确解法是加 API KEY / 提配额，而非把这个值调小。
    #
    # 兜底：拆解的落库竞态由 routes_v2._BREAKDOWN_DB_LOCK 单独保证，
    # 与并发度无关（LLM 调用在锁外，只有落库段持锁）。
    # 需要临时限流时设 FW_BREAKDOWN_CONCURRENCY=N（>0 即启用信号量）。
    breakdown_concurrency: int = 0

    # ---- 积分闸门（P1 下半，2026-10-14）----
    #: 是否在提交生成时预扣积分。**默认开**；设 FW_BUDGET_ENFORCED=0 可整体关掉
    #: （急救开关：组织数据配错导致全平台提交被拒时，一个环境变量即可止血）。
    #: 没有积分账户的用户一律放行（见 app/charge.py 模块文档），
    #: 所以打开它并不会拦住还未登记进组织的人。
    budget_enforced: bool = True

    #: **本服务自己的**管理员名单（逗号分隔的上游用户 id，如 "3"）。2026-10-15 加。
    #:
    #: 本服务没有自己的角色体系：登录时照抄上游（剧变时代平台）给的 role。
    #: 于是"让某人当镜流管理员"原本只能去改上游平台的角色——那会让他在剧变时代
    #: 也成为管理员，超出意图。用户裁定"只在镜流里提权"，故在这里列 id：
    #: 名单里的人在本服务一律按 admin 处理（看全部项目、转交、积分无限、管组织）。
    #: **只升不降**：上游本来就是管理员的人不受影响。
    #: ⚠️ 撤销：从名单删掉并重启**之后**，此人已开着的会话仍是 admin（会话行里存的就是
    #: admin，分不出是上游给的还是本地提的），要让他**重新登录一次**才降回去。
    admin_user_ids: str = ""

    # ---- 飞书开放平台（审批自动拨积分，2026-10-15）----
    #: 与剧变时代扫码登录 / 小说转视频多维表格**同一个应用**（同一组凭据）。
    #: 用的是应用身份（tenant_access_token），不需要任何用户授权。
    #: 不配 = 审批功能整体不可用，积分页的「刷新积分」会明确提示"未配置"。
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_base_url: str = "https://open.feishu.cn"
    #: 同一个人两次「刷新积分」的最短间隔（秒）。冷却内再点直接返回上一次结果，
    #: 不重复访问飞书——用户的要求是"不要有大量无用的网络开销"。
    approval_refresh_cooldown_sec: int = 20
    #: 积分到账 / 分配时是否给用户发飞书机器人消息。默认开；出问题可关掉止血。
    feishu_notify_enabled: bool = True
    #: 通知里"如有问题请找 XXX 反馈"的那个人（填名字即可）
    feishu_notify_contact: str = "管理员"

    # ---- 飞书机器人（P3，2026-10-30）：在飞书里跟镜流对话 ----
    #: 总开关。默认关：不连长连接，事件地址 `/feishu/events` 收到任何事件都拒收。
    feishu_bot_enabled: bool = False
    #: 收事件的方式（飞书后台「事件配置 → 订阅方式」要选同一种）：
    #:   long_connection —— 用官方 SDK 主动连飞书（推荐：不需要公网地址、不需要 Token/Encrypt Key）
    #:   webhook         —— 飞书把事件推到 `/feishu/events`（要配下面两项）
    #: ⚠️ 一个应用只该有一处在收：长连接是「集群模式」，dev 和 prod 同时连上时每条消息随机给其中一个。
    feishu_bot_mode: str = "long_connection"
    #: 官方 SDK（lark-oapi）的安装目录。装在这里而不是系统 Python：系统 Python 生产也在用。
    #: 只追加到 sys.path 末尾，后端自己的 httpx/requests 等永远优先。
    feishu_bot_sdk_path: str = str(Path(__file__).resolve().parent.parent / ".lark-deps")
    #: 开发者后台「事件与回调 → 加密策略」里的 Verification Token。开了机器人却没填 = 全部事件拒收。
    feishu_bot_verification_token: str = ""
    #: 同一页的 Encrypt Key。填了就要求事件加密并校验签名；不填 = 明文事件（只靠 Verification Token）。
    feishu_bot_encrypt_key: str = ""
    #: 是否接群聊。默认只接私聊；开了也只按**发消息的人**的身份办事。
    feishu_bot_allow_groups: bool = False
    #: 「回复 确认」的有效期（秒）。过期后回复确认不再生效，这一步按「不批准」收尾。
    feishu_bot_confirm_ttl_sec: int = 600
    #: 一轮最多等多久就先回一句「还在跑」（秒）；之后结束时仍会再回结果。
    feishu_bot_progress_after_sec: int = 120
    #: 回给未绑定用户的登录入口（网页版地址）。
    feishu_bot_login_url: str = "http://118.196.33.51:9080/sf/"
    #: 飞书机器人转给剧本平台用的内部地址与密钥（orchestrator 的本机端口）。不配 = 机器人只接镜流。
    drama_bridge_url: str = ""
    drama_bridge_key: str = ""
    #: 服务端 Agent 单次请求带的历史上限（字符，约 16 万 token）。超过时先缩旧工具结果，再省略最早的对话。
    agent_context_chars: int = 400_000

    request_timeout: int = 120


@lru_cache
def get_settings() -> Settings:
    return Settings()