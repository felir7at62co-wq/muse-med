"""TikHub 多平台适配层。

统一封装 抖音/TikTok/快手/小红书 的「关键词搜索」→ 统一视频 DTO。
下载/解析仍以各平台 detail 为主; 抖音走 service.py 的完整实现。

统一 DTO(与 service.normalize_video 对齐):
  {aweme_id, desc, cover, play_url, share_url, duration,
   author:{nickname}, statistics:{digg_count,comment_count,play_count,...}, tags:[]}
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..config import get_settings
from . import client
from .client import TikHubError

logger = logging.getLogger(__name__)

# 支持的平台清单(前端下拉用)。红果=番茄系短剧App, TikHub无接口, 不支持。
SUPPORTED_PLATFORMS = [
    {"id": "douyin", "label": "抖音", "kind": "video"},
    {"id": "tiktok", "label": "TikTok", "kind": "video"},
    {"id": "kuaishou", "label": "快手", "kind": "video"},
    {"id": "xiaohongshu", "label": "小红书", "kind": "note"},
]


def _first(lst, default=None):
    return lst[0] if isinstance(lst, list) and lst else default


def _deep_find_list(o, depth=0):
    if isinstance(o, list) and o and isinstance(o[0], dict):
        return o
    if isinstance(o, dict) and depth < 6:
        for v in o.values():
            r = _deep_find_list(v, depth + 1)
            if r:
                return r
    return None


def _url(v):
    """字段可能是 str 或 {url_list:[]} 或 {url_default}, 统一取一个 url 字符串。"""
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return _first(v.get("url_list")) or v.get("url_default") or v.get("url")
    return None


# ---------------- TikTok (item 结构: id/desc/video{cover,playAddr,duration}/author/stats) ----------------
def _norm_tiktok(it: dict) -> dict:
    aid = str(it.get("id") or it.get("aweme_id") or "")
    video = it.get("video") or {}
    author = it.get("author") or {}
    st = it.get("stats") or it.get("statistics") or {}
    return {
        "aweme_id": aid,
        "desc": it.get("desc") or "",
        "cover": _url(video.get("cover")) or _url(video.get("originCover")) or _url(video.get("dynamicCover")),
        "play_url": _url(video.get("playAddr")) or _url(video.get("downloadAddr")),
        "share_url": f"https://www.tiktok.com/@{author.get('uniqueId') or author.get('unique_id') or ''}/video/{aid}",
        "duration": video.get("duration"),
        "author": {"nickname": author.get("nickname") or author.get("uniqueId")},
        "statistics": {
            "digg_count": st.get("diggCount") or st.get("digg_count"),
            "comment_count": st.get("commentCount") or st.get("comment_count"),
            "play_count": st.get("playCount") or st.get("play_count"),
            "share_count": st.get("shareCount") or st.get("share_count"),
        },
        "tags": [],
        "platform": "tiktok",
    }


# ---------------- 快手 (feed 结构: photo_id + caption/coverUrls 视版本而定) ----------------
def _norm_kuaishou(it: dict) -> dict:
    aid = str(it.get("photo_id") or it.get("photoId") or it.get("id") or "")
    cover = _url(it.get("coverUrl")) or _url(_first(it.get("coverUrls") or []))
    play = _url(it.get("mainMvUrl")) or _url(_first(it.get("mainMvUrls") or [])) or _url(it.get("photoUrl"))
    user = it.get("user") or {}
    return {
        "aweme_id": aid,
        "desc": it.get("caption") or it.get("captionToComment") or "",
        "cover": cover,
        "play_url": play,
        "share_url": it.get("shareUrl") or "",
        "duration": it.get("duration"),
        "author": {"nickname": user.get("user_name") or it.get("userName")},
        "statistics": {
            "digg_count": it.get("likeCount") or it.get("realLikeCount"),
            "comment_count": it.get("commentCount"),
            "play_count": it.get("viewCount"),
        },
        "tags": [],
        "platform": "kuaishou",
    }


# ---------------- 小红书 (note 扁平结构: id/nice_count/collected_count/comments_count/user) ----------------
def _norm_xhs(note: dict) -> dict:
    aid = str(note.get("id") or note.get("note_id") or "")
    # 封面: images_list / cover 结构不定, 尽量取
    cover = _url(note.get("cover"))
    if not cover:
        imgs = note.get("images_list") or note.get("image_list") or []
        if imgs and isinstance(imgs[0], dict):
            cover = _url(imgs[0]) or imgs[0].get("url_size_large") or imgs[0].get("url")
    user = note.get("user") or {}
    return {
        "aweme_id": aid,
        "desc": note.get("display_title") or note.get("title") or note.get("desc") or "",
        "cover": cover,
        "play_url": None,  # 小红书图文为主, 视频需详情
        "share_url": f"https://www.xiaohongshu.com/explore/{aid}",
        "duration": note.get("video_duration"),
        "author": {"nickname": user.get("nickname") or user.get("nick_name") or user.get("name")},
        "statistics": {
            "digg_count": note.get("nice_count") or note.get("liked_count"),
            "comment_count": note.get("comments_count"),
            "collect_count": note.get("collected_count"),
            "share_count": note.get("shared_count"),
        },
        "tags": [],
        "platform": "xiaohongshu",
        "is_note": True,
    }


async def search(platform: str, keyword: str, *, user_id: Optional[int] = None) -> dict:
    """多平台关键词搜索 → {videos:[统一DTO]}。抖音请直接用 service.search_videos。"""
    s = get_settings()
    ttl = s.tikhub_cache_ttl_search
    p = platform.lower()

    if p == "tiktok":
        data = await client.call(
            "/api/v1/tiktok/web/fetch_general_search", method="GET",
            params={"keyword": keyword, "offset": 0},
            endpoint="tiktok_search", user_id=user_id, keyword=keyword, cache_ttl=ttl,
        )
        lst = ((data.get("data") or {}).get("data")) or []
        vids = []
        for it in lst[:25]:
            if not isinstance(it, dict):
                continue
            item = it.get("item")  # tiktok: {type, item, common}
            if isinstance(item, dict):
                v = _norm_tiktok(item)
                if v.get("aweme_id"):
                    vids.append(v)
        return {"videos": vids}

    if p == "kuaishou":
        data = await client.call(
            "/api/v1/kuaishou/app/search_video_v2", method="GET",
            params={"keyword": keyword},
            endpoint="kuaishou_search", user_id=user_id, keyword=keyword, cache_ttl=ttl,
        )
        dd = data.get("data") or {}
        feeds = dd.get("mixFeeds") or dd.get("result") or []
        vids = []
        for it in feeds[:25]:
            if not isinstance(it, dict):
                continue
            feed = it.get("feed") or it.get("photo") or it  # 快手: mixFeeds[].feed
            v = _norm_kuaishou(feed if isinstance(feed, dict) else it)
            if v.get("aweme_id"):
                vids.append(v)
        return {"videos": vids}

    if p == "xiaohongshu":
        # app_v2 更稳(web_v3 已 410 弃用)
        data = await client.call(
            "/api/v1/xiaohongshu/app_v2/search_notes", method="GET",
            params={"keyword": keyword, "page": 1},
            endpoint="xhs_search", user_id=user_id, keyword=keyword, cache_ttl=ttl,
        )
        dd = data.get("data") or {}
        items = (dd.get("data") or {}).get("items") if isinstance(dd.get("data"), dict) else None
        items = items or dd.get("items") or _deep_find_list(dd) or []
        vids = []
        for it in items[:25]:
            if not isinstance(it, dict):
                continue
            v = _norm_xhs(it)  # xhs: items[].note
            if v.get("aweme_id"):
                vids.append(v)
        return {"videos": vids}

    raise TikHubError(f"平台 {platform} 暂不支持关键词搜索")
