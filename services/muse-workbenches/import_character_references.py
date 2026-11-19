"""Import verified images and metadata into Jingliu's configured database and media directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from sqlalchemy import insert, select


def ingest(source, *, database, table, media):
    """Publish all rows in one transaction after every immutable image is verified."""
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    entries = manifest["entries"]
    if manifest["format"] != 1 or not isinstance(entries, list) or not entries:
        raise ValueError("Invalid reference manifest")
    files = {}
    rows = []
    ids = set()
    policy = dict.fromkeys(("canPublish", "canReuse", "canBind", "applyAllowed"), False)
    for entry in entries:
        name = entry["originalAssetId"]
        catalog_id = entry["catalogAssetId"]
        filename = entry["file"]
        digest = entry["sha256"]
        if (not re.fullmatch(r"[\w-]{1,128}", name, flags=re.ASCII)
                or catalog_id != "character:muse-character-reference-qa:" + name or catalog_id in ids
                or not re.fullmatch(r"[0-9a-f]{64}\.(jpg|png|webp)", filename) or filename.split(".")[0] != digest
                or entry["safety"] != policy or entry["collection"] not in ("ancient", "urban")):
            raise ValueError("Invalid character identity, image or reference policy")
        ids.add(catalog_id)
        data = (source / filename).read_bytes()
        if not (0 < len(data) == entry["bytes"] <= 10 * 1024 * 1024) or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Reference image differs from its verified original")
        files[filename] = data
        details = {k: entry[k] for k in ("catalogAssetId", "originalAssetId", "collection", "format", "metadataStatus",
                   "category", "setting", "artStyle", "era", "gender", "appearance", "tags", "safety", "sha256", "bytes")}
        collection = "古装 古代" if entry["collection"] == "ancient" else "都市 现代"
        terms = [name, collection, entry["collection"], entry["artStyle"], entry["category"], entry["setting"], entry["gender"],
                 *entry["era"], *entry["appearance"], *entry["tags"]]
        rows.append(dict(catalog_id=catalog_id, name=name, terms=" ".join(t for t in terms if t).casefold(), file=filename, details=details))
    table.create(database, checkfirst=True)
    target = media / "character-references"
    target.mkdir(mode=0o750, parents=True, exist_ok=True)
    created = 0
    with database.begin() as db:
        for row in rows:
            existing = db.execute(select(table).where(table.c.catalog_id == row["catalog_id"])).mappings().first()
            if existing is not None and dict(existing) != row:
                raise ValueError("A studio reference has changed since import: " + row["name"])
            if existing is None:
                db.execute(insert(table).values(**row))
                created += 1
        for filename, data in files.items():
            path = target / filename
            if path.exists():
                if path.read_bytes() != data:
                    raise ValueError("Existing media differs: " + filename)
                continue
            with tempfile.NamedTemporaryFile(dir=target, delete=False) as tmp:
                tmp.write(data)
            try:
                os.replace(tmp.name, path)
            finally:
                Path(tmp.name).unlink(missing_ok=True)
    return {"created": created, "verified": len(rows), "distinct_images": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    from app.config import get_settings
    from app.db import engine
    from app.muse_references import references
    print(json.dumps(ingest(args.source, database=engine, table=references, media=Path(get_settings().data_dir))))
