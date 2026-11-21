"""飞书开放平台的最小客户端（应用身份 tenant_access_token），供审批同步用。

⚠️ 与剧变时代扫码登录、小说转视频多维表格是**同一个飞书应用**。登录换 code 用的是
`app_access_token`，这里走的是 `tenant_access_token`，两者不能混用
（drama auth/feishu_oauth.py 有同款告警）。

只放"怎么调飞书"，不放任何业务判断——业务在 approval_sync.py。这样以后换成
事件推送、或加方案 C 的"创建审批实例"，都只是在这里多一个函数。
"""
from __future__ import annotations

import json
import logging
import re
import time

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

#: 飞书"缺权限"的错误码。出现它说明开放平台后台少开了权限或新版本还没发布
_NO_SCOPE = {99991672, 99991679}
_TOKEN: dict = {"value": "", "exp": 0.0}


class FeishuError(RuntimeError):
    def __init__(self, code: int, msg: str, api: str = ""):
        self.code, self.msg, self.api = code, msg, api
        super().__init__(f"[{code}] {msg}")

    def user_text(self) -> str:
        if self.code in _NO_SCOPE:
            what = "审批" if "approval" in self.api else "相关"
            return (f"飞书应用缺少{what}权限（或新开的权限还没发布生效）。"
                    f"接口 {self.api} 返回：{self.msg[:200]}")
        if self.code == -1:
            return self.msg
        return f"飞书接口出错（{self.code}）：{self.msg[:200]}"


def configured() -> bool:
    s = get_settings()
    return bool(s.feishu_app_id and s.feishu_app_secret)


def _base() -> str:
    return (get_settings().feishu_base_url or "https://open.feishu.cn").rstrip("/")


def _tenant_token(client: httpx.Client) -> str:
    """缓存到过期前 5 分钟。进程内缓存即可：只有一个后端进程。"""
    if _TOKEN["value"] and time.time() < _TOKEN["exp"] - 300:
        return _TOKEN["value"]
    s = get_settings()
    if not configured():
        raise FeishuError(-1, "后端没有配置飞书应用（FW_FEISHU_APP_ID / FW_FEISHU_APP_SECRET）")
    r = client.post(f"{_base()}/open-apis/auth/v3/tenant_access_token/internal",
                    json={"app_id": s.feishu_app_id, "app_secret": s.feishu_app_secret})
    d = r.json()
    if d.get("code") != 0:
        raise FeishuError(int(d.get("code") or -1), d.get("msg") or "取 token 失败", "tenant_access_token")
    _TOKEN["value"] = d["tenant_access_token"]
    _TOKEN["exp"] = time.time() + int(d.get("expire") or 3600)
    return _TOKEN["value"]


def call(method: str, path: str, *, params: dict | None = None,
         body: dict | None = None, timeout: float = 20.0) -> dict:
    """调一个开放平台接口，返回 `data`。`code != 0` 抛 FeishuError。

    token 失效（99991663/99991661）时刷新一次重试——缓存的 token 可能被提前作废。
    """
    with httpx.Client(timeout=timeout) as client:
        for attempt in (0, 1):
            tok = _tenant_token(client)
            r = client.request(method, f"{_base()}{path}", params=params, json=body,
                               headers={"Authorization": f"Bearer {tok}"})
            try:
                d = r.json()
            except ValueError:
                raise FeishuError(-1, f"飞书返回非 JSON（HTTP {r.status_code}）", path)
            code = int(d.get("code") or 0)
            if code in (99991663, 99991661) and attempt == 0:
                _TOKEN["value"] = ""
                continue
            if code != 0:
                raise FeishuError(code, d.get("msg") or "", path)
            return d.get("data") or {}
    raise FeishuError(-1, "token 刷新后仍无效", path)


