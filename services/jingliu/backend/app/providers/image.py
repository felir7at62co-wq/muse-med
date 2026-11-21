"""Image Provider：多模型多渠道生图（渠道链自动降级，用户只见模型不见渠道）。

四个用户可选模型，每个 ≥2 条渠道互为替补（与主平台 image_studio 同源渠道）：
- gpt-image-2      : zx1(images API) → kege(images API) → RunningHub G-2 → modelverse
- nano-banana-pro  : zx1(gemini native→chat) → kege-gemini → RunningHub N-PRO → modelverse
- nano-banana-2    : zx1(gemini native→chat) → kege-gemini → modelverse  (gemini-3.1-flash-image)
- z-image          : RunningHub 人像工作流 → api4me(z-image-turbo)   ⚠️ 仅两条，见下

统一返回本地 URL 列表（bytes 落盘 /fw/media/generated/）。
渠道全挂才抛错（聚合各渠道错误便于排查）。

## 第二顺位 2026-10-10 由 api4me 换成 kege

api4me 2026-10-09 起全线 403「user quota is not enough」，图像与文本的兜底同时断掉。
kege 顶替它的位置，配置口径与主平台 drama 一致（见其 40e1c3b）。

⚠️ **kege 没有 z-image 系列**（84 个模型全表核过，图像侧只有 flux-* / gpt-image-*），
   故 z-image 那条链仍指向 api4me —— 该模型现状是「两条渠道都配了、但都不可用」，
   好在它在 dev/prod 两库都**零使用**。要恢复需另找承载 z-image 的中转站。
⚠️ **kege 也没有 whisper/audio**，故 ASR（providers/asr.py）仍只能走 api4me。

⚠️ **上游模型名各渠道不统一**（2026-10-09 实测，见 `_chain` 的 gpt-image-2 段）：
同一个 `gpt-image-2` 在 zx1 与 kege 上叫 `gpt-image-2-c`，在 modelverse 上仍是旧名。
故 `_oai_images` 接受**候选名链**，逐个试、首个成功即返回；只在「这个名字上游
没有」（model_not_found / channel not found）时才换名，审核/限流不换。
上游再次改名时，补一个候选名即可，不必整段排查。

## modelverse 排最后（2026-09-03 接入，与文本侧同步）

单价明显高于前两家，定位"前面都挂了才用"，与 llm.py 的 llm_channel_order
成本逻辑一致。FW_MODELVERSE_API_KEY 留空则该渠道不注册，行为与接入前一致。

⚠️ **z-image 没有第三条**：modelverse 全表核过，没有 z-image/z-image-turbo；
kege 也没有。且它图生图时 rh-portrait 会被剔除（RunningHub 文生图端点不吃参考图），
**只剩已欠费失效的 api4me 一条**——这是目前图像侧最薄弱的一环，需另找中转站承载。

## 不设并发上限，靠渠道兜底而非限流（2026-08 用户决策）

图像侧**不再设并发信号量**（原 default_concurrency=8 过于保守：单 key 至少支撑
500 并发，且有多条渠道）。取而代之的健壮性来自三件套，与 llm.py 同构：

1. **多渠道互备**——任一渠道欠费/鉴权失败/5xx/网络故障自动切下一条；
2. **渠道冷却**——判定不可用后冷却 `image_channel_cooldown` 秒，期间直接跳过。
   高并发下这条最关键：否则**每个**请求都要去撞一次死渠道白等一个 RTT；
3. **带抖动的指数退避重试**——429 是无上限并发下的常态。⚠️ 退避必须**加抖动**：
   几百个请求同时撞 429，若都固定退避 3s 会在 +3s 精确同步地二次打满网关
   （惊群），抖动把重试摊平到一个时间窗内。

⚠️ 以上都是"容忍限流 / 跳过坏渠道"，**不降任何并发数**（遵并发铁律）。
若两条渠道持续全挂且日志显示 429，正确解法是加 API KEY / 提配额，而非降并发。
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import random
import re
import time
import uuid
from math import gcd
from typing import Awaitable, Callable

import httpx

from ..config import get_settings
from . import http
from .local_fault import LocalResourceError, fd_usage, is_local_resource_error
# ⚠️ 落盘目录**必须**用 media 的 GENERATED_DIR（它读 settings.data_dir），
# 不能在这里另写 Path("/root/filmweaver-data/generated")：那样 prod 会把
# 用户生成的图写进 dev 的数据目录，而库里的 /fw/media/... 由 prod 按
# 自己的 data_dir 解析 → 图 404、后续出片报「参考素材不可用」（2026-09-01 修）。
from ..media import GENERATED_DIR

logger = logging.getLogger("fw.image")

_DATA_URL_RE = re.compile(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)")


class ChannelDown(Exception):
    """该渠道当前不可用（欠费/鉴权/无渠道/5xx/网络），应当切换到下一条。"""

    def __init__(self, msg: str, account_level: bool = False) -> None:
        super().__init__(msg)
        #: True = 账号级故障（欠费/鉴权）——该渠道所有模型都别试了；
        #: False = 模型级故障（该渠道没上架这个模型）——同渠道其它模型照常走。
        self.account_level = account_level


def _raise_network_fault(e: Exception) -> None:
    """把网络类异常转成"渠道故障"或"本机故障"，**永远不会正常返回**。

    ⚠️ 2026-10-19：此前这里无条件 `raise ChannelDown(...)`，于是本地 fd 耗尽
    （`[Errno 24] Too many open files`）被当成渠道故障写进冷却表，把所有图像
    渠道一起冻结 120 秒 —— 一次几秒的本地问题被放大成 20 分钟全渠道不可用。
    本地资源错误必须**不进冷却表**，否则故障会被我们自己放大。
    """
    if is_local_resource_error(e):
        logger.error("本机资源故障（非渠道问题）：%s | %s",
                     f"{type(e).__name__}: {e}", fd_usage())
        raise LocalResourceError(
            f"本机资源不足，请稍后重试（{type(e).__name__}: {e}）；"
            f"运行状态 {fd_usage()}", original=e,
        ) from e
    raise ChannelDown(f"网络异常 {type(e).__name__}: {e}") from e


class ContentRejected(Exception):
    """提示词/参考图被内容审核拒绝。**渠道是好的，是这次的内容过不了。**

    必须与 ChannelDown 严格分开，否则会连犯三个错（2026-08 实测踩过）：
    ① **重试无意义**——同一段提示词重试多少次都是同样判定，纯浪费调用与时间；
    ② **绝不能冷却渠道**——渠道健康得很，冷却会把它对**其他镜头**也一起封掉；
    ③ 但**仍要试下一条渠道**——各家审核尺度不同，实测同一段提示词
       gpt-image-2 双渠道全拒、nano-banana-pro（Gemini）正常出图。

    坑点在于中转站会把审核拒绝**包装成各种 HTTP 状态**，光看 status 必误判：
    - api4me → HTTP **429** + `code: moderation_blocked, safety_violations=[sexual]`
      （若按 429 当限流，就会退避重试 3 次后误判"持续限流"并冷却健康渠道）
    - zx1    → HTTP **500** + 「提交中含有违反平台政策的内容」
      （若按 5xx 当渠道故障，同样误冷却）
    所以判定必须**先看响应体关键词，再看状态码**。
    """

    def __init__(self, msg: str, categories: list[str] | None = None) -> None:
        super().__init__(msg)
        #: 违规类别（如 ["sexual"]）；上游未给出时为空，仅用于提示用户改哪里
        self.categories = categories or []


class RefUnavailable(Exception):
    """参考图取不到（外链过期、本地淘汰后拉不回、scheme 不认识）。

    ⚠️ 2026-10-08 新增，取代此前"静默退化成文生图"的行为。
    旧写法是 `_load_ref_bytes` 里一句裸 `continue`，于是：
      · 参考图全丢 → `refs or None` 变 None → `_oai_images` 走**纯文生图**分支、
        `_gemini_gen` 不再带 `inlineData`；
      · 一张图照生成、**照扣钱**，但完全没有参考效果 —— 用户只会觉得
        "这个模型画得不像"，永远不会知道参考图压根没送到；
      · 附带静默换渠道：`refs=None` 会让 `not refs` 不再排除 RunningHub，
        于是悄悄换到另一条更慢、价不同的通道。
    用户拍板的策略是"**报错让用户换图**，不出废图、不花钱"——花钱买一张
    不像的图，比明确告诉他图有问题更伤信任。
    """

    def __init__(self, msg: str, missing: list[str] | None = None) -> None:
        super().__init__(msg)
        #: 取不到的 URL，交给上层写进日志/错误里便于定位
        self.missing = missing or []


#: 内容审核拒绝的判据（响应体关键词，大小写不敏感）。
#: 覆盖 OpenAI(gpt-image-2)、中转站中文提示、Gemini、Azure 四类文案。
_MODERATION_MARKERS = (
    "moderation_blocked", "safety_violations", "safety system",
    "content_policy_violation", "content policy", "image_generation_user_error",
    "prohibited_content", "blocked_reason", "responsible ai",
    "content security audit", "security audit did not pass",
    "违反平台政策", "内容审核", "违规内容", "敏感内容", "涉及违规",
    "内容安全审查", "安全审查未通过",
)

#: 从 `safety_violations=[sexual, violence]` 里抠出类别，用于告诉用户改哪儿
_VIOLATION_RE = re.compile(r"safety_violations\s*=\s*\[([^\]]*)\]", re.I)


def _as_moderation_exc(exc: Exception) -> ContentRejected | None:
    """异常文案像审核拒绝就转成 ContentRejected，否则 None。

    `_as_moderation` 只覆盖"直接读到 HTTP 响应体"的渠道；RunningHub 这类
    **异步任务**渠道是先提交再轮询，审核结论以任务状态回来
    （`RH task FAILED: Content security audit did not pass`），永远不经过
    `_classify_http`。不在这里兜一层，它就会掉进通用失败分支——用户看到的是
    "全部渠道均失败，建议增加 API KEY"，而真实原因是提示词过不了审，
    加多少 KEY 都没用。
    """
    if isinstance(exc, ContentRejected):
        return exc
    return _as_moderation(0, str(exc))


def _as_moderation(status: int, body: str) -> ContentRejected | None:
    """响应体像内容审核拒绝就返回 ContentRejected，否则 None。

    只看响应体不看状态码——见 ContentRejected 文档：中转站把审核拒绝包装成
    429/500/400 各种状态，按状态码判定必然误伤。
    """
    low = body.lower()
    if not any(m in low for m in _MODERATION_MARKERS):
        return None
    cats: list[str] = []
    m = _VIOLATION_RE.search(body)
    if m:
        cats = [c.strip() for c in m.group(1).split(",") if c.strip()]
    where = f"HTTP {status}: " if status else ""
    return ContentRejected(
        f"内容审核拒绝{'（' + '、'.join(cats) + '）' if cats else ''} "
        f"{where}{body[:200]}", categories=cats)


# ---- 渠道健康度：key -> 冷却截止时刻（time.monotonic）----
# 进程内内存态即可：重启自动清空，多 worker 各自独立探测，无需共享存储。
_COOLDOWN: dict[str, float] = {}


def _mark_down(name: str, model: str, seconds: int, exc: ChannelDown) -> None:
    key = name if exc.account_level else f"{name}:{model}"
    _COOLDOWN[key] = time.monotonic() + seconds
    logger.warning("图像渠道 %s 判定不可用（%s），冷却 %ds：%s", key,
                   "账号级" if exc.account_level else "模型级", seconds, exc)


def _healthy(name: str, model: str) -> bool:
    now = time.monotonic()
    for key in (name, f"{name}:{model}"):
        until = _COOLDOWN.get(key)
        if until is None:
            continue
        if now >= until:
            _COOLDOWN.pop(key, None)   # 冷却到期，重新纳入探测
        else:
            return False
    return True


def _classify_http(status: int, body: str) -> ChannelDown | ContentRejected | None:
    """把 HTTP 错误分类；返回 None 表示"不是渠道的锅、也不是审核，别切换"。

    **判定顺序至关重要**：内容审核必须排在状态码规则之前。中转站会把审核拒绝
    包装成 429（api4me）或 500（zx1），若先按状态码判定，前者会被当限流去
    退避重试、后者会被当 5xx 渠道故障，两条健康渠道都被误冷却 120s，
    连累整批其他镜头（2026-08 项目 812 实际踩坑）。

    account_level=True 的判据是"换个模型也没用"：余额耗尽、key 无效、账号被禁。
    503/502「无可用渠道」是中转站上游没货，属模型级——同渠道别的模型可能还行。
    429 不在此处判定：它由调用方的退避重试消化，退避后仍 429 才升级为渠道故障。
    """
    rejected = _as_moderation(status, body)
    if rejected is not None:
        return rejected
    low = body.lower()
    if status in (401, 403) or "insufficient_user_quota" in low or "无可用渠道" in body:
        if status in (401, 403) or "quota" in low or "balance" in low:
            return ChannelDown(f"账号级故障 HTTP {status}: {body[:150]}",
                               account_level=True)
        return ChannelDown(f"模型不可用 HTTP {status}: {body[:150]}")
    if status in (404, 502, 503, 504) or status >= 500:
        return ChannelDown(f"HTTP {status}: {body[:150]}")
    return None


#: 上游**改了模型名**时返回的文案（"这个 id 不存在"，不是"渠道暂时挂了"）。
#: ⚠️ 与 `无可用渠道` 有本质区别：后者是"上游暂时没货"，换个名字也一样，属可用性问题；
#: 这里只收**命名类**文案，才能安全地拿它去驱动"换候选名"。
#:   实测 2026-10-09 zx1 返回：
#:   HTTP 503 {"error":{"code":"model_not_found","message":"Failed to get available
#:   channel for model gpt-image-2 under group codex (distributor): channel not found"}}
_MODEL_MISSING_MARKERS = ("model_not_found", "channel not found", "model not found")


def _is_model_missing(msg: str) -> bool:
    """该错误是不是"上游没有这个模型名"（→ 值得换候选名再试一次）。"""
    low = msg.lower()
    return any(m in low for m in _MODEL_MISSING_MARKERS)


def _is_transient(exc: Exception) -> bool:
    """值得原地退避重试的瞬时错误（限流 / 超时 / 连接抖动）。

    审核拒绝**绝不算瞬态**：它常伪装成 429（api4me 就是），若只匹配 "429"
    字样就会去退避重试 3 次，然后误判"持续限流"把健康渠道冷却掉。
    """
    if isinstance(exc, ContentRejected):
        return False
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    msg = str(exc).lower()
    if any(m in msg for m in _MODERATION_MARKERS):
        return False   # 双保险：漏进这里的审核文案也不许重试
    return "429" in msg or "timeout" in msg or "rate limit" in msg


async def _backoff(attempt: int, base: float = 2.0) -> None:
    """指数退避 + **抖动**。

    抖动不是锦上添花：无并发上限时，几百个请求会在同一瞬间收到 429，
    固定退避会让它们在 +base 秒时精确同步地再次打满网关（惊群），
    退避形同虚设。这里取 [0.5, 1.5] 倍随机因子把重试摊开。
    """
    delay = base * (2 ** attempt) * (0.5 + random.random())
    await asyncio.sleep(min(delay, 30.0))

#: 用户可选模型（前端下拉与后端渠道链的唯一契约）
IMAGE_MODELS: list[dict] = [
    {"id": "gpt-image-2", "label": "GPT Image 2"},
    {"id": "nano-banana-pro", "label": "Nano Banana Pro（Gemini 3）"},
    {"id": "nano-banana-2", "label": "Nano Banana 2（Gemini 3.1）"},
    {"id": "z-image", "label": "Z-Image（人像专用）"},
    # Midjourney 只上生图页（`image_page_only`）：本渠道 `--cref` 角色参考不可用
    # （2026-10-06 实测，见 _mj_imagine），资产/首帧这些要"同一张脸"的链路接不住它。
    # 要素页按类别选模型、资产生图弹窗的下拉都会把它过滤掉（routers/project.py）。
    {"id": "midjourney", "label": "Midjourney V8.2", "image_page_only": True,
     "fixed_n": 4, "supports_refs": False},
]

#: 只在生图页出现的模型 id（资产相关的模型选择一律排除）。
IMAGE_PAGE_ONLY = frozenset(m["id"] for m in IMAGE_MODELS if m.get("image_page_only"))


def _flatten_alpha(raw: bytes) -> bytes:
    """有透明通道就压到**纯白底**上再落盘；没有就原样返回（字节不变）。

    ## 为什么（2026-09-21，P0-5）

    同一句提示词在不同渠道上**出图格式不一样**：资产图 A/B 实测那 28 张里
    25 张是 RGBA 半透明、3 张是 RGB 白底，且那 3 张里有一张在**对照组**——
    即与提示词无关，是渠道行为。下游把资产图当参考图喂给视频模型时，
    透明底与白底的结果完全不同（不少服务把 alpha 合到**黑**底上），
    这种不确定性本身就是缺陷。

    ## 为什么归一到「白」而不是「透明」

    线上存量逐张开文件数过：`generated/img_*.png` 抽 300 张 RGB 占 **98.3%**，
    **character 资产 174 张 RGB 占 100%**。白底既是线上既有行为，
    也正是提示词自己要求的「纯白色干净空白背景」。
    反过来归一成 RGBA 要去抠白色，**会吃掉白衣服**，是有损的，不做。

    ## 为什么只在有 alpha 时才动

    没有 alpha 的图直接返回原始字节，**不解码不重编码** ——
    线上 98%+ 的图字节级不变，既不改行为也不付 CPU，
    只消灭那个异常分支。
    """
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return raw                      # 非 PNG（JPEG 等本就没有 alpha）
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as im:
            if im.mode not in ("RGBA", "LA", "P"):
                return raw
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            buf = io.BytesIO()
            bg.save(buf, "PNG")
            return buf.getvalue()
    except Exception:      # noqa: BLE001 归一失败不能连累出图，退回原图
        logger.warning("[image] 透明底归一失败，按原样落盘", exc_info=True)
        return raw


def _save(raw: bytes) -> str:
    name = f"img_{uuid.uuid4().hex[:12]}.png"
    (GENERATED_DIR / name).write_bytes(_flatten_alpha(raw))
    return f"/fw/media/generated/{name}"


def _save_all(images: list[bytes]) -> list[str]:
    """批量落盘（同步）。调用方用 asyncio.to_thread 丢线程池，别阻塞事件循环。"""
    return [_save(raw) for raw in images]


async def _download(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url)
    r.raise_for_status()
    return r.content


async def _load_ref_bytes(urls: list[str]) -> list[bytes]:
    """参考图 URL → bytes（本地 /fw/media/ 直读，http 下载）。

    本地直读是同步 IO：图像侧取消并发上限后，几百个协程同时读参考图会把
    事件循环卡住（每张几 MB），故丢线程池执行。

    ⚠️ 2026-10-08 起：取不到就**抛 RefUnavailable**，不再静默降级。
    此前是裸 `continue`——参考图全丢时 `refs` 变 None，调用方会走纯文生图，
    照常计费却毫无参考效果，且**不留任何痕迹**（日志、计数都没有）。
    现在缺哪张、缺几张都记进日志，上层据此给用户"该换哪张图"。
    """
    from ..media import ensure_local_async
    out: list[bytes] = []
    missing: list[str] = []
    async with http.client("image-refs", timeout=120) as client:
        for u in urls[:4]:
            p = await ensure_local_async(u)
            if p is not None and p.is_file():
                out.append(await asyncio.to_thread(p.read_bytes))
            elif u.startswith("http"):
                try:
                    out.append(await _download(client, u))
                except Exception as e:  # noqa: BLE001
                    logger.warning("参考图下载失败：%s（%s）", u, str(e)[:120])
                    missing.append(u)
            else:
                # 非 http 且本地取不到：scheme 不认识（data:/asset:// 之类），
                # 旧代码在这里**连下载都不试**就丢弃，连日志都没有
                logger.warning("参考图无法解析（scheme 不认识、本地也没有）：%s", u)
                missing.append(u)
    if missing:
        # ⚠️ 口径：**缺任何一张就中止**，不是"缺了就用剩下的凑"。
        #    因为参考图对应的是"这一镜里的某个角色/场景"，少一张就意味着一
        #    个人会画成另一个人 —— 那正是用户说的"废图"，而且照样计费。
        #    中止比出废图诚实，且错误信息直接点名是哪张、用户能立刻去修。
        #    （若将来发现"部分缺失也得先出一版"更合适，把这里改成
        #      `if not out:` 即可，即只在**全丢**时中止——那也正是旧代码
        #      真正会退化成文生图的那个点。留此注记便于将来调整。）
        raise RefUnavailable(
            f"{len(missing)}/{len(urls[:4])} 张参考图取不到（"
            + "；".join(u[-60:] for u in missing[:3])
            + "）；已中止生成——缺的那张会让对应角色/场景画错，"
              "请补上图片后重试", missing=missing)
    return out


# ---------- 协议 1：OpenAI 兼容 images/generations|edits（zx1 / api4me）----------
async def _oai_images(base: str, key: str, model: str | list[str], prompt: str,
                      n: int, size: str, timeout: float = 300.0,
                      refs: list[bytes] | None = None) -> list[bytes]:
    """请求 n 张；**上游少给就自己补齐**。

    ⚠️ zx1/api4me 这类中转站对 gpt-image-2 的 `n` 是**静默忽略**的：请求 n=4
    照样只回 1 张，HTTP 200、无任何提示（2026-08 实测）。而 gemini / RunningHub
    两条链路是本地循环 n 次，所以只有这条协议会"选 4 张只出 1 张"。
    这里按缺口补发单张请求（并发），把 n 的语义拉回一致。

    `model` 可给**候选名链**（`list[str]`）：逐个试，首个成功即返回。
    2026-10-09 zx1 把 `gpt-image-2` 改名为 `gpt-image-2-c`，旧名一律返回
    HTTP 503 model_not_found / channel not found，表现为整条渠道静默变砖。
    上游再次改名时，只需在候选表里补一个名字即可恢复。
    ⚠️ **只有"模型名不存在"才换下一个候选名**：审核 400 / 429 / 5xx 说明名字是
    对的，换名字救不了，直接抛出交给上层重试与切渠道。
    """
    names = [model] if isinstance(model, str) else list(model)
    headers = {"Authorization": f"Bearer {key}"}

    async def _once(want: int, name: str) -> list[bytes]:
        async with http.client("openai-images", timeout=timeout) as client:
            if refs:
                # 图生图：images/edits multipart（同主平台 image_studio 实测协议）
                files = [("image[]", (f"ref_{i}.png", raw, "image/png"))
                         for i, raw in enumerate(refs)]
                resp = await client.post(
                    f"{base}/images/edits", headers=headers,
                    data={"model": name, "prompt": prompt, "n": str(want), "size": size},
                    files=files)
            else:
                resp = await client.post(
                    f"{base}/images/generations",
                    headers={**headers, "Content-Type": "application/json"},
                    json={"model": name, "prompt": prompt, "n": want, "size": size})
            if resp.status_code != 200:
                # 渠道级故障（欠费/鉴权/上游没货）抛 ChannelDown → 上层切渠道并冷却；
                # 其余（如 400 提示词被拒）照常抛，换渠道也是同样结果，白花一次钱。
                down = _classify_http(resp.status_code, resp.text)
                if down is not None:
                    raise down
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            got: list[bytes] = []
            for item in resp.json().get("data", []) or []:
                if item.get("b64_json"):
                    got.append(base64.b64decode(item["b64_json"]))
                elif item.get("url"):
                    got.append(await _download(client, item["url"]))
            return got

    async def _once_any(want: int) -> list[bytes]:
        """按候选名链试；只在"这个名字上游没有"时才换下一个。"""
        last: Exception | None = None
        for i, name in enumerate(names):
            try:
                return await _once(want, name)
            except ChannelDown as e:
                # 只对**命名类**错误换名。`无可用渠道`（上游没货）换了也一样，
                # 且换名会让真正的渠道故障被掩盖成"名字不对"，故不等价处理。
                if i + 1 < len(names) and _is_model_missing(str(e)):
                    logger.warning("图像渠道模型名 %s 上游不存在，改用候选名 %s",
                                   name, names[i + 1])
                    last = e
                    continue
                raise
            except RuntimeError as e:
                last = e
                if i + 1 < len(names) and _is_model_missing(str(e)):
                    logger.warning("图像渠道模型名 %s 上游不存在，改用候选名 %s",
                                   name, names[i + 1])
                    continue
                raise
        raise last if last is not None else RuntimeError("候选模型名链为空")

    try:
        out = await _once_any(n)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        _raise_network_fault(e)
    if not out:
        raise RuntimeError("no image in response")

    gap = max(0, n - len(out))
    if gap:
        # 补发的失败不算数：首张已经成功 = 渠道是好的，能补几张补几张，
        # 让用户拿到"至少一张"而不是整次白跑（异常吞掉但记日志便于追因）。
        extra = await asyncio.gather(*[_once_any(1) for _ in range(gap)],
                                     return_exceptions=True)
        for r in extra:
            if isinstance(r, BaseException):
                logger.info("补齐第 n 张失败（已忽略）：%r", r)
            else:
                out.extend(r)
        logger.info("上游忽略 n=%d（只回 %d 张），补发 %d 次后共 %d 张",
                    n, n - gap, gap, len(out))
    return out[:n]


# ---------- 协议 2：gemini（native generateContent 优先，chat/completions 回退）----------
_GEMINI_ASPECTS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}


def _size_to_aspect(size: str) -> str | None:
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except ValueError:
        return None
    g = gcd(w, h) or 1
    cand = f"{w // g}:{h // g}"
    if cand in _GEMINI_ASPECTS:
        return cand
    target = w / h
    return min(_GEMINI_ASPECTS,
               key=lambda a: abs(int(a.split(":")[0]) / int(a.split(":")[1]) - target))


def _size_to_tier(size: str) -> str:
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except ValueError:
        return "1K"
    long_edge = max(w, h)
    return "4K" if long_edge >= 3200 else "2K" if long_edge >= 2240 else "1K"


async def _gemini_gen(base: str, key: str, model: str, prompt: str,
                      n: int, size: str, timeout: float = 300.0,
                      refs: list[bytes] | None = None) -> list[bytes]:
    """native generateContent（硬控比例/画质档）→ 失败回退 chat/completions。
    refs：参考图 bytes（图生图；native 走 inlineData，chat 走 data-url content 块）。"""
    out: list[bytes] = []
    async with http.client("gemini", timeout=timeout) as client:
        try:
            root = base[:-3] if base.endswith("/v1") else base
            parts: list[dict] = [{"text": prompt}]
            for raw in (refs or []):
                parts.append({"inlineData": {
                    "mimeType": "image/png",
                    "data": base64.b64encode(raw).decode()}})
            gbody = {
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "responseModalities": ["IMAGE"],
                    "imageConfig": {"aspectRatio": _size_to_aspect(size) or "1:1",
                                    "imageSize": _size_to_tier(size)},
                },
            }
            gheaders = {"Content-Type": "application/json", "x-goog-api-key": key,
                        "Authorization": f"Bearer {key}"}
            for _ in range(max(1, n)):
                resp = await client.post(
                    f"{root}/v1beta/models/{model}:generateContent",
                    headers=gheaders, json=gbody)
                if resp.status_code != 200:
                    raise RuntimeError(f"native HTTP {resp.status_code}")
                for c in resp.json().get("candidates", []) or []:
                    for part in ((c.get("content") or {}).get("parts") or []):
                        d = part.get("inlineData") or part.get("inline_data") or {}
                        if d.get("data"):
                            out.append(base64.b64decode(d["data"]))
            if out:
                return out
        except Exception:  # noqa: BLE001  native 不通 → chat 回退
            out = []
        if refs:
            content: object = ([{"type": "text", "text": prompt}]
                + [{"type": "image_url", "image_url": {
                    "url": "data:image/png;base64," + base64.b64encode(r).decode()}}
                   for r in refs])
        else:
            content = prompt
        payload = {"model": model,
                   "messages": [{"role": "user", "content": content}],
                   "modalities": ["image", "text"]}
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        for _ in range(max(1, n)):
            try:
                resp = await client.post(f"{base}/chat/completions",
                                         headers=headers, json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                _raise_network_fault(e)
            if resp.status_code != 200:
                # native 已失败过一轮，chat 再挂基本就是渠道问题（余额/上游没货）
                down = _classify_http(resp.status_code, resp.text)
                if down is not None:
                    raise down
                raise RuntimeError(f"chat HTTP {resp.status_code}: {resp.text[:200]}")
            msg = (resp.json().get("choices") or [{}])[0].get("message", {}) or {}
            text = msg.get("content")
            if isinstance(text, list):
                text = " ".join((p.get("text") or "") if isinstance(p, dict) else str(p)
                                for p in text)
            for m in _DATA_URL_RE.finditer(text or ""):
                out.append(base64.b64decode(m.group(1)))
            for im in msg.get("images") or []:
                u = (im or {}).get("image_url", {}).get("url") if isinstance(im, dict) else None
                if u:
                    for m in _DATA_URL_RE.finditer(u):
                        out.append(base64.b64decode(m.group(1)))
    if not out:
        raise RuntimeError("gemini no image in response")
    return out


# ---------- 协议 3：RunningHub v2 文生图（G-2 / N-PRO 低价渠道）----------
_RH_ASPECTS = {"1:1", "3:2", "2:3", "5:4", "4:5", "16:9", "9:16", "21:9", "3:4", "4:3"}


async def _rh_v2_t2i(endpoint: str, prompt: str, n: int, size: str,
                     poll_interval: float = 5.0, poll_max: int = 60) -> list[bytes]:
    """RunningHub v2 标准模型：提交 → 轮询 /openapi/v2/query → 下载产出。"""
    s = get_settings()
    if not s.runninghub_api_key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    base = s.runninghub_base_url.rstrip("/")
    headers = {"Content-Type": "application/json",
               "Authorization": f"Bearer {s.runninghub_api_key}"}
    payload: dict = {"prompt": prompt, "resolution": _size_to_tier(size).lower()}
    aspect = _size_to_aspect(size)
    if aspect in _RH_ASPECTS:
        payload["aspectRatio"] = aspect
    out: list[bytes] = []
    async with http.client("runninghub-image", timeout=90) as client:
        for _ in range(max(1, n)):
            resp = await client.post(f"{base}{endpoint}", headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"RH submit HTTP {resp.status_code}: {resp.text[:150]}")
            j = resp.json()
            if j.get("errorCode"):
                raise RuntimeError(f"RH submit {j.get('errorCode')}: {j.get('errorMessage')}")
            tid = j.get("taskId")
            if not tid:
                raise RuntimeError(f"RH no taskId: {str(j)[:150]}")
            urls: list[str] = []
            for _i in range(poll_max):
                await asyncio.sleep(poll_interval)
                qr = await client.post(f"{base}/openapi/v2/query", headers=headers,
                                       json={"taskId": str(tid)})
                if qr.status_code != 200:
                    continue
                qj = qr.json()
                st = str(qj.get("status") or "").upper()
                if st == "SUCCESS":
                    urls = [it["url"] for it in (qj.get("results") or [])
                            if isinstance(it, dict) and it.get("url")]
                    break
                if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
                    raise RuntimeError(f"RH task {st}: {qj.get('errorMessage')}")
            if not urls:
                raise RuntimeError("RH 任务超时或无产出图")
            for u in urls:
                out.append(await _download(client, u))
    if not out:
        raise RuntimeError("RH no image produced")
    return out


# ---------- 协议 4：RunningHub ComfyUI 人像专用工作流（z-image 主渠道）----------
async def _rh_portrait(prompt: str, n: int, size: str,
                       poll_interval: float = 5.0, poll_max: int = 60) -> list[bytes]:
    """人像工作流：提示词入节点 #200，宽高入节点 #196；每任务出 1 张。"""
    s = get_settings()
    if not s.runninghub_api_key or not s.runninghub_portrait_workflow_id:
        raise RuntimeError("RUNNINGHUB portrait not configured")
    base = s.runninghub_base_url.rstrip("/")
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except ValueError:
        w, h = 928, 1664
    out: list[bytes] = []
    async with http.client("runninghub-image", timeout=90) as client:
        for _ in range(max(1, n)):
            payload = {
                "apiKey": s.runninghub_api_key,
                "workflowId": s.runninghub_portrait_workflow_id,
                "nodeInfoList": [
                    {"nodeId": "200", "fieldName": "text", "fieldValue": prompt},
                    {"nodeId": "196", "fieldName": "width", "fieldValue": str(w)},
                    {"nodeId": "196", "fieldName": "height", "fieldValue": str(h)},
                ],
            }
            r = await client.post(f"{base}/task/openapi/create", json=payload)
            d = r.json()
            if r.status_code != 200 or d.get("code") != 0:
                raise RuntimeError(f"RH portrait create: {d.get('msg') or r.status_code}")
            tid = (d.get("data") or {}).get("taskId")
            if not tid:
                raise RuntimeError("RH portrait no taskId")
            urls: list[str] = []
            for _i in range(poll_max):
                await asyncio.sleep(poll_interval)
                sr = await client.post(f"{base}/task/openapi/status",
                                       json={"apiKey": s.runninghub_api_key, "taskId": tid})
                st = str((sr.json() or {}).get("data") or "").upper()
                if st in ("SUCCESS", "SUCCEED", "SUCCEEDED"):
                    orr = await client.post(f"{base}/task/openapi/outputs",
                                            json={"apiKey": s.runninghub_api_key, "taskId": tid})
                    od = orr.json()
                    if od.get("code") == 0:
                        urls = [it.get("fileUrl") or it.get("url")
                                for it in (od.get("data") or [])
                                if isinstance(it, dict) and (it.get("fileUrl") or it.get("url"))]
                    break
                if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
                    raise RuntimeError(f"RH portrait task {st}")
            if not urls:
                raise RuntimeError("RH portrait 超时或无产出")
            for u in urls:
                out.append(await _download(client, u))
    if not out:
        raise RuntimeError("RH portrait no image")
    return out


