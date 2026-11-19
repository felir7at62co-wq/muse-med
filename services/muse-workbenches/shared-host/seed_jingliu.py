"""Create the bound Muse operator as an ordinary user in the new Jingliu database."""
import json
import sys
from pathlib import Path
from app.auth import KnownUser
from app.db import get_session

profile = json.load(sys.stdin)
with get_session() as db:
    current = db.get(KnownUser, profile["id"])
    if current and (current.username != profile["username"] or current.role != "user"):
        raise ValueError("Unexpected existing native Jingliu user")
    if not current:
        db.add(KnownUser(user_id=profile["id"], username=profile["username"], display_name=profile["username"], role="user"))
        db.commit()
print("Jingliu account binding ready.")
