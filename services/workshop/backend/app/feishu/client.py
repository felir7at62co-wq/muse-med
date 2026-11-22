"""飞书开放平台客户端。

职责:
- 用 App ID/Secret 换 tenant_access_token(内存缓存 + 过期前刷新)。
- 多维表格(Bitable): 列字段元信息、列记录、更新单条记录。
- 云文档(Drive): 按 file_token 下载附件字节。

所有密钥从 config(.env) 读, 不硬编码。飞书接口文档:
- token:   POST /open-apis/auth/v3/tenant_access_token/internal
- 字段:    GET  /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields
- 列记录:  GET  /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records?page_size=..&page_token=..
- 更新:    PUT  /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}
- 附件下载: GET /open-apis/drive/v1/medias/{file_token}/download
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Optional
from urllib.parse import urlparse, parse_qs

import httpx

from ..config import get_settings

logger = logging.getLogger(__name__)

# tenant_access_token 内存缓存: {app_id: (token, expire_epoch)}
_token_cache: dict[str, tuple[str, float]] = {}
# wiki 节点 token → bitable app_token 解析缓存(避免每次调 get_node)
_wiki_app_cache: dict[str, str] = {}


def parse_bitable_ref(text: str) -> tuple[str, Optional[str]]:
    """把用户输入解析成 (token, table_id)。

    支持三种输入:
    - 完整链接: .../wiki/<node>?table=<tbl>  或  .../base/<app>?table=<tbl>
    - 纯 token(wiki 节点 token 或 bitable app_token)
    返回的 token 可能是 wiki 节点 token(需再经 resolve_app_token 转换)或已是 app_token。
    table_id 从 URL 的 ?table= 取, 取不到返回 None(仍用配置里单独填的 table_id)。
    """
    text = (text or "").strip()
    if not text:
        return "", None
    if text.startswith("http://") or text.startswith("https://"):
        u = urlparse(text)
        table_id = (parse_qs(u.query).get("table") or [None])[0]
        # 路径形如 /wiki/<token> 或 /base/<token>，取最后一段非空
        seg = [p for p in u.path.split("/") if p]
        token = ""
        for i, p in enumerate(seg):
            if p in ("wiki", "base") and i + 1 < len(seg):
                token = seg[i + 1]
                break
        if not token and seg:
            token = seg[-1]
        return token, table_id
    return text, None


async def resolve_app_token(token: str) -> str:
    """把 token 解析成真正的 bitable app_token。

    - 若 token 是 wiki 节点(知识库里的多维表格), 调 wiki get_node 换出 obj_token。
    - 若 token 本身就是独立多维表格 app_token, get_node 会失败, 直接原样返回。
    结果缓存, 避免重复请求。
    """
    token = (token or "").strip()
    if not token:
        return token
    if token in _wiki_app_cache:
        return _wiki_app_cache[token]
    _, _, base = _cfg()
    url = f"{base}/open-apis/wiki/v2/spaces/get_node"
    try:
        tok = await get_tenant_access_token()
        async with httpx.AsyncClient(timeout=30) as cli:
            r = await cli.get(url, headers={"Authorization": f"Bearer {tok}"},
                              params={"token": token, "obj_type": "wiki"})
            j = r.json()
        node = ((j or {}).get("data") or {}).get("node") or {}
        obj_type = node.get("obj_type")
        obj_token = node.get("obj_token")
        if j.get("code") == 0 and obj_type == "bitable" and obj_token:
            _wiki_app_cache[token] = obj_token
            return obj_token
    except Exception as e:  # noqa: BLE001
        logger.warning("wiki get_node 解析失败, 按普通 app_token 处理 token=%s: %s", token, e)
    # 非 wiki 节点(或解析失败): 视为已是 app_token
    _wiki_app_cache[token] = token
    return token


def _cfg():
    s = get_settings()
    base = (s.feishu_base_url or "https://open.feishu.cn").rstrip("/")
    return s.feishu_app_id, s.feishu_app_secret, base


async def get_tenant_access_token(*, force: bool = False) -> str:
    """获取 tenant_access_token。缓存至过期前 5 分钟, 到期自动重取。"""
    app_id, app_secret, base = _cfg()
    if not app_id or not app_secret:
        raise RuntimeError("未配置 FEISHU_APP_ID / FEISHU_APP_SECRET")
    now = time.time()
    if not force:
        cached = _token_cache.get(app_id)
        if cached and cached[1] - 300 > now:  # 提前 5 分钟视为过期
            return cached[0]
    url = f"{base}/open-apis/auth/v3/tenant_access_token/internal"
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(url, json={"app_id": app_id, "app_secret": app_secret})
        r.raise_for_status()
        j = r.json()
    if j.get("code") != 0:
        raise RuntimeError(f"飞书取 token 失败 code={j.get('code')}: {j.get('msg')}")
    token = j["tenant_access_token"]
    expire = now + int(j.get("expire", 7200))
    _token_cache[app_id] = (token, expire)
    return token


async def _auth_headers() -> dict[str, str]:
    tok = await get_tenant_access_token()
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json; charset=utf-8"}


async def list_fields(app_token: str, table_id: str) -> list[dict[str, Any]]:
    """列出表的字段(含 field_name / field_id / type)。"""
    _, _, base = _cfg()
    url = f"{base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields"
    out: list[dict] = []
    page_token: Optional[str] = None
    async with httpx.AsyncClient(timeout=30) as cli:
        while True:
            params = {"page_size": 100}
            if page_token:
                params["page_token"] = page_token
            r = await cli.get(url, headers=await _auth_headers(), params=params)
            r.raise_for_status()
            j = r.json()
            if j.get("code") != 0:
                raise RuntimeError(f"飞书列字段失败 code={j.get('code')}: {j.get('msg')}")
            data = j.get("data") or {}
            out.extend(data.get("items") or [])
            if not data.get("has_more"):
                break
            page_token = data.get("page_token")
    return out


async def list_records(app_token: str, table_id: str) -> list[dict[str, Any]]:
    """拉取表的全部记录(自动翻页)。每条含 record_id + fields(字段名→值)。"""
    _, _, base = _cfg()
    url = f"{base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records"
    out: list[dict] = []
    page_token: Optional[str] = None
    async with httpx.AsyncClient(timeout=60) as cli:
        while True:
            params = {"page_size": 500}
            if page_token:
                params["page_token"] = page_token
            r = await cli.get(url, headers=await _auth_headers(), params=params)
            r.raise_for_status()
            j = r.json()
            if j.get("code") != 0:
                raise RuntimeError(f"飞书列记录失败 code={j.get('code')}: {j.get('msg')}")
            data = j.get("data") or {}
            out.extend(data.get("items") or [])
            if not data.get("has_more"):
                break
            page_token = data.get("page_token")
    return out


async def preview_table(
    url: str,
    text_field_name: str,
    title_field_name: str = None,
    limit: int = 10
) -> dict[str, Any]:
    """预览飞书表格数据。
    
    Args:
        url: 飞书表格URL
        text_field_name: 文本内容字段名
        title_field_name: 标题字段名(可选)
        limit: 预览前N条
    
    Returns:
        {
            "success": bool,
            "total": int,
            "empty_rows": int,
            "field_exists": {"text_field": bool, "title_field": bool},
            "preview": [{"title": str, "text_preview": str, "text_length": int}, ...],
            "error": str (if failed)
        }
    """
    try:
        # 1. 解析URL获取app_token和table_id
        token, table_id = parse_bitable_ref(url)
        if not token:
            return {"success": False, "error": "无效的飞书表格URL"}
        
        # 2. 解析app_token(支持wiki节点转换)
        app_token = await resolve_app_token(token)
        
        # 3. 如果URL中没有table_id,需要用户在URL query中提供
        if not table_id:
            return {"success": False, "error": "URL中未包含table参数,无法确定表格ID"}
        
        # 4. 获取字段列表,验证字段是否存在
        fields_list = await list_fields(app_token, table_id)
        field_names = {f.get("field_name") for f in fields_list}
        
        text_exists = text_field_name in field_names
        title_exists = (title_field_name in field_names) if title_field_name else True
        
        if not text_exists:
            return {
                "success": False,
                "error": f"字段 '{text_field_name}' 不存在",
                "field_exists": {"text_field": False, "title_field": title_exists}
            }
        
        # 5. 获取记录
        records = await list_records(app_token, table_id)
        total = len(records)
        
        # 6. 统计空行和生成预览
        preview = []
        empty_count = 0
        
        for i, record in enumerate(records[:limit * 2]):  # 多取一些以防空行
            if len(preview) >= limit:
                break
                
            fields_data = record.get("fields", {})
            text_value = fields_data.get(text_field_name, "")
            
            # 处理各种格式的文本字段
            if isinstance(text_value, list):
                text_value = " ".join(str(v.get("text", v)) if isinstance(v, dict) else str(v) for v in text_value)
            elif isinstance(text_value, dict):
                text_value = text_value.get("text", str(text_value))
            else:
                text_value = str(text_value) if text_value else ""
            
            text_value = text_value.strip()
            
            if not text_value:
                empty_count += 1
                continue
            
            # 获取标题
            title_value = ""
            if title_field_name:
                title_val = fields_data.get(title_field_name, "")
                if isinstance(title_val, list):
                    title_value = " ".join(str(v.get("text", v)) if isinstance(v, dict) else str(v) for v in title_val)
                elif isinstance(title_val, dict):
                    title_value = title_val.get("text", str(title_val))
                else:
                    title_value = str(title_val) if title_val else ""
                title_value = title_value.strip()
            
            preview.append({
                "row_id": record.get("record_id", ""),
                "title": title_value or f"条目 {i + 1}",
                "text_preview": text_value[:100] + ("..." if len(text_value) > 100 else ""),
                "text_length": len(text_value),
                "has_content": True
            })
        
        return {
            "success": True,
            "total": total,
            "empty_rows": empty_count,
            "field_exists": {
                "text_field": text_exists,
                "title_field": title_exists
            },
            "preview": preview
        }
        
    except Exception as e:
        logger.exception("预览飞书表格失败")
        return {
            "success": False,
            "error": f"预览失败: {str(e)}"
        }


async def update_record(app_token: str, table_id: str, record_id: str,
                        fields: dict[str, Any]) -> None:
    """局部更新单条记录的指定字段(不动其它列)。fields: {字段名: 值}。"""
    _, _, base = _cfg()
    url = f"{base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}"
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.put(url, headers=await _auth_headers(), json={"fields": fields})
        r.raise_for_status()
        j = r.json()
    if j.get("code") != 0:
        raise RuntimeError(f"飞书更新记录失败 code={j.get('code')}: {j.get('msg')}")


async def create_record(app_token: str, table_id: str, fields: dict[str, Any]) -> str:
    """新增单条记录。fields: {字段名: 值}。返回 record_id。"""
    _, _, base = _cfg()
    url = f"{base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records"
    async with httpx.AsyncClient(timeout=60) as cli:
        r = await cli.post(url, headers=await _auth_headers(), json={"fields": fields})
        r.raise_for_status()
        j = r.json()
    if j.get("code") != 0:
        raise RuntimeError(f"飞书新增记录失败 code={j.get('code')}: {j.get('msg')}")
    return (((j.get("data") or {}).get("record") or {}).get("record_id")) or ""


async def upload_media(app_token: str, filename: str, content: bytes) -> str:
    """上传文件到多维表格(drive medias upload_all, parent_type=bitable),返回 file_token。

    上传后的 file_token 可作为附件字段的值写入记录:
    fields = {"剧本": [{"file_token": "..."}]}

    ⚠ 飞书Drive上传接口有严格频控(实测批量并发即触发400)。
    非200响应会把飞书返回体带进异常信息, 便于定位是频控还是参数错误。
    """
    _, _, base = _cfg()
    tok = await get_tenant_access_token()
    url = f"{base}/open-apis/drive/v1/medias/upload_all"
    data = {
        "file_name": filename,
        "parent_type": "bitable_file",
        "parent_node": app_token,
        "size": str(len(content)),
    }
    files = {"file": (filename, content, "application/octet-stream")}
    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.post(url, headers={"Authorization": f"Bearer {tok}"}, data=data, files=files)
        if r.status_code != 200:
            raise RuntimeError(f"飞书上传附件HTTP{r.status_code}: {r.text[:300]}")
        j = r.json()
    if j.get("code") != 0:
        raise RuntimeError(f"飞书上传附件失败 code={j.get('code')}: {j.get('msg')}")
    return ((j.get("data") or {}).get("file_token")) or ""


async def download_media(file_token: str, *, table_id: Optional[str] = None,
                         url: Optional[str] = None) -> bytes:
    """下载附件/云文档字节(Drive media download)。

    多维表格里的附件受表级权限保护, 直连 medias/{token}/download 会 400,
    必须带 extra={"bitablePerm":{"tableId":...}} 参数。优先级:
    1. 附件对象自带的 url(已含正确 extra) — 最稳;
    2. 用 file_token + table_id 自行拼 extra;
    3. 裸 file_token(非 bitable 附件, 如普通云盘文件)。
    """
    _, _, base = _cfg()
    tok = await get_tenant_access_token()
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as cli:
        # 1) 附件自带 url(含 extra) 最可靠
        if url:
            r = await cli.get(url, headers={"Authorization": f"Bearer {tok}"})
            if r.status_code == 200:
                return r.content
            logger.warning("附件自带 url 下载失败(%s), 回退拼 extra", r.status_code)
        # 2) file_token + bitable extra
        params = {}
        if table_id:
            import json as _json
            params["extra"] = _json.dumps({"bitablePerm": {"tableId": table_id}}, separators=(",", ":"))
        u = f"{base}/open-apis/drive/v1/medias/{file_token}/download"
        r = await cli.get(u, headers={"Authorization": f"Bearer {tok}"}, params=params or None)
        r.raise_for_status()
        return r.content


# ---------------------------------------------------------------------------
# 发消息(IM): 给单个用户发一条文本私信
#
# 与多维表格那套的区别: 这里代表**应用**给某个人发消息, 收件人是人的 union_id,
# 不是表格。需要的权限是 `im:message:send_as_bot`(给用户发单聊)。
#
# ⚠️ 2026-10-26 实测过权限是通的: 用故意不存在的 union_id 调, 返回
#    code=99992364 "not a valid {union_id}" —— 说明请求已经走到"校验收件人"
#    这一步, 不是权限被拒(权限类错误是 99991672/99991679 那一类)。
#
# ⚠️ 收件人必须传 **union_id**, 不是 open_id: union_id 在同一开发者下的多个应用
#    之间一致, 而 open_id 是"应用内唯一" —— 换过应用(或以后多应用)就全失效。
#    users 表里有 feishu_union_id, 就用它。
# ---------------------------------------------------------------------------

#: 飞书"收件人无效/不存在"的错误码 —— 这是**收件人**的问题, 不是凭据/网络问题,
#: 群发时应当逐个记下来而不是让整批发失败。
FEISHU_INVALID_RECIPIENT_CODES = frozenset({99992364, 230001, 230002, 230013})


class FeishuSendError(RuntimeError):
    """发消息失败。

    三个属性决定群发时怎么记账，别混：
      - `code`         飞书业务码（请求根本没发出去时为 None）
      - `invalid_recipient` 收件人本身发不到（没绑飞书 / union_id 无效）→ skipped
      - `retryable`    换个时机重发有没有意义（网络/限流 → True；内容为空 → False）
    """

    def __init__(self, msg: str, *, code: int | None = None,
                 retryable: bool = True, invalid_recipient: bool = False):
        super().__init__(msg)
        self.code = code
        self.retryable = retryable
        self.invalid_recipient = invalid_recipient


async def send_text(*, union_id: str, text: str, timeout: float = 15.0) -> dict:
    """给一个人发一条纯文本私信，返回飞书的 data（含 message_id）。

    失败抛 `FeishuSendError`；**收件人无效**也算失败，但带上 `invalid_recipient`，
    调用方据此决定是"这个人收不到"还是"这一批都别发了"。
    """
    import json as _json

    union_id = (union_id or "").strip()
    if not union_id:
        raise FeishuSendError("收件人没有飞书身份(union_id 为空)",
                              retryable=False, invalid_recipient=True)
    text = text or ""
    if not text.strip():
        # ⚠️ 这是**内容**问题不是收件人问题：绝不能标成 invalid_recipient，
        # 否则一次空内容群发会被整批记成"这些人收不到"，看起来像名单坏了。
        raise FeishuSendError("消息内容为空", retryable=False)

    _, _, base = _cfg()
    url = f"{base}/open-apis/im/v1/messages"
    body = {"receive_id": union_id, "msg_type": "text",
            "content": _json.dumps({"text": text}, ensure_ascii=False)}
    async with httpx.AsyncClient(timeout=timeout) as cli:
        r = await cli.post(url, headers=await _auth_headers(),
                           params={"receive_id_type": "union_id"}, json=body)
    try:
        j = r.json()
    except Exception:  # noqa: BLE001  非 JSON 响应(网关页/限流页)
        raise FeishuSendError(f"飞书返回非 JSON(HTTP {r.status_code})", retryable=True)

    code = j.get("code")
    if code != 0:
        msg = str(j.get("msg") or "")[:200]
        # 收件人无效 = 这个人发不到，重试没有意义
        invalid = code in FEISHU_INVALID_RECIPIENT_CODES
        raise FeishuSendError(f"飞书发消息失败 code={code}: {msg}",
                              code=code, retryable=not invalid,
                              invalid_recipient=invalid)
    return j.get("data") or {}


def is_invalid_recipient(exc: BaseException) -> bool:
    """这个失败是"收件人本身发不到"（没有飞书身份 / union_id 无效），而不是暂态故障。

    ⚠️ 只认显式的 `invalid_recipient` 标记。"内容为空"同样是 retryable=False，
    但它不是收件人的问题 —— 以前用 `not retryable` 推，会把内容错误算成名单坏了。
    """
    if isinstance(exc, FeishuSendError):
        return bool(exc.invalid_recipient) or exc.code in FEISHU_INVALID_RECIPIENT_CODES
    return False



def extract_attachments(cell_value: Any) -> list[dict[str, Any]]:
    """从"附件"类型单元格值里提取 [{file_token, name}]。
    飞书附件字段值是 list[{file_token, name, type, size, url, tmp_url}]。
    """
    if not cell_value:
        return []
    if isinstance(cell_value, list):
        out = []
        for it in cell_value:
            if isinstance(it, dict) and it.get("file_token"):
                out.append({
                    "file_token": it["file_token"],
                    "name": it.get("name") or "",
                    "url": it.get("url") or "",  # bitable 附件自带含 extra 的下载 url
                })
        return out
    return []


def cell_text(cell_value: Any) -> str:
    """把飞书单元格值统一转成纯文本(文本字段可能是 str 或 [{text,type}] 富文本段)。"""
    if cell_value is None:
        return ""
    if isinstance(cell_value, str):
        return cell_value.strip()
    if isinstance(cell_value, (int, float)):
        return str(cell_value)
    if isinstance(cell_value, list):
        parts = []
        for seg in cell_value:
            if isinstance(seg, dict):
                parts.append(seg.get("text") or seg.get("name") or "")
            elif isinstance(seg, str):
                parts.append(seg)
        return "".join(parts).strip()
    if isinstance(cell_value, dict):
        return (cell_value.get("text") or cell_value.get("name") or "").strip()
    return str(cell_value).strip()