def download_image(message_id: str, image_key: str, max_bytes: int = 10 * 1024 * 1024) -> bytes:
    """下载用户发给机器人的图片。成功时返回的是图片本身，失败时才是 JSON。"""
    with httpx.Client(timeout=30.0) as client:
        r = client.get(f"{_base()}/open-apis/im/v1/messages/{message_id}/resources/{image_key}",
                       params={"type": "image"}, headers={"Authorization": f"Bearer {_tenant_token(client)}"})
    if "application/json" in r.headers.get("content-type", ""):
        d = r.json()
        raise FeishuError(int(d.get("code") or -1), d.get("msg") or "下载图片失败", "im/v1/messages/resources")
    if r.status_code != 200:
        raise FeishuError(-1, f"下载图片失败（HTTP {r.status_code}）", "im/v1/messages/resources")
    if len(r.content) > max_bytes:
        raise FeishuError(-1, "图片太大（上限 10 MB）", "im/v1/messages/resources")
    return r.content


# ---------------------------------------------------------------------------
# 审批（approval v4）
# ---------------------------------------------------------------------------

def get_definition(approval_code: str) -> dict:
    """审批定义：名字 + 表单控件列表（id / name / type）。配置模板时用来选金额字段。"""
    d = call("GET", f"/open-apis/approval/v4/approvals/{approval_code}",
             params={"locale": "zh-CN"})
    try:
        widgets = json.loads(d.get("form") or "[]")
    except ValueError:
        widgets = []
    return {"name": d.get("approval_name") or "", "widgets": widgets}


def list_instance_codes(approval_code: str, start_ms: int, end_ms: int) -> list[str]:
    """该模板在 [start, end) 内**发起**的全部审批单号（只是号，不含详情）。

    一页 100 个；按 30 天切片，避免单次时间窗过大被接口拒绝。
    """
    out: list[str] = []
    step = 30 * 86400 * 1000
    t = start_ms
    while t < end_ms:
        hi = min(end_ms, t + step)
        token = ""
        while True:
            p = {"approval_code": approval_code, "start_time": str(t),
                 "end_time": str(hi), "page_size": 100}
            if token:
                p["page_token"] = token
            d = call("GET", "/open-apis/approval/v4/instances", params=p)
            out.extend(d.get("instance_code_list") or [])
            if not d.get("has_more"):
                break
            token = d.get("page_token") or ""
            if not token:
                break
        t = hi
    return list(dict.fromkeys(out))


def resolve_users(tenant_user_ids: list[str]) -> dict[str, str]:
    """把审批接口返回的 `user_id`（**租户内 user_id**）换成 union_id。2026-10-15 加。

    ⚠️ 实测：审批接口的 `user_id` 字段就是租户 user_id（如 `316462eg`），即便显式传
    `user_id_type=union_id` 也不变；而本服务认人用的是 union_id（扫码登录存下来的）。
    两者只能靠通讯录接口换算。不换算的后果不是报错，是**所有审批单都"对不上账号"
    而全部转人工**——看起来像权限问题，其实是 ID 空间不同。

    一次最多 50 个。返回 {user_id: union_id}，查不到的就不在结果里。
    """
    out: dict[str, str] = {}
    ids = [str(i) for i in tenant_user_ids if i]
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        d = call("GET", "/open-apis/contact/v3/users/batch",
                 params={"user_ids": chunk, "user_id_type": "user_id"})
        for it in d.get("items") or []:
            uid_, union = str(it.get("user_id") or ""), str(it.get("union_id") or "")
            if uid_ and union:
                out[uid_] = union
    return out


def get_instance(instance_code: str) -> dict:
    """单张审批详情。人一律按 union_id 返回（与剧变时代 users.feishu_union_id 同值）。"""
    return call("GET", f"/open-apis/approval/v4/instances/{instance_code}",
                params={"user_id_type": "union_id", "locale": "zh-CN"})


# ---------------------------------------------------------------------------
# 云文档（docx v1）：替用户建一份文档，建好转给本人。2026-10-31 加。
# ---------------------------------------------------------------------------

