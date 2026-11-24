"""Run the native Muse script editor for the configured Workshop accounts."""
from os import environ
import re
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from .auth import User, get_current_user
from .script_editor import router

identifiers = environ["MUSE_SCRIPT_EDITOR_CANARY_USERS"].split(",")
if not all(re.fullmatch(r"[1-9][0-9]*", value) for value in identifiers):
    raise ValueError("Expected comma-separated Workshop account IDs")
owners = frozenset(int(value) for value in identifiers)
if len(owners) != len(identifiers):
    raise ValueError("Workshop account IDs must be unique")


async def require_canary_editor(user: Annotated[User, Depends(get_current_user)]) -> None:
    if user.id not in owners:
        raise HTTPException(403, {"code": "SCRIPT_EDITOR_CANARY", "message": "此剧本编辑器当前仅供中央 Muse 验证。"})


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router, dependencies=[Depends(require_canary_editor)])


@app.get("/health")
async def health():
    return {"ok": True}
