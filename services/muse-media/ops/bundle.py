"""Create an immutable, credential-free deployment archive from reviewed source."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile


def bundle(media_root, archive):
    """Archive gateway and operations code, recording every included file hash."""
    if not (media_root / "gateway/Dockerfile").is_file():
        raise ValueError("gateway Dockerfile is missing")
    files = []
    for directory in ("gateway", "ops"):
        for file in sorted((media_root / directory).rglob("*")):
            if file.is_symlink() or not file.is_file() or "__pycache__" in file.parts:
                continue
            if file.name not in ("Dockerfile", ".dockerignore") and not file.name.endswith(".example.json") and file.suffix not in (".py", ".sh", ".yml", ".yaml", ".conf", ".md"):
                continue
            files.append((file.relative_to(media_root).as_posix(), file.read_bytes()))
    records = [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for name, data in files]
    source_hash = hashlib.sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    metadata = {"version": 1, "sourceSha256": source_hash,
                "image": "muse-company-media:" + source_hash[:16], "files": records}
    files.append(("bundle-inputs.json", (json.dumps(metadata, indent=2) + "\n").encode()))
    archive.parent.mkdir(parents=True, exist_ok=True)
    with archive.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as tar:
                for name, data in files:
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o644
                    tar.addfile(entry, io.BytesIO(data))
    return {**metadata, "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "archive": str(archive)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    result = bundle(args.media_root, args.archive)
    args.archive.with_suffix(".inputs.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("sourceSha256", "image", "archiveSha256", "archive")}))
