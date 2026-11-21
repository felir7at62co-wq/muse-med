"""低价 seedance2.5：三条第三方中转渠道，互为兜底。

## 为什么是独立的一个模型

它与 `seedance-2.5`（火山官方 EP）**完全无关**：不出自同一个上游、不走同一套
鉴权（无 FW_ARK_API_KEY / 无可信资产入库）、失败模式也不同。因此它是注册表里
**并列的另一个 model_id**，而不是 seedance-2.5 的一条兜底渠道——不能让官方通道
的失败"顺带"落到这里计费，也不能让这里的失败污染官方通道的健康度。

## 为什么只有 30s / 720p / 9:16 与 16:9

三渠道交集实测（2026-09-15）：

| | 时长 | 比例 | 清晰度 |
|---|---|---|---|
| gw-oai     | 30 | 9:16 16:9 | 720p |
| gw-frame   | 30（`-30s` 别名；`-special` 别名 30s 无定价返 402） | 9:16 16:9 | 720p |
| gw-shanhai | 4–30 | 9:16 16:9 | 720p |

**30 是唯一三渠道都能出的时长**，故 `duration_slots=[30]` 写死。比例取交集但不
写死：生成时按目标渠道的 `ratios` 再过滤一遍——渠道能力是数据（JSON）不是常量，
日后某条渠道加了 21:9 只需改 JSON。

## 真人形象参考图

实测（合成真人肖像，非真实人物）：

- gw-frame：**支持**，模型描述明写「支持人像参考，需审核」，单图实测出片且面部一致
- gw-shanhai：**不稳定**，单图被拦、双图通过
- gw-oai：**不支持**，带人像的请求上游返 `generation_failed(710082025)`

故 `person_ref` 是每个渠道的数据字段：带参考图时**优先挑 person_ref 的渠道**，
但被拦的渠道本身不算故障（不冷却），只是本次内容它过不了。

## 兜底与「不降并发」

完全沿用 `providers/image.py` 的模式：健康渠道优先 → 每渠道瞬时错误带抖动退避重试
→ 判定渠道不可用则冷却并切下一条 → 全挂才失败。**不设任何并发上限**，
并发数仍由 `FW_VIDEO_CONCURRENCY` 统一掌控（遵并发铁律）。

## 审核拒绝绝不降级切渠道

内容审核失败在同内容下必然重现，换了渠道只是**再扣一次费**。故
`ContentRejected` 直接判失败并向上抛，不冷却渠道、不切下一条。
渠道级故障（余额/无可用渠道/5xx/超时）才切。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from ..config import get_settings
from . import http
from ..media import GENERATED_DIR
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult, VisualMode,
                   sanitize_video_prompt, to_public_url)

logger = logging.getLogger(__name__)

_CHANNELS_FILE = Path(__file__).resolve().parent / "lowcost_channels.json"

#: 三渠道唯一共同时长。改这里前先确认每条渠道的 duration 字段都支持。
COMMON_DURATION = 30
#: 三渠道共同清晰度
COMMON_RESOLUTION = "720p"
#: 同时作为 registry 里的 model_id 与提示词框架选取依据
LOWCOST_MODEL_ID = "seedance-lowcost-2.5"

#: 渠道不可用（余额/无可用渠道/鉴权/5xx/超时）→ 冷却并切下一条
_COOLDOWN: dict[str, float] = {}


class ChannelDown(RuntimeError):
    """渠道级故障：换一条渠道可能就好了。"""

    def __init__(self, msg: str, *, account_level: bool = False) -> None:
        super().__init__(msg)
        self.account_level = account_level


class ContentRejected(RuntimeError):
    """内容/人像审核拒绝：换渠道无用（同内容同判定），且换渠道=再扣一次费。"""

    def __init__(self, msg: str, *, person: bool = False) -> None:
        super().__init__(msg)
        self.person = person   # 是否是"真人形象参考图"被拦


class RefUnavailable(RuntimeError):
    """参考图自己拉不下来（404/超时等）——**不是渠道的锅**。

    与 ChannelDown 分开的理由：参考图取不到时，换任何一条渠道都会在同一步
    栽同样的跟头（gw-frame 本地 GET 失败、另两条把死链交给上游），
    所以既不该把这条渠道冷却 300s（它可能好得很），也不该把整条链跑一遍
    白等三次超时。直接失败并把话说清：问题在那个 URL 上。
    """


#: 审核类文案特征。中转站会把审核拒绝包装成 5xx 或 429，故必须先于状态码判定
#: （image.py 有同一份教训：先按状态码判会把健康渠道误冷却）。
#:
#: ⚠️ **不要**把 `generation_failed` / `upstream_failed` / `upstream_generation_failed`
#: 这类**通用上游失败码**放进来（2026-09-15 曾放过，实测踩坑）：
#: 它们既是 gw-oai 拒真人参考图时的返回码，**也是**上游偶发抖动的返回码
#: （实测 gw-shanhai 一个正常的参考图请求就返 502 `upstream_generation_failed`）。
#: 判成审核 = 不切渠道、不重试、直接失败，把一个**换条渠道就能出片**的请求判死；
#: 判成渠道故障 = 最多在另一条渠道上多花一次钱。后者代价明显更小，
#: 且 gw-oai 那个真实场景本来就该切到支持人像的 gw-frame/gw-shanhai 去。
#: 所以这里只收**明确**的审核词，模糊的一律当渠道故障走兜底。
_MODERATION_MARKERS = (
    "审核", "敏感", "违规", "content policy", "moderation", "safety",
    "人脸", "人像", "肖像", "public figure", "real person",
    "sensitive", "prohibited", "blocked",
    # 「侵权」：gw-frame 对参考图的实测拒绝文案（2026-09-15）——
    #   `内容可能涉及侵权，请更换提示词或素材后重试。已退回余额 ¥3.20`
    # 这是**内容判定**（同图同词换渠道多半同样被拦），且已退款，
    # 故按审核处理：不切链、不冷却，把"换素材/换提示词"这条可执行的话传回去。
    "侵权", "infringement", "copyright",
)


def _as_moderation(status: int, body: str) -> Optional[ContentRejected]:
    low = (body or "").lower()
    if any(m in low for m in _MODERATION_MARKERS):
        person = any(m in low for m in ("人脸", "人像", "肖像", "face", "person"))
        return ContentRejected(f"内容/人像审核拒绝 HTTP {status}: {body[:200]}",
                               person=person)
    return None


def _classify_http(status: int, body: str) -> Optional[ChannelDown]:
    """把 HTTP 错误分类为渠道级故障；None = 不是渠道的锅（别切、别冷却）。

    顺序：审核 → 余额/鉴权（账号级）→ 5xx/404（模型级）。审核必须排最前。
    """
    if _as_moderation(status, body) is not None:
        return None
    low = (body or "").lower()
    if status in (401, 403) or "quota" in low or "balance" in low or "余额" in body \
            or "insufficient" in low:
        return ChannelDown(f"账号级故障 HTTP {status}: {body[:150]}", account_level=True)
    if status in (404, 402, 429, 502, 503, 504) or status >= 500:
        return ChannelDown(f"HTTP {status}: {body[:150]}")
    return None


def _mark_down(name: str, seconds: int, exc: ChannelDown) -> None:
    key = name if exc.account_level else f"{name}"
    _COOLDOWN[key] = time.monotonic() + seconds
    logger.warning("低价渠道 %s 不可用，冷却 %ds：%s", key, seconds, exc)


def _healthy(name: str) -> bool:
    until = _COOLDOWN.get(name)
    if until is None:
        return True
    if time.monotonic() >= until:
        _COOLDOWN.pop(name, None)
        return True
    return False


#: 查询状态时可容忍的连续瞬时错误次数。超了才当渠道故障切链。
#: 依据：gw-shanhai 的 `GET /tasks/{id}` 实测会**偶发** 502
#: `task_query_failed`（同一任务前后几次查询有成功有失败，任务本身仍在跑）。
#: 一次查询失败就判渠道死，会把一条**正在正常出片**的渠道踢掉并去冷却，
#: 白白丢掉已经付费、已经跑了十几分钟的那个任务。
_MAX_QUERY_ERRORS = 4


def _is_transient_query_error(exc: Exception) -> bool:
    """查询阶段的错误是否"这次不算数"。

    只放过网络层抖动（超时/连接断开）与 5xx/429；402（余额）、401/403（鉴权）、
    404（渠道不认这个任务）都是**确定性**的，重试多少次都一样，立即切链。
    """
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    if isinstance(exc, ChannelDown) and not exc.account_level:
        msg = str(exc)
        return any(f"HTTP {c}" in msg for c in (429, 500, 502, 503, 504))
    return False


async def _backoff(attempt: int, base: float = 3.0) -> None:
    """指数退避 + 抖动。无并发上限时固定退避会惊群（同 image.py._backoff）。"""
    await asyncio.sleep(min(base * (2 ** attempt) * (0.5 + random.random()), 30.0))


#: env 变量名 → Settings 字段。渠道清单里只写**变量名**（密钥不进 git）。
#: pydantic-settings 只读 os.environ、**不往里面写**，故不能靠 os.environ 取；
#: 未登记的变量名仍回落到 os.environ（便于临时用环境变量塞 key 做试验）。
_KEY_FIELDS = {
    "FW_LOWCOST_GW1_KEY": "lowcost_gw1_key",
    "FW_LOWCOST_GW2_KEY": "lowcost_gw2_key",
    "FW_LOWCOST_GW3_KEY": "lowcost_gw3_key",
}


#: 图片魔数 → (MIME, 扩展名)。只认这几种：三条渠道都只吃常见位图。
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"GIF87a", "image/gif", "gif"),
    (b"GIF89a", "image/gif", "gif"),
)


def _sniff_image(blob: bytes, content_type: str = "") -> tuple[str, str]:
    """认出参考图的真实类型，返回 (MIME, 扩展名)。

    为什么不信 URL 后缀、也不只信 Content-Type：库里的资产图是后端自己生成的，
    落盘名与响应头都可能与真实字节不一致（走过 CDN/反代更是如此），而 gw-frame
    对"内容与声明不符"的反应是 **500**（见 upload_refs 里的实测记录），
    看起来跟渠道抖动一模一样。以魔数为准最稳；认不出时才退回响应头，
    最后兜底 jpeg（保持与改动前一致的行为，不引入新的失败面）。
    """
    for magic, mime, ext in _MAGIC:
        if blob.startswith(magic):
            return mime, ext
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp", "webp"
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct.startswith("image/"):
        return ct, ct.split("/", 1)[1] or "jpg"
    return "image/jpeg", "jpg"


def channel_key(env_name: str) -> str:
    field = _KEY_FIELDS.get(env_name)
    if field:
        return (getattr(get_settings(), field, "") or "").strip()
    return (os.environ.get(env_name) or "").strip()


@dataclass
class Channel:
    """一条渠道的配置。全部字段来自 lowcost_channels.json。"""

    name: str
    dialect: str
    base_url: str
    api_key_env: str
    upstream_model: str
    duration: int = COMMON_DURATION
    resolution: str = COMMON_RESOLUTION
    ratios: list[str] = field(default_factory=lambda: ["9:16", "16:9"])
    max_reference_images: int = 9
    person_ref: bool = False
    priority: int = 50
    enabled: bool = True
    #: 该渠道的参考图**只收 HTTPS**（gw-shanhai 实测：http 与 data URI 都 422
    #: `invalid_input_url: Input media URLs must use HTTPS`）。
    #:
    #: 之所以要建模成字段而不是写死在方言里：本项目的 media_base 是
    #: **http**（`http://118.196.33.51:9080/fw`，全站无 HTTPS），于是"库里的
    #: 资产图"对这类渠道**天生不可用**——不是偶发故障，而是每次必 422。
    #: 不先筛掉的话，每个带参考图的镜头都会在它身上白撞一次、还把它冷却 300s，
    #: 顺带把日志刷满"渠道故障"。将来站点上了 HTTPS，这条限制会自动失效
    #: （判据看的是实际 URL 的 scheme，不是写死的结论）。
    ref_needs_https: bool = False

    @property
    def api_key(self) -> str:
        return channel_key(self.api_key_env)

    @property
    def headers(self) -> dict:
        """下载成片时带的鉴权头。

        与 `_Dialect.headers` 的区别是**不带 Content-Type**：那条路径是 GET 一个
        mp4 流，带上 application/json 只会让某些反代误判。渠道间鉴权方式一致
        （都是 Bearer），所以这一份可以共用；将来某条渠道换成 query token 或
        签名，改这里一处即可。
        """
        return {"Authorization": f"Bearer {self.api_key}"}

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url)

    def supports_ratio(self, ratio: Optional[str]) -> bool:
        if not ratio:
            return True
        return ratio in self.ratios


def load_channels() -> list[Channel]:
    """读渠道清单。文件缺失/损坏时返回空表（=模型不注册），绝不抛。

    这是"未来可能要增删渠道"的落点：加一条渠道 = 往 JSON 加一个对象 +
    在 .env 配一把 key，不需要碰任何 .py。
    """
    try:
        raw = json.loads(_CHANNELS_FILE.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.error("低价 seedance2.5 渠道清单读取失败（%s）：%s", _CHANNELS_FILE, e)
        return []
    out: list[Channel] = []
    seen: set[str] = set()
    for item in (raw.get("channels") or []):
        if not isinstance(item, dict) or not item.get("name"):
            continue
        name = str(item["name"])
        if name in seen:
            logger.error("低价渠道名重复，已跳过：%s", name)
            continue
        seen.add(name)
        try:
            out.append(Channel(
                name=name,
                dialect=str(item.get("dialect") or ""),
                base_url=str(item.get("base_url") or "").rstrip("/"),
                api_key_env=str(item.get("api_key_env") or ""),
                upstream_model=str(item.get("upstream_model") or ""),
                duration=int(item.get("duration") or COMMON_DURATION),
                resolution=str(item.get("resolution") or COMMON_RESOLUTION),
                ratios=list(item.get("ratios") or ["9:16", "16:9"]),
                max_reference_images=int(item.get("max_reference_images") or 9),
                person_ref=bool(item.get("person_ref")),
                priority=int(item.get("priority") or 50),
                enabled=bool(item.get("enabled", True)),
                ref_needs_https=bool(item.get("ref_needs_https")),
            ))
        except Exception as e:  # noqa: BLE001
            logger.error("低价渠道 %s 配置非法，已跳过：%s", name, e)
    return out


# ---------------------------------------------------------------- 方言适配器

class _Dialect:
    """一种渠道协议的适配器。submit 返回 (task_id, 已解析好的直链 or None)。"""

    dialect: str = ""

    def __init__(self, ch: Channel) -> None:
        self.ch = ch

    @property
    def base(self) -> str:
        return self.ch.base_url

    @property
    def _origin(self) -> str:
        """base_url 的 scheme://host[:port]（去掉路径）。

        仅用于把渠道返回的**绝对路径**（如 `/v1/tasks/<id>/video`）接成完整 URL：
        那条路径自带 `/v1`，接在 base（可能含 `/api` 之类前缀）后面就成了
        `/api/v1/v1/...` → 404。
        """
        return "{0.scheme}://{0.netloc}".format(urlparse(self.base))

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.ch.api_key}",
                "Content-Type": "application/json"}

    async def upload_refs(self, urls: list[str]) -> list[str]:
        """把参考图变成该渠道能吃的形态。默认原样返回绝对 URL。"""
        return urls

    async def create(self, c: httpx.AsyncClient, prompt: str, refs: list[str],
                     ratio: str, duration: int,
                     idem: Optional[str] = None) -> tuple[str, Optional[str]]:
        """提交一次生成。`idem` 是本次提交固定的幂等键（见 provider._run_one）。"""
        raise NotImplementedError

    async def fetch(self, c: httpx.AsyncClient, task_id: str) -> tuple[str, Optional[str], str]:
        """返回 (status, download_url, error)。status ∈ queued/running/done/failed。"""
        raise NotImplementedError


class _OpenAIVideo(_Dialect):
    """OpenAI 兼容视频通道：POST /v1/videos + GET /v1/videos/{id}。

    参考图字段是 `images`（URL 数组），远端自己拉——故必须是公网绝对地址。
    """

    dialect = "openai-video"

    async def create(self, c, prompt, refs, ratio, duration, idem=None):
        body: dict = {"model": self.ch.upstream_model, "prompt": prompt,
                      "seconds": str(duration), "ratio": ratio}
        if refs:
            body["images"] = refs
        r = await c.post(f"{self.base}/v1/videos", headers=self.headers, json=body)
        if r.status_code not in (200, 201, 202):
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            rej = _as_moderation(r.status_code, r.text)
            if rej:
                raise rej
            raise RuntimeError(f"提交 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        tid = d.get("id") or d.get("task_id")
        if not tid:
            raise RuntimeError(f"未返回任务 id: {r.text[:200]}")
        return str(tid), None

    async def fetch(self, c, task_id):
        r = await c.get(f"{self.base}/v1/videos/{task_id}", headers=self.headers)
        if r.status_code != 200:
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        st = str(d.get("status") or "").lower()
        url = d.get("url") or (d.get("data") or {}).get("url") or d.get("video_url")
        if st in ("completed", "succeeded", "success"):
            return "done", url, ""
        if st in ("failed", "error", "cancelled", "canceled"):
            msg = json.dumps(d.get("error") or d.get("message") or d, ensure_ascii=False)
            rej = _as_moderation(0, msg)
            if rej:
                raise rej
            return "failed", None, msg[:300]
        return "running", None, ""


class _FwFrame(_Dialect):
    """帧间通道：参考图必须**先上传换 asset id**，不接受远端 URL。

    三个特有约束（2026-09-15 实测）：
    1. `Idempotency-Key` 必填（16–100 位 [A-Za-z0-9_-]）；提交超时重试必须**复用**
       同一把 key，否则同一内容会被重复受理、重复扣费。
    2. 下载地址是**相对路径**（`/v1/tasks/<id>/video`），必须自己拼 BASE。
    3. 状态 `unknown` + `暂未收到提交回执…请勿重复提交`：**任务仍在跑**，不是失败。
       （早先按"排不进去/渠道故障"处理是错的，见 fetch 里的实测记录。）
    """

    dialect = "fw-frame"

    def __init__(self, ch: Channel) -> None:
        super().__init__(ch)

    async def upload_refs(self, urls):
        out: list[str] = []
        async with http.client("lowcost-submit", timeout=300.0) as c:
            for u in urls:
                try:
                    r = await c.get(u, timeout=180.0)
                except Exception as e:  # noqa: BLE001
                    # 连接不上那张图 ≠ 渠道坏了（见 RefUnavailable）
                    raise RefUnavailable(
                        f"参考图无法访问: {u[:120]} ({e!r})") from e
                if r.status_code != 200:
                    raise RefUnavailable(
                        f"参考图下载失败 HTTP {r.status_code}: {u[:120]}")
                # ⚠️ 必须按**真实字节**报类型，不能一律 ref.jpg/image/jpeg
                #（2026-09-15 实测踩坑）：本项目资产图大多是 PNG，把 PNG 内容
                # 标成 image/jpeg 上传，本渠道**稳定返 500**
                #（`当前服务暂时不可用` —— 一个把"格式不符"包装成 5xx 的报错，
                # 极易被误判成渠道抖动，进而白切一条渠道再付一次钱）。
                # 同一张图按 image/png 上传则稳定 200。
                mime, ext = _sniff_image(r.content,
                                         r.headers.get("content-type", ""))
                files = {"file": (f"ref.{ext}", r.content, mime)}
                data = {"model": self.ch.upstream_model, "kind": "image"}
                # ⚠️ **不能用 self.headers**（它带 Content-Type: application/json）。
                # 这是 multipart 上传：显式给了 Content-Type 就会顶掉 httpx 自己
                # 生成的 `multipart/form-data; boundary=...`，服务端拿不到边界串、
                # 解不出 body → 返 500 `当前服务暂时不可用`。
                #
                # 2026-09-15 A/B 实测（同一份 4.8MB PNG、同一端点）：
                #   headers={Authorization, Content-Type: application/json} → 500
                #   headers={Authorization}                                 → 200
                # 这个 500 的文案像"渠道抖动"，实际是本地请求构造错误 ——
                # 之前据此判渠道故障、冷却 300s 并切链，等于为自己的 bug 付两次钱。
                # （requests 里没暴露：它会用自己的 multipart 头覆盖传入值。）
                up = await c.post(f"{self.base}/v1/assets", headers=self.ch.headers,
                                  data=data, files=files)
                if up.status_code not in (200, 201):
                    down = _classify_http(up.status_code, up.text)
                    if down:
                        raise down
                    raise RuntimeError(f"素材上传 HTTP {up.status_code}: {up.text[:200]}")
                aid = (up.json() or {}).get("id")
                if not aid:
                    raise RuntimeError(f"素材上传未返回 id: {up.text[:200]}")
                out.append(str(aid))
        return out

    async def create(self, c, prompt, refs, ratio, duration, idem=None):
        body = {"model": self.ch.upstream_model, "prompt": prompt,
                "resolution": self.ch.resolution, "seconds": duration,
                "ratio": ratio}
        if refs:
            body["assets"] = refs
        h = {**self.headers, "Idempotency-Key": idem or uuid.uuid4().hex}
        r = await c.post(f"{self.base}/v1/videos", headers=h, json=body)
        if r.status_code not in (200, 201, 202):
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            rej = _as_moderation(r.status_code, r.text)
            if rej:
                raise rej
            raise RuntimeError(f"提交 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        tid = d.get("id") or d.get("task_id")
        if not tid:
            raise RuntimeError(f"未返回任务 id: {r.text[:200]}")
        return str(tid), None

    async def fetch(self, c, task_id):
        r = await c.get(f"{self.base}/v1/tasks/{task_id}", headers=self.headers)
        if r.status_code != 200:
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        st = str(d.get("status") or "").lower()
        url = d.get("video") or d.get("url") or ""
        if isinstance(url, dict):
            url = url.get("url", "")
        # ⚠️ 相对路径：不拼就是 0 字节的下载失败（2026-09-15 踩过）。
        # 但**只能拼 origin，不能拼 base**：本渠道给的相对地址自带 `/v1`
        # （实测 `/v1/tasks/<id>/video`），而 base 里已经含了 `/api` 之类的
        # 前缀，直接 `base + url` 会得到 `https://host/api/v1/v1/tasks/...` → 404。
        if url.startswith("/"):
            url = self._origin + url
        if st == "completed":
            return "done", url, ""
        # ⚠️ `unknown` **不是终态**（2026-09-15 实测纠正）：本渠道用它表示
        # "提交回执丢了，我正在自己查"，同一份 payload 里明写着
        # `statusWarning: 任务处理中，完成后视频会自动显示，无需重复提交`、
        # `error: 暂未收到提交回执…请勿重复提交`、`waitingLong: false`。
        # 实测一个带参考图的任务在 unknown 上停了 6 分钟以上，随后照常出片。
        # 早先把它并进 failed 会：① 丢掉一个**已扣费且正在跑**的任务；
        # ② 立刻切下一条渠道**再扣一次**；③ 还违反上游"请勿重复提交"的明示。
        # 所以按 running 继续轮询——真出不来的话，poll_max 那层的超时会收口。
        if st == "unknown":
            return "running", None, ""
        if st == "failed":
            msg = json.dumps({k: d.get(k) for k in ("statusWarning", "error", "message")},
                             ensure_ascii=False)
            rej = _as_moderation(0, msg)
            if rej:
                raise rej
            return "failed", None, msg[:300]
        return "running", None, ""


class _Shanhai(_Dialect):
    """山海画布：POST /generations + GET /tasks/{id}。

    参考图走 `inputs:[{type:image,url}]`，**只收 HTTPS**（data URI 与 http 都 422）。
    """

    dialect = "shanhai"

    async def create(self, c, prompt, refs, ratio, duration, idem=None):
        body: dict = {"model": self.ch.upstream_model, "prompt": prompt,
                      "media_type": "video"}
        if refs:
            body["inputs"] = [{"type": "image", "url": u} for u in refs]
        body["options"] = {"aspect_ratio": ratio,
                           "resolution": self.ch.resolution,
                           "duration": duration}
        r = await c.post(f"{self.base}/generations", headers=self.headers, json=body)
        if r.status_code not in (200, 201, 202):
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            rej = _as_moderation(r.status_code, r.text)
            if rej:
                raise rej
            raise RuntimeError(f"提交 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        tid = d.get("id") or d.get("task_id")
        if not tid:
            raise RuntimeError(f"未返回任务 id: {r.text[:200]}")
        return str(tid), None

    async def fetch(self, c, task_id):
        r = await c.get(f"{self.base}/tasks/{task_id}", headers=self.headers)
        if r.status_code != 200:
            down = _classify_http(r.status_code, r.text)
            if down:
                raise down
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        st = str(d.get("status") or "").lower()
        out = d.get("output") or {}
        url = out.get("url") if isinstance(out, dict) else ""
        if st in ("succeeded", "success"):
            return "done", url, ""
        if st in ("failed", "cancelled"):
            msg = json.dumps(d.get("error") or d, ensure_ascii=False)
            rej = _as_moderation(0, msg)
            if rej:
                raise rej
            return "failed", None, msg[:300]
        return "running", None, ""


_DIALECTS: dict[str, type[_Dialect]] = {
    "openai-video": _OpenAIVideo,
    "fw-frame": _FwFrame,
    "shanhai": _Shanhai,
}


def _make_dialect(ch: Channel) -> Optional[_Dialect]:
    cls = _DIALECTS.get(ch.dialect)
    if cls is None:
        logger.error("低价渠道 %s 的方言未知，已跳过：%s", ch.name, ch.dialect)
        return None
    return cls(ch)


# ---------------------------------------------------------------- Provider

class LowCostSeedanceProvider(VideoProvider):
    """低价 seedance2.5：多渠道互为兜底的单体 Provider。"""

    #: 轮询预算 = poll_interval × poll_max = 20s × 150 ≈ 50 分钟。
    #:
    #: 定这个数的依据（2026-09-15 实测）：顺畅时单条 30s 片子 766–858 秒出片
    #: （13–14 分钟），但 gw-frame **单账号只允许 3 个未结算任务**，一旦排队，
    #: 实测同一批里有任务卡到 40 分钟以上仍在正常处理
    #: （status=unknown + `waitingLong:false`，随后照常出片）。
    #: 原来的 90（=30 分钟）会在那种情况下超时抛 ChannelDown → 冷却一条**好**渠道
    #: → 换一条**重新付一次钱**，而先前那单照样会扣。宁可多等 20 分钟。
    #: ⚠️ 这不是并发参数，只是"等多久才判死"，不影响吞吐。
    def __init__(self, model_id: str = LOWCOST_MODEL_ID,
                 channels: Optional[list[Channel]] = None,
                 poll_interval: float = 20.0, poll_max: int = 150) -> None:
        self.model_id = model_id
        self.visual_mode = VisualMode.reference
        self.audio_mode = AudioMode.tts_separate   # 三渠道都不吃参考音频
        #: 时长是**写死的 30**，不是"档位里的一个选项"：三渠道交集只有 30，
        #: 少一秒都可能被某条渠道拒（gw-frame 的 -30s 别名只认 30）。
        #: 故 min=max=30，上层划区间/选档位时不会算出别的值来。
        self.duration_slots = [COMMON_DURATION]
        self.max_duration = COMMON_DURATION
        self.min_duration = COMMON_DURATION
        self.supports_last_frame = False
        #: ⚠️ 分辨率**本渠道吃不到项目档位**：请求里的 `megapixels`（项目默认档案
        #: 下的 480p/720p/1080p/2k）在这里一律无效——三条渠道固定 720p，值写在
        #: 渠道清单里（每条一个 `resolution`，便于将来某条升档）。项目要是选了
        #: 1080p，出来的仍是 720p，**且不报错**。之所以不在这里按 megapixels 反推
        #: 档位：这三条渠道的文档/实测都没有分档证据，猜一个 1080p 传上去只会换来
        #: 400 或被静默降回 720p，不如统一 720p、行为可预期。前端已据此提示。
        self.aspect_ratios = ["9:16", "16:9"]
        #: 三条渠道**固定 720p**，项目档位（480p/1080p/2k）对本模型完全无效，
        #: 且不报错。如实声明，前端据此把其它档位禁用并说明原因——
        #: 否则用户把项目改成 1080p、出来的仍是 720p，只会以为是平台没生效。
        #: （值取自每条渠道自己的 `resolution`，见上面的 COMMON_RESOLUTION 注释。）
        self.supported_resolutions = sorted(
            {c.resolution for c in (channels if channels is not None
                                    else load_channels())} or {COMMON_RESOLUTION})

        self.max_reference_images = 9
        self.supports_reference_audio = False
        self.supports_reference_video = False
        self.poll_interval = poll_interval
        self.poll_max = poll_max
        self.channels: list[Channel] = (channels if channels is not None
                                        else load_channels())
        #: 提示词框架：与官方 seedance 2.5 同一套（见 prompt_opt.service.framework_for_model）
        self.prompt_framework = "seedance2"

    # ---- 对外可见的渠道状况（供 /v2/providers/video 与健康接口）----
    def channel_report(self) -> list[dict]:
        """渠道可用性快照。**只输出布尔与 base_url，绝不输出 key。**"""
        out = []
        for ch in sorted(self.channels, key=lambda x: x.priority):
            out.append({
                "name": ch.name,
                "base_url": ch.base_url,
                "enabled": ch.enabled,
                "configured": ch.configured,
                "healthy": _healthy(ch.name),
                "person_ref": ch.person_ref,
                # 运维要看的第二个"为什么没用它"：不是坏，是吃不下 http 参考图
                "ref_needs_https": ch.ref_needs_https,
                "ratios": ch.ratios,
                "duration": ch.duration,
            })
        return out

    def usable_channels(self, ratio: Optional[str] = None,
                        has_refs: bool = False,
                        refs: Optional[list[str]] = None) -> list[Channel]:
        """按兜底顺序返回本次请求可用的渠道。

        排序：person_ref 命中优先（带参考图时）→ priority 小的优先 →
        健康渠道优先（冷却中的垫底，宁可撞一次也不能无渠道可用）。

        `refs` 给了的话还会按**参考图 URL 的实际 scheme** 剔掉吃不下它的渠道
        （见 Channel.ref_needs_https）——那种渠道每次必 422，进链纯属浪费。
        """
        cand = [c for c in self.channels
                if c.enabled and c.configured and c.supports_ratio(ratio)]
        if refs and any(not u.lower().startswith("https://") for u in refs):
            drop = [c.name for c in cand if c.ref_needs_https]
            if drop:
                # 只在**真有非 https 参考图**时剔除；日志说清原因，
                # 否则"渠道明明配好了却没被用"会很难查。
                logger.info("低价渠道 %s 只收 HTTPS 参考图，本次参考图非 HTTPS，"
                            "已跳过（站点上 HTTPS 后自动恢复）", ", ".join(drop))
            cand = [c for c in cand if not c.ref_needs_https]
        if has_refs:
            # 带参考图时把明确支持人像的渠道提前，但**不剔除**其余——
            # 非人像的参考图（场景/物件）在任一渠道都能用。
            cand.sort(key=lambda c: (0 if c.person_ref else 1, c.priority))
        else:
            cand.sort(key=lambda c: c.priority)
        healthy = [c for c in cand if _healthy(c.name)]
        return healthy + [c for c in cand if not _healthy(c.name)] if healthy else cand

    def resolution_for(self, megapixels: float | None) -> str | None:
        """本模型**不按 MP 分档**：无论项目选什么档，出来的都是渠道自己那一档。

        与官方 seedance 的差别就在这里 —— 那边 `resolution_for(3.5)` 会返回
        "1080p"（它确实降档去 1080p 了），这边返回 720p 而**与项目档位无关**。
        上层据此判定"选了没生效"（`pending`），界面才说得清为什么。

        取渠道清单里实际用的那一档（当前是 720p，见 COMMON_RESOLUTION 注释）；
        拿不到渠道时退回 COMMON_RESOLUTION —— 绝不返回 None 假装"不知道"，
        那会让界面误以为"这个模型不按档位下发、所以没落差"。
        """
        if self.supported_resolutions:
            return self.supported_resolutions[0]
        return COMMON_RESOLUTION

    def mode_support(self) -> dict[str, dict]:
        """三渠道共同能力：纯文本 / 首帧+参考图（=全参考）；无首尾帧、无参考音频。"""
        return {
            "t2va": {"available": True, "reference_audio": False},
            "i2va": {"available": True, "reference_audio": False},
            "fl2va": {"available": False, "reason": "低价渠道不支持首尾帧锚定"},
            "l2va": {"available": False, "reason": "低价渠道不支持尾帧锚定"},
            "full_reference": {"available": True, "reference_audio": False,
                               "reference_video": False},
        }

    # ---- 内部工具 ----
    @staticmethod
    def _collect_refs(req: VideoRequest) -> list[str]:
        """参考图统一成"图列表"：首帧图在低价渠道里就是第一张参考图。

        三渠道都没有 first_frame role 的概念（fw-frame 连 role 字段都没有），
        故首帧语义无法原样传达，一律按参考图下发。
        """
        # ⚠️ 必须 to_public_url：库里存的资产图**几乎全是相对地址**
        # （dev 实测 assets.image_url 940/940、asset_stages 689/690 为 `/fw/media/...`），
        # 而这三条渠道没有一条能消化相对路径：
        #   - gw-oai / gw-shanhai 把 URL 字符串塞进请求 JSON，由**上游自己去拉** →
        #     相对路径到了对端就是死链（base.py 里 2026-09-02 那次事故同因）；
        #   - gw-frame 由本进程 GET 回来再上传换 asset id → httpx 直接抛
        #     "Request URL is missing an 'http://'"。
        # 前者**静默**丢参考图（照样出片、照样扣费，只是人物不像），后者报错切链。
        # 两种都不能接受，故在唯一入口补成绝对地址。
        refs: list[str] = []
        for u in ([req.first_frame_url] if req.first_frame_url else []):
            if u:
                refs.append(to_public_url(u) or u)
        for u in (req.reference_image_urls or []):
            if u:
                refs.append(to_public_url(u) or u)
        return refs

    async def _download(self, url: str, ch: Channel) -> str:
        name = f"lc_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        async with http.client("lowcost-download", timeout=900.0, follow_redirects=True) as c:
            async with c.stream("GET", url, headers=ch.headers) as resp:
                resp.raise_for_status()
                with dest.open("wb") as w:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        w.write(chunk)
        return f"/fw/media/generated/{name}"

    async def _run_one(self, ch: Channel, req: VideoRequest, refs: list[str],
                       ratio: str) -> VideoResult:
        """单条渠道跑到底（提交 + 轮询 + 下载）。"""
        d = _make_dialect(ch)
        if d is None:
            raise ChannelDown(f"{ch.name} 方言未知")
        clean = sanitize_video_prompt(req.prompt.strip()) or req.prompt.strip()
        s = get_settings()
        attempts = max(1, int(getattr(s, "video_retries", 2)))
        #: 幂等键：**整次提交**共用一把，重试时复用（见 _FwFrame 的说明）。
        #: 抖动重试若换了 key，上游会把同一次生成当两单各扣一次费。
        idem = uuid.uuid4().hex
        last: Optional[Exception] = None
        for attempt in range(attempts):
            if attempt:
                await _backoff(attempt)
            try:
                async with http.client("lowcost-query", timeout=300.0) as c:
                    remote_refs = await d.upload_refs(refs) if refs else []
                    try:
                        tid, _ = await d.create(c, clean, remote_refs, ratio,
                                                ch.duration, idem)
                    except ChannelDown as e:
                        # 提交阶段的渠道级故障：**先原地重试一次再切链**。
                        #
                        # 依据（2026-09-15 实测）：gw-frame 的 POST /v1/videos 会偶发
                        # 500 `当前服务暂时不可用`，而几秒后同样的请求（同参考图、
                        # 同 asset id）稳定返 202 —— 三发对照全部 202。
                        # 直接切链的代价：在**另一条**渠道上重新生成一次 = 多付一次钱，
                        # 而这条渠道其实几秒后就好了。
                        #
                        # 安全性：提交尚未成功，且重试复用同一把 Idempotency-Key，
                        # 故不会产生两个计费任务。account_level（余额/鉴权）不重试——
                        # 那种错误等多久都一样。
                        if e.account_level or attempt >= attempts - 1:
                            raise
                        logger.warning("低价渠道 %s 提交失败，原地重试：%s", ch.name, e)
                        last = e
                        continue
                    t0 = time.monotonic()
                    qerr = 0                    # 连续查询失败次数（见 _MAX_QUERY_ERRORS）
                    for _ in range(self.poll_max):
                        await asyncio.sleep(self.poll_interval)
                        try:
                            st, url, err = await d.fetch(c, tid)
                        except Exception as e:  # noqa: BLE001
                            # 查询失败 ≠ 任务失败：任务可能好端端地在跑（见
                            # _MAX_QUERY_ERRORS 的实测依据）。瞬时错误计数，
                            # 攒够了才判渠道故障；确定性错误（402/401/404）立即抛。
                            if not _is_transient_query_error(e):
                                raise
                            qerr += 1
                            logger.warning("低价渠道 %s 查询失败 %d/%d：%s",
                                           ch.name, qerr, _MAX_QUERY_ERRORS, e)
                            if qerr >= _MAX_QUERY_ERRORS:
                                raise ChannelDown(
                                    f"{ch.name} 连续 {qerr} 次查询失败: {e}") from e
                            continue
                        qerr = 0
                        if st == "done" and url:
                            # 用量（P0 统计）：低价渠道单价尚未定价，cost 记 0，
                            # 只保证"用了多少次、什么时长"有据可查。记在取片之前。
                            from .. import usage as _usage
                            _usage.record("video", model_id=LOWCOST_MODEL_ID,
                                          channel=ch.name, media_seconds=ch.duration,
                                          cost_fen=0, meta={"task_id": tid})
                            # ⚠️ 取片失败绝不能落进下面的泛 except（2026-10-08 修）。
                            #    那时 `continue` 会**回到本轮尝试的顶部重新
                            #    `d.create(...)`** —— 而任务已经在远端跑完并
                            #    计过费了。注释说"复用同一把 Idempotency-Key
                            #    防重复扣费"，但**只有 `_FwFrame` 发这个头**，
                            #    `_OpenAIVideo` / `_Shanhai` 从不发 → 上游无从去重，
                            #    于是同一条镜头在网关侧真的会生成两遍、扣两次钱。
                            #    现在退避重试"取回"这一步：片子已存在，重试它
                            #    不产生新的生成费用。
                            for dl in range(_MAX_QUERY_ERRORS):
                                try:
                                    local = await self._download(url, ch)
                                    return VideoResult(
                                        status="done", task_id=tid, video_url=local,
                                        duration_ms=ch.duration * 1000,
                                        raw={"channel": ch.name, "dialect": ch.dialect,
                                             "upstream_model": ch.upstream_model,
                                             "ratio": ratio, "duration": ch.duration,
                                             "elapsed": round(time.monotonic() - t0, 1)})
                                except Exception as e:  # noqa: BLE001
                                    logger.warning("低价渠道 %s 取片失败 %d/%d：%s",
                                                   ch.name, dl + 1,
                                                   _MAX_QUERY_ERRORS, e)
                                    if dl < _MAX_QUERY_ERRORS - 1:
                                        await asyncio.sleep(min(10.0, 2.0 ** dl))
                            raise ChannelDown(
                                f"{ch.name} 出片成功但取片失败（已在网关计费，"
                                f"不要重开任务）：{url}")
                        if st == "failed":
                            raise ChannelDown(f"{ch.name} 任务失败: {err}")
                raise ChannelDown(f"{ch.name} 轮询超时"
                                  f"(>{int(self.poll_interval * self.poll_max)}s)")
            except (ChannelDown, ContentRejected, RefUnavailable):
                # RefUnavailable 也要原样抛：被下面那个 except 兜住就会变成
                # ChannelDown，于是白白冷却一条健康渠道、再把链跑一遍。
                raise
            except Exception as e:  # noqa: BLE001
                last = e
                # 连接抖动/超时：原地退避重试（复用同一把 Idempotency-Key，
                # 见 _FwFrame.create —— 复用是防重复扣费的关键）
                if attempt < attempts - 1:
                    logger.warning("低价渠道 %s 第 %d 次尝试失败：%s", ch.name,
                                   attempt + 1, e)
                    continue
                raise ChannelDown(f"{ch.name} 异常: {e!r}") from e
        raise ChannelDown(f"{ch.name} 重试耗尽: {last!r}")

    async def submit(self, req: VideoRequest) -> VideoResult:
        refs = self._collect_refs(req)
        # 比例：必须落在**对外宣称的** aspect_ratios（= 三渠道交集 {9:16, 16:9}）里。
        # 上层据 aspect_ratios 拦掉别的比例，但项目 base_aspect 是**项目级**设置，
        # 老项目可能存着 1:1/21:9 —— 那种情况下**不静默改画幅**（改了下游裁切/
        # 导出全对不上），而是拒绝并说清可选值；也不放进渠道链（单条渠道或许支持
        # 21:9，但兜底要求"任一条都能出"，只支持一条的比例进来，那条挂了就没兜底了）。
        # 与 H3 对非法比例的处理一致（video_runninghub 直接抛错）。只有请求压根
        # 没给比例时才取交集首位。
        ratio = req.aspect_ratio or "9:16"
        if ratio not in self.aspect_ratios:
            per_ch = {c.name: list(c.ratios) for c in self.channels
                      if c.enabled and c.configured}
            return VideoResult(status="failed",
                               error=f"低价 seedance2.5 不支持画面比例 {ratio}；"
                                     f"可选: {', '.join(self.aspect_ratios)}"
                                     f"（各渠道自身能力: {json.dumps(per_ch, ensure_ascii=False)}）")
        chain = self.usable_channels(ratio=ratio, has_refs=bool(refs), refs=refs)
        if not chain:
            # 把"为什么一条都不剩"说清楚，否则这条报错在 3 种完全不同的成因
            # （key 没配 / 比例不合 / 参考图非 HTTPS 被全筛掉）之间无法区分。
            https_blocked = [c.name for c in self.channels
                             if c.enabled and c.configured and c.ref_needs_https]
            why = ("检查渠道清单 lowcost_channels.json 与 FW_LOWCOST_GW*_KEY 配置")
            if refs and https_blocked and any(
                    not u.lower().startswith("https://") for u in refs):
                why = (f"带参考图且参考图不是 HTTPS，而仅剩的渠道"
                       f"（{', '.join(https_blocked)}）只收 HTTPS 参考图。"
                       f"本站 media_base 为 http，故此类镜头需要 gw-frame 可用")
            return VideoResult(status="failed",
                               error=f"低价 seedance2.5 无可用渠道（{why}）")
        for ch in chain:
            # 各渠道参考图上限不同（本文件里三条都是 9，但将来未必），故**逐渠道**
            # 截断，不动上层传进来的原始列表——切下一条时用的是各自的上限。
            refs_for_ch = (refs[: ch.max_reference_images]
                           if refs and len(refs) > ch.max_reference_images else refs)
            try:
                return await self._run_one(ch, req, refs_for_ch, ratio)
            except RefUnavailable as e:
                # 参考图本身不可达：换渠道也是同样结果，且不该冷却这条渠道。
                # 直接把原因交回上层——这类问题只能改 URL / 补公网前缀来修。
                logger.warning("低价渠道 %s 参考图不可用，不切换也不冷却：%s",
                               ch.name, e)
                return VideoResult(status="failed", error=str(e),
                                   raw={"channel": ch.name, "ref_unavailable": True})
            except ContentRejected as e:
                # 审核拒绝：**不切渠道**。同内容换渠道只是再扣一次费，
                # 且会掩盖"这张参考图本身过不了审"这个事实。
                logger.warning("低价渠道 %s 内容审核拒绝，不切换：%s", ch.name, e)
                return VideoResult(status="failed", error=str(e),
                                   raw={"channel": ch.name, "rejected": True,
                                        "person_ref_rejected": e.person})
            except ChannelDown as e:
                s = get_settings()
                _mark_down(ch.name, int(getattr(s, "video_channel_cooldown", 300)), e)
                logger.warning("低价渠道 %s 故障，切下一条：%s", ch.name, e)
                continue
        return VideoResult(status="failed",
                           error=f"低价 seedance2.5 全部渠道失败（已试 "
                                 f"{len(chain)} 条：{', '.join(c.name for c in chain)}）",
                           raw={"tried": [c.name for c in chain]})

    async def poll(self, task_id: str) -> VideoResult:
        """按 `channel:task_id` 复查既有任务。

        与 seedance 官方通道不同，这里的 task_id 是**渠道专属**的，故格式固定为
        `<渠道名>:<任务号>`；不认得的格式直接返回 failed 而不是瞎猜渠道。
        """
        name, _, tid = (task_id or "").partition(":")
        if not tid:
            return VideoResult(status="failed", task_id=task_id,
                               error="低价渠道 task_id 须为 '<渠道名>:<任务号>'")
        ch = next((c for c in self.channels if c.name == name), None)
        if ch is None or not ch.configured:
            return VideoResult(status="failed", task_id=task_id,
                               error=f"未知或未配置的渠道: {name}")
        d = _make_dialect(ch)
        if d is None:
            return VideoResult(status="failed", task_id=task_id,
                               error=f"未知渠道方言: {ch.dialect}")
        try:
            async with http.client("lowcost-poll", timeout=300.0) as c:
                st, url, err = await d.fetch(c, tid)
                if st == "done" and url:
                    local = await self._download(url, ch)
                    return VideoResult(status="done", task_id=task_id, video_url=local)
                if st == "failed":
                    return VideoResult(status="failed", task_id=task_id, error=err)
                return VideoResult(status="running", task_id=task_id)
        except Exception as e:  # noqa: BLE001
            return VideoResult(status="failed", task_id=task_id, error=f"{e!r}")
