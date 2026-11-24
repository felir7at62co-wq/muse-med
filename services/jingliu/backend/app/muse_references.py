"""Read the studio's shared character references without assigning them to a production."""
from sqlalchemy import JSON, Column, String, Table, Text, func, select

from .db import Base, get_session

references = Table(
    "muse_character_references", Base.metadata,
    Column("catalog_id", String(255), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("file", String(72), nullable=False),
    Column("terms", Text, nullable=False),
    Column("details", JSON, nullable=False),
)


def public_item(row):
    details = row["details"]
    collection = "古装" if details["collection"] == "ancient" else "都市"
    traits = [collection, *details["appearance"], *details["tags"], details["artStyle"]]
    prompt = " · ".join(dict.fromkeys(value for value in traits if value))
    return {
        "asset_id": "mref-" + row["name"], "kind": "character", "name": row["name"],
        "image_url": "/fw/media/character-references/" + row["file"], "prompt": prompt,
        "reference_only": True, "reference": details, "mine": False, "visibility": "public",
        "my_asset_ids": [], "my_projects": [], "uses": 0, "created_at": None,
    }


def shared_page(native, *, kind, q, mine, with_image, scope, sort, limit, offset, importable_only):
    """Retain native filters and paging. Reference-only items have no project owner or uses."""
    args = dict(kind=kind, q=q, mine=mine, with_image=with_image, scope=scope, sort=sort)
    limit = max(1, min(int(limit or 120), 500))
    offset = max(0, int(offset or 0))
    if importable_only or mine or kind not in (None, "", "character") or (scope or "all").strip().lower() not in ("all", "others"):
        return native(**args, limit=limit, offset=offset)
    needle = (q or "").strip().casefold()
    condition = references.c.terms.contains(needle, autoescape=True)
    with get_session() as db:
        count = db.scalar(select(func.count()).select_from(references).where(condition))
        first = (sort or "").strip().lower() == "least_used"
        native_offset = max(0, offset - count) if first else offset
        page = native(**args, limit=limit, offset=native_offset)
        start = offset if first else max(0, offset - page["total"])
        size = limit if first else limit - len(page["items"])
        extra = []
        if size and start < count:
            rows = db.execute(select(references).where(condition).order_by(references.c.name, references.c.catalog_id)
                              .offset(start).limit(size)).mappings()
            extra = [public_item(row) for row in rows]
    items = extra + page["items"] if first else page["items"] + extra
    return {"total": page["total"] + count, "items": items[:limit]}
