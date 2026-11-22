"""Test-only Jingliu studio for the desktop REAL composition tests.

Runs the Jingliu backend of this repository on a temporary SQLite database and data folder, with no object storage
and no `.env`, behind a `/fwp` prefix like the Muse gateway, with one signed-in user who owns one seeded project.

usage: python -I jingliu-server.py <backend dir> <data dir> <port> <seed.json>

seed.json: ``{"token", "project", "title", "characters": [...], "shots": [{"order", "episode", "file", "line",
"clip_in_sec", "clip_dur_sec", "speed", "duration_sec"}]}``; each ``file`` is copied into the studio's generated media.

Test-only route: ``POST /fwp/__test/shots/{order}/video {"file"}`` gives a shot a new video, as regenerating it would.
"""
import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

backend, data, port, seed_path = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4])
seed = json.loads(seed_path.read_text(encoding="utf-8"))
data.mkdir(parents=True, exist_ok=True)
for key in [k for k in os.environ if k.startswith("FW_") or k.lower().endswith("_proxy")]:
    os.environ.pop(key)
os.environ.update({"FW_DATABASE_URL": f"sqlite:///{data}/jingliu.db", "FW_DATA_DIR": str(data / "data"),
                   "FW_DB_SLOW_LOG": "0", "FW_AUTH_UPSTREAM": "https://login.invalid"})
sys.path.insert(0, backend)

from app import config  # noqa: E402

config.Settings.model_config["env_file"] = None
config.get_settings.cache_clear()

import pyJianYingDraft as draft  # noqa: E402

if not hasattr(draft.ScriptFile, "add_track"):
    # pyJianYingDraft 0.3.x renamed track and segment placement; the studio's install step maps them the same way.
    class ScriptFile(draft.ScriptFile):
        def __init__(self, width, height, fps):
            super().__init__(width, height, fps, maintrack_adsorb=True)

        def add_track(self, track_type, track_name=None):
            return self.append_track(draft.TrackSpec(track_type, track_name))

        def add_segment(self, segment, track_name=None):
            return super().add_segment(segment, track=track_name)

    draft.ScriptFile = ScriptFile

import app.main  # noqa: E402,F401  (registers every table)
from app.db import init_db  # noqa: E402

init_db()
from app.migrations import run_migrations  # noqa: E402

run_migrations()

from app.auth import AuthSession, _hash_token  # noqa: E402
from app.db import Asset, Project, Shot, get_session  # noqa: E402
from app.media import GENERATED_DIR  # noqa: E402

GENERATED_DIR.mkdir(parents=True, exist_ok=True)


def store(file: str) -> str:
    """Copy one video into the studio's generated media and return its stored address."""
    name = f"{uuid.uuid4().hex[:12]}{Path(file).suffix}"
    shutil.copyfile(file, GENERATED_DIR / name)
    return f"/fw/media/generated/{name}"


expires = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat()
with get_session() as s:
    s.add(AuthSession(token=_hash_token(seed["token"]), user_id=7, username="alice", role="user", expires_at=expires))
    s.add(Project(id=seed["project"], title=seed["title"], owner_id=7))
    for name in seed["characters"]:
        s.add(Asset(id=uuid.uuid4().hex[:12], project_id=seed["project"], kind="character", name=name))
    for row in seed["shots"]:
        s.add(Shot(id=uuid.uuid4().hex[:12], project_id=seed["project"], order=row["order"], episode=row["episode"],
                   script_ref=row["line"], video_url=store(row["file"]), adopted_version=1,
                   duration_sec=row["duration_sec"], clip_in_sec=row["clip_in_sec"], clip_dur_sec=row["clip_dur_sec"],
                   transform_meta=json.dumps({"speed": row["speed"]})))
    s.commit()

from fastapi import Body  # noqa: E402

from app.main import create_app  # noqa: E402

studio = create_app()


@studio.post("/__test/shots/{order}/video")
def regenerate(order: int, body: dict = Body(...)) -> dict:
    with get_session() as s:
        shot = s.query(Shot).filter(Shot.project_id == seed["project"], Shot.order == order).one()
        shot.video_url = store(body["file"])
        shot.adopted_version = (shot.adopted_version or 1) + 1
        s.commit()
        return {"video_url": shot.video_url}


async def gateway(scope, receive, send):
    """Strip the gateway's `/fwp` prefix, as the studio's reverse proxy does."""
    if scope["type"] in ("http", "websocket") and scope["path"].startswith("/fwp/"):
        scope = {**scope, "path": scope["path"][4:], "raw_path": scope.get("raw_path", b"/fwp")[4:]}
    await studio(scope, receive, send)


import uvicorn  # noqa: E402

uvicorn.run(gateway, host="127.0.0.1", port=port, log_level="warning")
