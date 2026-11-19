"""Serve a checked episode's materials to authorized Workshop editors."""
import asyncio
import hashlib
import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

from .auth import User, get_current_user
from .db import ScriptDraft, session_scope
from .muse_reverse import config, output_dir
from .reverse_storage import encode_catalog, local_file

router = APIRouter(prefix="/video", tags=["video"])


def require_reverse():
    try:
        config()
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(503, "工坊云端 Muse 视频反推尚未就绪，请管理员检查转写配置") from error


async def materials(draft_id, episode, user):
    async with session_scope() as session:
        draft = await session.get(ScriptDraft, draft_id)
        if not draft or (draft.user_id != user.id and user.role not in ("admin", "superadmin")):
            raise HTTPException(404, "找不到草稿")
        ref = (draft.outline or {}).get("muse_reverse", {}).get(str(episode))
        if not ref:
            raise HTTPException(404, "本集暂无 Muse 反推素材")
        owner = draft.user_id
    root = None
    if ref["storage"] == "tos":
        from .oss.client import get_client_internal
        def read_catalog():
            return get_client_internal().get_object(ref["bucket"], ref["manifestKey"]).read()
        raw = await asyncio.to_thread(read_catalog)
        catalog = json.loads(raw)
    else:
        cfg = json.loads(Path(os.environ["MUSE_WORKSHOP_REVERSE_CONFIG"]).read_text())
        root = output_dir(cfg, owner, draft_id, episode, ref["revision"])
        catalog = json.loads((root / "catalog.json").read_text())
        raw = encode_catalog(catalog)
    if (hashlib.sha256(raw).hexdigest() != ref["manifestSHA256"] or catalog["sessionId"] != ref["sessionId"]
            or catalog["sourceSHA256"] != ref["sourceSHA256"]):
        raise HTTPException(409, "素材与当前剧本版本不一致")
    return root, catalog


@router.get("/intake-options")
async def intake_options(user: User = Depends(get_current_user)):
    from .oss.client import is_configured
    require_reverse()
    return {"upload": "tos" if is_configured() else "server"}


@router.get("/jobs/{draft_id}/episodes/{episode}/materials")
async def list_materials(draft_id: int, episode: int, user: User = Depends(get_current_user)):
    _, catalog = await materials(draft_id, episode, user)
    return {"episode": episode, "recordedFrames": catalog["recordedFrames"], "warnings": catalog["warnings"],
            "files": [{"index": i, **{k: row[k] for k in ("name", "kind", "bytes", "sha256")}}
                      for i, row in enumerate(catalog["files"])]}


@router.get("/jobs/{draft_id}/episodes/{episode}/materials/{index}")
async def fetch_material(draft_id: int, episode: int, index: int, user: User = Depends(get_current_user)):
    root, catalog = await materials(draft_id, episode, user)
    if not 0 <= index < len(catalog["files"]):
        raise HTTPException(404, "找不到素材")
    item = catalog["files"][index]
    headers = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}
    if "key" in item:
        from tos import HttpMethodType
        from .oss.client import get_client_public
        signed = get_client_public().pre_signed_url(HttpMethodType.Http_Method_Get, catalog["bucket"], item["key"], expires=300)
        return RedirectResponse(signed.signed_url, headers=headers)
    manifest = json.loads((root / "materials.json").read_text())
    entry = manifest["files"][index]
    if entry["sha256"] != item["sha256"]:
        raise HTTPException(409, "素材版本已变更")
    return FileResponse(local_file(root, entry["path"]), filename=item["name"], headers=headers)
