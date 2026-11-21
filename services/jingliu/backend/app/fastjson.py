"""把响应体按 UTF-8 原样编码，而不是 `\\uXXXX` 转义（3.12 / F8）。

FastAPI 的默认 `JSONResponse` 走 `json.dumps(..., ensure_ascii=True)`，
于是每个汉字变成 6 个 ASCII 字节。对别的接口这无所谓，对**项目详情**是灾难：
1424 镜的项目里 `script_ref`（中文剧本片段）、场景名、`profile_override`
全是中文，实测响应 **1200.7 KiB**，而原文只有 163 KiB —— 六分之五的流量
是转义符。

`ensure_ascii=False` + `utf-8` 编码直接消掉这一层，内容一字不改（同一个
JSON 值，合法的 UTF-8 字节流），前端 `response.json()` 照常解析。

这里刻意**不引 orjson**：那要多装一个包、要过一遍依赖与部署流程，而本模块
只有几行。真到了 JSON 编码本身是瓶颈的时候再换不迟——现在的瓶颈是字节数。

用法（只给真正大的接口用，别全站套上）：

    from .fastjson import json_bytes
    @router.get("/...")
    def handler():
        ...
        return json_bytes(payload)
"""

import json
from typing import Any

from starlette.responses import Response


def json_bytes(payload: Any, status_code: int = 200) -> Response:
    """`payload` → UTF-8 JSON 响应。

    `allow_nan=False`：标准 JSON 里没有 NaN/Infinity，Python 默认会写出
    裸的 `NaN`（非法 JSON，`JSON.parse` 直接抛）。这个项目的时长/秒数是从
    float 列来的，理论上可能出现 inf；让它响亮地失败，而不是把一个前端
    解析不了的响应发出去。
    """
    body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return Response(content=body, status_code=status_code, media_type="application/json")


def _etag_of(body: bytes) -> str:
    """内容摘要 → 强 ETag（带引号，符合 RFC 7232 的 entity-tag 语法）。"""
    import hashlib
    return '"' + hashlib.sha1(body).hexdigest()[:32] + '"'


def _none_match_ok(header: str | None, etag: str) -> bool:
    """`If-None-Match` 是否命中（支持 `*`、逗号分隔列表、弱校验前缀）。"""
    if not header:
        return False
    for raw in header.split(","):
        candidate = raw.strip()
        if candidate == "*":
            return True
        # 弱比较：`W/"abc"` 与 `"abc"` 视为等价
        if candidate.startswith("W/"):
            candidate = candidate[2:]
        if candidate == etag:
            return True
    return False


def json_bytes_cached(payload: Any, request: Any, *, cache_control: str | None = None) -> Response:
    """带 ETag 协商的 `json_bytes`：内容没变就回 304，客户端不必再收一遍正文。

    ## 为什么需要（2026-10-19 流量复盘）

    今日 `/v2/projects/*/detail` 被请求 3,137 次、下发 **4.0 GB**，平均每次
    **1.3 MB**（最大 5.85 MB）。而前端每个离散编辑（裁剪/移轨/分割）改前都要
    重下整份详情 —— 大量请求拿到的内容与上一次**完全相同**。

    实测媒体侧对比：`/fwp/media` 200 有 8,393 次、304 仅 1,485 次，说明这个
    链路此前**完全没有协商缓存**。详情接口同理。

    这里用**内容哈希**做 ETag 而不是「项目 updated_at」：
      · 详情聚合了 shots / assets / 版本计数 / 场景归一表，任何一张表变了
        内容就变，而 `projects` 上没有一列能覆盖全部（没有 updated_at 列）；
      · 内容哈希**永远不会漏**——宁可算一次 sha1（1.3MB 约 3ms），
        也不要出现"数据变了但 304 说没变"这种静默错误。
      · 代价是响应体仍要在服务端生成一次。这省的是**网络传输**（4GB/天 的大头），
        不是 CPU；真要省 CPU 得先引入增量版本号，那是另一件事。

    ⚠️ 调用方必须传 FastAPI 的 `Request`（不是 `Response`），否则拿不到
    `If-None-Match`。
    """
    body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    etag = _etag_of(body)
    headers: dict[str, str] = {"ETag": etag}
    if cache_control:
        headers["Cache-Control"] = cache_control

    if _none_match_ok(getattr(request, "headers", {}).get("if-none-match"), etag):
        # 304 按规范**不能带正文**；保留 ETag 便于下一次继续命中。
        return Response(status_code=304, headers=headers)

    return Response(content=body, status_code=200,
                    media_type="application/json", headers=headers)