#: Midjourney 版本。**以实测为准**：2026-10-21 在 zx1 上 `--v 8.2` 出图正常，
#: `--v 8.3` / `--v 9` 立即被 Midjourney 本体拒绝（「参数的值无效: --version」）。
#: 上游出新版时改这里即可；探法：提交一个 `--v X` 的小提示词，1~2 秒内 FAILURE 即不支持。
MJ_VERSION = "8.2"

#: 已带这些参数的提示词不再追加（用户自己写了 --ar / --v / --niji 就尊重他的）。
_MJ_HAS_AR = re.compile(r"(?:^|\s)--(?:ar|aspect)\s", re.I)
_MJ_HAS_VER = re.compile(r"(?:^|\s)--(?:v|version|niji)\b", re.I)


async def _mj_imagine(root: str, key: str, prompt: str, size: str,
                      timeout: float = 420) -> list[bytes]:
    """Midjourney（midjourney-proxy 协议）：提交 → 轮询 → 下载 4 张独立图。

    ## 渠道事实（2026-10-06 / 10-21 两次实测，脚本在 /root/mj-channel-test-20261006）

    · 只有 zx1 的**文本分组 key**（`llm_api_key`）有 midjourney；图像分组 key 调用
      返回 503 model_not_found（分组下没有该渠道）。
    · 接口：`POST /mj/submit/imagine` 返回任务号（code 1 成功 / 22 排队 / 23 队列满 /
      24 敏感词）；`GET /mj/task/{id}/fetch` 轮询到 SUCCESS / FAILURE。一次约 60~75 秒。
    · 结果 `imageUrls` 是 4 张**独立图**（对象数组，取 `.url`）；`imageUrl` 是四宫格拼图。
      一次提交固定出 4 张，所以这里不收 n——按 4 张返回、按 4 张记账（与其它模型同口径）。
    · 比例靠提示词里的 `--ar`（实测出图尺寸与 --ar 精确对应）；画质档位对 MJ 无意义，
      出图恒为 1024 级（方图 1024×1024）。
    · `--cref` 不可用（报敏感词 / 无效参数），故本渠道不接参考图（`supports_refs=False`）。
    """
    full = prompt.strip()
    if not _MJ_HAS_AR.search(full):
        try:
            w, h = (int(x) for x in size.lower().split("x"))
            g = gcd(w, h) or 1
            full += f" --ar {w // g}:{h // g}"
        except ValueError:
            pass
    if not _MJ_HAS_VER.search(full):
        full += f" --v {MJ_VERSION}"
    headers = {"Authorization": f"Bearer {key}"}
    async with http.client("midjourney", timeout=60) as c:
        try:
            r = await c.post(f"{root}/mj/submit/imagine", headers=headers,
                             json={"prompt": full})
        except httpx.HTTPError as e:
            _raise_network_fault(e)
            raise
        bad = _classify_http(r.status_code, r.text)
        if bad is not None:
            raise bad
        body = r.json() if r.content else {}
        code = body.get("code")
        if code == 24:
            raise ContentRejected(f"Midjourney 判定提示词含敏感词：{body.get('description') or ''}")
        if code == 23:
            # 队列满：瞬时，交给 generate 的退避重试
            raise RuntimeError("429 Midjourney 队列已满，稍后重试")
        tid = body.get("result")
        if code not in (1, 22) or not tid:
            raise RuntimeError(f"Midjourney 提交失败（code={code}）：{body.get('description') or body}")

        deadline = time.monotonic() + timeout
        task: dict = {}
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            try:
                fr = await c.get(f"{root}/mj/task/{tid}/fetch", headers=headers)
            except httpx.HTTPError:
                continue                     # 轮询抖一下不算失败，下一轮再查
            if fr.status_code != 200:
                continue
            task = fr.json() or {}
            if task.get("status") in ("SUCCESS", "FAILURE"):
                break
        else:
            raise RuntimeError(f"timeout：Midjourney 任务 {tid} 超过 {int(timeout)} 秒仍未完成")

        if task.get("status") == "FAILURE":
            why = str(task.get("failReason") or "未知原因")
            if any(w in why.lower() for w in ("sensitive", "banned", "违规", "敏感")):
                raise ContentRejected(f"Midjourney 审核未通过：{why[:120]}")
            raise RuntimeError(f"Midjourney 生成失败：{why[:160]}")

        urls = [it.get("url") for it in (task.get("imageUrls") or [])
                if isinstance(it, dict) and it.get("url") and it.get("status", "ok") == "ok"]
        if not urls and task.get("imageUrl"):
            urls = [task["imageUrl"]]        # 没有分图时退回四宫格整图，总比没有强
        if not urls:
            raise RuntimeError("Midjourney 返回成功但没有图片地址")
        async with http.client("image-download", timeout=120, follow_redirects=True) as dl:
            return list(await asyncio.gather(*(_download(dl, u) for u in urls)))


