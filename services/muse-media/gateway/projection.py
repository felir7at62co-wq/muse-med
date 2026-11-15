"""Bounded public-data projection for DTK 5.1.10 MCP responses.

Only documented public content, pagination and metrics leave
the company gateway. Download ownership and upstream task identifiers belong
to the gateway ledger and are deliberately absent here.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

_TOOLS = frozenset({
    "parse_url", "get_video", "get_user", "list_user_posts", "list_comments",
    "get_content_history", "download_media", "get_task_result",
})
_PLATFORMS = frozenset({"douyin", "tiktok", "bilibili"})
_PUBLIC_DOMAINS = ("douyin.com", "tiktok.com", "bilibili.com", "b23.tv")
_URL = re.compile(r"https?://[^\s<>\"\']+", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ID = re.compile(r"[A-Za-z0-9_@.:-]{1,256}\Z")
_DATE = re.compile(r"[0-9TtZz:+. -]{1,64}\Z")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._() -]{0,127}\Z")
_HASH = re.compile(r"[a-fA-F0-9]{64}\Z")
_MAX_TEXT = 8192
_MAX_ITEMS = 200
_MAX_POINTS = 500
_MAX_DEPTH = 7
# DTK's per-post file protocol ceiling, also used to disclose incomplete manifests.
MAX_MANIFEST_FILES = 128
_METRICS = frozenset({
    "play_count", "digg_count", "comment_count", "share_count", "collect_count",
    "follower_count", "following_count", "content_count", "total_digg",
    "reply_count", "item_count", "view_count", "hot_value", "viewer_count",
    "like_count", "rank", "duration_ms", "width", "height", "part",
})
_IDS = frozenset({
    "content_id", "uid", "sec_uid", "unique_id", "comment_id", "parent_id",
    "music_id", "collection_id", "mix_id", "hashtag_id", "room_id", "live_id",
    "owner_id", "author_uid", "cid",
})
_TEXT = frozenset({
    "title", "description", "nickname", "signature", "text", "name", "word",
    "owner_name", "location",
})
_DATES = frozenset({
    "created_at", "updated_at", "fetched_at", "started_at", "finished_at", "ts",
})
_BOOLS = frozenset({
    "is_deleted", "is_private", "verified", "is_author_liked", "is_pinned",
    "is_public", "is_original", "is_live", "has_more", "truncated",
})
_KINDS = frozenset({"video", "image_album", "image", "cover", "live_video", "metadata"})


def public_url(value: object) -> str | None:
    """Return a platform HTTPS page without credentials, query or fragment.

    CDN URLs, alternate ports and malformed public links are omitted. The
    result is a reference page, never a media download authorization.
    """
    if not isinstance(value, str) or len(value) > 4096 or _CONTROL.search(value):
        return None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or url.username or url.password
                or url.port not in (None, 443)
                or not any(host == domain or host.endswith("." + domain) for domain in _PUBLIC_DOMAINS)):
            return None
        return urlunsplit(("https", host, url.path or "/", "", ""))
    except ValueError:
        return None


class _Projection:
    def __init__(self) -> None:
        self.truncated = False

    def text(self, value: str) -> str:
        if len(value) > _MAX_TEXT:
            self.truncated = True
        clean = _CONTROL.sub("", value[:_MAX_TEXT])
        return _URL.sub(lambda match: public_url(match.group()) or "[link omitted]", clean)

    def list(self, value: list, *, depth: int, limit: int = _MAX_ITEMS) -> list:
        if len(value) > limit:
            self.truncated = True
        return [self.entity(item, depth + 1) for item in value[:limit] if isinstance(item, dict)]

    def entity(self, value: object, depth: int = 0) -> dict:
        if not isinstance(value, dict):
            return {}
        if depth > _MAX_DEPTH:
            self.truncated = True
            return {}
        result = {}
        for key, item in value.items():
            if key in _IDS:
                if item is None or isinstance(item, str) and _ID.fullmatch(item):
                    result[key] = item
            elif key == "platform":
                if isinstance(item, str) and item in _PLATFORMS:
                    result[key] = item
            elif key == "web_url":
                if item is None:
                    result[key] = None
                elif (url := public_url(item)) is not None:
                    result[key] = url
            elif key in _TEXT:
                if item is None or isinstance(item, str):
                    result[key] = self.text(item) if isinstance(item, str) else None
            elif key in _METRICS:
                if item is None or type(item) is int and 0 <= item <= 2**63 - 1:
                    result[key] = item
            elif key in _DATES:
                if item is None or isinstance(item, str) and _DATE.fullmatch(item):
                    result[key] = item
            elif key in _BOOLS:
                if item is None or isinstance(item, bool):
                    result[key] = item
            elif key == "kind":
                if isinstance(item, str) and item in _KINDS:
                    result[key] = item
            elif key in ("author", "owner", "music", "stats"):
                if item is None:
                    result[key] = None
                elif isinstance(item, dict):
                    result[key] = self.entity(item, depth + 1)
            elif key in ("items", "parts", "comments", "replies") and isinstance(item, list):
                result[key] = self.list(item, depth=depth)
            elif key == "tags" and isinstance(item, list):
                if len(item) > _MAX_ITEMS:
                    self.truncated = True
                result[key] = [self.text(tag) for tag in item[:_MAX_ITEMS] if isinstance(tag, str)]
            elif key == "cursor":
                if item is None or isinstance(item, str) and len(item) <= 4096 and not _CONTROL.search(item):
                    result[key] = item
                else:
                    self.truncated = True
        return result

def safe_result(tool: str, value: object) -> dict:
    """Project one successful DTK tool value into bounded public JSON fields.

    Unknown tools and non-object results are refused. Upstream free-form
    messages and errors are never forwarded; callers own fixed diagnostics.
    Truncation is explicit and missing reported metrics remain null.
    """
    if tool not in _TOOLS or not isinstance(value, dict):
        raise ValueError("Unsupported media result")
    project = _Projection()
    result = project.entity(value)
    if value.get("status") in ("ok", "pending"):
        result["status"] = value["status"]
    for key in ("cached", "guest_fallback", "truncated"):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    if isinstance(value.get("resource"), str) and re.fullmatch(r"[a-z_]{1,64}", value["resource"]):
        result["resource"] = value["resource"]
    if (url := public_url(value.get("url"))) is not None:
        result["url"] = url
    if isinstance(value.get("data"), dict):
        result["data"] = project.entity(value["data"])
    elif isinstance(value.get("data"), list):
        result["data"] = project.list(value["data"], depth=0)
    if tool == "get_content_history":
        since = value.get("since")
        if isinstance(since, str) and _DATE.fullmatch(since):
            result["since"] = since
        if type(value.get("point_count")) is int and value["point_count"] >= 0:
            result["point_count"] = value["point_count"]
        if isinstance(value.get("points"), list):
            result["points"] = project.list(value["points"], depth=0, limit=_MAX_POINTS)
    if tool in ("download_media", "get_task_result"):
        record = value.get("data")
        if isinstance(record, dict) and record.get("state") in ("queued", "running", "done", "partial", "failed", "cancelled"):
            result.setdefault("data", {})["state"] = record["state"]
            result["data"]["files"] = safe_files(record)
    if project.truncated:
        result["projection_truncated"] = True
    return result


def safe_files(value: object) -> list[dict]:
    """Return complete, hash-verified manifest entries using stored names.

    The DTK record uses files[].bytes and files[].sha256. Failed/incomplete
    entries, duplicate names, unsafe names and absent hashes are omitted;
    export_name and directory never authorize a file fetch.
    """
    rows = value.get("files") if isinstance(value, dict) else value
    if not isinstance(rows, list):
        return []
    result, names = [], set()
    for row in rows[:MAX_MANIFEST_FILES]:
        if not isinstance(row, dict):
            continue
        name, size, hash_value, kind = (row.get(key) for key in ("name", "bytes", "sha256", "kind"))
        if (row.get("state") != "done" or not isinstance(name, str) or not _NAME.fullmatch(name)
                or ".." in name or name in names or type(size) is not int or size <= 0
                or not isinstance(hash_value, str) or not _HASH.fullmatch(hash_value)
                or not isinstance(kind, str) or kind not in _KINDS):
            continue
        names.add(name)
        result.append({"name": name, "bytes": size, "sha256": hash_value.lower(), "kind": kind})
    return result
