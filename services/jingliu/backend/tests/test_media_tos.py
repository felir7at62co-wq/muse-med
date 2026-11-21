"""媒体进桶：写入点直传、台账、resolve / 直传端点、本地副本的删除时机、
zx1 下载失败、清理引用表、库备份进桶。

桶用内存里的假实现代替（`FakeTOS`），预签名地址由真实的签名代码生成，
不发任何网络请求。
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import pytest
from sqlalchemy import text

from conftest import PID, make_project, run

# AuthSession 表要在 db 夹具建表之前注册进元数据
importlib.import_module("app.auth")

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
SECRET_URL = "https://bucket.tos-internal.example/muse-jingliu/x?X-Tos-Signature=deadbeef"


class FakeTOS:
    """内存里的桶：rel → (字节, Content-Type)。"""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str | None]] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail_put = False
        self.fail_fetch = False

    def _store(self, rel: str, data: bytes, ct: str | None) -> dict:
        from app import storage
        if self.fail_put:
            raise RuntimeError(f"上传失败 HTTP 503 {SECRET_URL}")
        self.objects[rel] = (bytes(data), ct)
        return {"key": storage.key_for(rel), "size": len(data),
                "etag": hashlib.md5(data).hexdigest()}

    def put_bytes(self, data, rel, *, content_type=None):
        self.calls.append(("put_bytes", rel))
        return self._store(rel, data, content_type)

    def put_file(self, local, rel, *, content_type=None):
        self.calls.append(("put_file", rel))
        return self._store(rel, Path(local).read_bytes(), content_type)

    def head(self, rel):
        self.calls.append(("head", rel))
        if rel not in self.objects:
            return None
        data, ct = self.objects[rel]
        return {"size": len(data), "etag": hashlib.md5(data).hexdigest(),
                "content_type": ct or ""}

    def delete(self, rel):
        self.calls.append(("delete", rel))
        self.objects.pop(rel, None)

    def read_head_bytes(self, rel, n=32):
        return self.objects[rel][0][:n]

    def fetch(self, rel, dest):
        self.calls.append(("fetch", rel))
        if self.fail_fetch or rel not in self.objects:
            raise RuntimeError(f"下载失败 404 {SECRET_URL}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.objects[rel][0])
        return dest


@pytest.fixture()
def tos(db, monkeypatch):
    """配好桶（内存假实现）与 `media_objects` 台账表。"""
    from app import media_cache, media_store, storage
    from app.config import get_settings
    from app.db import engine
    from app.migrations import _TABLES
    from app.providers.base import invalidate_in_ledger

    s = get_settings()
    for k, v in {"tos_bucket": "bucket", "tos_access_key_id": "AKTEST",
                 "tos_access_key_secret": "SKTEST", "tos_region": "cn-beijing",
                 "tos_endpoint": "tos-internal.example",
                 "tos_public_endpoint": "tos-public.example",
                 "tos_key_prefix": "muse-jingliu/"}.items():
        monkeypatch.setattr(s, k, v)
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS media_objects"))
        conn.execute(text(_TABLES["media_objects"]))
    # 数据目录是整个测试进程共用的临时目录：清掉托管目录，台账与目录从同一个空状态开始
    import shutil

    from app.media import DATA_DIR
    for d in s.tos_dirs:
        shutil.rmtree(DATA_DIR / d, ignore_errors=True)
        (DATA_DIR / d).mkdir(parents=True, exist_ok=True)
    fake = FakeTOS()
    for name in ("put_bytes", "put_file", "head", "delete", "read_head_bytes", "fetch"):
        monkeypatch.setattr(storage, name, getattr(fake, name))
    monkeypatch.setattr(media_cache, "probe_meta",
                        lambda p: {"width": None, "height": None, "duration_us": None})
    invalidate_in_ledger()
    media_store.take_counts()
    return fake


@pytest.fixture()
def drop_local(tos, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "media_keep_local", False)
    return tos


def _ledger() -> dict[str, tuple[int, str]]:
    from app.db import engine
    with engine.begin() as conn:
        return {r[0]: (r[1], r[2]) for r in conn.execute(
            text("SELECT rel_path, size, etag FROM media_objects"))}


def _gen(name: str | None = None) -> Path:
    from app.media import GENERATED_DIR
    return GENERATED_DIR / (name or f"img_{uuid.uuid4().hex[:12]}.png")


def _age(p: Path, seconds: float) -> None:
    t = time.time() - seconds
    os.utime(p, (t, t))


# ---------------------------------------------------------------- 写入点直传

def test_store_bytes_uploads_from_memory_and_records_the_ledger(tos):
    from app import media_store

    dest = _gen()
    url = media_store.store_bytes(PNG, dest)
    rel = f"generated/{dest.name}"
    assert url == f"/fw/media/{rel}"
    assert dest.read_bytes() == PNG
    assert tos.calls == [("put_bytes", rel)]                 # 从内存传，不再读盘
    assert tos.objects[rel] == (PNG, "image/png")
    assert _ledger() == {rel: (len(PNG), hashlib.md5(PNG).hexdigest())}
    assert media_store.take_counts()["uploaded"] == 1


def test_without_a_bucket_only_the_file_is_written(db):
    from app import media_store, storage

    assert not storage.enabled()
    dest = _gen()
    # 台账表在这个库里不存在：没配桶时一次都不能碰它
    assert media_store.store_bytes(PNG, dest) == f"/fw/media/generated/{dest.name}"
    assert dest.read_bytes() == PNG


def test_failed_upload_logs_one_line_without_the_address_and_the_sweep_backfills(tos, caplog):
    from app import media_cache, media_store

    tos.fail_put = True
    dest = _gen()
    rel = f"generated/{dest.name}"
    with caplog.at_level(logging.WARNING, logger="app.media_store"):
        assert media_store.store_bytes(PNG, dest) == f"/fw/media/{rel}"
    recs = [r for r in caplog.records if r.name == "app.media_store"]
    lines = [r.getMessage() for r in recs]
    assert len(lines) == 1 and rel in lines[0] and "上传失败" in lines[0]
    assert "http" not in lines[0] and "Signature" not in lines[0] and not recs[0].exc_info
    assert dest.is_file() and _ledger() == {}

    tos.fail_put = False
    assert media_cache.upload_pending()["uploaded"] == 0     # 刚写出的文件归写入点，巡检先不碰
    _age(dest, media_cache.FRESH_SEC + 5)
    assert media_cache.upload_pending()["uploaded"] == 1
    assert rel in _ledger()


def test_sweep_and_direct_upload_share_one_ledger_row(tos):
    from app import media_cache, media_store

    dest = _gen()
    dest.write_bytes(PNG)
    _age(dest, media_cache.FRESH_SEC + 5)
    assert media_cache.upload_pending()["uploaded"] == 1
    media_store.store_bytes(PNG + b"x", dest)
    rel = f"generated/{dest.name}"
    assert _ledger()[rel][0] == len(PNG) + 1
    assert list(_ledger()) == [rel]


def test_sweep_uploads_exports_and_references_but_not_pack_folders(tos):
    from app import media_cache
    from app.media import DATA_DIR

    zip_path = DATA_DIR / "exports" / "jianying" / f"{uuid.uuid4().hex[:8]}-第1集.zip"
    half = DATA_DIR / "exports" / "jianying" / f"pack-{uuid.uuid4().hex[:8]}" / "draft.json"
    ref = DATA_DIR / "character-references" / f"{uuid.uuid4().hex}.png"
    for p in (zip_path, half, ref):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(PNG)
        _age(p, media_cache.FRESH_SEC + 5)
    media_cache.upload_pending()
    rels = set(_ledger())
    assert f"exports/jianying/{zip_path.name}" in rels
    assert f"character-references/{ref.name}" in rels
    assert not any(r.startswith("exports/jianying/pack-") for r in rels)


def test_presigned_addresses_for_clients_use_the_public_host(tos):
    from app import storage

    get = urlparse(storage.public_url("generated/a.png"))
    put = urlparse(storage.upload_url("uploads/a.png"))
    inner = urlparse(storage.presign("HEAD", storage.key_for("generated/a.png")))
    assert get.hostname == put.hostname == "bucket.tos-public.example"
    assert inner.hostname == "bucket.tos-internal.example"
    assert get.path == "/muse-jingliu/generated/a.png"


def test_image_provider_saves_through_the_bucket(tos):
    from app.providers import image

    [url] = image._save_all([PNG])
    rel = url.removeprefix("/fw/media/")
    assert tos.calls[0] == ("put_bytes", rel) and rel in _ledger()


# ---------------------------------------------------------------- zx1 下载失败

class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    def __init__(self, fail: bool):
        self.fail = fail

    async def post(self, url, headers=None, json=None):
        return _Resp({"choices": [{"message": {
            "content": "[download video](https://vendor.example/v.mp4?Expires=1&Signature=s)"}}]})

    @contextlib.asynccontextmanager
    async def stream(self, method, url):
        import httpx
        if self.fail:
            raise httpx.ConnectError(f"connect failed for {url}")

        class _S:
            def raise_for_status(self):
                return None

            async def aiter_bytes(self, n):
                yield b"\x00\x00\x00\x18ftypmp42"

        yield _S()


def _zx1(monkeypatch, fail: bool):
    from app.providers import video

    @contextlib.asynccontextmanager
    async def client(name, **kw):
        yield _Client(fail)

    monkeypatch.setattr(video.http, "client", client)
    monkeypatch.setattr(video, "DOWNLOAD_RETRY_SEC", 0.0)
    from app.providers.base import VideoRequest
    return run(video.ChatVideoProvider("veo-test").submit(VideoRequest(prompt="一个镜头")))


def test_zx1_download_failure_fails_the_shot_and_keeps_no_vendor_address(tos, monkeypatch):
    res = _zx1(monkeypatch, fail=True)
    assert res.status == "failed" and res.video_url is None
    assert "vendor.example" not in (res.error or "") and "ConnectError" in res.error


def test_zx1_download_is_uploaded(tos, monkeypatch):
    res = _zx1(monkeypatch, fail=False)
    assert res.status == "done" and res.video_url.startswith("/fw/media/generated/shot_")
    assert res.video_url.removeprefix("/fw/media/") in _ledger()


# ---------------------------------------------------------------- resolve

def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import media_tos

    a = FastAPI()
    a.include_router(media_tos.router)
    return TestClient(a)


def test_resolve_signs_bucket_files_and_reports_the_rest(tos):
    from app import media_store

    in_tos = _gen()
    media_store.store_bytes(PNG, in_tos)
    local_only = _gen()
    local_only.write_bytes(PNG)
    paths = [f"/fwp/media/generated/{in_tos.name}?t=1", f"/fw/media/generated/{local_only.name}",
             "/fw/media/generated/img_missing.png", "/fw/media/outputs/final.mp4",
             "/fw/media/generated/../../test.db", "/fw/media/backups/jingliu.db",
             "/media/generated/x.png", "https://elsewhere.example/x.png",
             "/fw/media/generated/%2e%2e/x.png", "/fw/media/generated/a\nb.png"]
    r = _client().post("/v2/media/resolve", json={"paths": paths})
    assert r.status_code == 200
    body = r.json()
    assert body["tos"] is True
    items = body["items"]
    assert [i["path"] for i in items] == paths
    signed = items[0]
    assert urlparse(signed["url"]).hostname == "bucket.tos-public.example"
    assert urlparse(signed["url"]).path == f"/muse-jingliu/generated/{in_tos.name}"
    assert signed["size"] == len(PNG) and signed["etag"] == hashlib.md5(PNG).hexdigest()
    assert signed["content_type"] == "image/png"
    left = datetime.fromisoformat(signed["expires_at"]) - datetime.now(timezone.utc)
    assert timedelta(minutes=55) < left <= timedelta(hours=1)
    assert items[1] == {"path": paths[1], "local": True}
    assert items[2] == {"path": paths[2], "error": "not_found"}
    assert items[3] == {"path": paths[3], "error": "not_in_tos"}
    assert all(i.get("error") == "invalid" for i in items[4:])


def test_resolve_accepts_at_most_200_paths(tos):
    ok = _client().post("/v2/media/resolve", json={"paths": ["/fw/media/generated/a.png"] * 200})
    assert ok.status_code == 200
    r = _client().post("/v2/media/resolve", json={"paths": ["/fw/media/generated/a.png"] * 201})
    assert r.status_code == 422


def test_resolve_without_a_bucket_points_back_to_local_files(db):
    f = _gen()
    f.write_bytes(PNG)
    r = _client().post("/v2/media/resolve",
                       json={"paths": [f"/fw/media/generated/{f.name}", "/fw/media/uploads/no.png"]})
    assert r.json() == {"tos": False, "items": [
        {"path": f"/fw/media/generated/{f.name}", "local": True},
        {"path": "/fw/media/uploads/no.png", "error": "not_found"}]}


def test_media_endpoints_need_a_login_like_other_v2_routes(tos, monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth import AuthSession, _hash_token
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setattr(get_settings(), "auth_upstream", "https://login.example")
    client = TestClient(create_app())
    body = {"paths": ["/fw/media/generated/a.png"]}
    assert client.post("/v2/media/resolve", json=body).status_code == 401
    assert client.post("/v2/media/upload-url", json={
        "filename": "a.png", "content_type": "image/png", "size": 10}).status_code == 401
    assert client.post("/v2/media/upload-complete",
                       json={"path": "/fw/media/uploads/a.png", "token": "x"}).status_code == 401

    from app.db import get_session
    with get_session() as s:
        s.add(AuthSession(token=_hash_token("tok-1"), user_id=7, username="tester",
                          role="user",
                          expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()))
        s.commit()
    r = client.post("/v2/media/resolve", json=body, headers={"Authorization": "Bearer tok-1"})
    assert r.status_code == 200 and r.json()["items"][0]["error"] == "not_found"


# ---------------------------------------------------------------- 直传

def _upload_url(**kw):
    body = {"filename": "封面.png", "content_type": "image/png", "size": len(PNG), **kw}
    return _client().post("/v2/media/upload-url", json=body)


def test_upload_url_checks_type_size_and_extension(tos):
    r = _upload_url()
    assert r.status_code == 200
    out = r.json()
    assert set(out) == {"upload_url", "headers", "path", "token"}
    assert out["headers"] == {"Content-Type": "image/png"}
    name = out["path"].removeprefix("/fw/media/uploads/")
    assert len(name) == len("0123456789ab.png") and name.endswith(".png")
    put = urlparse(out["upload_url"])
    assert put.hostname == "bucket.tos-public.example"
    assert put.path == f"/muse-jingliu/uploads/{name}" and "X-Tos-Expires=900" in put.query

    mib = 1024 * 1024
    assert _upload_url(content_type="text/plain", filename="a.txt").status_code == 415
    assert _upload_url(size=50 * mib + 1).status_code == 413
    assert _upload_url(content_type="video/mp4", filename="a.mp4", size=1024 * mib).status_code == 200
    assert _upload_url(content_type="video/mp4", filename="a.mp4", size=1024 * mib + 1).status_code == 413
    assert _upload_url(content_type="audio/mpeg", filename="a.mp3", size=200 * mib + 1).status_code == 413
    assert _upload_url(filename="a.jpg").status_code == 400
    assert _upload_url(size=0).status_code == 422


def test_upload_url_without_a_bucket_answers_503(db):
    assert _upload_url().status_code == 503


def _complete(out, path=None):
    return _client().post("/v2/media/upload-complete",
                          json={"path": path or out["path"], "token": out["token"]})


def test_upload_complete_records_the_file_and_the_project_clip(tos):
    from app.db import MediaClip, get_session

    make_project(get_session)
    out = _upload_url(project_id=PID).json()
    rel = out["path"].removeprefix("/fw/media/")
    tos.objects[rel] = (PNG, "image/png")                     # 客户端 PUT 进了桶
    r = _complete(out, path=out["path"].replace("/fw/", "/fwp/", 1))
    assert r.status_code == 200 and r.json() == {"path": out["path"], "size": len(PNG)}
    assert _ledger()[rel][0] == len(PNG)
    assert _complete(out).status_code == 200                  # 重复确认：结果相同，不重复登记
    with get_session() as s:
        clips = s.query(MediaClip).all()
        assert [(c.name, c.url, c.kind, c.size) for c in clips] == [
            ("封面.png", out["path"], "image", len(PNG))]


@pytest.mark.parametrize("stored, reason", [
    ((PNG + b"extra", "image/png"), "size_mismatch"),
    ((PNG, "application/octet-stream"), "type_mismatch"),
    ((b"GIF89a" + PNG[6:], "image/png"), "not_an_image"),
])
def test_upload_complete_deletes_a_mismatching_object(tos, stored, reason):
    out = _upload_url().json()
    rel = out["path"].removeprefix("/fw/media/")
    tos.objects[rel] = stored
    r = _complete(out)
    assert r.status_code == 422 and r.json()["detail"]["reason"] == reason
    assert rel not in tos.objects and _ledger() == {}


def test_upload_complete_needs_the_object_and_a_matching_token(tos, monkeypatch):
    from app.routers import media_tos

    out = _upload_url().json()
    missing = _complete(out)
    assert missing.status_code == 422 and missing.json()["detail"]["reason"] == "missing"
    other = _upload_url().json()
    assert _complete(out, path=other["path"]).status_code == 403
    forged = out["token"][:-2] + ("AA" if not out["token"].endswith("AA") else "BB")
    assert _client().post("/v2/media/upload-complete",
                          json={"path": out["path"], "token": forged}).status_code == 403
    monkeypatch.setattr(media_tos.access, "current_user_id", lambda: 99)
    assert _complete(out).status_code == 403                  # 别人的令牌


# ---------------------------------------------------------------- 本地副本


def test_ensure_local_restores_references_and_logs_failures_briefly(tos, caplog):
    from app.media import DATA_DIR, ensure_local

    name = f"{uuid.uuid4().hex}.png"
    tos.objects[f"character-references/{name}"] = (PNG, "image/png")
    p = ensure_local(f"/fw/media/character-references/{name}")
    assert p.resolve() == (DATA_DIR / "character-references" / name).resolve()
    assert p.read_bytes() == PNG

    tos.fail_fetch = True
    with caplog.at_level(logging.WARNING, logger="app.media_store"):
        ensure_local("/fw/media/generated/img_gone.png")
    [rec] = [r for r in caplog.records if r.name == "app.media_store"]
    assert "回填失败 generated/img_gone.png" in rec.getMessage()
    assert "http" not in rec.getMessage() and not rec.exc_info


# ---------------------------------------------------------------- 清理与引用

def test_version_images_and_shot_references_count_as_referenced(db):
    import json

    from app import media_refs
    from app.db import AssetImageVersion, get_session
    from conftest import add_shot

    make_project(db)
    add_shot(db, PID, 1, profile_override=json.dumps(
        {"refs": ["/fw/media/generated/img_ref.png"]}))
    with get_session() as s:
        s.add(AssetImageVersion(id="v1", project_id=PID, kind="character", target_id="a1",
                                version_no=1, image_url="/fw/media/generated/img_old.png",
                                label="林晨"))
        s.commit()
        names = media_refs.referenced_filenames(s)
        assert {"img_ref.png", "img_old.png"} <= names
        refs = media_refs.find_references(s, "/fw/media/generated/img_old.png")
        assert [(r["type"], r["label"]) for r in refs] == [
            ("asset_image_version", "「林晨」的图片历史版本 v1")]
        assert [r["type"] for r in media_refs.find_references(
            s, "/fw/media/generated/img_ref.png")] == ["shot_ref"]


def test_export_objects_expire_with_the_export_ttl(tos):
    from app import media_cache, media_store
    from app.db import engine
    from app.media import DATA_DIR

    zip_path = DATA_DIR / "exports" / "jianying" / f"{uuid.uuid4().hex[:8]}.zip"
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    media_store.store_bytes(PNG, zip_path)
    rel = f"exports/jianying/{zip_path.name}"
    assert media_cache.sweep_export_objects() == 0
    with engine.begin() as conn:
        conn.execute(text("UPDATE media_objects SET uploaded_at='2020-01-01T00:00:00+00:00'"))
    assert media_cache.sweep_export_objects() == 1
    assert rel not in tos.objects and rel not in _ledger() and not zip_path.exists()
