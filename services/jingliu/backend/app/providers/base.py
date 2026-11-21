"""Provider 抽象层。新增模型 = 新增一个 Provider 子类 + 注册，不改上层（开闭原则）。"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class VisualMode(str, Enum):
    reference = "reference"      # 全能参考
    first_frame = "first_frame"  # 首帧图


class AudioMode(str, Enum):
    inline = "inline"            # 音画一体
    tts_separate = "tts_separate"  # 独立 TTS


#: 生成模式。模式决定：提示词框架分支 + 工作流路由。
#:
#: 2026-11-20 用户裁定：首帧（i2va）/ 首尾帧（fl2va）/ 尾帧（l2va）三种模式**整体下线**，
#: 只留纯文本与全能参考。理由：首尾帧没人用；官方也推荐"要指定开头 / 结尾画面，就把
#: 那张图放进全能参考"；而统一网关的私域人像入库只覆盖参考图这一个位置。
#: 本表是界面与工具**能选什么**的唯一来源（`GET /v2/providers/video` 原样下发）。
GENERATION_MODES: dict[str, str] = {
    "t2va": "纯文本生成（无参考素材）",
    "full_reference": "全参考生成（参考图/参考音频/参考视频作身份与风格参考）",
}

#: 已下线的三种模式。老项目的 `default_profile.generation_mode`、老镜头的
#: `profile_override.generation_mode` 里还会读到它们——**不迁移数据**，读到一律按
#: 全能参考处理（见 `live_generation_mode`），镜头上留着的首帧 / 尾帧图当参考图带上。
RETIRED_GENERATION_MODES: frozenset[str] = frozenset({"i2va", "fl2va", "l2va"})


def live_generation_mode(mode: str | None) -> str | None:
    """把读到的生成模式换成仍在用的那一个：已下线的三种 → 全能参考，其余原样。"""
    return "full_reference" if mode in RETIRED_GENERATION_MODES else mode


def live_mode_support(support: dict[str, dict]) -> dict[str, dict]:
    """从一个通道的能力表里去掉已下线的模式：界面与工具只该看到还能选的。"""
    return {mode: info for mode, info in support.items()
            if mode not in RETIRED_GENERATION_MODES}


def _tos_direct(path: str) -> str | None:
    """素材在桶里时，返回 TOS 直链；否则 None。

    ## 判据（2026-10-21 改：本地存在也优先给桶直链）

    旧判据是"**本地文件不存在**才给桶直链，本地在就给后端地址"。它基于一个
    错误假设：我方后端能 200 直发，对端就一定拉得动。生产实测推翻了这个假设：

        8 条 `Timeout while downloading url=http://118.196.33.51:9080/fwp/media/...`
        同一条 URL 在火山私域库入库时也报 `DownloadFailed`（日志有闭环）

    交给远端拉的是 **9080 非标准端口、单层 nginx + Python 静态直发的 2–5MB PNG**。
    本机 curl 11–16ms 是 localhost，证明不了公网可达性；48 小时内出片
    1085 成功 / 192 失败，是典型的"链路时好时坏"。对象存储的 CDN 链路则稳定得多。

    所以现在**只要对象已在桶里，一律给桶直链**，不看本地有没有。

    ⚠️ 不能无条件给直链：新生成的文件要等巡检上传（最多 300 秒）才进桶，
    这段时间桶里没有它 —— 给了直链就是 404，比慢更糟。所以必须查台账
    `media_objects`（`upload_pending` 上传成功后才写入）。
    """
    from ..config import get_settings
    s = get_settings()
    if not s.tos_bucket:
        return None
    # path 形如 media/generated/x.png → rel 形如 generated/x.png
    if not path.startswith("media/"):
        return None
    rel = path[len("media/"):]
    if not rel or rel.split("/", 1)[0] not in set(s.tos_dirs):
        return None
    try:
        from .. import storage
        if not storage.enabled():
            return None
        if not _in_ledger(rel):
            return None               # 还没进桶（新文件，等下轮巡检）
        from ..storage import PRESIGN_TTL_REMOTE
        return storage.public_url(rel, ttl=PRESIGN_TTL_REMOTE)
    except Exception:      # noqa: BLE001
        # 查台账/签名失败不致命：退回后端地址（本地/跳转两条路都还在）
        return None


#: `_in_ledger` 的进程内缓存：`rel_path -> (是否在桶里, 写入时刻)`。
#:
#: 为什么要有（2026-10-24）：`_in_ledger` 在**出片热路径**上，是 `to_public_url`
#: 的必经一步 —— 每张参考图、每段音频各一次。170 镜的项目每镜 5~9 张参考图，
#: 就是几百到上千次 `engine.connect()`，全部在**事件循环**上同步取连接。
#: 连接池只有 20+30；撞上出片 runner 自己的写事务时，最坏要等 `busy_timeout`
#: 的 30 秒。这正是"点了批量出片，整站跟着卡"的来源之一。
#:
#: 台账只在 `media_cache.upload_pending` 里"确认上传成功"时**新增**行，在
#: `media_cache.drop_media` 里**删除**行，所以「在桶里」这个事实一旦成立就长期
#: 稳定 —— 缓存它是安全的。反向（不在桶里）不稳定：新文件上传完就变 true，
#: 所以只给很短的有效期。
_LEDGER_CACHE: dict[str, tuple[bool, float]] = {}
_LEDGER_TTL_HIT = 600.0     # 命中（在桶里）：10 分钟。事实稳定，给长一点。
_LEDGER_TTL_MISS = 20.0     # 未命中（还没进桶）：20 秒。上传完要尽快转正。
_LEDGER_CACHE_MAX = 20000   # 防御性上限：超过就整体清空，不做 LRU（不值得）


def invalidate_in_ledger(rel: str | None = None) -> None:
    """让 `_in_ledger` 的缓存失效。

    `rel=None` 清空全部。`media_cache.drop_media` 删台账行之后必须调它 ——
    否则对象被删了，缓存还说"在桶里"，出片会拿到一个已经 404 的地址。
    """
    if rel is None:
        _LEDGER_CACHE.clear()
    else:
        _LEDGER_CACHE.pop(rel, None)


def _in_ledger(rel: str) -> bool:
    """这个对象是否**已确认传进桶**。

    只认 `media_objects` 台账，不做 HEAD 探测：本函数在出片热路径上，
    每个参考图一次 HEAD 等于给提交加一个 RTT，而台账是"上传成功才写"的事实来源
    （见 `media_cache.upload_pending`：ETag 比对通过才 INSERT）。
    查库失败按"不在桶里"处理 —— 宁可给后端地址（慢但能通），也不给一个 404。

    ⚠️ 2026-10-24：加了进程内缓存，见 `_LEDGER_CACHE` 的说明。**命中时不查库**，
    所以这条路径在稳态下不再产生任何数据库往返。删除类操作必须调
    `invalidate_in_ledger`。
    """
    import time as _time

    now = _time.monotonic()
    hit = _LEDGER_CACHE.get(rel)
    if hit is not None:
        val, ts = hit
        if now - ts < (_LEDGER_TTL_HIT if val else _LEDGER_TTL_MISS):
            return val

    from sqlalchemy import text as _text

    from ..db import engine
    try:
        with engine.connect() as conn:
            row = conn.execute(
                _text("SELECT 1 FROM media_objects WHERE rel_path=:r LIMIT 1"),
                {"r": rel}).first()
        val = row is not None
    except Exception:      # noqa: BLE001
        # 查库失败**不缓存**：这是一次性故障，不该被记住 10 分钟。
        return False
    if len(_LEDGER_CACHE) >= _LEDGER_CACHE_MAX:
        _LEDGER_CACHE.clear()
    _LEDGER_CACHE[rel] = (val, now)
    return val


def to_public_url(url: str | None) -> str | None:
    """把库里的相对媒体地址补成**远端 API 能直接拉到**的公网绝对地址。

    远端视频服务（火山方舟 / zx1 chat 通道）是把 URL 字符串塞进请求 JSON 后
    **由远端自己去拉**，相对路径 /fw/media/... 到了对端就是死链——这正是首帧图
    与上传型参考图偶发失效的根因（现网多数资产图是 OSS 绝对地址，故非必现）。

    ⚠️ 库里的前缀恒为 `/fw`（media.py 写死，与环境无关），**必须剥掉再按当前
    环境重拼**：prod 进程若原样拼成 …:9080/fw/media/…，那条 nginx 路由指向
    dev 后端 8002，而文件在 prod 数据目录 → 远端拉取 404。2026-09-02 现网
    事故（VolcAsset DownloadFailed / image_url resource not found）即此。

    ⚠️ 2026-10-05：本地已被淘汰的文件**不能给后端地址**——那要经一次 307 跳转，
    而远端客户端多半不跟。改为一律给 TOS 直链，见 `_tos_direct`。

    ⚠️ 2026-10-21：**本地还在的文件也优先给桶直链**。原因见 `_tos_direct`：
    让远端来拉我们的 9080 直发链路，实测会超时（生产 8 条 DownloadFailed）。

    仅在 Provider 提交前调用，不改写入库的值（DB 存相对地址，换域名不失效）。
    RunningHub 通道无需本函数：它走 upload 换 fileName（_to_remote_name）。
    """
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:", "asset://")):
        return url
    from ..config import get_settings
    base = get_settings().media_base
    # /fw/media/x → /media/x；base 自带环境前缀，不剥就会拼成 /fwp/fw/media/x
    path = url[3:] if url.startswith("/fw/") else url
    # 桶直链优先：不看 media_base 有没有配 —— 只要对象在桶里，直链就是最优解
    direct = _tos_direct(path.lstrip("/"))
    if direct:
        return direct
    if not base:
        return url  # 未配置公网前缀：维持原样，交由渠道自行处理
    return f"{base}/{path.lstrip('/')}"


#: Seedance 官方符号语义（references/seedance-2-troubleshooting-guide.txt「字符使用规范」）：
#:   （）=背景音乐   <>=音效   {}=台词   **【】=字幕（在画面上烧字）**
#: 而我们的原稿把**表演提示与台词**写进了【】（如【声音低沉无情】
#: 【不可能……你怎么可能查得出来？！】），等于逐镜明确要求模型烧字幕。
#: 2026-09-02 抽样 dev 库最近 120 条 gen_prompt，20 条命中——这是现网"画面出字幕"
#: 的直接原因（官方文档另称竖屏本身出字幕概率 60-90%，不加约束根本压不住）。
_SUBTITLE_BRACKETS = re.compile(r"【\s*([^】]{0,300}?)\s*】")

#: 拆【】时是否需要补分隔符。原稿常见 `【声音低沉无情】【不可能……】` 这种连排，
#: 直接摘掉括号会黏成 `声音低沉无情不可能……` 这样的病句，反而干扰模型理解。
#: 左侧含「】」= 上一个括号刚补过分隔符，不重复补；右侧**不含**「【」= 后面紧跟
#: 另一个括号时要补，由前一个负责补这一刀。
_SEP_LEFT_OK = set("。，、；：！？…—~,.;:!?（(《「『【】\n\t 　“‘\"'")
_SEP_RIGHT_OK = set("。，、；：！？…—~,.;:!?）)》」』\n\t 　”’\"'")


def _unwrap_subtitle(m: "re.Match[str]") -> str:
    inner = m.group(1)
    if not inner:
        return ""
    s, start, end = m.string, m.start(), m.end()
    prev = s[start - 1] if start else ""
    nxt = s[end] if end < len(s) else ""
    lead = "，" if prev and prev not in _SEP_LEFT_OK else ""
    tail = "，" if nxt and nxt not in _SEP_RIGHT_OK else ""
    return f"{lead}{inner}{tail}"

#: 出画面文字的兜底否定约束。官方 V-2/V-3 条目实测：显式写禁令可把出字幕概率
#: 从 60-90% 压到 10-40%，且能有效抑制平台 logo/水印。
#: 中英两版：海螺 H3 框架产出的提示词**通篇英文**，往英文正文尾巴上挂一句中文
#: 约束，模型权重给得明显更低（且它自己的 SKILL 还要求"画面可见文字原文保留"）。
_NO_ONSCREEN_TEXT = "无字幕，无文字，无水印，无logo"
_NO_ONSCREEN_TEXT_EN = ("No subtitles, no captions, no on-screen text, "
                        "no watermark, no logo")

#: ⚠️ 视频提示词**不追加**政治红线约束（2026-10-18 用户裁定）。
#:
#: 2026-10-17 曾在这里追加「禁止出现真实国徽、警徽、国旗、军徽及其他国家标志性符号」，
#: 结果 seedance 的输入文本审核（`InputTextSensitiveContentDetected`，点名 `content[0]`
#: ——那正是本函数产出的提示词正文）大面积拦截：全生产出片任务的文本违规率从上线前
#: 3%（379 中 11）涨到上线后 62%（243 中 150），涉及 10 个项目。
#: 决定性证据：镜 64242da934e1 上线前后提示词相似度 1.00（正文没变），上线前成功、上线后失败。
#:
#: **用「禁止」去描述政治符号，恰好把这些词送进了审核。** 资产图与首帧仍在
#: `asset_prompt` / `jobs._gen_first_frame` 里注入该约束（图侧实测未出现违规），
#: 视频侧改为不注入 —— 用户裁定"只对视频链路去掉，资产图保留"。
#: 若将来要恢复，务必先确认上游审核已不再按该字面拦截，并用真实长提示词实测。

_HAS_NO_TEXT = re.compile(
    r"无字幕|不要字幕|避免.{0,4}字幕|保持无字幕|no subtitle|without subtitle|"
    r"no caption|no on-screen text|no onscreen text|no burned-in text",
    re.I)

#: 判定正文语种：CJK 字符占比低即视作英文稿。阈值 15% 而非 0，是因为英文稿里
#: 常合法嵌中文台词（H3 规范 `<d>[Chinese] …</d>`），那种仍应挂英文约束。
_CJK = re.compile(r"[一-鿿]")


def _is_mostly_english(text: str) -> bool:
    letters = sum(c.isalpha() for c in text)
    if not letters:
        return False
    return len(_CJK.findall(text)) / letters < 0.15



def sanitize_video_prompt(prompt: str | None) -> str | None:
    """下发前净化视频提示词：拆掉会被当成"烧字幕"的写法 + 补否定约束。

    这是**确定性兜底**，与提示词优化器的框架规则互补：
    - 优化器是 LLM，不保证每次听话；无框架的通道（veo 直通）压根不过优化器
    - 用户手改的提示词也不过优化器
    故最终出网这一层必须自己再兜一次。

    只做两件不会损失语义的事：
    1. `【x】` → `x`（去掉字幕语义，内容原样保留为普通描述，必要时补「，」分隔）。
       不改写成（）或{}：那两个符号在同一张表里分别是**音乐**和**台词**，
       猜错语义比留成普通描述更糟。台词该怎么写由优化器框架负责规范。
    2. 末尾补无文字约束（已有等价约束则不重复补）。中文稿补中文、英文稿补英文
       —— 海螺 H3 的产出通篇英文，挂中文约束权重明显更低。

    幂等：重复调用结果不变。
    """
    if not prompt or not prompt.strip():
        return prompt
    out = _SUBTITLE_BRACKETS.sub(_unwrap_subtitle, prompt)
    out = re.sub(r"，{2,}", "，", out).strip().strip("，")

    # 补无文字约束（已有则不重复）
    if not _HAS_NO_TEXT.search(out):
        if _is_mostly_english(out):
            sep = "" if out.endswith((".", ",", ";", "\n")) else "."
            out = f"{out}{sep} {_NO_ONSCREEN_TEXT_EN}."
        else:
            sep = "" if out.endswith(("。", "，", ".", ",", ";", "；")) else "。"
            out = f"{out}{sep}{_NO_ONSCREEN_TEXT}。"

    return out


def infer_generation_mode(req: "VideoRequest") -> str:
    """未显式指定模式时按素材推断（显式 generation_mode 优先）。

    ⚠️ **参考音频不参与推断**。它现在是自动注入的（角色音色，见
    jobs._auto_inject_voice_ref）：若让它参与，一个纯文本镜头只因为主角有音色
    就会从 t2va 变成 full_reference，等于注入音色这个动作**顺手改了生成模式**，
    连带换掉提示词框架分支与工作流路由。音色只能改音色。
    """
    if req.generation_mode and req.generation_mode not in RETIRED_GENERATION_MODES:
        return req.generation_mode
    # 首帧 / 尾帧图不再单独成模式（2026-11-20 下线）：带了图就是全能参考。
    if (req.first_frame_url or req.last_frame_url
            or req.reference_image_urls or req.reference_video_url):
        return "full_reference"
    return "t2va"


@dataclass
class VideoRequest:
    prompt: str
    #: 生成模式（GENERATION_MODES 之一）；None=按素材自动推断
    generation_mode: Optional[str] = None
    #: 首帧 / 尾帧图。三种帧模式已于 2026-11-20 下线，出片流程（jobs）不再填这两项，
    #: 镜头上留着的帧图改进 `reference_image_urls`。字段留着是因为各通道的 submit()
    #: 仍按"给了就用"读它们；官方 Seedance 通道读到会当参考图发。
    first_frame_url: Optional[str] = None
    last_frame_url: Optional[str] = None
    reference_image_urls: list[str] = field(default_factory=list)  # full_reference
    reference_audio_url: Optional[str] = None
    #: 多段参考音频（音色），顺序即提示词里 `@音频N` 的编号来源。
    #: 2.0 上限 3、2.5 上限 10（见 video_seedance._CAPS_*）。
    #:
    #: ⚠️ 与上面的单值字段**并存而非替代**：RunningHub 的工作流只有一路音轨
    #: 节点（video_runninghub.py 里 `if req.reference_audio_url` 直接判，
    #: 超过一段无处可放），所以那边继续读单值。Seedance 侧优先读这个列表，
    #: 空则回退单值——这样两个通道都不用改各自的语义。
    reference_audio_urls: list[str] = field(default_factory=list)
    reference_video_url: Optional[str] = None  # 参考视频（工作流支持时）
    duration_ms: Optional[int] = None
    aspect_ratio: Optional[str] = None
    #: 画面精细度（百万像素）。仅 reference 路线的可调分辨率模型使用；
    #: None 表示由 Provider 按时长自动选安全值（防显存 OOM）。
    megapixels: Optional[float] = None
    #: 随机种子。None = Provider 自行随机化（务必随机，否则同 prompt 永远同一结果）。
    seed: Optional[int] = None


@dataclass
class VideoResult:
    status: str                 # submitted | running | done | failed
    task_id: Optional[str] = None
    video_url: Optional[str] = None
    last_frame_url: Optional[str] = None   # 尾帧（承接接力用，模型支持时）
    duration_ms: Optional[int] = None
    error: Optional[str] = None
    raw: Optional[dict] = None


class VideoProvider(ABC):
    """视频生成 Provider 接口。"""

    #: 网关/厂商的模型 id
    model_id: str
    #: 该模型的能力档位（拿到 key 实测后回填到具体子类）
    visual_mode: VisualMode
    audio_mode: AudioMode
    duration_slots: list[int] = []
    supports_last_frame: bool = False
    aspect_ratios: list[str] = []
    #: 最多可吃几张参考图（首帧路线通常为 1）
    max_reference_images: int = 1
    #: 是否支持参考音频 / 参考视频
    supports_reference_audio: bool = False
    #: 最多可吃几段参考音频（仅 supports_reference_audio 为真时有意义）
    max_reference_audios: int = 1
    supports_reference_video: bool = False

    #: 参考图是否必须先转成**火山方舟私域可信资产**（asset://）才能过人脸审核。
    #: 只有官方方舟通道为真：审核是他家独有的，别家通道把图入进方舟库
    #: 纯属白花配额与时间，且那些图根本不会出现在请求里。
    #:
    #: ⚠️ 这**曾经是按 `"seedance" in model_id` 字符串匹配判定的**。种子期够用
    #: （只有官方有 seedance 系模型），但第三方便宜渠道的 model_id 同样含
    #: "seedance" —— 一旦沿用，每一次生成都会先把参考图传进**火山方舟**私域库，
    #: 等于"用官方通道"（用户明确禁止），且会把密钥/配额搅在一起。
    #: 能力是**渠道属性**，不该靠名字猜：改为显式声明，一处定义、无歧义。
    uses_ark_trusted_assets: bool = False

    #: 提示词优化框架目录名（prompt_opt/skill_assets/<name>）。None = 直通不优化。
    #: 同理，这以前是靠 model_id 前缀猜的；第三方渠道与官方共用同一套
    #: seedance2 框架，但 model_id 前缀不同，故显式声明。
    prompt_framework: str | None = None

    #: 本模型**真正吃得到**的分辨率档位（项目档位名，见 shot_timing.RESOLUTION_TIERS）。
    #: None = 未声明 = 全部档位都吃（老 Provider 的行为，不改动它们）。
    #:
    #: ⚠️ 这个字段存在的唯一理由是"**别让用户选了却不生效**"：
    #:   · `seedance-*` 官方通道按 p 档下发，而它的映射是
    #:     `≤0.5MP→480p / ≤1.2MP→720p / 其余→1080p` —— **没有 2k 这一档**，
    #:     选 2k 出来仍是 1080p，且不报错（实测见 video_seedance.submit）。
    #:   · `seedance-lowcost-2.5` 三条渠道**固定 720p**，项目档位对它完全无效，
    #:     见 video_lowcost 的 `COMMON_RESOLUTION` 注释。
    #: 两处都是"项目里写着 1080p、出来的片子是 720p"这种静默落差。
    #: 前端据此把不可用的档位**列出来但禁用 + 说明原因**，而不是假装它能选。
    supported_resolutions: list[str] | None = None

    def resolution_for(self, megapixels: float | None) -> str | None:
        """给定 MP，本模型实际会按哪一档出片。None = 无法判断。

        缺省实现：**按 MP 反查档位名**。适用于"项目给多少 MP 就按多少 MP 出"
        的通道（如 RunningHub H3，它按 `aspect × megapixels` 直接算像素，
        不认 p 档语法）。返回档位名只是为了让界面能说人话（"实际按 1080p 出"），
        **不参与下发** —— 下发用的永远是 megapixels 本身。

        按 p 档下发、且档位由 MP 反推的通道（seedance 系）应当覆盖本方法，
        因为它们的映射是**分段的**（`≤1.2MP→720p` 之类），不是等值反查。
        """
        from ..shot_timing import RESOLUTION_TIERS
        if megapixels is None:
            return None
        for name, mp in RESOLUTION_TIERS.items():
            if abs(mp - megapixels) < 1e-6:
                return name
        return None

    def max_seconds(self, megapixels: float | None = None) -> float | None:
        """单镜可生成的最长时长（秒）。None = 未知/不限。

        解说剧按旁白时长驱动镜头时长，拆镜时必须知道"这个模型最长能出多久"，
        否则会切出模型根本吃不下的段：seedance 会静默钳到 15s、veo 只出 8s，
        而旁白音频仍是完整长度 —— 画面早停、声音还在响，且**不报错**。

        缺省实现取 duration_slots 的最大值。时长上限依赖分辨率的模型
        （如 RunningHub H3，受显存 MP·s 约束）应当覆盖此方法。
        """
        return float(max(self.duration_slots)) if self.duration_slots else None

    def min_seconds(self) -> float | None:
        """单镜可生成的最短时长（秒）。None = 未知/不限。

        与 `max_seconds` 严格对称，用途也对称：划区间（`recut`）时必须拦住
        "中间段只有 2 秒"这种请求 —— 送下去要么被厂商拒（seedance 传 1~3 直接
        error），要么被静默补齐（H3 会补到最近档位），用户看到的是"我明明划了
        2 秒，出来的是 5 秒"。在划的那一刻就报错，用户才知道该把刀往哪挪。

        缺省实现取 duration_slots 的最小值 —— 与上限同一份事实来源，不另立字段。
        seedance 的 slots 是 `range(min_duration, max+1)` 的连续区间，H3 是
        `[2,3,5,8,…]` 的离散档位，两者的最小值都是**真实可生成**的，不会误拦。
        厂商下限不落在档位上的模型应当覆盖此方法。
        """
        return float(min(self.duration_slots)) if self.duration_slots else None

    def mode_support(self) -> dict[str, dict]:
        """各生成模式的可用性：{mode: {available, reason?}}。

        默认实现按 visual_mode 推导保守值；能力更细的 Provider（如按工作流
        配置动态判定的 H3）应覆写本方法。
        """
        first_frame_ok = self.visual_mode == VisualMode.first_frame
        return {
            "t2va": {"available": True},
            "i2va": {"available": first_frame_ok,
                     "reason": None if first_frame_ok else "该通道不支持首帧输入"},
            "fl2va": {"available": False, "reason": "该通道不支持首尾帧锚定"},
            "l2va": {"available": False, "reason": "该通道不支持尾帧锚定"},
            "full_reference": {
                "available": self.visual_mode == VisualMode.reference,
                "reason": None if self.visual_mode == VisualMode.reference
                else "该通道不支持多参考素材"},
        }

    @abstractmethod
    async def submit(self, req: VideoRequest) -> VideoResult:
        """提交生成任务。"""

    @abstractmethod
    async def poll(self, task_id: str) -> VideoResult:
        """轮询任务状态。"""