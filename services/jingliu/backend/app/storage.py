"""对象存储（火山 TOS）——本地盘降级为缓存，桶才是持久层。

## 为什么要有这一层

素材一直只落本地盘（见 `media.py` 模块头的 MVP 取舍）。dev 侧已经堆到 19G，
而这台机器的盘是**和剧本平台共用的**：写满时遭殃的是 drama prod 的 postgres。
所以把 `generated/` 与 `uploads/` 挪进桶，本地只留一份按水位淘汰的缓存。

## 为什么不用 tos SDK

`pip install tos` 会把 `requests` / `certifi` / `six` / `pytz` 一并升级，而
`/usr/bin/python3` 是**织影生产后端也在跑的解释器**——那属于改生产，本次无授权。
TOS 是 S3 风格对象存储，SigV4 自己签即可：零新依赖、dev/prod 完全一致、
不动 systemd 单元。实测正确签名 200 / 故意签错 403，签名确实生效。

## 一切都走预签名 URL

GET / PUT / HEAD / DELETE / LIST 共用同一个 `presign()`，不做请求头签名。
好处是只有一处签名逻辑要维护和验证，而且浏览器与剪映导入器拿到的就是同一种
URL，服务端不必代理流量。

## key 布局（用户要求的"专属标记"）

    shotflow/{env}/{rel}          rel 形如 generated/x.mp4、uploads/y.png

桶 `jubian-juben` 顶层原本只有 `drama/` 一个前缀，`shotflow/` 与它并列且互不
干扰；`{env}` 再把 dev 与 prod 隔开——两边共用一个前缀的话，dev 的清理脚本
会顺手删掉生产素材，而这正是本项目反复强调不能发生的事。
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import logging
import re
import threading
import urllib.parse
from pathlib import Path

import httpx

from .config import get_settings

logger = logging.getLogger(__name__)

#: 预签名默认有效期。浏览器读图用短的即可；剪映导入器那条路单独给长的
#: （见 `PRESIGN_TTL_EXPORT`）——用户可能几小时后才双击导入器。
PRESIGN_TTL = 3600

#: 剪映导出清单里的素材地址有效期。7 天是 SigV4 的上限量级，够用户慢慢下。
#: 给短了的后果很隐蔽：导入器下到一半整批 403，而它只会报"大小不符"。
PRESIGN_TTL_EXPORT = 7 * 24 * 3600

#: 交给**远端服务**去拉的地址有效期（火山方舟 / zx1 / 去字幕 等）。
#: 不用 1 小时：任务是排队的，提交后可能要等很久才真正拉图；给短了会在
#: 排队期间过期，表现是"提交时好好的、跑到一半说图取不到"。24 小时足够
#: 覆盖任何正常排队，又不至于把链接长期散在外面。
PRESIGN_TTL_REMOTE = 24 * 3600

#: 单个对象大小上限。实测现网最大 57.7MB，远低于此；超过就该上分片上传了，
#: 所以这里**宁可报错也不静默截断**。
MAX_PUT_BYTES = 200 * 1024 * 1024


class StorageNotConfigured(RuntimeError):
    """未配置桶。调用方应当回退到"只用本地盘"的老行为，而不是报错给用户。"""


def enabled() -> bool:
    s = get_settings()
    return bool(s.tos_bucket and s.tos_access_key_id and s.tos_access_key_secret)


def _cfg():
    s = get_settings()
    if not enabled():
        raise StorageNotConfigured("FW_TOS_* 未配置")
    host = f"{s.tos_bucket}.{s.tos_endpoint}"
    return s, host


def key_for(rel: str) -> str:
    """`generated/x.mp4` → `shotflow/dev/generated/x.mp4`。

    `rel` 必须是相对 DATA_DIR 的路径，且**不含**前导斜杠与 `..`——
    调用方应已经过 `media._resolve_local` 的越界检查。
    """
    s = get_settings()
    prefix = (s.tos_key_prefix or "").strip("/")
    rel = rel.lstrip("/")
    return f"{prefix}/{rel}" if prefix else rel


def _signing_key(secret: str, datestamp: str, region: str) -> bytes:
    k = hmac.new(secret.encode(), datestamp.encode(), hashlib.sha256).digest()
    k = hmac.new(k, region.encode(), hashlib.sha256).digest()
    k = hmac.new(k, b"tos", hashlib.sha256).digest()
    return hmac.new(k, b"request", hashlib.sha256).digest()


def presign(method: str, key: str, *, ttl: int = PRESIGN_TTL,
            query: dict | None = None) -> str:
    """生成预签名 URL。key 为空串 = 对桶本身操作（如 list）。"""
    s, host = _cfg()
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    scope = f"{datestamp}/{s.tos_region}/tos/request"

    q = dict(query or {})
    q.update({
        "X-Tos-Algorithm": "TOS4-HMAC-SHA256",
        "X-Tos-Credential": f"{s.tos_access_key_id}/{scope}",
        "X-Tos-Date": amzdate,
        "X-Tos-Expires": str(ttl),
        "X-Tos-SignedHeaders": "host",
    })
    # 规范化查询串：必须按 key 排序、逐字段 percent-encode，且 `~` 不转义。
    # 少一步签名就对不上，而服务端只回一个没有细节的 403。
    cq = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(str(v), safe='-_.~')}"
        for k, v in sorted(q.items()))
    uri = "/" + urllib.parse.quote(key, safe="/-_.~")
    creq = f"{method}\n{uri}\n{cq}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD"
    sts = (f"TOS4-HMAC-SHA256\n{amzdate}\n{scope}\n"
           f"{hashlib.sha256(creq.encode()).hexdigest()}")
    sig = hmac.new(_signing_key(s.tos_access_key_secret, datestamp, s.tos_region),
                   sts.encode(), hashlib.sha256).hexdigest()
    return f"https://{host}{uri}?{cq}&X-Tos-Signature={sig}"


#: 下载文件名（`?dl=`）的最大长度。nginx 默认 8KB 的请求行上限，浏览器对过长的
#: Content-Disposition 也不友好；宁可截断，也别让一条 URL 在中间层被 414 掉。
DL_NAME_MAX = 120

#: Content-Disposition 里必须剔除的字符。引号会提前闭合引号段，分号切错参数，
#: CR/LF 是响应头注入，反斜杠在部分客户端里被当成转义符。
_DL_BAD = re.compile(r'[\x00-\x1f\x7f"\\;/]')


def safe_download_name(raw: str | None) -> str | None:
    """把前端传来的下载文件名洗成可以放进响应头的形态。None = 不设文件名。

    ⚠️ 这是**用户可控输入**，会被拼进 HTTP 响应头（经对象存储下发），
    所以除了截断，还必须挡掉路径分隔符与换行——`../../` 至少在文件名里
    没有意义，而换行就是响应头注入。
    """
    if not raw:
        return None
    name = _DL_BAD.sub("", str(raw)).strip().strip(".")
    if not name:
        return None
    return name[:DL_NAME_MAX]


def content_disposition(name: str) -> str:
    """构造 `Content-Disposition: attachment` 头，中文名走 RFC 5987。

    两段都写：`filename*` 是给现代浏览器的（保留中文），`filename` 是纯 ASCII
    兜底（老客户端不认 `filename*`，给个下划线名字也比没有强——总比又变成
    `up_62e1a3408268.mp4` 好）。
    """
    quoted = urllib.parse.quote(name, safe="")
    fallback = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quoted}'


def public_url(rel: str, *, ttl: int = PRESIGN_TTL,
               download_name: str | None = None) -> str:
    """相对路径 → 可直接下载的预签名地址。

    `download_name` 非空时带上 `response-content-disposition`：**这是唯一
    能让桶把文件名交还给浏览器的办法**。背景见 `main._MediaFiles`
    （跨域 307 之后 `<a download>` 会被浏览器丢弃，文件名退化成 URL 末段）。
    """
    q = None
    if download_name:
        q = {"response-content-disposition": content_disposition(download_name)}
    return presign("GET", key_for(rel), ttl=ttl, query=q)


def put_file(local: Path, rel: str, *, content_type: str | None = None) -> dict:
    """上传一个本地文件。返回 {key, size, etag}。

    校验 ETag：TOS 对非分片上传回的是内容 MD5。传完不比对的话，
    截断/网络损坏的对象会被当成"已上传"然后把本地原件删掉——**不可逆的丢数据**。
    """
    size = local.stat().st_size
    if size > MAX_PUT_BYTES:
        raise ValueError(f"{local.name} 有 {size/1048576:.1f}MB，超过单次上传上限；需要分片上传")

    key = key_for(rel)
    url = presign("PUT", key, ttl=900)
    md5 = hashlib.md5()
    with local.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            md5.update(chunk)
    want = md5.hexdigest()

    headers = {"Content-Length": str(size)}
    if content_type:
        headers["Content-Type"] = content_type
    with local.open("rb") as f:
        r = httpx.put(url, content=f, headers=headers, timeout=600.0)
    if r.status_code // 100 != 2:
        raise RuntimeError(f"上传失败 {r.status_code}: {r.text[:200]}")

    etag = (r.headers.get("ETag") or "").strip('"')
    if etag and etag.lower() != want:
        # 立刻把坏对象删掉，不留给下一轮当成"已存在"跳过
        try:
            delete(rel)
        except Exception:      # noqa: BLE001
            pass
        raise RuntimeError(f"ETag 不符：本地 {want} 远端 {etag}，已删除远端对象")
    return {"key": key, "size": size, "etag": etag or want}


#: 每个本地目标路径一把锁，防止同一对象被并发回填时互相踩临时文件。
#:
#: 为什么必须有（2026-10-25 实测踩到）：`fetch` 用 `dest + ".part"` 做临时文件，
#: 而**两个协程同时回填同一个 rel 时用的是同一个 .part 路径**：
#:   · A 写完 rename → 成功；
#:   · B 的 `finally: tmp.unlink()` 把 A 刚 rename 走之前/之后的临时文件删掉；
#:   · 或者 B 的 `tmp.open("wb")` 截断 A 正在写的内容。
#: 实测报错原文：
#:   FileNotFoundError: '...img_xxx.png.part' -> '...img_xxx.png'
#: 这类错误只在**并发**且**冷缓存**时出现，正好是批量出片时的形态 ——
#: 表现为"偶尔某一镜的参考图取不到"，然后触发既有的降级/中止分支。
#:
#: 用 `threading.Lock`（不是 asyncio.Lock）：`fetch` 是同步函数，
#: 调用方既有 `to_thread(...)` 也有同步上下文，threading 锁两种都适用。
_FETCH_LOCKS: dict[str, "threading.Lock"] = {}
_FETCH_LOCKS_GUARD = threading.Lock()


def _fetch_lock(dest: Path) -> "threading.Lock":
    key = str(dest)
    with _FETCH_LOCKS_GUARD:
        lk = _FETCH_LOCKS.get(key)
        if lk is None:
            lk = threading.Lock()
            _FETCH_LOCKS[key] = lk
        return lk


def fetch(rel: str, dest: Path) -> Path:
    """把对象拉回本地 `dest`（缓存回填）。先写临时文件再改名。

    不用临时文件的话，拉到一半进程被杀就会在缓存里留下一个**大小不对但看着
    存在**的文件，之后每一次 `_resolve_local` 都会命中它 —— ffmpeg 报
    "moov atom not found"，而没人会想到是缓存半截。

    ⚠️ **同一 dest 并发调用必须串行**（见 `_FETCH_LOCKS` 的说明）。
    拿到锁后要**再查一次本地是否已有**：前一个持有者可能刚刚回填完，
    这时直接返回即可，不必再下一遍。
    """
    url = presign("GET", key_for(rel))
    dest.parent.mkdir(parents=True, exist_ok=True)
    with _fetch_lock(dest):
        if dest.is_file():
            return dest          # 前一个并发者在等锁期间已经拉好了
        tmp = dest.with_name(dest.name + ".part")
        try:
            with httpx.stream("GET", url, timeout=600.0, follow_redirects=True) as r:
                if r.status_code // 100 != 2:
                    raise RuntimeError(f"下载失败 {r.status_code}")
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes(1024 * 1024):
                        f.write(chunk)
            tmp.replace(dest)
        finally:
            tmp.unlink(missing_ok=True)
    return dest


def head(rel: str) -> dict | None:
    """对象存在则返回 {size, etag}，否则 None。"""
    r = httpx.head(presign("HEAD", key_for(rel)), timeout=30.0)
    if r.status_code == 404:
        return None
    if r.status_code // 100 != 2:
        raise RuntimeError(f"HEAD 失败 {r.status_code}")
    return {"size": int(r.headers.get("Content-Length") or 0),
            "etag": (r.headers.get("ETag") or "").strip('"')}


def delete(rel: str) -> None:
    """删除对象。404 视作成功——删除要幂等，否则清理脚本会卡在已删的条目上。"""
    r = httpx.delete(presign("DELETE", key_for(rel)), timeout=60.0)
    if r.status_code not in (200, 202, 204, 404):
        raise RuntimeError(f"删除失败 {r.status_code}: {r.text[:200]}")
