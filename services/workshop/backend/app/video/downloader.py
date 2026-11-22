"""视频下载模块 (独立、可替换) — 从平台链接下载视频到本地。

设计目标 (见 docs/PLAN-视频反推-URL与搜索下载.md):
  - 独立封装: 对外只暴露 probe_url / download_url / search_videos,
    内部用 yt-dlp 实现; 将来换库/加代理只改这里, 主业务无感。
  - 预留代理: 通过环境变量 VIDEO_DL_PROXY 配置 (默认空=不走代理),
    将来要上 IP 池只需设这个变量, 不用改代码。
  - 安全: 域名白名单 (防 SSRF + 合规)、拒绝主页/合集、从粘贴文本里提取 URL。

注意: 本能力仅供"个人学习/拆解分析", 不分发不商用; 仅接受用户主动提供的
单条视频链接。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger("video.downloader")

# 代理配置 (预留, 默认不启用)。将来上 IP 池: 设 VIDEO_DL_PROXY=http://host:port
DL_PROXY = os.environ.get("VIDEO_DL_PROXY", "").strip()

# Cookies 文件 (Netscape 格式)。抖音/B站等平台要求 cookies 才能解析:
#   设 VIDEO_DL_COOKIES=/path/to/cookies.txt (在容器内可见的路径)。
# 抖音强制要求"新鲜 cookies"(不必登录), 没有则报 "Fresh cookies needed"。
DL_COOKIES = os.environ.get("VIDEO_DL_COOKIES", "").strip()

# 桌面浏览器 UA, 多数平台反爬需要
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# 单条视频时长上限 (秒)。超过需用户二次确认 (前端用 probe 返回的 duration 判断)。
MAX_DURATION_SEC = int(os.environ.get("VIDEO_DL_MAX_DURATION", "1800"))  # 30 min

# 域名白名单: 只放行这些平台的视频链接 (防 SSRF + 合规)。
# key=用于识别的域名子串; value=平台展示名。
DOMAIN_WHITELIST: dict[str, str] = {
    "douyin.com": "抖音",
    "iesdouyin.com": "抖音",
    "v.douyin.com": "抖音",
    "kuaishou.com": "快手",
    "gifshow.com": "快手",
    "v.kuaishou.com": "快手",
    "xiaohongshu.com": "小红书",
    "xhslink.com": "小红书",
    "bilibili.com": "B站",
    "b23.tv": "B站",
    "youtube.com": "YouTube",
    "youtu.be": "YouTube",
}

# 明显是"主页/合集/播放列表"而非单条视频的路径特征 → 拒绝, 防误下一大堆。
_COLLECTION_HINTS = (
    "/user/", "/space.bilibili", "space.bilibili.com",
    "/playlist", "list=", "/collection/", "/channel/",
    "/@",  # 部分平台用户主页
)

_URL_RE = re.compile(r"https?://[^\s\u4e00-\u9fff，。、！？；：\"'）)】\]]+", re.IGNORECASE)


def _normalize_url(url: str) -> str:
    """把各平台的'网页地址'规范化成 yt-dlp 认识的'单条视频'地址。

    抖音常见两种用户会贴的形式:
      - https://www.douyin.com/jingxuan?modal_id=<id>   (精选页弹窗)
      - https://www.douyin.com/discover?modal_id=<id>
      → 统一转成 https://www.douyin.com/video/<id>
    其它平台原样返回。
    """
    low = url.lower()
    if "douyin.com" in low and "modal_id=" in low:
        m = re.search(r"modal_id=(\d+)", url)
        if m:
            return f"https://www.douyin.com/video/{m.group(1)}"
    return url


def extract_url(text: str) -> str | None:
    """从用户粘贴的一坨文本(可能含中文分享口令)里提取出第一个 http(s) URL。"""
    if not text:
        return None
    m = _URL_RE.search(text.strip())
    if not m:
        return None
    return _normalize_url(m.group(0).rstrip("/."))


def match_platform(url: str) -> str | None:
    """URL 是否命中白名单域名; 命中返回平台名, 否则 None。"""
    low = (url or "").lower()
    # 简单域名包含匹配 (yt-dlp 会处理真实跳转; 这里只做粗过滤)
    for dom, name in DOMAIN_WHITELIST.items():
        if dom in low:
            return name
    return None


def looks_like_collection(url: str) -> bool:
    """是否疑似主页/合集/播放列表链接 (而非单条视频)。"""
    low = (url or "").lower()
    return any(h in low for h in _COLLECTION_HINTS)


def validate_url(raw_text: str) -> tuple[str, str]:
    """校验并返回 (clean_url, platform_name)。校验失败抛 ValueError(含中文原因)。"""
    url = extract_url(raw_text)
    if not url:
        raise ValueError("未识别到有效链接, 请粘贴抖音/快手/小红书/B站等单条视频的链接")
    if not url.lower().startswith("https://") and not url.lower().startswith("http://"):
        raise ValueError("链接必须是 http(s) 地址")
    platform = match_platform(url)
    if not platform:
        raise ValueError("暂不支持该来源, 仅支持抖音/快手/小红书/B站/YouTube 的视频链接")
    if looks_like_collection(url):
        raise ValueError("看起来是主页/合集链接, 请提供单条视频的链接")
    return url, platform


def _ydl_base_opts() -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,          # 只取单条, 不展开播放列表
        "socket_timeout": 30,
        "retries": 3,
        "nocheckcertificate": True,
        "http_headers": {"User-Agent": _UA},
    }
    if DL_PROXY:
        opts["proxy"] = DL_PROXY
    if DL_COOKIES and os.path.exists(DL_COOKIES):
        # 抖音/B站等平台需要 cookies 才能解析; 由运维放置 cookies.txt 并设 VIDEO_DL_COOKIES
        opts["cookiefile"] = DL_COOKIES
    return opts


def _friendly_error(platform: str, exc: Exception) -> str:
    """把 yt-dlp 的英文报错转成对用户友好的中文提示。"""
    msg = str(exc)
    low = msg.lower()
    if "fresh cookies" in low or "cookies" in low and "needed" in low:
        return f"{platform}需要登录态(cookies)才能下载。请联系管理员配置 {platform} cookies, 或改用「上传文件」方式。"
    if "412" in msg or "precondition" in low:
        return f"{platform}触发了反爬保护(412)。建议稍后再试, 或改用「上传文件」。"
    if "unsupported url" in low:
        return "链接无法识别为单条视频, 请确认是该视频的播放页地址(或 App 分享链接)。"
    if "private" in low or "login" in low or "sign in" in low:
        return f"该视频需要登录/为私密内容, 无法下载。"
    if "unavailable" in low or "not available" in low or "404" in msg:
        return "视频不存在或已被删除。"
    return f"{platform}下载失败: {type(exc).__name__}(可能反爬/失效/需登录)"


async def probe_url(raw_text: str) -> dict:
    """解析链接元信息(不下载): 标题/时长/上传者/缩略图/平台。

    Returns: {ok, url, platform, title, duration, uploader, thumbnail, too_long}
    失败抛 ValueError。
    """
    url, platform = validate_url(raw_text)

    def _run() -> dict:
        import yt_dlp
        opts = _ydl_base_opts()
        opts["skip_download"] = True
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        # 若解析出的是播放列表, 取第一条并提示
        if info.get("_type") == "playlist":
            entries = info.get("entries") or []
            if not entries:
                raise ValueError("该链接未解析到视频")
            info = entries[0]
        return info

    try:
        info = await asyncio.to_thread(_run)
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("probe_url failed: %s", e)
        raise ValueError(_friendly_error(platform, e))

    duration = int(info.get("duration") or 0)
    return {
        "ok": True,
        "url": url,
        "platform": platform,
        "title": info.get("title") or "",
        "duration": duration,
        "uploader": info.get("uploader") or info.get("uploader_id") or "",
        "thumbnail": info.get("thumbnail") or "",
        "too_long": duration > MAX_DURATION_SEC,
        "max_duration": MAX_DURATION_SEC,
    }


async def download_url(raw_text: str, dest_dir: Path) -> dict:
    """下载单条视频到 dest_dir。返回 {ok, path, title, duration, platform}。失败抛 ValueError。"""
    url, platform = validate_url(raw_text)
    dest_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(dest_dir / "%(id)s.%(ext)s")

    def _run() -> dict:
        import yt_dlp
        opts = _ydl_base_opts()
        opts.update({
            "outtmpl": outtmpl,
            # 优先 mp4, 合并音视频 (容器已装 ffmpeg)
            "format": "bv*+ba/b",
            "merge_output_format": "mp4",
        })
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info.get("_type") == "playlist":
                entries = info.get("entries") or []
                if not entries:
                    raise ValueError("该链接未解析到可下载视频")
                info = entries[0]
            path = ydl.prepare_filename(info)
            # merge 后扩展名可能变 mp4
            p = Path(path)
            if not p.exists():
                mp4 = p.with_suffix(".mp4")
                if mp4.exists():
                    p = mp4
            return {"path": str(p), "info": info}

    try:
        res = await asyncio.to_thread(_run)
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("download_url failed: %s", e)
        raise ValueError(_friendly_error(platform, e))

    info = res["info"]
    path = res["path"]
    if not Path(path).exists():
        raise ValueError("下载完成但未找到文件")
    return {
        "ok": True,
        "path": path,
        "title": info.get("title") or "",
        "duration": int(info.get("duration") or 0),
        "platform": platform,
    }


# 搜索前缀: 仅这些平台支持 yt-dlp 关键词搜索; 其余平台前端引导"贴链接"。
_SEARCH_PREFIX = {
    "bilibili": "bilisearch{n}:{q}",
    "youtube": "ytsearch{n}:{q}",
}


async def search_videos(query: str, *, platform: str = "bilibili", limit: int = 8) -> list[dict]:
    """关键词搜索候选 (仅 B站/YouTube)。返回候选列表; 不支持的平台返回空+由上层提示。"""
    q = (query or "").strip()
    if not q:
        return []
    tpl = _SEARCH_PREFIX.get(platform)
    if not tpl:
        return []
    search_term = tpl.format(n=max(1, min(20, limit)), q=q)

    def _run() -> list[dict]:
        import yt_dlp
        opts = _ydl_base_opts()
        opts["skip_download"] = True
        opts["extract_flat"] = True  # 只取列表元信息, 不深挖每条, 快
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(search_term, download=False)
        return info.get("entries") or []

    try:
        entries = await asyncio.to_thread(_run)
    except Exception as e:  # noqa: BLE001
        logger.warning("search_videos failed: %s", e)
        return []

    out: list[dict] = []
    for e in entries[:limit]:
        if not isinstance(e, dict):
            continue
        out.append({
            "title": e.get("title") or "",
            "uploader": e.get("uploader") or e.get("channel") or "",
            "duration": int(e.get("duration") or 0),
            "thumbnail": e.get("thumbnail") or "",
            "platform": platform,
            "url": e.get("url") or e.get("webpage_url") or "",
        })
    return out