class ImageProvider:
    """多渠道生图调度器：按模型走渠道链，逐渠道尝试、全挂才抛错。

    用户只选模型（IMAGE_MODELS），渠道链后端内部维护（同主平台策略）：
    每渠道自带一次 429 退避重试，失败即切下一渠道；未配置 key 的渠道自动跳过。
    """

    def __init__(self, model_id: str | None = None) -> None:
        self.settings = get_settings()
        self.model_id = model_id or self.settings.image_model
        if not any(m["id"] == self.model_id for m in IMAGE_MODELS):
            # 未知模型按旧行为兜底到 gpt-image-2 渠道链（保持向后兼容）
            self.model_id = "gpt-image-2"

    # ---- 渠道工厂：返回 (渠道名, 协程工厂) 列表；未配置的渠道剔除 ----
    # refs 非空 = 图生图：RunningHub 文生图端点不支持参考图，自动剔除。
    #
    # ⚠️ **底层模型 id 是"每条渠道各自的"，不是全局唯一的**（2026-09-03 接入
    # modelverse 时踩到）：nano-banana-pro 在 zx1/api4me 上叫
    # `gemini-3-pro-image-preview`，在 modelverse 上叫 `gemini-3-pro-image`
    # （无 -preview 后缀）。若沿用旧写法让三条渠道共用一个 `gm` 变量，
    # modelverse 会收到不存在的 id → 404/503 → 被判"模型级故障"冷却 120s，
    # 表现是**渠道配了等于没配，且只在日志里留一行**，极难发现。
    # 故凡是 id 有差异的模型，都显式写出各渠道的 id（见 gm / gm_mv）。
    def _chain(self, prompt: str, size: str, n: int,
               refs: list[bytes] | None = None) -> list[tuple[str, Callable[[], Awaitable[list[bytes]]]]]:
        s = self.settings
        zx1_img = s.img_api_key            # zx1 图像分组 key（gpt-image-2）
        zx1_llm = s.llm_api_key            # zx1 文本分组 key（gemini 系有权限）
        zx1_base = s.llm_base_url          # https://zx1.deepwl.net/v1
        # kege 基址（2026-10-10 起替换已全线失效的 api4me；未配则整条不注册）
        kege_base = s.kege_v1_base
        # modelverse：第三条渠道，单 key 覆盖全部模型（无 api4me 的分组之分）。
        # 一律**排在最后**——单价明显高于前两家，定位是"前面都挂了才用"，
        # 与文本侧 llm_channel_order 的成本逻辑一致。
        mv_base = s.modelverse_v1_base
        mv_key = s.modelverse_api_key if mv_base else ""
        chain: list[tuple[str, Callable[[], Awaitable[list[bytes]]]]] = []

        if self.model_id == "gpt-image-2":
            # ⚠️ **各渠道的上游模型名不统一，必须分别给候选名链**（2026-10-09 实测）：
            #   zx1         : 已改名 → 只认 `gpt-image-2-c`（旧名 503 model_not_found）
            #   kege        : 与 zx1 同属 new-api 平台（错误体同为 new_api_error），
            #                 2026-10-10 实测 `gpt-image-2-c` 出图正常。
            #                 两个名字都给，靠候选名链自动选中可用的那个。
            #   modelverse  : **仍是 `gpt-image-2`** —— 实测带 `-c` 返回
            #                 400 "not support for model"，故只能给旧名。
            #   RunningHub  : 走自家工作流 id，与此无关。
            # 上游再次改名时，只需在对应候选表里补一个名字，不至于整条渠道静默变砖。
            zx1_g2 = ["gpt-image-2-c", "gpt-image-2"]
            kege_g2 = ["gpt-image-2-c", "gpt-image-2"]
            mv_g2 = ["gpt-image-2"]
            if zx1_img:
                chain.append(("zx1", lambda: _oai_images(
                    zx1_base, zx1_img, zx1_g2, prompt, n, size, refs=refs)))
            if kege_base and s.kege_gpt_api_key:
                chain.append(("kege", lambda: _oai_images(
                    kege_base, s.kege_gpt_api_key, kege_g2, prompt, n, size,
                    timeout=420, refs=refs)))
            if s.runninghub_api_key and not refs:
                chain.append(("rh-g2", lambda: _rh_v2_t2i(
                    "/openapi/v2/rhart-image-g-2/text-to-image", prompt, n, size)))
            if mv_key:   # id 与前两家一致
                chain.append(("modelverse", lambda: _oai_images(
                    mv_base, mv_key, mv_g2, prompt, n, size,
                    timeout=420, refs=refs)))
        elif self.model_id == "nano-banana-pro":
            gm = "gemini-3-pro-image-preview"
            gm_mv = "gemini-3-pro-image"    # ⚠️ modelverse 上没有 -preview 后缀
            if zx1_llm:
                chain.append(("zx1", lambda: _gemini_gen(
                    zx1_base, zx1_llm, gm, prompt, n, size, refs=refs)))
            if kege_base and s.kege_gemini_api_key:
                chain.append(("kege", lambda: _gemini_gen(
                    kege_base, s.kege_gemini_api_key, gm, prompt, n, size,
                    timeout=420, refs=refs)))
            if s.runninghub_api_key and not refs:
                chain.append(("rh-npro", lambda: _rh_v2_t2i(
                    "/openapi/v2/rhart-image-n-pro/text-to-image", prompt, n, size)))
            if mv_key:
                chain.append(("modelverse", lambda: _gemini_gen(
                    mv_base, mv_key, gm_mv, prompt, n, size,
                    timeout=420, refs=refs)))
        elif self.model_id == "nano-banana-2":
            gm = "gemini-3.1-flash-image"
            if zx1_llm:
                chain.append(("zx1", lambda: _gemini_gen(
                    zx1_base, zx1_llm, gm, prompt, n, size, refs=refs)))
            if kege_base and s.kege_gemini_api_key:
                chain.append(("kege", lambda: _gemini_gen(
                    kege_base, s.kege_gemini_api_key, gm, prompt, n, size,
                    timeout=420, refs=refs)))
            if mv_key:   # id 与前两家一致
                chain.append(("modelverse", lambda: _gemini_gen(
                    mv_base, mv_key, gm, prompt, n, size,
                    timeout=420, refs=refs)))
        elif self.model_id == "midjourney":
            # 只有 zx1 文本分组 key 有 midjourney（见 _mj_imagine 文档）；不接参考图。
            if zx1_llm and not refs:
                root = zx1_base.rstrip("/").removesuffix("/v1")
                chain.append(("zx1-mj", lambda: _mj_imagine(root, zx1_llm, prompt, size)))
        elif self.model_id == "z-image":
            # ⚠️ modelverse **没有** z-image/z-image-turbo（2026-09-03 全表核过），
            # 故这里加不了第三条。现状是本模型最薄的一环：图生图时 rh-portrait
            # 被 `not refs` 剔除 → **只剩 api4me 一条**，它一挂该模型即不可用。
            # 补渠道需另找承载 z-image 的中转站，不是 modelverse 能解决的。
            if s.runninghub_api_key and s.runninghub_portrait_workflow_id and not refs:
                chain.append(("rh-portrait", lambda: _rh_portrait(prompt, n, size)))
            if s.api4me_api_key:
                # ⚠️ d51685a 删 api4me 其它分支时把 `a4m_base` 的定义一起删了，
                #    这里漏改 → 只要配了 api4me key，z-image 走到这条就 NameError。
                a4m_base = s.api4me_base_url.rstrip("/") + "/v1"
                chain.append(("api4me", lambda: _oai_images(
                    a4m_base, s.api4me_api_key, "z-image-turbo", prompt, n, size,
                    timeout=420, refs=refs)))
        return chain

    async def generate(self, prompt: str, size: str = "1024x1024", n: int = 1,
                       ref_urls: list[str] | None = None) -> list[str]:
        """生成图片，返回本地 URL 列表。跨渠道兜底 + 冷却 + 带抖动的退避重试。

        ref_urls：参考图（图生图）。首帧生成用：喂角色定妆/场景参考图，
        产出与资产一致的镜头首帧。

        调度：健康渠道优先 → 每渠道最多 `image_retries` 次带抖动的指数退避
        （只对 429/超时/网络抖动这类**瞬时**错误重试）→ 判定该渠道不可用则冷却
        并切下一条 → 全部渠道失败才抛错。
        ⚠️ 这套机制是"容忍限流、绕开坏渠道"，**不降任何并发数**。
        """
        s = self.settings
        refs = await _load_ref_bytes(ref_urls) if ref_urls else None
        chain = self._chain(prompt, size, n, refs=refs or None)
        spec = next((m for m in IMAGE_MODELS if m["id"] == self.model_id), {})
        if not chain and refs and spec.get("supports_refs") is False:
            raise RuntimeError(f"{spec.get('label', self.model_id)} 不支持参考图，请去掉参考图再生成")
        if not chain:
            raise RuntimeError(f"模型 {self.model_id} 无可用渠道（缺 key 配置）")

        # 健康的排前面；全在冷却中则保持原序（宁可撞一次也不能无渠道可用）
        healthy = [c for c in chain if _healthy(c[0], self.model_id)]
        ordered = healthy + [c for c in chain if c not in healthy] if healthy else chain

        errs: list[str] = []
        mod_reject: ContentRejected | None = None  # 记录第一次审核拒绝，便于抛错时带上
        for name, factory in ordered:
            for attempt in range(max(1, s.image_retries)):
                try:
                    images = await factory()
                except ChannelDown as e:
                    # 渠道级故障：冷却后立刻换下一条，不在这条上继续耗
                    _mark_down(name, self.model_id, s.image_channel_cooldown, e)
                    errs.append(f"{name} → {e}")
                    break
                except ContentRejected as e:
                    # 内容审核拒绝：**不重试**（同样提示词必然同样判定）、
                    # **不冷却渠道**（渠道健康，是这次内容过不了）、
                    # 但**仍试下一条**（各家审核尺度不同，实测 gpt-image-2 双渠道
                    # 全拒的提示词，nano-banana-pro 正常出图）。
                    if mod_reject is None:
                        mod_reject = e   # 全渠道同样被拒时，带上第一家的类别信息
                    errs.append(f"{name} → 审核拒绝")
                    break
                except Exception as e:  # noqa: BLE001
                    # 异步任务型渠道（RunningHub）的审核结论以任务状态回来，
                    # 不经 _classify_http，在这里兜住，按审核拒绝同样处理
                    rejected = _as_moderation_exc(e)
                    if rejected is not None:
                        if mod_reject is None:
                            mod_reject = rejected
                        errs.append(f"{name} → 审核拒绝")
                        break
                    if _is_transient(e) and attempt < s.image_retries - 1:
                        # 429/超时：退避重试。抖动见 _backoff——无并发上限时
                        # 固定退避会让整批请求同步二次打满网关
                        await _backoff(attempt)
                        continue
                    if _is_transient(e):
                        # 退避到头仍限流 → 判定本渠道当前不可用，冷却并换渠道，
                        # 等于把压力分散到另一条渠道上
                        down = ChannelDown(f"持续限流/超时（重试 {s.image_retries} 次）: "
                                           f"{str(e)[:120]}")
                        _mark_down(name, self.model_id, s.image_channel_cooldown, down)
                        errs.append(f"{name} → {down}")
                    else:
                        # 内容级错误（如返回体无图）：不算渠道故障，不冷却本渠道
                        # （别把一条好渠道因一次坏提示词封掉），但仍继续试下一条
                        # ——不同渠道上游实现不同，未必同样拒绝
                        errs.append(f"{name}={str(e)[:150]}")
                    break
                else:
                    if errs:   # 前面有渠道失败过，记一笔便于事后追因
                        logger.info("图像渠道已切换到 %s（前序失败：%s）",
                                    name, "；".join(errs))
                    # 用量：0.15 元/张，所有生图模型同价（见 app/pricing.py）
                    from .. import usage as _usage
                    _usage.record("image", model_id=self.model_id, channel=name,
                                  units=len(images) if images else n)
                    # 落盘是同步 IO，丢线程池避免阻塞事件循环（无并发上限时
                    # 几百张图同时落盘，累计阻塞很可观）
                    return await asyncio.to_thread(_save_all, images)

        if mod_reject is not None and all("审核拒绝" in e for e in errs):
            # 全部渠道都因内容审核被拒 → 抛 ContentRejected 而非泛化 RuntimeError，
            # 上层据此给用户「换生图模型 / 改写提示词」的可执行建议，
            # 而不是含糊的"图像渠道不可用"（用户无从判断该等还是该改）。
            cats = "、".join(mod_reject.categories) if mod_reject.categories else "未标注类别"
            raise ContentRejected(
                f"{self.model_id} 全部 {len(ordered)} 条渠道均判定内容违规（{cats}）。"
                f"重试无效——同一提示词判定一致；"
                f"建议换生图模型（不同厂商审核尺度不同）或改写该镜提示词。",
                categories=mod_reject.categories)

        # 混合失败（部分渠道审核拒绝、部分渠道真故障）：仍按渠道故障抛出——
        # 那条故障渠道从未给出审核结论，重试仍有希望，不该武断让用户去改提示词。
        # 但必须把审核那部分说出来：否则用户只看到"建议增加 API KEY"，
        # 反复重试到故障渠道恢复，才发现真正卡住的是提示词过不了审。
        # 提示放在**最前面**：上层（jobs/接口）会把错误截断到 300 字，
        # 各渠道明细往往就把配额吃满了，压在末尾的建议必被剪掉。
        hint = ""
        if mod_reject is not None:
            n_mod = sum(1 for e in errs if "审核拒绝" in e)
            cats = "、".join(mod_reject.categories) if mod_reject.categories else ""
            hint = (f"其中 {n_mod} 条渠道判定内容违规{('：' + cats) if cats else ''}"
                    "——若重试仍失败，请改写提示词或换生图模型。")
        raise RuntimeError(
            f"{self.model_id} 全部 {len(ordered)} 条渠道均失败。{hint}"
            "若为限流，建议增加 API KEY 或提升配额，而非降并发。明细: "
            + "; ".join(errs))


def channel_names(model_id: str | None = None) -> list[str]:
    """该模型当前已配置的渠道名（/health 排障用，不含任何 key）。

    用文生图口径（refs=None）枚举——图生图会剔除 RunningHub 那条，
    健康面板报的是"这个模型总共有几条渠道可用"。
    """
    p = ImageProvider(model_id=model_id)
    return [name for name, _ in p._chain("", "1024x1024", 1)]