#: 一次插入的块数上限（飞书 descendant 接口限 1000）
_DOC_INSERT_MAX = 1000
#: 单次 markdown 转换的字数（按空行切段，超长再硬切）
_DOC_CONVERT_CHARS = 20000
#: 转换结果里写不进去的块：图片要另走素材上传，外链图片转出来是空壳，插入会整批失败
_DOC_SKIP_BLOCKS = {27}


def open_id_of(union_id: str) -> str:
    """union_id → 本应用下的 open_id。转移所有者只收 open_id/user_id/email，不收 union_id。"""
    d = call("GET", f"/open-apis/contact/v3/users/{union_id}", params={"user_id_type": "union_id"})
    oid = str(((d.get("user") or {}).get("open_id")) or "")
    if not oid:
        raise FeishuError(-1, "通讯录里查不到这个人（应用的通讯录权限范围可能没包含他）", "contact/v3/users")
    return oid


def _md_chunks(markdown: str) -> list[str]:
    out, cur = [], ""
    for para in markdown.split("\n\n"):
        while len(para) > _DOC_CONVERT_CHARS:
            if cur:
                out.append(cur)
                cur = ""
            out.append(para[:_DOC_CONVERT_CHARS])
            para = para[_DOC_CONVERT_CHARS:]
        if cur and len(cur) + len(para) + 2 > _DOC_CONVERT_CHARS:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur.strip():
        out.append(cur)
    return out


def _clean_blocks(blocks: list[dict], roots: list[str]) -> tuple[list[dict], list[str], int]:
    """去掉写不进去的块（连同它的子块），以及表格里转换接口自带、插入接口却拒收的 merge_info。"""
    by_id = {b.get("block_id"): b for b in blocks}
    drop: set[str] = set()

    def mark(bid: str) -> None:
        drop.add(bid)
        for c in (by_id.get(bid) or {}).get("children") or []:
            mark(c)

    for b in blocks:
        if b.get("block_type") in _DOC_SKIP_BLOCKS:
            mark(b.get("block_id"))
    kept = []
    for b in blocks:
        if b.get("block_id") in drop:
            continue
        if b.get("children"):
            b["children"] = [c for c in b["children"] if c not in drop]
        if b.get("block_type") == 31:
            ((b.get("table") or {}).get("property") or {}).pop("merge_info", None)
        kept.append(b)
    return kept, [r for r in roots if r not in drop], sum(1 for b in blocks if b.get("block_type") in _DOC_SKIP_BLOCKS)


def _subtree_size(bid: str, by_id: dict) -> int:
    return 1 + sum(_subtree_size(c, by_id) for c in (by_id.get(bid) or {}).get("children") or [])


def _insert_markdown(did: str, markdown: str, index: int) -> int:
    """把 markdown 从第 `index` 个顶层位置起写进文档，返回跳过的图片数。"""
    skipped = 0
    for chunk in _md_chunks(markdown):
        conv = call("POST", "/open-apis/docx/v1/documents/blocks/convert",
                    body={"content_type": "markdown", "content": chunk})
        blocks, roots, n = _clean_blocks(conv.get("blocks") or [], conv.get("first_level_block_ids") or [])
        skipped += n
        by_id = {b["block_id"]: b for b in blocks}
        # 按顶层块分批：每批连同子孙不超过 1000 块（单个顶层块本身超限的，飞书也写不进，照样报错）
        batch, size = [], 0
        for r in roots + [None]:
            k = _subtree_size(r, by_id) if r else 0
            if batch and (r is None or size + k > _DOC_INSERT_MAX):
                ids: set[str] = set()
                stack = list(batch)
                while stack:
                    x = stack.pop()
                    ids.add(x)
                    stack.extend((by_id.get(x) or {}).get("children") or [])
                call("POST", f"/open-apis/docx/v1/documents/{did}/blocks/{did}/descendant",
                     params={"document_revision_id": -1},
                     body={"children_id": batch, "index": index,
                           "descendants": [b for b in blocks if b["block_id"] in ids]})
                index += len(batch)
                batch, size = [], 0
            if r:
                batch.append(r)
                size += k
    return skipped


