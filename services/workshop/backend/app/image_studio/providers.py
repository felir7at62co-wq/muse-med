"""图像生成 provider 适配层。

两条协议 (2026-08-15 实测定型, 详见 docs/IMAGE-CHANNELS-AND-KEYS.md):

- gpt-image-2 (上游模型名 gpt-image-2-c):
    POST /v1/images/generations, 返回 data[0].b64_json。
    尺寸由 size 字段**精确控制**。

- gemini 系 (Nano Banana Pro / Nano Banana 2):
    优先 POST {root}/v1beta/models/{model}:generateContent (native),
    用 generationConfig.imageConfig{aspectRatio, imageSize} **硬控**比例与画质档;
    native 失败才回退 POST /v1/chat/completions + modalities (图片以 markdown
    ![image](data:image/...;base64,XXX) 内嵌在 content)。
    ⚠ 回退路径**没有任何尺寸控制能力**, 仅用于保命出图。
    ⚠ /v1/images/generations 的 size 对 gemini 系完全无效 (一律退回 1024x1024)。

统一返回 list[bytes] (每张图的原始字节)。
图生图 (参考图) 两条协议都支持最多 9 张 (统一压到长边 1024 / JPEG q85 防 413):
- gpt-image-2 走 images/edits (multipart, image[] 字段)
- gemini native 走 contents.parts[].inlineData; chat 回退走 content 数组里
  多个 image_url (data URL)

三个模型均为 zx1.deepwl ↔ kege 双渠道互为兜底 (2026-10-09 起 kege 替换已失效的
api4me), 渠道与 key 的对应关系见 _zx1_gemini_cfg / _kege_gemini_cfg / _kege_image_cfg
各自的 docstring。

⚠ 2026-10-14: **zx1/kege 是现在唯一的生图渠道链**。原先 RunningHub 还占着"文生图对冲
  优先 / 图生图优先"的位子, 已因上游 CN 节点合规下线(40310)整条摘除 —— 详见文件内
  两处 ⛔ 注释。RunningHub 只保留其**工作流**(人像专用/高清放大/图片润色/视频放大),
  那条路径走的是 ComfyUI 接口, 与被摘的托管生图模型无关。

⚠ 顺序是 **zx1 在前、kege 在后**, 依据是 2026-10-09 实测: kege 生图单发可用
  (尺寸逐像素遵守), 但 8 路并发时图生图基本全部 400s 超时、Pro 9:16/2K 4 次里
  2 次超时。放第一位的话它一卡, 用户要先白等 6 分钟才轮到 zx1。

- GPT Image 2.5 (image2.5flare / image2.5sunburst, 上游 gpt-image-2.5-flare-c|sunburst-c):
    与 gpt-image-2 同协议 (generations / edits), zx1 主 + kege 兜底 (2026-10-09 起)。
    尺寸只近似遵守。详见 generate_image25 上方的实测注释。
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
from typing import Optional

import httpx

# 最多参考图数量
MAX_REF_IMAGES = 9

# markdown 内嵌 base64 图片解析
_DATA_URL_RE = re.compile(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)")


def _kege_base() -> str:
    base = os.environ.get("KEGE_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("KEGE_BASE_URL not configured")
    return base


def _kege_gemini_cfg() -> tuple[str, str]:
    """kege gemini 分组: KEGE_GEMINI_API_KEY (Nano Banana Pro / Nano Banana 2)。

    与 KEGE_GPT_API_KEY 分组不同, 不可混用。2026-10-09 实测 native generateContent
    的 imageConfig 双参数均被遵守 (9:16/2K → 1536x2752, 16:9/1K → 1376x768)。
    """
    key = os.environ.get("KEGE_GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("KEGE_GEMINI_API_KEY not configured")
    return key, _kege_base()


def _kege_image_cfg() -> tuple[str, str]:
    """kege gpt 分组: KEGE_GPT_API_KEY (gpt-image-2-c / gpt-image-2.5-*-c)。

    2026-10-09 实测文生图 size **逐像素遵守** (含 image2.5, 比 zx1 的"近似"更准);
    图生图 (images/edits) 可用但 1024x1024 会回 1254x1254, 与 zx1 同款行为。
    ⚠ 不带 -c 的 gpt-image-2 在该渠道图生图单发也 400s 超时, 故只用 -c。
    """
    key = os.environ.get("KEGE_GPT_API_KEY", "").strip()
    if not key:
        raise RuntimeError("KEGE_GPT_API_KEY not configured")
    return key, _kege_base()


def _zx1_gemini_cfg() -> tuple[str, str]:
    """zx1.deepwl 生图通道: ZX1_GEMINI_KEY (71 模型分组)。

    该分组同时可用 gemini 系 -c 模型与 gpt-image-2-c, 故同时充当:
      - Nano Banana Pro / Nano Banana 2 的渠道B
      - GPT Image 2 的渠道B
    实测无 403、无并发熔断, imageConfig 双参数 5/5 honored 零漂移。

    ⚠ 不要与 ZX1_API_KEY 混淆: 后者是 Adobe 分组, 其 gpt-image-2-c 上游
      已整体不可用 (5/5 HTTP500 do_request_failed), 生图链路不再使用。
    """
    key = os.environ.get("ZX1_GEMINI_KEY", "").strip()
    base = os.environ.get("ZX1_BASE_URL", "https://zx1.deepwl.net").rstrip("/")
    if not key:
        raise RuntimeError("ZX1_GEMINI_KEY not configured")
    return key, base


# ── 参考图压缩 (413 根治) ────────────────────────────────────
# gemini 通道把参考图 base64 内联进 JSON, 多张全分辨率 PNG 会撑爆网关
# nginx client_max_body_size (zx1 实测约 50MB, ≥7 张大图必 413)。
# 统一压缩: 长边 ≤1024, JPEG q85 → 9 张 <5MB, 彻底消除 413。
_REF_MAX_EDGE = 1024
_REF_JPEG_QUALITY = 85


def _compress_ref(raw: bytes) -> tuple[bytes, str]:
    """压缩单张参考图: 长边 ≤_REF_MAX_EDGE, 转 JPEG。失败则原样返回 (PNG)。"""
    try:
        import io as _io
        from PIL import Image as _Img
        im = _Img.open(_io.BytesIO(raw))
        im = im.convert("RGB")
        w, h = im.size
        long_edge = max(w, h)
        if long_edge > _REF_MAX_EDGE:
            scale = _REF_MAX_EDGE / long_edge
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), _Img.LANCZOS)
        buf = _io.BytesIO()
        im.save(buf, format="JPEG", quality=_REF_JPEG_QUALITY)
        out = buf.getvalue()
        # 压缩反而变大 (极小图) 则用原图
        if len(out) < len(raw):
            return out, "image/jpeg"
    except Exception:  # noqa: BLE001
        pass
    return raw, "image/png"


def _compress_refs(refs: list[bytes]) -> list[tuple[bytes, str]]:
    """批量压缩参考图, 返回 [(bytes, mime), ...]。"""
    return [_compress_ref(r) for r in refs]



# gemini 原生支持的宽高比白名单
_GEMINI_ASPECTS = {"1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"}


def _size_to_image_size_tier(size: Optional[str]) -> str:
    """从 'WxH' 推出 gemini imageConfig.imageSize 档位 (1K/2K/4K)。

    前端画质档位 (lib/imageStudio.ts _LONG) 算出的长边像素:
      - 1K 画质 -> 长边 1024
      - 2K 画质 -> 长边 2048
      - 4K 画质 -> 长边 3840
    gemini imageConfig.imageSize 只接受 1K/2K/4K 三档 (16:9 实测分别出
    1376x768 / 2752x1536 / 5504x3072, 两条渠道逐像素一致)。这里把请求长边
    按"最接近的锚点"归档, 阈值取相邻锚点中点 (1024/2048 中点=1536,
    2048/3840 中点≈2944)。默认 1K。

    ⚠ 阈值必须与前端 _LONG / workflows.QUALITY_LONG_EDGE 三处同步修改,
      否则会出现"选 1K 实际落 2K 档"的错档多花钱问题 (2026-08-15 修复)。
    """
    if not size:
        return "1K"
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except Exception:  # noqa: BLE001
        return "1K"
    long_edge = max(w, h)
    if long_edge >= 2944:
        return "4K"
    if long_edge >= 1536:
        return "2K"
    return "1K"


def _size_to_aspect(size: Optional[str]) -> Optional[str]:
    """从 'WxH' 推出最接近的 gemini 支持比例。"""
    if not size:
        return None
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except Exception:  # noqa: BLE001
        return None
    if not w or not h:
        return None
    from math import gcd
    g = gcd(w, h) or 1
    cand = f"{w//g}:{h//g}"
    if cand in _GEMINI_ASPECTS:
        return cand
    # 不在白名单则按数值找最接近的
    target = w / h
    best, bestd = None, 1e9
    for a in _GEMINI_ASPECTS:
        aw, ah = (int(x) for x in a.split(":"))
        d = abs(aw/ah - target)
        if d < bestd:
            best, bestd = a, d
    return best


def _parse_inline_images(j: dict) -> list[bytes]:
    """从 gemini generateContent 响应里抽取 inlineData 图片字节。"""
    out: list[bytes] = []
    for c in j.get("candidates", []) or []:
        for part in ((c.get("content", {}) or {}).get("parts", []) or []):
            d = part.get("inlineData") or part.get("inline_data") or {}
            data = d.get("data")
            if data:
                try:
                    out.append(base64.b64decode(data))
                except Exception:  # noqa: BLE001
                    continue
    return out



def _decode_data_urls(text: str) -> list[bytes]:
    out: list[bytes] = []
    for m in _DATA_URL_RE.finditer(text or ""):
        try:
            out.append(base64.b64decode(m.group(1)))
        except Exception:  # noqa: BLE001
            continue
    return out


def _parse_imgen_response(data: dict, tag: str) -> "tuple[list[bytes], list[str]]":
    """解析 images/generations|edits 响应 (b64_json 或 url), 同步下载 url 图。"""
    out: list[bytes] = []
    urls: list[str] = []
    for item in data.get("data", []) or []:
        b64 = item.get("b64_json")
        if b64:
            out.append(base64.b64decode(b64))
            continue
        img_url = item.get("url")
        if img_url:
            urls.append(img_url)
    return out, urls


async def _imgen_request(
    *, base: str, key: str, model: str, prompt: str, n: int, size: str,
    refs: list[bytes], timeout: float, tag: str,
) -> list[bytes]:
    """通用 OpenAI 兼容生图请求: 有参考图走 images/edits (multipart), 无走 generations。"""
    headers = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        if refs:
            url = f"{base}/images/edits"
            files = []
            for i, (raw, mime) in enumerate(_compress_refs(refs)):
                ext = "jpg" if mime == "image/jpeg" else "png"
                files.append(("image[]", (f"ref_{i}.{ext}", raw, mime)))
            data = {"model": model, "prompt": prompt, "n": str(n), "size": size}
            resp = await client.post(url, headers=headers, data=data, files=files)
        else:
            url = f"{base}/images/generations"
            payload = {"model": model, "prompt": prompt, "n": n, "size": size}
            resp = await client.post(url, headers={**headers, "Content-Type": "application/json"}, json=payload)

        if resp.status_code != 200:
            raise RuntimeError(f"{tag} HTTP {resp.status_code}: {resp.text[:300]}")

        out, urls = _parse_imgen_response(resp.json(), tag)
        for u in urls:
            r2 = await client.get(u)
            out.append(r2.content)
    if not out:
        raise RuntimeError(f"{tag} no image in response")
    return out


async def generate_gpt_image(
    *,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
    timeout: float = 300.0,
) -> list[bytes]:
    """gpt-image-2 文生图 / 图生图 — 双渠道互为兜底 (2026-08-15 实测定型)。

    渠道链 (两条不同 URL, 任一挂掉另一条顶上):
      A) zx1     ZX1_GEMINI_KEY       model=gpt-image-2-c
      B) kege    KEGE_GPT_API_KEY     model=gpt-image-2-c
    (2026-10-09 前 A/C 两条是 api4me, 已全线失效; 顺序理由见模块头部)

    尺寸控制: 两条主渠道均**精确遵守请求 size**, 10 比例 × 3 档位实测产出与
    请求逐像素一致, 故渠道切换不会有尺寸跳变。

    ⚠ 不再使用 ZX1_API_KEY (Adobe 分组): 其 gpt-image-2-c 上游整体不可用
      (5/5 HTTP500 do_request_failed, 换 size / 换 chat 协议均同样报错)。

    无参考图 -> images/generations (json, 返回 b64_json)
    有参考图 -> images/edits (multipart, image[] 多文件)
    """
    import logging as _logging
    _log = _logging.getLogger("app.image_studio")
    refs = (ref_images or [])[:MAX_REF_IMAGES]

    chain: list[tuple[str, callable, float]] = [
        ("zx1", _zx1_gemini_cfg, timeout),
        ("kege", _kege_image_cfg, max(timeout, 420.0)),
    ]
    errs: list[str] = []
    for tag, cfg_fn, to in chain:
        try:
            key, base = cfg_fn()
        except Exception as e_cfg:  # noqa: BLE001 — key 未配置, 跳到下一条
            errs.append(f"{tag}=unconfigured({str(e_cfg)[:60]})")
            continue
        v1 = base if base.endswith("/v1") else f"{base}/v1"
        try:
            return await _imgen_request(
                base=v1, key=key, model="gpt-image-2-c", prompt=prompt, n=n, size=size,
                refs=refs, timeout=to, tag=f"gpt-image-2({tag})",
            )
        except Exception as e:  # noqa: BLE001
            errs.append(f"{tag}={str(e)[:120]}")
            _log.warning("gpt-image-2 渠道 %s 失败(%s), 切下一条", tag, str(e)[:120])

    raise RuntimeError("gpt-image-2 全渠道失败: " + "; ".join(errs))


async def _gemini_native_try(
    *, base: str, key: str, model: str, prompt: str, n: int, size: str,
    refs: list[tuple[bytes, str]], timeout: float,
) -> list[bytes]:
    """gemini 原生 generateContent 调用 (可硬控宽高比+画质档位)。失败抛异常。

    aspectRatio 与 imageSize **必须成对下发**: 实测缺任一个, 另一个也会被上游
    忽略并退回 1024x1024。size 无法解析时退化为只带 imageSize (仍优于不带)。
    """
    aspect = _size_to_aspect(size)
    image_size_tier = _size_to_image_size_tier(size)
    img_cfg: dict = {"imageSize": image_size_tier}
    if aspect:
        img_cfg["aspectRatio"] = aspect
    root = base[:-3] if base.endswith("/v1") else base
    gen_url = f"{root}/v1beta/models/{model}:generateContent"
    parts: list[dict] = [{"text": prompt}]
    for raw, mime in refs:
        parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(raw).decode()}})
    gbody = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": img_cfg,
        },
    }
    gheaders = {"Content-Type": "application/json", "x-goog-api-key": key, "Authorization": f"Bearer {key}"}
    native_out: list[bytes] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        for _ in range(max(1, n)):
            resp = await client.post(gen_url, headers=gheaders, json=gbody)
            if resp.status_code != 200:
                raise RuntimeError(f"gemini native HTTP {resp.status_code}: {resp.text[:200]}")
            native_out.extend(_parse_inline_images(resp.json()))
    if not native_out:
        raise RuntimeError("gemini native no image in response")
    return native_out


async def _gemini_chat_try(
    *, base: str, key: str, model: str, prompt: str, n: int, size: str,
    refs: list[tuple[bytes, str]], timeout: float,
) -> list[bytes]:
    """gemini chat/completions 调用 (参考图 base64 内联 data-url)。失败抛异常。"""
    url = f"{base}/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    content: list[dict] = [{"type": "text", "text": prompt}]
    for raw, mime in refs:
        b64 = base64.b64encode(raw).decode()
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "modalities": ["image", "text"],
    }
    out: list[bytes] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        for _ in range(max(1, n)):
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"gemini-image HTTP {resp.status_code}: {resp.text[:300]}")
            msg = (resp.json().get("choices") or [{}])[0].get("message", {}) or {}
            text = msg.get("content")
            # content 可能是 str, 也可能是数组
            if isinstance(text, list):
                text = " ".join(
                    (part.get("text") or "") if isinstance(part, dict) else str(part)
                    for part in text
                )
            imgs = _decode_data_urls(text or "")
            # 某些网关把图片放在 message.images 字段
            if not imgs and msg.get("images"):
                for im in msg["images"]:
                    u = (im or {}).get("image_url", {}).get("url") if isinstance(im, dict) else None
                    if u:
                        imgs.extend(_decode_data_urls(u))
            out.extend(imgs)
    if not out:
        raise RuntimeError("gemini-image no image parsed from response")
    return out


# Nano Banana 系列 -> 各渠道的模型名 (2026-08-15 实测定型)
#   渠道A = zx1     ZX1_GEMINI_KEY
#   渠道B = kege    KEGE_GEMINI_API_KEY (2026-10-09 起替换 api4me, 模型名沿用原 a4m 那套)
# 两条渠道 16:9 产出逐像素一致: 1K=1376x768 / 2K=2752x1536 / 4K=5504x3072,
# 故兜底切换不会有尺寸跳变。
_GEMINI_CHANNEL_MODELS: dict[str, dict[str, str]] = {
    # Nano Banana Pro
    "pro": {"kege": "gemini-3-pro-image", "zx1": "gemini-3-pro-image-preview-c"},
    # Nano Banana 2
    "flash": {"kege": "gemini-3.1-flash-image", "zx1": "gemini-3.1-flash-image-preview-c"},
}


async def generate_gemini_image(
    *,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
    timeout: float = 300.0,
    family: str = "pro",
) -> list[bytes]:
    """Nano Banana Pro / Nano Banana 2 文生图 / 图生图 — 双渠道互为兜底。

    family: "pro" = Nano Banana Pro, "flash" = Nano Banana 2。

    渠道链 (两条不同 URL, 各自 native 优先 → chat 回退):
      A) zx1     ZX1_GEMINI_KEY         pro=gemini-3-pro-image-preview-c
                                        flash=gemini-3.1-flash-image-preview-c
      B) kege    KEGE_GEMINI_API_KEY    pro=gemini-3-pro-image / flash=gemini-3.1-flash-image

    尺寸/比例控制走 native generateContent 的 generationConfig.imageConfig
    (aspectRatio + imageSize 成对下发); chat/completions 回退路径**无任何尺寸
    控制能力**, 仅在 native 也失败时保命用。

    ⚠ 不再使用 OPENAI_API_KEY: 该分组 gemini 系非 -c 模型全部 403
      (account flagged for terms of use violation), 且 -c 模型存在渠道漂移
      (同参数两次调用产出可差 4 倍)。

    参考图统一压缩 (长边≤1024 JPEG) 后 base64 内联 → 彻底根治 413。
    """
    import logging as _logging
    _log = _logging.getLogger("app.image_studio")
    models = _GEMINI_CHANNEL_MODELS.get(family) or _GEMINI_CHANNEL_MODELS["pro"]
    refs = _compress_refs((ref_images or [])[:MAX_REF_IMAGES])
    errs: list[str] = []

    chain = [
        ("zx1", _zx1_gemini_cfg, models["zx1"], max(timeout, 420.0)),
        ("kege", _kege_gemini_cfg, models["kege"], max(timeout, 420.0)),
    ]
    for tag, cfg_fn, model, to in chain:
        try:
            key, base = cfg_fn()
        except Exception as e_cfg:  # noqa: BLE001 — key 未配置, 跳到下一条
            errs.append(f"{tag}=unconfigured({str(e_cfg)[:60]})")
            continue
        v1 = base if base.endswith("/v1") else f"{base}/v1"
        # native 优先 (唯一能硬控比例+档位的路径)
        try:
            return await _gemini_native_try(
                base=v1, key=key, model=model, prompt=prompt, n=n, size=size,
                refs=refs, timeout=to)
        except Exception as e_native:  # noqa: BLE001
            _log.warning("gemini %s/%s native 失败(%s), 试 chat 回退",
                         tag, model, str(e_native)[:120])
            errs.append(f"{tag}-native={str(e_native)[:100]}")
        # chat 回退 (无尺寸控制, 仅保命)
        try:
            return await _gemini_chat_try(
                base=v1, key=key, model=model, prompt=prompt, n=n, size=size,
                refs=refs, timeout=to)
        except Exception as e_chat:  # noqa: BLE001
            _log.warning("gemini %s/%s chat 也失败(%s), 切下一条渠道",
                         tag, model, str(e_chat)[:120])
            errs.append(f"{tag}-chat={str(e_chat)[:100]}")

    raise RuntimeError(f"gemini({family}) 双渠道均失败: " + "; ".join(errs))


# ============================================================
# ⛔ 2026-10-14: RunningHub 的**托管生图模型**(rhart-image-g-2 / rhart-image-n-pro
#    的 text-to-image 与 image-to-image)整条渠道已下线, 用户明确指示"从生图渠道里
#    摘掉, 保留它的工作流"。原先这里是 _RH_G2_T2I_ASPECTS / _RH_NPRO_T2I_ASPECTS
#    / _rh_v2_text_to_image / generate_rh_g2_text_to_image
#    / generate_rh_npro_text_to_image 五个定义, 现已删除。
#
#    原因(prod 日志实测): 上游 CN 节点因合规要求下线了这两个模型,
#    报 `RH submit error 40310: this model is no longer available on the CN endpoint`。
#    40310 只在**生图**路径出现 —— 全量日志按调用类型拆分: RH v2 3677 次、
#    RH t2i 3338 次, 而人像/润色/放大走的是 ComfyUI 工作流接口(_rh_*_cfg),
#    一次都没中。所以"摘渠道"与"保工作流"正好是两件独立的事。
#
#    ⚠ 不要看到 RunningHub 就一并删掉下面的 _rh_cfg / _rh_portrait_cfg /
#      _rh_polish_cfg / _rh_video_upscale_cfg —— 那些是**工作流**, 仍然在用。
#
#    生效方式: 生图从此只走 zx1(主) + kege(兜底), 见 generate_gpt_image
#    与 generate_gemini_image 各自的渠道链。用户已确认这两家的并发与成本可承接。
# ============================================================
# RunningHub 人像专用 文生图 (ComfyUI 工作流 __REDACTED__)
# 纯文生图 (不吃参考图); 提示词写入节点 #200(JjkText), 输出节点 #210(SaveImage),
# 宽高比由节点 #196(AspectRatio) 控制 — 注入用户所选 size 的 width/height。
# 走 task/openapi/create + nodeInfoList 协议 (同 upscale/polish), 复用同一 API key 共享 100 并发。
# ============================================================

RH_PORTRAIT_TEXT_NODE_ID = "200"
RH_PORTRAIT_SIZE_NODE_ID = "196"


def _rh_portrait_cfg() -> tuple[str, str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    wf = os.environ.get("RUNNINGHUB_PORTRAIT_WORKFLOW_ID", "").strip()
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    if not wf:
        raise RuntimeError("RUNNINGHUB_PORTRAIT_WORKFLOW_ID not configured")
    return key, base, wf


async def _rh_portrait_create(prompt: str, width: int, height: int, *, timeout: float = 60.0) -> str:
    """提交人像专用文生图任务, 返回远端 taskId。"""
    key, base, wf = _rh_portrait_cfg()
    payload = {
        "apiKey": key,
        "workflowId": wf,
        "nodeInfoList": [
            {"nodeId": RH_PORTRAIT_TEXT_NODE_ID, "fieldName": "text", "fieldValue": prompt},
            {"nodeId": RH_PORTRAIT_SIZE_NODE_ID, "fieldName": "width", "fieldValue": str(width)},
            {"nodeId": RH_PORTRAIT_SIZE_NODE_ID, "fieldName": "height", "fieldValue": str(height)},
        ],
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/create", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH portrait create HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH portrait create error: {d.get('msg')}")
    tid = (d.get("data") or {}).get("taskId")
    if not tid:
        raise RuntimeError(f"RH portrait create no taskId: {str(d)[:200]}")
    return str(tid)


async def generate_rh_portrait_text_to_image(
    *,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    poll_interval: float = 5.0,
    poll_max: int = 60,
) -> list[bytes]:
    """RunningHub 人像专用 文生图: 提交 -> 轮询 task/openapi/status -> outputs -> 下载。

    宽高从 size('WxH') 解析后注入节点 #196; n>1 时循环提交多次 (每任务出 1 张)。
    """
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except Exception:  # noqa: BLE001
        w, h = 928, 1664
    out: list[bytes] = []
    for _ in range(max(1, n)):
        tid = await _rh_portrait_create(prompt, w, h)
        result_urls: list[str] = []
        for _i in range(poll_max):
            await asyncio.sleep(poll_interval)
            st = await rh_status(tid)
            if st in ("SUCCESS", "SUCCEED", "SUCCEEDED"):
                result_urls = await rh_outputs(tid)
                break
            if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
                raise RuntimeError(f"RH portrait task {st}")
        if not result_urls:
            raise RuntimeError("RH portrait 任务超时或无产出图")
        for u in result_urls:
            out.append(await download_url(u))
    if not out:
        raise RuntimeError("RH portrait no image produced")
    return out


async def generate_zx1_image(
    *,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
    timeout: float = 300.0,
) -> list[bytes]:
    """zx1.deepwl.net 文生图 (OpenAI 兼容协议,复用gpt-image-2流程)。

    纯文生图,不吃参考图。实测500并发95.6%成功率。

    ⚠ 2026-08-15: key 由 ZX1_API_KEY 改为 ZX1_GEMINI_KEY, 模型由 gpt-image-2
      改为 gpt-image-2-c —— 原 ZX1_API_KEY 是 Adobe 分组, 压根不含 gpt-image-2
      (503 model_not_found), 且其 gpt-image-2-c 上游已整体 500 不可用。
    """
    key, base = _zx1_gemini_cfg()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        url = f"{base}/v1/images/generations"
        payload = {"model": "gpt-image-2-c", "prompt": prompt, "n": n, "size": size}
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        raise RuntimeError(f"zx1 HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    out: list[bytes] = []
    for item in data.get("data", []) or []:
        b64 = item.get("b64_json")
        if b64:
            out.append(base64.b64decode(b64))
            continue
        img_url = item.get("url")
        if img_url:
            async with httpx.AsyncClient(timeout=120) as c2:
                r2 = await c2.get(img_url)
                out.append(r2.content)
    if not out:
        raise RuntimeError(f"zx1 no image in response: {str(data)[:200]}")
    return out


# ── GPT Image 2.5 (flare / sunburst) ────────────────────────
# 2026-09-11 实测定型 (共约 1200 次调用, 详见 docs/IMAGE-CHANNELS-AND-KEYS.md):
#   渠道: zx1 主 (ZX1_GEMINI_KEY 的 71 模型分组) + kege 兜底 (KEGE_GPT_API_KEY, 2026-10-09 起;
#         api4me 当年无此模型, 故此前一直是单渠道)。
#   并发: 1/5/10/20/40/100/200 全档位成功率 99.5~100%, 未见天花板;
#         中位延迟恒定 ~35s 与并发无关 (上游纯排队), 全程未出现 429。
#         flare 比 sunburst 快且长尾短 (200 并发下最慢 70s vs 119s), 优先用 flare。
#   参考图: 两者都支持 images/edits 且**真正遵守参考图** (实拍验证: 保留主体与构图,
#           只改被要求改的部分), 故走与 gpt-image-2 相同的 _imgen_request 流程。
#   ⚠ 尺寸只"近似"遵守, 不像 gpt-image-2 那样逐像素精确:
#       1024x1024 -> 1254x1254 (明显放大), 1080x1920 -> 1081x1920, 2160x3840 -> 2161x3840。
#     落库宽高从图片字节实读 (service._decode_size), 故账单/展示不受影响。
#   ⚠ 内容审核判的是**生成出来的图**而非提示词 (错误文案: "生成的图片可能违反…"),
#     同一提示词重试可过 —— 故失败必须走 service 层的重试, 不要改写提示词。
#   ⚠ 2026-10-09: 上游把模型名加上了 `-c` 后缀 (与 gpt-image-2 → gpt-image-2-c
#     同一套命名)。旧名 gpt-image-2.5-flare / -sunburst 现在一律返回
#     HTTP 503 model_not_found "Failed to get available channel ... channel not found",
#     前端归类成"图像服务暂时不可用"。实测加 -c 后两个模型均 200 正常出图。
#     这里保留"候选名链": 逐个试, 首个成功即返回 —— 上游若再次改名, 只需在
#     该候选表里补一个名字, 不至于整个模型再次全灭。
_IMAGE25_UPSTREAM = {
    "image2.5flare": ["gpt-image-2.5-flare-c", "gpt-image-2.5-flare"],
    "image2.5sunburst": ["gpt-image-2.5-sunburst-c", "gpt-image-2.5-sunburst"],
}


async def generate_image25(
    *,
    model: str,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
    timeout: float = 300.0,
) -> list[bytes]:
    """GPT Image 2.5 (image2.5flare / image2.5sunburst) 文生图 / 图生图。

    zx1 主 + kege 兜底 (2026-10-09 起), OpenAI 兼容协议; 无参考图走 images/generations,
    有则走 images/edits。zx1 整条失败 (含所有候选名) 才切 kege, kege 同样按候选名链试。

    上游模型名按"候选名链"逐个试 (见 _IMAGE25_UPSTREAM): 503 model_not_found /
    channel not found 属"该名字不存在" → 立即换下一个候选名, 不算终局失败;
    其余错误 (内容审核 400 / 429 / 5xx) 说明名字是对的, 直接抛出交给 service
    层重试 —— 重试同一名字才有意义, 换名字救不了审核。
    """
    upstreams = _IMAGE25_UPSTREAM.get(model)
    if not upstreams:
        raise RuntimeError(f"unknown image2.5 model: {model}")
    async def _one_channel(tag: str, cfg_fn) -> list[bytes]:
        key, base = cfg_fn()
        v1 = base if base.endswith("/v1") else f"{base}/v1"
        last_err: Optional[Exception] = None
        for upstream in upstreams:
            try:
                return await _imgen_request(
                    base=v1, key=key, model=upstream, prompt=prompt, n=n, size=size,
                    refs=(ref_images or [])[:MAX_REF_IMAGES], timeout=timeout,
                    tag=f"{model}({tag})",
                )
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                # 仅"模型名不存在"才换下一个候选名
                if "model_not_found" in msg or "channel not found" in msg:
                    last_err = e
                    continue
                raise
        raise last_err if last_err else RuntimeError(f"{model}: no upstream candidate")

    try:
        return await _one_channel("zx1", _zx1_gemini_cfg)
    except Exception as e_zx1:  # noqa: BLE001
        # ⚠ 内容审核类失败 (判的是生成出来的图) 换渠道也照样会被拦, 但两家审核器
        # 不是同一个, 换一家有机会过; 且 service 层仍会按原逻辑重试。故一律切 kege。
        import logging as _logging
        _logging.getLogger("app.image_studio").warning(
            "%s zx1 失败(%s), 切 kege 兜底", model, str(e_zx1)[:120])
        try:
            return await _one_channel("kege", _kege_image_cfg)
        except Exception as e_kg:  # noqa: BLE001
            raise RuntimeError(f"{model} 双渠道均失败: zx1={str(e_zx1)[:150]}; "
                               f"kege={str(e_kg)[:150]}") from e_kg


async def generate_kege_image(
    *,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
    timeout: float = 300.0,
) -> list[bytes]:
    """kege 文生图 (OpenAI 兼容协议, gpt-image-2-c)。纯文生图, 不吃参考图。

    小说转视频的备选渠道。2026-10-09 起替换已失效的 api4me (原 key 是小说转视频
    专用授权; kege 的 GPT key 无此限制)。
    """
    key, base = _kege_image_cfg()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        url = f"{base}/v1/images/generations"
        payload = {"model": "gpt-image-2-c", "prompt": prompt, "n": n, "size": size}
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        raise RuntimeError(f"kege HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    out: list[bytes] = []
    for item in data.get("data", []) or []:
        b64 = item.get("b64_json")
        if b64:
            out.append(base64.b64decode(b64))
            continue
        img_url = item.get("url")
        if img_url:
            async with httpx.AsyncClient(timeout=120) as c2:
                r2 = await c2.get(img_url)
                out.append(r2.content)
    if not out:
        raise RuntimeError(f"kege no image in response: {str(data)[:200]}")
    return out


async def generate(
    *,
    model: str,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    ref_images: Optional[list[bytes]] = None,
) -> list[bytes]:
    """按 model 分派到对应 provider。"""
    if model == "gpt-image-2":
        return await generate_gpt_image(prompt=prompt, n=n, size=size, ref_images=ref_images)
    # Nano Banana Pro
    if model == "gemini-3-pro-image-preview":
        return await generate_gemini_image(
            prompt=prompt, n=n, size=size, ref_images=ref_images, family="pro")
    # Nano Banana 2
    if model == "gemini-3.1-flash-image":
        return await generate_gemini_image(
            prompt=prompt, n=n, size=size, ref_images=ref_images, family="flash")
    # GPT Image 2.5 (zx1 单渠道) — 文生图/图生图, 支持参考图
    if model in _IMAGE25_UPSTREAM:
        return await generate_image25(
            model=model, prompt=prompt, n=n, size=size, ref_images=ref_images)
    # zx1.deepwl.net 文生图 — OpenAI兼容,纯文生图,不吃参考图
    if model == "zx1-gpt-image-2":
        return await generate_zx1_image(prompt=prompt, n=n, size=size, ref_images=None)
    # kege 文生图 — OpenAI兼容,纯文生图,不吃参考图(小说转视频备选渠道)。
    # "api4me-gpt-image-2" 是 2026-10-09 前的旧 id, 保留映射: 已排队/重试中的任务
    # 可能还带着旧名, 不认就会以 unsupported model 整镜失败。
    if model in ("kege-gpt-image-2", "api4me-gpt-image-2"):
        return await generate_kege_image(prompt=prompt, n=n, size=size, ref_images=None)
    # RunningHub 人像专用 — 纯文生图 ComfyUI 工作流（**保留**：走工作流接口，
    # 不在被摘除的托管生图渠道内）
    if model == "rh-portrait-t2i":
        return await generate_rh_portrait_text_to_image(prompt=prompt, n=n, size=size)
    # ⛔ 2026-10-14: rh-image-g-2-t2i / rh-image-n-pro-t2i 两个 RunningHub 托管
    #    生图模型的映射已删除（上游 CN 节点合规下线，40310）。落到这里的调用会
    #    走下面的 unsupported model —— 这正是期望行为：库中没有任何任务用过这两个
    #    名字（实测 image_jobs=0 / draft_image_tasks=0），不存在需要兼容的历史任务。
    #    若将来真的冒出来，说明有别处在硬编码，应该改成走 zx1/kege 而不是把它们加回来。
    raise RuntimeError(f"unsupported model: {model}")


# ============================================================
# ⛔ 2026-10-14: RunningHub **托管模型生图渠道**已整段摘除。
#
#    原先这里定义的是 RH_FALLBACK_MAP / _rh_v2_cfg / _size_to_rh_resolution
#    / _size_to_rh_aspect / rh_fallback_for / rh_v2_image_to_image。
#    它们是"图生图优先走 RunningHub 的 rhart-image-* 托管模型"这条路。
#    上游 CN 节点合规下线了这些模型(40310), 用户决定不再补救、直接放弃这条渠道。
#
#    生图的渠道链现在是 **zx1(主) + kege(兜底)**, 见 generate_gpt_image /
#    generate_gemini_image / generate_image25 各自体内的 chain 列表。
#
#    ⚠ 下面紧接着的 _rh_cfg / _rh_portrait_cfg / _rh_polish_cfg /
#      _rh_video_upscale_cfg 是**工作流**接口(ComfyUI), 不在摘除范围 ——
#      它们对应的高清放大 / 图片润色 / 人像专用 / 视频放大仍然保留。
#      40310 从未出现在这些工作流调用上(全量日志实测), 两条路径互不相干。
# ============================================================


# ============================================================
# RunningHub 高清放大 provider (P2)
# 异步工作流: upload -> create -> poll status -> outputs
# 工作流 __REDACTED__ (SeedVR2): 上传节点 #71 image, 输出节点 #12
# ============================================================

def _rh_cfg() -> tuple[str, str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    wf = os.environ.get("RUNNINGHUB_UPSCALE_WORKFLOW_ID", "").strip()
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    if not wf:
        raise RuntimeError("RUNNINGHUB_UPSCALE_WORKFLOW_ID not configured")
    return key, base, wf

RH_UPLOAD_NODE_ID = "71"
RH_UPLOAD_FIELD = "image"


async def rh_upload(raw: bytes, *, timeout: float = 120.0) -> str:
    """上传图片到 RunningHub, 返回远端 fileName。"""
    key, base, _ = _rh_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(
            f"{base}/task/openapi/upload",
            data={"apiKey": key},
            files={"file": ("input.png", raw, "image/png")},
        )
    if r.status_code != 200:
        raise RuntimeError(f"RH upload HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH upload error: {d.get('msg')}")
    fn = (d.get("data") or {}).get("fileName")
    if not fn:
        raise RuntimeError(f"RH upload no fileName: {str(d)[:200]}")
    return fn


async def rh_create_upscale(file_name: str, *, timeout: float = 60.0) -> str:
    """创建放大任务, 返回远端 taskId。"""
    key, base, wf = _rh_cfg()
    payload = {
        "apiKey": key,
        "workflowId": wf,
        "nodeInfoList": [
            {"nodeId": RH_UPLOAD_NODE_ID, "fieldName": RH_UPLOAD_FIELD, "fieldValue": file_name},
        ],
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/create", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH create HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH create error: {d.get('msg')}")
    tid = (d.get("data") or {}).get("taskId")
    if not tid:
        raise RuntimeError(f"RH create no taskId: {str(d)[:200]}")
    return str(tid)


# ============================================================
# RunningHub 图片润色 provider (P3)
# 异步工作流: upload -> create -> poll status -> outputs (复用 upscale 同一套轮询/下载)
# 工作流 __REDACTED__ (Flux2 润色): 上传节点 #216 image, 输出节点 #217
# 复用同一 RUNNINGHUB_API_KEY, 共享 100 并发额度
# ============================================================

RH_POLISH_UPLOAD_NODE_ID = "216"
RH_POLISH_UPLOAD_FIELD = "image"
RH_POLISH_PROMPT_NODE_ID = "146"  # CLIPTextEncode 提示词节点; 默认含预置润色词, 可被用户追加词覆盖
RH_POLISH_PROMPT_FIELD = "text"


def _rh_polish_cfg() -> tuple[str, str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    wf = os.environ.get("RUNNINGHUB_POLISH_WORKFLOW_ID", "").strip()
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    if not wf:
        raise RuntimeError("RUNNINGHUB_POLISH_WORKFLOW_ID not configured")
    return key, base, wf


async def rh_create_polish(file_name: str, *, prompt: Optional[str] = None, timeout: float = 60.0) -> str:
    """创建图片润色任务, 返回远端 taskId。

    prompt: 可选; 传入时覆盖 #146 节点提示词 (调用方负责拼好 "预置词\\n用户词")。
            不传则工作流使用其内置默认润色提示词。
    """
    key, base, wf = _rh_polish_cfg()
    node_info = [
        {"nodeId": RH_POLISH_UPLOAD_NODE_ID, "fieldName": RH_POLISH_UPLOAD_FIELD, "fieldValue": file_name},
    ]
    if prompt and prompt.strip():
        node_info.append(
            {"nodeId": RH_POLISH_PROMPT_NODE_ID, "fieldName": RH_POLISH_PROMPT_FIELD, "fieldValue": prompt}
        )
    payload = {
        "apiKey": key,
        "workflowId": wf,
        "nodeInfoList": node_info,
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/create", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH polish create HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH polish create error: {d.get('msg')}")
    tid = (d.get("data") or {}).get("taskId")
    if not tid:
        raise RuntimeError(f"RH polish create no taskId: {str(d)[:200]}")
    return str(tid)


async def rh_status(task_id: str, *, timeout: float = 30.0) -> str:
    """查询任务状态: RUNNING / SUCCESS / FAILED / QUEUED 等。"""
    key, base, _ = _rh_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/status", json={"apiKey": key, "taskId": task_id})
    if r.status_code != 200:
        raise RuntimeError(f"RH status HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH status error: {d.get('msg')}")
    return str(d.get("data") or "").upper()


async def rh_outputs(task_id: str, *, timeout: float = 60.0) -> list[str]:
    """取产出图 URL 列表 (SUCCESS 后调用)。"""
    key, base, _ = _rh_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/outputs", json={"apiKey": key, "taskId": task_id})
    if r.status_code != 200:
        raise RuntimeError(f"RH outputs HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH outputs error: {d.get('msg')} {str(d.get('data'))[:200]}")
    data = d.get("data") or []
    urls: list[str] = []
    if isinstance(data, list):
        for it in data:
            if isinstance(it, dict):
                u = it.get("fileUrl") or it.get("url")
                if u:
                    urls.append(u)
            elif isinstance(it, str):
                urls.append(it)
    if not urls:
        raise RuntimeError(f"RH outputs no urls: {str(d)[:200]}")
    return urls


async def download_url(url: str, *, timeout: float = 180.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"download HTTP {r.status_code}")
        return r.content


# 便捷封装: 按 job 的 params.rh_task_id 查询 (service 用)
async def _rh_task_id_of_job(job_id: int) -> str:
    from ..db import session_scope
    from .models import ImageJob
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        tid = (dict(job.params or {}).get("rh_task_id") if job else None)
    if not tid:
        raise RuntimeError(f"job {job_id} 无 rh_task_id")
    return str(tid)


async def rh_status_for_job(job_id: int) -> str:
    return await rh_status(await _rh_task_id_of_job(job_id))


async def rh_outputs_for_job(job_id: int) -> list[str]:
    return await rh_outputs(await _rh_task_id_of_job(job_id))


# ============================================================
# RunningHub 视频高清 provider (SeedVR2 视频超分工作流)
# 工作流 __REDACTED__: 上传节点 #16 (VHS_LoadVideo, 字段 video), 输出节点 #72
# 异步: upload(视频) -> create(nodeInfoList) -> 轮询 rh_status -> rh_outputs 取视频URL
# 复用同一 RUNNINGHUB_API_KEY, 共享并发额度; status/outputs 只用 apiKey+taskId, 可复用上面的实现。
# ============================================================

RH_VIDEO_UPSCALE_UPLOAD_NODE_ID = "16"
RH_VIDEO_UPSCALE_UPLOAD_FIELD = "video"


def _rh_video_upscale_cfg() -> tuple[str, str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    wf = os.environ.get("RUNNINGHUB_VIDEO_UPSCALE_WORKFLOW_ID", "").strip()
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    if not wf:
        raise RuntimeError("RUNNINGHUB_VIDEO_UPSCALE_WORKFLOW_ID not configured")
    return key, base, wf


async def rh_upload_video(raw: bytes, *, filename: str = "input.mp4", timeout: float = 600.0) -> str:
    """上传视频到 RunningHub, 返回远端 fileName (供节点 #16 引用)。"""
    key, base, _ = _rh_video_upscale_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(
            f"{base}/task/openapi/upload",
            data={"apiKey": key},
            files={"file": (filename, raw, "video/mp4")},
        )
    if r.status_code != 200:
        raise RuntimeError(f"RH video upload HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH video upload error: {d.get('msg')}")
    fn = (d.get("data") or {}).get("fileName")
    if not fn:
        raise RuntimeError(f"RH video upload no fileName: {str(d)[:200]}")
    return fn


async def rh_create_video_upscale(file_name: str, *, timeout: float = 60.0) -> str:
    """创建视频高清任务, 返回远端 taskId。"""
    key, base, wf = _rh_video_upscale_cfg()
    payload = {
        "apiKey": key,
        "workflowId": wf,
        "nodeInfoList": [
            {"nodeId": RH_VIDEO_UPSCALE_UPLOAD_NODE_ID,
             "fieldName": RH_VIDEO_UPSCALE_UPLOAD_FIELD,
             "fieldValue": file_name},
        ],
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/create", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH video upscale create HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH video upscale create error: {d.get('msg')}")
    tid = (d.get("data") or {}).get("taskId")
    if not tid:
        raise RuntimeError(f"RH video upscale create no taskId: {str(d)[:200]}")
    return str(tid)
