"""TikHub 业务封装(抖音)。

对上层(routes / video downloader / market)提供语义化方法, 屏蔽 TikHub 原始接口细节。
包含: 视频搜索、分享链接解析、无水印下载地址、视频详情/统计、评论、
      热榜/话题榜、话题作品。

同时提供 normalize_* 把原始 aweme 结构 → 平台统一 DTO。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..config import get_settings
from . import client
from .client import TikHubError

logger = logging.getLogger(__name__)

# ---- TikHub 抖音接口路径(均为当前推荐版本, 避开"弃用") ----
P_VIDEO_SEARCH = "/api/v1/douyin/search/fetch_video_search_v2"          # POST
P_GENERAL_SEARCH = "/api/v1/douyin/search/fetch_general_search_v1"      # POST
P_USER_SEARCH = "/api/v1/douyin/search/fetch_user_search_v2"            # POST
P_ONE_VIDEO = "/api/v1/douyin/web/fetch_one_video"                      # GET aweme_id
P_ONE_BY_SHARE = "/api/v1/douyin/web/fetch_one_video_by_share_url"      # GET share_url
P_HQ_PLAY_URL = "/api/v1/douyin/web/fetch_video_high_quality_play_url"  # GET
P_VIDEO_STATS = "/api/v1/douyin/app/v3/fetch_video_statistics"          # GET aweme_ids
P_COMMENTS = "/api/v1/douyin/web/fetch_video_comments"                  # GET aweme_id
P_HOT_SEARCH = "/api/v1/douyin/app/v3/fetch_hot_search_list"            # GET
P_HOT_TOPIC = "/api/v1/douyin/billboard/fetch_hot_total_topic_list"     # GET
P_HOT_RISING_TOPIC = "/api/v1/douyin/billboard/fetch_hot_total_high_topic_list"
P_HOT_CHALLENGE = "/api/v1/douyin/billboard/fetch_hot_challenge_list"   # GET
P_HASHTAG_VIDEOS = "/api/v1/douyin/app/v3/fetch_hashtag_video_list"     # GET
P_SERIES_VIDEOS = "/api/v1/douyin/app/v3/fetch_series_video_list"       # GET series_id+cursor 拉全集


# ============ normalize ============

def _stat(aweme: dict) -> dict:
    st = aweme.get("statistics") or {}
    return {
        "digg_count": st.get("digg_count"),        # 点赞
        "comment_count": st.get("comment_count"),  # 评论
        "share_count": st.get("share_count"),      # 分享
        "collect_count": st.get("collect_count"),  # 收藏
        "play_count": st.get("play_count"),        # 播放
    }


def normalize_video(aweme: dict) -> dict:
    """把抖音 aweme 结构 → 平台统一视频 DTO。"""
    if not isinstance(aweme, dict):
        return {}
    author = aweme.get("author") or {}
    video = aweme.get("video") or {}
    cover = ((video.get("cover") or {}).get("url_list") or [None])[0]
    # 播放地址(尽量取无水印)
    play_addr = video.get("play_addr") or {}
    play_url = (play_addr.get("url_list") or [None])[0]
    # 话题标签
    tags = []
    for t in (aweme.get("text_extra") or []):
        name = t.get("hashtag_name")
        if name:
            tags.append(name)
    # 抖音短剧官方标记: series_basic_info.series_id 只有"正片剧集"才有,
    # 番外/切片/混剪/催更等都是空 —— 这是判别"剧目原片"最权威的信号。
    sbi = aweme.get("series_basic_info") or {}
    series_id = sbi.get("series_id") if isinstance(sbi, dict) else None
    return {
        "aweme_id": aweme.get("aweme_id"),
        "desc": aweme.get("desc"),
        "create_time": aweme.get("create_time"),
        "duration": video.get("duration"),
        "series_id": series_id or None,           # 有值=官方正片剧集
        "item_title": aweme.get("item_title"),     # 正片标题(如"《X》第七集")
        "cover": cover,
        "play_url": play_url,
        "share_url": aweme.get("share_url"),
        "author": {
            "uid": author.get("uid"),
            "sec_uid": author.get("sec_uid"),
            "nickname": author.get("nickname"),
            "signature": author.get("signature"),
        },
        "statistics": _stat(aweme),
        "tags": tags,
    }


def _extract_aweme_list(data: dict) -> list[dict]:
    """从各种返回结构里尽量抽出 aweme 列表。

    兼容:
    - 搜索V2: data.business_data[].data.aweme_info
    - 通用: data.aweme_list / data.data / data.videos
    """
    d = data.get("data") or {}
    items: list = []
    if isinstance(d, list):
        items = d
    elif isinstance(d, dict):
        # 搜索V2: business_data[].data.aweme_info
        bd = d.get("business_data")
        if isinstance(bd, list) and bd:
            items = bd
        else:
            items = (
                d.get("aweme_list")
                or d.get("data")
                or d.get("videos")
                or []
            )

    result = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        # 逐层解包: card → data → aweme_info / aweme
        inner = it.get("data") if isinstance(it.get("data"), dict) else it
        aweme = inner.get("aweme_info") or inner.get("aweme") or it.get("aweme_info") or it.get("aweme") or it
        if isinstance(aweme, dict) and aweme.get("aweme_id"):
            result.append(aweme)
    return result


# ============ 业务方法 ============

async def search_videos(
    keyword: str,
    *,
    sort_type: str = "0",
    publish_time: str = "0",
    filter_duration: str = "0",
    cursor: int = 0,
    pages: int = 8,
    user_id: Optional[int] = None,
) -> dict:
    """视频搜索(多页聚合)。sort_type: 0综合 1最多点赞 2最新; publish_time: 0不限 1一天 7一周 180半年。

    抖音搜索单页仅 ~8 条; 短剧多集散落多页, 故默认翻 pages 页并按 aweme_id 去重聚合,
    尽量把同一部剧的各集都拉全。翻页用 search_id(取自 log_pb.impr_id) + 累计 cursor。
    """
    s = get_settings()
    all_videos: list[dict] = []
    seen: set = set()
    search_id = ""

    for page in range(max(1, pages)):
        body = {
            "keyword": keyword, "sort_type": sort_type, "publish_time": publish_time,
            "filter_duration": filter_duration, "content_type": "0",
            "cursor": page * 10,
        }
        if search_id:
            body["search_id"] = search_id
        try:
            data = await client.call(
                P_VIDEO_SEARCH, method="POST", json_body=body,
                endpoint="search_videos", user_id=user_id, keyword=f"{keyword}#p{page}",
                cache_ttl=s.tikhub_cache_ttl_search,
            )
        except TikHubError:
            break
        d = data.get("data") or {}
        # 记录 search_id 供下一页翻页
        if not search_id and isinstance(d, dict):
            lp = d.get("log_pb") or {}
            search_id = d.get("search_id") or (lp.get("impr_id") if isinstance(lp, dict) else "") or ""
        page_videos = [normalize_video(a) for a in _extract_aweme_list(data)]
        new_cnt = 0
        for v in page_videos:
            aid = v.get("aweme_id")
            if aid and aid not in seen:
                seen.add(aid)
                all_videos.append(v)
                new_cnt += 1
        # 该页无新增, 说明到底了
        if new_cnt == 0 and page > 0:
            break

    return {"videos": all_videos, "cursor": None, "has_more": None}


async def list_series_episodes(series_id: str, *, user_id: Optional[int] = None) -> dict:
    """按短剧 series_id 拉全部集(翻页聚合)。这是拿"整部剧所有集"的权威入口,
    比关键词搜索召回全得多。返回 {videos:[...], total:n}。
    """
    s = get_settings()
    all_eps: list[dict] = []
    seen: set = set()
    cursor = 0
    for _ in range(20):  # 最多翻20页(足够覆盖超长剧), has_more=0 即停
        try:
            data = await client.call(
                P_SERIES_VIDEOS, method="GET",
                params={"series_id": series_id, "cursor": cursor},
                endpoint="series_video_list", user_id=user_id, keyword=str(series_id),
                cache_ttl=s.tikhub_cache_ttl_search,
            )
        except TikHubError:
            break
        dd = data.get("data") or {}
        page = [normalize_video(a) for a in (dd.get("aweme_list") or [])]
        new_cnt = 0
        for v in page:
            aid = v.get("aweme_id")
            if aid and aid not in seen:
                seen.add(aid)
                all_eps.append(v)
                new_cnt += 1
        has_more = dd.get("has_more")
        nxt = dd.get("max_cursor") or dd.get("cursor")
        if not has_more or nxt is None or new_cnt == 0:
            break
        cursor = nxt
    return {"videos": all_eps, "total": len(all_eps)}


async def resolve_share_url(share_url: str, *, user_id: Optional[int] = None) -> dict:
    """分享链接/短链 → 视频详情(含下载地址)。"""
    s = get_settings()
    data = await client.call(
        P_ONE_BY_SHARE, method="GET", params={"share_url": share_url},
        endpoint="resolve_share_url", user_id=user_id, keyword=share_url,
        cache_ttl=s.tikhub_cache_ttl_detail,
    )
    d = data.get("data") or {}
    aweme = d.get("aweme_detail") or d.get("aweme") or d
    return normalize_video(aweme)


async def get_video_detail(aweme_id: str, *, user_id: Optional[int] = None) -> dict:
    """作品ID → 视频详情。"""
    s = get_settings()
    data = await client.call(
        P_ONE_VIDEO, method="GET", params={"aweme_id": aweme_id},
        endpoint="get_video_detail", user_id=user_id, keyword=aweme_id,
        cache_ttl=s.tikhub_cache_ttl_detail,
    )
    d = data.get("data") or {}
    aweme = d.get("aweme_detail") or d.get("aweme") or d
    return normalize_video(aweme)


async def get_play_url(aweme_id: str, *, user_id: Optional[int] = None) -> Optional[str]:
    """拿最高画质(无水印)播放地址, 用于下载。"""
    s = get_settings()
    try:
        data = await client.call(
            P_HQ_PLAY_URL, method="GET", params={"aweme_id": aweme_id},
            endpoint="get_play_url", user_id=user_id, keyword=aweme_id,
            cache_ttl=s.tikhub_cache_ttl_detail,
        )
        d = data.get("data") or {}
        # 常见: data 里直接是 url 或 url_list
        url = d.get("play_url") or d.get("url")
        if not url:
            urls = d.get("url_list") or []
            url = urls[0] if urls else None
        if url:
            return url
    except TikHubError:
        logger.warning("get_play_url 高画质接口失败, 回退详情 play_url")
    # 回退: 用详情里的 play_url
    detail = await get_video_detail(aweme_id, user_id=user_id)
    return detail.get("play_url")


async def get_comments(aweme_id: str, *, cursor: int = 0, count: int = 20, user_id: Optional[int] = None) -> dict:
    """视频评论。"""
    s = get_settings()
    data = await client.call(
        P_COMMENTS, method="GET",
        params={"aweme_id": aweme_id, "cursor": cursor, "count": count},
        endpoint="get_comments", user_id=user_id, keyword=aweme_id,
        cache_ttl=s.tikhub_cache_ttl_comments,
    )
    d = data.get("data") or {}
    comments = []
    for c in (d.get("comments") or []):
        comments.append({
            "text": c.get("text"),
            "digg_count": c.get("digg_count"),
            "reply_comment_total": c.get("reply_comment_total"),
            "nickname": ((c.get("user") or {}).get("nickname")),
        })
    return {"comments": comments, "cursor": d.get("cursor"), "has_more": d.get("has_more"), "total": d.get("total")}


async def get_hot_boards(*, user_id: Optional[int] = None) -> dict:
    """聚合抖音热点面板: 热搜榜 + 话题热榜 + 飙升话题 + 挑战热榜。

    各接口方法/参数不同(实测):
    - hot_search: GET 无参
    - hot_topic / rising_topic: POST + body(page/page_size/date_window)
    - hot_challenge: GET + page/page_size 必填
    """
    s = get_settings()
    out: dict[str, Any] = {}

    async def _safe(name: str, path: str, *, method: str = "GET",
                    params: dict | None = None, json_body: dict | None = None):
        try:
            data = await client.call(
                path, method=method, params=params, json_body=json_body,
                endpoint=f"board_{name}", user_id=user_id,
                cache_ttl=s.tikhub_cache_ttl_board,
            )
            out[name] = data.get("data")
        except TikHubError as e:
            logger.warning("热榜 %s 拉取失败: %s", name, e)
            out[name] = None

    _topic_body = {"page": 1, "page_size": 20, "date_window": 1}
    await _safe("hot_search", P_HOT_SEARCH)
    await _safe("hot_topic", P_HOT_TOPIC, method="POST", json_body=_topic_body)
    await _safe("rising_topic", P_HOT_RISING_TOPIC, method="POST", json_body=_topic_body)
    await _safe("hot_challenge", P_HOT_CHALLENGE, params={"page": 1, "page_size": 20})

    # 短剧热榜: 搜"短剧"按最多点赞, 取爆款(与业务强相关)
    series_videos = []
    try:
        sr = await search_videos("短剧", sort_type="1", user_id=user_id)
        series_videos = sr.get("videos") or []
    except TikHubError as e:
        logger.warning("短剧热榜拉取失败: %s", e)

    # 归一化: 各榜结构不同, 统一抽成 [{word, hot}] 便于前端直接渲染
    def _find_list(o, depth=0):
        if isinstance(o, list) and o and isinstance(o[0], dict):
            return o
        if isinstance(o, dict) and depth < 5:
            for vv in o.values():
                r = _find_list(vv, depth + 1)
                if r:
                    return r
        return None

    def _norm(raw):
        lst = _find_list(raw) or []
        items = []
        for it in lst[:20]:
            word = (it.get("word") or it.get("sentence") or it.get("challenge_name")
                    or it.get("label") or it.get("title") or it.get("hot_word") or "")
            hot = (it.get("hot_value") or it.get("hot_score") or it.get("score")
                   or it.get("play_cnt") or it.get("video_count"))
            if word:
                items.append({"word": word, "hot": hot})
        return items

    # 短剧热榜归一: 视频列表 → {word(标题), hot(点赞), aweme_id, cover}
    series = [{
        "word": (v.get("desc") or "")[:40],
        "hot": (v.get("statistics") or {}).get("digg_count"),
        "aweme_id": v.get("aweme_id"),
        "cover": v.get("cover"),
    } for v in series_videos if v.get("aweme_id")]

    return {
        "raw": out,
        "series": series,
        "hot_search": _norm(out.get("hot_search")),
        "hot_topic": _norm(out.get("hot_topic")),
        "rising_topic": _norm(out.get("rising_topic")),
        "hot_challenge": _norm(out.get("hot_challenge")),
    }