def create_doc(title: str, markdown: str, owner_union_id: str) -> dict:
    """建一份飞书云文档，正文按 markdown 写入，再把所有者转给 `owner_union_id` 这个人。

    返回 {document_id, url, skipped_images}。顺序是先查人再建文档：查不到人就什么都不建，
    不会在应用名下留下一份谁也打不开的文档。转移失败时把刚建的文档删掉再抛错，理由同上。
    """
    owner = open_id_of(owner_union_id)
    did = call("POST", "/open-apis/docx/v1/documents", body={"title": title})["document"]["document_id"]
    try:
        skipped = _insert_markdown(did, markdown, 0)
        # 所有者转给用户、应用保留可管理权限：之后才能替用户继续读和改这份文档。
        url = ""
        try:
            metas = call("POST", "/open-apis/drive/v1/metas/batch_query",
                         body={"request_docs": [{"doc_token": did, "doc_type": "docx"}], "with_url": True})
            url = str(((metas.get("metas") or [{}])[0]).get("url") or "")
        except FeishuError:
            log.warning("飞书文档 %s 取链接失败", did, exc_info=True)
        call("POST", f"/open-apis/drive/v1/permissions/{did}/members/transfer_owner",
             params={"type": "docx", "need_notification": "true", "remove_old_owner": "false",
                     "old_owner_perm": "full_access", "stay_put": "false"},
             body={"member_type": "openid", "member_id": owner})
    except Exception:
        try:
            call("DELETE", f"/open-apis/drive/v1/files/{did}", params={"type": "docx"})
        except Exception:  # noqa: BLE001  删不掉只记日志：真正要报的是上面那个错
            log.warning("飞书文档 %s 建了一半、清理失败", did, exc_info=True)
        raise
    return {"document_id": did, "url": url or f"https://feishu.cn/docx/{did}", "skipped_images": skipped}


# ---------------------------------------------------------------------------
# 读、改已有文档（2026-11-01）
#
# 应用用自己的身份调接口，能碰到所有分享给应用的文档；所以**每次**都要核对发起人
# 本人对这份文档有权限，否则谁都能借机器人读到自己无权看的文档。
# ---------------------------------------------------------------------------

_DOC_URL = re.compile(r"/(docx|wiki)/([A-Za-z0-9]{10,})")
_DOC_TOKEN = re.compile(r"^[A-Za-z0-9]{10,}$")
#: 文档块类型 → 块里存文字的字段名
_TEXT_BLOCKS = {2: "text", 3: "heading1", 4: "heading2", 5: "heading3", 6: "heading4", 7: "heading5",
                8: "heading6", 9: "heading7", 10: "heading8", 11: "heading9", 12: "bullet", 13: "ordered",
                14: "code", 15: "quote", 17: "todo"}
_DOC_BATCH_UPDATE_MAX = 200
_NOT_SHARED = ("机器人打不开这份文档：请在飞书文档右上角「…→ 更多 → 添加文档应用」把镜流的应用加进去，再试一次"
               "（这份文档不是由机器人新建的，所以要手动分享一次）")


def resolve_doc(ref: str) -> str:
    """文档链接或 id → docx 的 document_id。知识库链接要先换成它底下的文档。"""
    ref = (ref or "").strip()
    m = _DOC_URL.search(ref)
    if m is None and not _DOC_TOKEN.match(ref):
        raise FeishuError(-1, "这不是飞书文档链接：要 https://xxx.feishu.cn/docx/... 或 /wiki/... 这种地址")
    if m is None or m.group(1) == "docx":
        return m.group(2) if m else ref
    try:
        node = call("GET", "/open-apis/wiki/v2/spaces/get_node", params={"token": m.group(2)}).get("node") or {}
    except FeishuError as e:
        raise FeishuError(-1, _NOT_SHARED, e.api) from e
    if node.get("obj_type") != "docx":
        raise FeishuError(-1, f"这个知识库节点是 {node.get('obj_type')}，目前只支持读写文档（docx）")
    return str(node.get("obj_token") or "")


