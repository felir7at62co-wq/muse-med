"""桶里的媒体：给客户端换下载地址、发直传地址、确认直传完成。

三个端点都在 `/v2` 下，鉴权与其它 `/v2` 路由相同（登录中间件 + 项目档位）。
客户端（Muse）只拿到短期预签名地址，桶的密钥只在服务器上。

- `POST /v2/media/resolve`：`/fw/media/...` 地址 → 1 小时的公网 GET 预签名地址。
- `POST /v2/media/upload-url`：登记一次直传，发 15 分钟的公网 PUT 预签名地址
  与一个令牌，地址固定为 `/fw/media/uploads/<id>.<ext>`。
- `POST /v2/media/upload-complete`：凭令牌确认上传完成。服务器每次都 HEAD 对象
  核对大小与类型（图片再读文件头），写台账；不符就删对象并回 422。PUT 地址把
  Content-Type 与 Content-Length 签了进去，有效期内也换不了类型和大小；
  同类型同大小的改写在再次确认时由 ETag 发现。

`/fw/media/...` 仍是文件的永久地址，库里不存任何预签名地址。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import access, media_store, storage
from ..config import get_settings

router = APIRouter(prefix="/v2", tags=["media"])

#: 一次 resolve 最多几个地址。
RESOLVE_MAX = 200

#: 直传令牌的有效期（秒）。比 PUT 地址长：大文件传完可能超过 15 分钟，
#: 桶只在请求开始时检查 PUT 地址是否过期。
UPLOAD_TOKEN_TTL = 2 * 3600

MIB = 1024 * 1024

#: 直传允许的类型：kind → (单文件上限, {Content-Type: 允许的扩展名})。
UPLOAD_KINDS: dict[str, tuple[int, dict[str, frozenset[str]]]] = {
    "image": (50 * MIB, {
        "image/png": frozenset({".png"}),
        "image/jpeg": frozenset({".jpg", ".jpeg"}),
        "image/webp": frozenset({".webp"}),
    }),
    "audio": (200 * MIB, {
        "audio/mpeg": frozenset({".mp3"}),
        "audio/wav": frozenset({".wav"}),
        "audio/x-wav": frozenset({".wav"}),
        "audio/wave": frozenset({".wav"}),
        "audio/aac": frozenset({".aac"}),
        "audio/mp4": frozenset({".m4a"}),
        "audio/x-m4a": frozenset({".m4a"}),
    }),
    "video": (1024 * MIB, {
        "video/mp4": frozenset({".mp4"}),
        "video/quicktime": frozenset({".mov"}),
        "video/x-matroska": frozenset({".mkv"}),
        "video/webm": frozenset({".webm"}),
    }),
}

#: 图片的文件头：扩展名 → 判定函数。
_IMAGE_MAGIC = {
    ".png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    ".jpg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    ".webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}


def _norm_type(ct: str) -> str:
    return (ct or "").split(";", 1)[0].strip().lower()


def _kind_of(ct: str) -> str | None:
    ct = _norm_type(ct)
    for kind, (_limit, types) in UPLOAD_KINDS.items():
        if ct in types:
            return kind
    return None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- resolve

class ResolveIn(BaseModel):
    #: `/fw/media/...` 或 `/fwp/media/...` 地址
    paths: list[str] = Field(..., max_length=RESOLVE_MAX)


@router.post("/media/resolve")
@access.requires("viewer")
def media_resolve(body: ResolveIn) -> dict:
    """每个地址一项，顺序与请求相同：

    - 桶里有：`{path, url, size, etag, content_type, expires_at}`，`url` 是公网
      主机上 1 小时有效的 GET 预签名地址；
    - 桶没配，或文件只在本地：`{path, local: true}`，客户端照旧经 `/fwp/media/...` 取。
      桶不管的目录（`outputs/`、配乐 / 音效 / 音色库等）里本地存在的文件也是这样；
    - 否则 `{path, error}`：`invalid`（不是合法的媒体地址）、`not_in_tos`
      （目录不归桶管，本地也没有）、`not_found`（桶里与本地都没有）。

    `tos` 说明服务器是否配了桶。
    """
    tos = storage.enabled()
    parsed = [(p, *media_store.split_media_path(p)) for p in body.paths]
    rows = (media_store.ledger_rows(sorted({rel for _p, rel, e in parsed if rel and not e}))
            if tos else {})
    now = time.time()
    items: list[dict] = []
    for path, rel, err in parsed:
        if err == "not_in_tos" and rel and media_store.local_file(rel) is not None:
            items.append({"path": path, "local": True})
            continue
        if err:
            items.append({"path": path, "error": err})
            continue
        row = rows.get(rel)
        if row is not None:
            items.append({
                "path": path,
                "url": storage.public_url(rel, ttl=storage.PRESIGN_TTL),
                "size": row["size"],
                "etag": row["etag"],
                "content_type": media_store.content_type_for(rel),
                "expires_at": _iso(now + storage.PRESIGN_TTL),
            })
        elif media_store.local_file(rel) is not None:
            items.append({"path": path, "local": True})
        else:
            items.append({"path": path, "error": "not_found"})
    return {"items": items, "tos": tos}


# ---------------------------------------------------------------- 直传令牌

def _token_key() -> bytes:
    """令牌签名密钥：由桶的密钥派生，不另设配置；换桶密钥后旧令牌一并失效。"""
    secret = get_settings().tos_access_key_secret or ""
    return hashlib.sha256(b"jingliu-media-upload\0" + secret.encode()).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign_token(claims: dict) -> str:
    body = _b64(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode())
    sig = _b64(hmac.new(_token_key(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _read_token(token: str) -> dict:
    """校验签名、有效期与调用者；不通过抛 403。"""
    try:
        body, sig = token.split(".", 1)
        want = _b64(hmac.new(_token_key(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            raise ValueError("签名不符")
        claims = json.loads(_unb64(body))
    except (ValueError, TypeError):
        raise HTTPException(403, "上传令牌无效") from None
    if not isinstance(claims, dict) or float(claims.get("e") or 0) < time.time():
        raise HTTPException(403, "上传令牌已过期，请重新申请上传地址")
    if claims.get("u") != access.current_user_id():
        raise HTTPException(403, "上传令牌不属于当前用户")
    return claims


# ---------------------------------------------------------------- upload-url

class UploadUrlIn(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., min_length=1, max_length=100)
    size: int = Field(..., gt=0)
    #: 给了就在确认上传时登记进该项目的素材池（`media_clips`）
    project_id: str | None = None


@router.post("/media/upload-url")
def media_upload_url(body: UploadUrlIn) -> dict:
    """登记一次直传。客户端随后 `PUT upload_url`（带上 `headers`，Content-Length
    等于申请时的 `size`；地址签了这两个头，值不同桶回 403），再调 `upload-complete`。只收图片 / 音频 / 视频：类型不对 415，超过上限 413，
    扩展名与类型对不上 400，桶没配 503（此时改用 `POST /v2/media/upload`）。"""
    if not storage.enabled():
        raise HTTPException(503, "对象存储未配置，请改用普通上传")
    ct = _norm_type(body.content_type)
    kind = _kind_of(ct)
    if kind is None:
        raise HTTPException(415, f"不支持的文件类型 {ct}：只能上传图片、音频或视频")
    limit, types = UPLOAD_KINDS[kind]
    if body.size > limit:
        raise HTTPException(413, f"文件超过上限 {limit // MIB}MB")
    ext = Path(body.filename).suffix.lower()
    if ext not in types[ct]:
        raise HTTPException(400, f"文件扩展名 {ext or '（无）'} 与类型 {ct} 不符")
    if body.project_id:
        from ..db import get_session
        with get_session() as session:
            access.require_project_access(session, body.project_id)

    rel = f"uploads/{uuid.uuid4().hex[:12]}{ext}"
    token = _sign_token({
        "p": rel, "s": body.size, "t": ct, "k": kind,
        "u": access.current_user_id(), "j": body.project_id,
        "n": body.filename, "e": int(time.time()) + UPLOAD_TOKEN_TTL,
    })
    return {
        # Content-Length 也签进了地址，但不放进 headers：客户端按文件大小自己发
        # （浏览器与 fetch 不许脚本设置它），值与申请时的 size 相同即可。
        "upload_url": storage.upload_url(rel, content_type=ct, size=body.size),
        "headers": {"Content-Type": ct},
        "path": media_store.url_for(rel),
        "token": token,
    }


# ---------------------------------------------------------------- upload-complete

class UploadCompleteIn(BaseModel):
    path: str = Field(..., min_length=1, max_length=1024)
    token: str = Field(..., min_length=1, max_length=4096)


def _reject(rel: str, reason: str, message: str, *, pid: str | None = None) -> HTTPException:
    """删掉不合格的对象和它的台账行（以及这次直传登记的素材），返回要抛出的 422。"""
    try:
        storage.delete(rel)
    except Exception as e:      # noqa: BLE001
        media_store.note_failure("upload", rel, e)
    media_store.drop_ledger(rel)
    if pid:
        _drop_clip(rel)
    return HTTPException(422, {"reason": reason, "message": message})


def _check_failed(rel: str, e: BaseException) -> HTTPException:
    media_store.note_failure("check", rel, e)
    return HTTPException(502, "暂时无法核对上传结果，请稍后重试")


@router.post("/media/upload-complete")
def media_upload_complete(body: UploadCompleteIn) -> dict:
    """凭 `upload-url` 发的令牌确认直传完成，返回 `{path, size}`。

    每次都 HEAD 桶里的对象核对：存在（不存在 422 `missing`）、大小等于申请时的
    大小（`size_mismatch`）、Content-Type 等于申请时的类型（`type_mismatch`）、
    图片的文件头与扩展名一致（`not_an_image`）。同一个令牌重复确认时，对象的大小
    与 ETag 和台账一致就返回同样的结果；不一致说明确认之后有人用同一个 PUT 地址
    改写了对象（`changed`）。不符时删掉对象与台账行再回 422。
    """
    if not storage.enabled():
        raise HTTPException(503, "对象存储未配置")
    claims = _read_token(body.token)
    rel, _err = media_store.parse_media_path(body.path)
    if rel is None or rel != claims.get("p"):
        raise HTTPException(403, "上传令牌与地址不符")
    size, ct, kind = int(claims["s"]), str(claims["t"]), str(claims["k"])
    pid = claims.get("j")

    from ..db import get_session
    if pid:
        with get_session() as session:
            access.require_project_access(session, pid)

    try:
        h = storage.head(rel)
    except Exception as e:      # noqa: BLE001
        raise _check_failed(rel, e) from None
    row = media_store.ledger_rows([rel]).get(rel)
    if h is None:
        if row is not None:
            media_store.drop_ledger(rel)
            if pid:
                _drop_clip(rel)
        raise HTTPException(422, {"reason": "missing", "message": "桶里没有这个文件，请先上传"})
    if h["size"] != size:
        raise _reject(rel, "size_mismatch",
                      f"上传的文件有 {h['size']} 字节，申请时是 {size} 字节", pid=pid)
    if _norm_type(h.get("content_type") or "") != ct:
        raise _reject(rel, "type_mismatch", f"上传时的 Content-Type 不是 {ct}", pid=pid)
    if kind == "image":
        try:
            head = storage.read_head_bytes(rel, 32)
        except Exception as e:      # noqa: BLE001
            raise _check_failed(rel, e) from None
        if not _IMAGE_MAGIC[Path(rel).suffix.lower()](head):
            raise _reject(rel, "not_an_image", "文件内容不是声明的图片格式", pid=pid)
    etag = h.get("etag") or ""
    if row is not None:
        if int(row["size"]) != h["size"] or (row["etag"] or "") != etag:
            raise _reject(rel, "changed", "确认上传之后文件又被改写过，已删除，请重新上传",
                          pid=pid)
    else:
        media_store.upsert_ledger(rel, key=storage.key_for(rel), size=size, etag=etag)

    if pid:
        _register_clip(rel, pid, str(claims.get("n") or Path(rel).name), size, kind)
    return {"path": media_store.url_for(rel), "size": size}


def _drop_clip(rel: str) -> None:
    """删掉 `_register_clip` 为这次直传登记的素材行（只认同一个 id 与地址）。"""
    from ..db import MediaClip, get_session
    with get_session() as session:
        clip = session.get(MediaClip, Path(rel).stem)
        if clip is not None and clip.url == media_store.url_for(rel):
            session.delete(clip)
            session.commit()


def _register_clip(rel: str, pid: str, name: str, size: int, kind: str) -> None:
    """登记进项目素材池，与 `POST /v2/media/upload` 的 `media_clips` 行相同。"""
    from ..db import MediaClip, get_session
    fid = Path(rel).stem
    with get_session() as session:
        if session.get(MediaClip, fid) is not None:
            return
        session.add(MediaClip(
            id=fid, project_id=pid, name=name[:255], url=media_store.url_for(rel),
            size=size, kind=kind, duration=0.0,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds")))
        session.commit()
