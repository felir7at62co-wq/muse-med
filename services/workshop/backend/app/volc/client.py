"""火山官方方舟(ARK) provider — 统一封装，替代旧 ARK key 与 RunningHub Seedance。

两类能力:
1. 视频理解(seed2.1pro): chat/completions, 返回 (text, usage)。给反推链路用。
2. 视频生成(seedance-2.0): contents/generations/tasks 异步任务, submit + poll, 返回 (video_url, usage)。

凭证(config):
- volc_ark_api_key / volc_ark_base_url
- volc_seed21pro_ep (视频理解 endpoint id)
- volc_seedance_ep  (视频生成 endpoint id)

注意: 调用 model 传 endpoint id(ep-xxx), 火山会路由到对应模型。
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from ..config import get_settings

logger = logging.getLogger("volc.client")

# 视频理解 Chat API 的输出 token 预算。
# 不传时走模型默认(豆包约 4096)，一集短剧详尽复述约 4000-8000 中文字，
# 极易撞上默认上限导致正文在句子中间硬截断。
# 探测到模型接受的最大值为 131072，这里直接设到上限——"不设字数上限"
# 的意图就是让模型写多少出多少，所以给它最大预算，不要人为卡住。
_MAX_UNDERSTAND_TOKENS = 131072


def _cfg() -> tuple[str, str]:
    s = get_settings()
    key = (getattr(s, "volc_ark_api_key", "") or "").strip()
    base = (getattr(s, "volc_ark_base_url", "") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
    if not key:
        raise RuntimeError("VOLC_ARK_API_KEY 未配置")
    return key, base


# ============================================================
# 1) 视频理解 (seed2.1pro) — chat/completions, 返回 (text, usage)
# ============================================================

async def chat_understand(
    *,
    video_ref: dict | None = None,
    image_url: str | None = None,
    system_prompt: str,
    user_prompt: str,
    timeout: float = 600.0,
) -> tuple[str, dict]:
    """调火山官方 seed2.1pro 做视频/图片理解。

    video_ref: {"file_id":...,"fps":1} 或 {"url":...,"fps":1}(二选一, 与图片二选一)
    image_url: 图片直链(首帧描述用)
    返回 (text, usage_dict)。usage_dict 含 prompt_tokens/completion_tokens/total_tokens。
    """
    s = get_settings()
    key, base = _cfg()
    ep = (getattr(s, "volc_seed21pro_ep", "") or "").strip()
    if not ep:
        raise RuntimeError("VOLC_SEED21PRO_EP 未配置")

    content: list[dict[str, Any]] = []
    if video_ref is not None:
        content.append({"type": "video_url", "video_url": video_ref})
    if image_url:
        content.append({"type": "image_url", "image_url": {"url": image_url}})
    content.append({"type": "text", "text": user_prompt})

    payload = {
        "model": ep,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        # ⚠️ 必须显式给 max_tokens。不传时走模型默认(豆包约 4096 输出 token),
        # 而一集短剧的详尽复述约 4000-8000 中文字 —— 4600 字恰好撞上默认上限,
        # 正文会在句子中间被硬截断(实测: draft 457 结尾停在"扔出圈套中了白玉兔子",
        # 无标点、无收尾)。反推提示词写着"不设字数上限", 但那只约束模型的表达意图,
        # 约束不了 API 的输出预算, 两者必须对齐。
        "max_tokens": _MAX_UNDERSTAND_TOKENS,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    url = f"{base}/chat/completions"
    r = None
    for attempt in range(5):
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, headers=headers, json=payload)
        if r.status_code == 429:
            wait = min(2 ** attempt * 3, 30)
            logger.warning("火山视频理解 429 限流, 第%d次退避 %ds", attempt + 1, wait)
            await asyncio.sleep(wait)
            continue
        break
    if r is None or r.status_code != 200:
        raise RuntimeError(f"火山视频理解 HTTP {getattr(r, 'status_code', 'NA')}: {getattr(r, 'text', '')[:400]}")
    data = r.json()
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"火山视频理解返回结构异常: {str(data)[:400]}") from e
    usage = data.get("usage") or {}

    # 截断必须显式暴露, 不能当成功返回。
    # 之前没查 finish_reason, 结果输出被 token 上限砍断也照常入库,
    # 用户看到的是"反推完成"但正文停在半句话 —— 静默的数据损坏比报错难查得多。
    fr = (data.get("choices") or [{}])[0].get("finish_reason") or ""
    if fr == "length":
        ct = usage.get("completion_tokens", "?")
        logger.error("火山视频理解输出被截断: finish_reason=length completion_tokens=%s "
                     "text_len=%d max_tokens=%d", ct, len(text), _MAX_UNDERSTAND_TOKENS)
        raise RuntimeError(
            f"视频理解输出被 token 上限截断(completion_tokens={ct}, "
            f"已生成 {len(text)} 字), 正文不完整。当前上限 {_MAX_UNDERSTAND_TOKENS}, "
            "如确需更长请调高 _MAX_UNDERSTAND_TOKENS 或将视频分段反推。"
        )
    if fr and fr not in ("stop", "", "null"):
        logger.warning("火山视频理解 finish_reason=%s (非正常结束), text_len=%d", fr, len(text))
    return text.strip(), usage


# 方舟默认托管存储的单文件上限（官方文档: 512 MB）。
# 超过这个值必须改用"存到用户自己的 TOS 桶"模式，那条路视频上限 2 GB。
_ARK_DEFAULT_STORE_LIMIT = 512 * 1024 * 1024


async def upload_file_and_wait(
    local_path: str, *, timeout: float = 600.0,
) -> str:
    """把本地视频上传到火山 Files API, 轮询到可用, 返回 file_id。

    两种存储去向, 上限不同(官方文档 82379/1895586):

      - 不传 tos 参数 -> 方舟平台托管的默认存储空间, 单文件 **512 MB**
      - 传 tos 参数   -> 用户自己的火山 TOS 桶, 视频 **2 GB**

    策略: 默认走托管存储(零配置、无需授权); **仅当文件超过 512 MB** 时才
    切到 TOS 桶模式。这样绝大多数视频不受影响, 只有大文件才依赖额外配置。

    ⚠️ TOS 桶模式的两个硬性前置条件(踩过, 记下来省得再排查):
      1. 桶必须在 **cn-beijing**。方舟视频理解只部署在北京, 上海桶会被拒:
         `Tos bucket "x" is in region "cn-shanghai"; this deployment only
          supports buckets in region "cn-beijing"`
      2. 必须在方舟控制台 **项目设置 → 项目授权** 里给该 TOS 资源授权,
         否则 403: `Please go to Ark Project Settings → Project
         Authorization, and grant permission to the TOS resource`
         这一步只能在控制台做, 加任何请求头都绕不过去。
    """
    key, base = _cfg()
    headers = {"Authorization": f"Bearer {key}"}
    size = os.path.getsize(local_path)
    s = get_settings()
    big_bucket = (getattr(s, "ark_tos_bucket", "") or "").strip()
    use_tos = size > _ARK_DEFAULT_STORE_LIMIT

    if use_tos and not big_bucket:
        raise RuntimeError(
            f"视频 {size / 1048576:.0f} MB 超过方舟托管存储上限 512 MB, "
            "需改用 TOS 桶模式(上限 2 GB), 但未配置 ARK_TOS_BUCKET。"
            "请设置一个 **cn-beijing** 区域的 TOS 桶名, 并在方舟控制台"
            "「项目设置 → 项目授权」中为该桶授权。"
        )

    # 纯文本字段也必须放进 files=, 否则 httpx 会发成
    # application/x-www-form-urlencoded, 方舟只收 multipart/form-data
    async with httpx.AsyncClient(timeout=timeout) as c:
        with open(local_path, "rb") as f:
            fields: dict = {
                "purpose": (None, "user_data"),
                "file": (os.path.basename(local_path) or "v.mp4", f, "video/mp4"),
            }
            if use_tos:
                fields["tos[bucket]"] = (None, big_bucket)
                fields["tos[prefix]"] = (None,
                                         getattr(s, "ark_tos_prefix", "") or "ark-files/")
            r = await c.post(f"{base}/files", headers=headers, files=fields)
        if r.status_code != 200:
            where = f"TOS 桶 {big_bucket}" if use_tos else "方舟托管存储"
            raise RuntimeError(
                f"火山 Files 上传失败 HTTP {r.status_code} "
                f"({size / 1048576:.0f} MB → {where}): {r.text[:300]}")
        fid = r.json().get("id")
        if not fid:
            raise RuntimeError(f"火山 Files 上传未返回 file id: {r.text[:200]}")
        st = "processing"
        for _ in range(80):
            g = await c.get(f"{base}/files/{fid}", headers=headers)
            st = (g.json() or {}).get("status", "")
            if st in ("ready", "processed", "active", "success"):
                return fid
            if st in ("failed", "error"):
                raise RuntimeError(f"火山 Files 处理失败: status={st}")
            await asyncio.sleep(3)
        raise RuntimeError(f"火山 Files 处理超时: 最终 status={st}")


async def delete_file(file_id: str, *, timeout: float = 30.0) -> bool:
    """删除方舟 Files 里已上传的文件, 释放账号存储配额。返回是否确认已不存在。

    为什么必须显式删(血泪教训, 2026-09-11 生产全量反推失败):
      上传后的文件默认有 7 天存储有效期, 而反推是"上传→理解→再也不用"的一次性用法。
      不在用完时删掉, 这些文件会在托管存储里堆积 7 天 —— 实测 6 小时就堆出约 1.2 GB,
      滚动峰值 30~40 GB, 直接把账号配额撑满, 之后**所有**反推上传都被
      `OperationDenied.FileQuotaExceeded` 拒绝, 功能整体不可用。

    幂等且绝不上抛: 文件已不存在(404)视作成功; 其他失败只记日志。
    这是清理路径, 不能因为它出错而让已经成功的反推变成失败。
    """
    fid = (file_id or "").strip()
    if not fid:
        return True
    key, base = _cfg()
    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.delete(f"{base}/files/{fid}", headers=headers)
        if r.status_code in (200, 204):
            return True
        if r.status_code == 404:
            # 已经不存在(比如被 7 天有效期清掉了), 目的已达成
            return True
        logger.warning("火山 Files 删除失败 HTTP %s (file_id=%s): %s",
                       r.status_code, fid, r.text[:200])
        return False
    except Exception as e:  # noqa: BLE001
        logger.warning("火山 Files 删除异常 (file_id=%s): %s", fid, str(e)[:200])
        return False


# ============================================================
# 2) 视频生成 (seedance-2.0) — contents/generations/tasks 异步任务
# ============================================================

def _build_content_parts(
    prompt: str,
    image_urls: list | None,
) -> list[dict]:
    """组装 seedance 视频生成的 content 数组: 文本 + 可选图片。

    image_urls 每项支持两种形式:
    - str: 纯 URL(单图旧用法, 不带 role, 火山默认按首帧图处理)
    - dict: {"url": ..., "role": "first_frame"|"last_frame"|"reference_image"}
      ⚠️ 火山 Seedance 2.0: 多图时每张必须带 role, 否则 400 "role must be specified"。
    """
    parts: list[dict] = [{"type": "text", "text": prompt}]
    for u in (image_urls or []):
        if not u:
            continue
        if isinstance(u, dict):
            iu: dict = {"url": u.get("url")}
            if not iu["url"]:
                continue
            part: dict = {"type": "image_url", "image_url": iu}
            if u.get("role"):
                part["role"] = u["role"]
            parts.append(part)
        else:
            parts.append({"type": "image_url", "image_url": {"url": u}})
    return parts


async def submit_video(
    *,
    prompt: str,
    image_urls: list | None = None,
    resolution: str = "720p",
    duration: str | int = "5",
    ratio: str = "9:16",
    generate_audio: bool = True,
    timeout: float = 120.0,
) -> str:
    """提交火山官方 Seedance 视频生成任务, 返回 task_id。

    image_urls: 每项为 str(纯URL) 或 {"url", "role"} dict(多图必须带 role, 见 _build_content_parts)。
    火山把分辨率/时长/比例/音频等作为 text 参数尾缀(官方 --参数 语法), 也可用结构化字段;
    这里采用官方推荐的 text 尾缀写法, 兼容性最好。
    """
    s = get_settings()
    key, base = _cfg()
    ep = (getattr(s, "volc_seedance_ep", "") or "").strip()
    if not ep:
        raise RuntimeError("VOLC_SEEDANCE_EP 未配置")

    ratio_norm = (ratio or "9:16").replace("：", ":").replace(" ", "").strip()
    # 官方 text 尾缀参数: --resolution --duration --ratio --watermark --camerafixed 等
    tail = f" --resolution {resolution} --duration {duration} --ratio {ratio_norm}"
    if generate_audio:
        tail += " --audio true"
    full_prompt = f"{prompt.strip()}{tail}"

    payload = {
        "model": ep,
        "content": _build_content_parts(full_prompt, image_urls),
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    url = f"{base}/contents/generations/tasks"
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(url, headers=headers, json=payload)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"火山 Seedance 提交 HTTP {r.status_code}: {r.text[:400]}")
    d = r.json()
    tid = d.get("id") or d.get("task_id")
    if not tid:
        raise RuntimeError(f"火山 Seedance 提交未返回任务 id: {str(d)[:300]}")
    return str(tid)


async def query_video(task_id: str, *, timeout: float = 60.0) -> dict:
    """查询 Seedance 任务。返回 {status, video_url, usage, raw}。

    status 归一为大写: SUCCEEDED/RUNNING/QUEUED/FAILED 等。火山官方状态字段为 'status',
    完成时 content.video_url 有产出, usage 含 token 计量。
    """
    key, base = _cfg()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    url = f"{base}/contents/generations/tasks/{task_id}"
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(url, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"火山 Seedance 查询 HTTP {r.status_code}: {r.text[:300]}")
    d = r.json()
    status = (d.get("status") or "").upper()
    # 产出视频 url: 官方在 content.video_url
    video_url = None
    content = d.get("content") or {}
    if isinstance(content, dict):
        video_url = content.get("video_url")
    if not video_url:
        # 兜底: 有些返回把 url 放顶层或 results
        video_url = d.get("video_url")
    usage = d.get("usage") or {}
    reason = d.get("error") or d.get("message") or ""
    return {"status": status, "video_url": video_url, "usage": usage, "reason": reason, "raw": d}


async def download(url: str, *, timeout: float = 600.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
        r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"视频下载 HTTP {r.status_code}")
        return r.content