def doc_perm(document_id: str, union_id: str) -> str | None:
    """这个人对文档的权限：`full_access`/`edit`/`view`，没有权限时 None。

    只认所有者和**直接**协作者：经群或部门获得的权限这里核对不出来，按没有处理。
    """
    open_id = open_id_of(union_id)
    try:
        metas = call("POST", "/open-apis/drive/v1/metas/batch_query", params={"user_id_type": "open_id"},
                     body={"request_docs": [{"doc_token": document_id, "doc_type": "docx"}]}).get("metas") or []
        if not metas:
            raise FeishuError(-1, _NOT_SHARED)
        if metas[0].get("owner_id") == open_id:
            return "full_access"
        members = call("GET", f"/open-apis/drive/v1/permissions/{document_id}/members",
                       params={"type": "docx", "fields": "*"}).get("items") or []
    except FeishuError as e:
        if e.code == -1:
            raise
        raise FeishuError(-1, _NOT_SHARED, e.api) from e
    for m in members:
        if m.get("member_type") == "openid" and m.get("member_id") == open_id:
            return str(m.get("perm") or "view")
    return None


def read_doc(document_id: str) -> dict:
    title = ""
    try:
        title = str((call("GET", f"/open-apis/docx/v1/documents/{document_id}").get("document") or {}).get("title") or "")
    except FeishuError:
        log.warning("飞书文档 %s 取标题失败", document_id, exc_info=True)
    content = str(call("GET", f"/open-apis/docx/v1/documents/{document_id}/raw_content").get("content") or "")
    return {"title": title, "content": content}


def _doc_blocks(document_id: str) -> list[dict]:
    out, token = [], ""
    while True:
        params: dict = {"page_size": 500}
        if token:
            params["page_token"] = token
        d = call("GET", f"/open-apis/docx/v1/documents/{document_id}/blocks", params=params)
        out += d.get("items") or []
        token = d.get("page_token") or ""
        if not d.get("has_more") or not token:
            return out


def append_doc(document_id: str, markdown: str) -> dict:
    root = call("GET", f"/open-apis/docx/v1/documents/{document_id}/blocks/{document_id}").get("block") or {}
    return {"skipped_images": _insert_markdown(document_id, markdown, len(root.get("children") or []))}


def replace_in_doc(document_id: str, find: str, replace: str) -> dict:
    """把文档里的 `find` 全部换成 `replace`，保留原有字体样式。

    只在同一段连续样式的文字内匹配：跨了加粗等样式边界的文字数进 `unmatched`，不去改它，
    否则要重排整段样式，改错的代价比漏改大。
    """
    updates, replaced, unmatched = [], 0, 0
    for b in _doc_blocks(document_id):
        field = _TEXT_BLOCKS.get(int(b.get("block_type") or 0))
        elements = ((b.get(field) or {}).get("elements") or []) if field else []
        runs = [e["text_run"] for e in elements if isinstance(e.get("text_run"), dict)]
        whole = "".join(str(r.get("content") or "") for r in runs).count(find)
        hit = 0
        for r in runs:
            n = str(r.get("content") or "").count(find)
            if n:
                r["content"] = r["content"].replace(find, replace)
                hit += n
        unmatched += max(0, whole - hit)
        if hit:
            replaced += hit
            updates.append({"block_id": b["block_id"], "update_text_elements": {"elements": elements}})
    for i in range(0, len(updates), _DOC_BATCH_UPDATE_MAX):
        call("PATCH", f"/open-apis/docx/v1/documents/{document_id}/blocks/batch_update",
             params={"document_revision_id": -1}, body={"requests": updates[i:i + _DOC_BATCH_UPDATE_MAX]})
    return {"replaced": replaced, "unmatched": unmatched}
