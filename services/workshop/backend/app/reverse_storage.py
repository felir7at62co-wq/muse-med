"""Archive verified Muse materials in a private TOS prefix and publish the index last."""
import hashlib
import json
import mimetypes
from pathlib import Path
import re


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def local_file(root, relative):
    path = root / relative
    if not path.is_relative_to(root) or path.resolve() != path or not path.is_file():
        raise ValueError("反推素材路径无效")
    return path


def storage_prefix(value):
    prefix = value.rstrip("/")
    if not prefix or not all(re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in prefix.split("/")):
        raise ValueError("反推素材的 TOS 前缀无效")
    return prefix


def encode_catalog(catalog):
    return (json.dumps(catalog, ensure_ascii=False, sort_keys=True) + "\n").encode()


def put_verified(client, bucket, key, data, sha, size, mime):
    """Reconcile retries against object metadata and require a server-checked payload hash."""
    def existing():
        from tos.exceptions import TosServerError
        try:
            result = client.head_object(bucket, key)
        except TosServerError as error:
            if error.status_code != 404:
                raise
            return False
        if result.content_length != size or result.meta.get("sha256") != sha:
            raise ValueError("TOS 中已有内容不同的同名素材")
        return True

    if existing():
        return
    options = dict(content_sha256=sha, meta={"sha256": sha}, forbid_overwrite=True, content_type=mime)
    try:
        if isinstance(data, Path):
            client.put_object_from_file(bucket, key, str(data), **options)
        else:
            client.put_object(bucket, key, content=data, **options)
    except Exception:
        if not existing():
            raise
        return
    if not existing():
        raise ValueError("TOS 写入后的素材不可读")


def publish(directory, manifest, identity, target=None):
    """Return a stable private catalog; a partially uploaded set has no visible index."""
    catalog = {k: v for k, v in manifest.items() if k != "files"}
    catalog["files"] = []
    if target:
        client, bucket, prefix = target
        base = f"{storage_prefix(prefix)}/{identity}"
        catalog.update(bucket=bucket, manifestKey=f"{base}/manifest.json")
    for entry in manifest["files"]:
        path = local_file(directory, entry["path"])
        sha, size = entry["sha256"], entry["bytes"]
        if size != path.stat().st_size or sha != file_sha(path):
            raise ValueError("已核对的反推素材发生了变化")
        row = {"kind": entry["kind"], "name": path.name, "sha256": sha, "bytes": size}
        if target:
            key = f"{base}/{entry['kind']}/{sha}{path.suffix.lower()}"
            put_verified(client, bucket, key, path, sha, size, mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            row["key"] = key
        catalog["files"].append(row)
    if target:
        raw = encode_catalog(catalog)
        put_verified(client, bucket, catalog["manifestKey"], raw, hashlib.sha256(raw).hexdigest(), len(raw), "application/json")
    return catalog
