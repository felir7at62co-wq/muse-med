"""用户主题系统 + Admin预设背景管理"""
import io
import os
import uuid
import logging
from pathlib import Path
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import text

from ..db import session_scope
from ..auth import get_current_user, require_admin, User

router = APIRouter(prefix="/v1", tags=["theme"])
logger = logging.getLogger("theme")

# 容器内路径
UPLOAD_ROOT = Path("/app/uploads")
THEMES_DIR = UPLOAD_ROOT / "themes"
PRESETS_DIR = UPLOAD_ROOT / "preset-backgrounds"
for d in [THEMES_DIR, PRESETS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10MB
TARGET_BYTES = 3 * 1024 * 1024        # 目标压缩到3MB以内
MAX_DIM = 1920                        # 最大宽/高


def _compress_image(raw: bytes, target_bytes: int = TARGET_BYTES, max_dim: int = MAX_DIM) -> tuple[bytes, str]:
    """压缩图片,返回(data, extension)"""
    img = Image.open(io.BytesIO(raw))
    # RGBA转RGB
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode in ("RGBA", "LA"):
            bg.paste(img, mask=img.split()[-1])
        else:
            bg.paste(img.convert("RGB"))
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    
    # 限制分辨率
    if img.width > max_dim or img.height > max_dim:
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    
    # 尝试降质量压缩
    for quality in [85, 75, 65, 55, 45]:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        if len(data) <= target_bytes:
            return data, "jpg"
    return data, "jpg"  # 最低质量也返回


# ============ 用户主题 ============

class ThemeConfig(BaseModel):
    mode: str | None = None  # light/dark/auto
    primary_color: str | None = None   # #hex
    accent_color: str | None = None
    bg_type: str | None = None  # gradient/solid/image
    bg_value: str | None = None  # css值 or image url
    bg_opacity: float | None = None  # 蒙版透明度0-1
    bg_blur: float | None = None  # 模糊px


@router.get("/auth/me/theme")
async def get_theme(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        row = (await s.execute(
            text("SELECT theme_config FROM users WHERE id=:id"), {"id": user.id}
        )).first()
        return row[0] if row and row[0] else {}


@router.put("/auth/me/theme")
async def update_theme(payload: ThemeConfig, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        import json
        await s.execute(
            text("UPDATE users SET theme_config=:c WHERE id=:id"),
            {"c": json.dumps(payload.model_dump(exclude_none=True)), "id": user.id}
        )
        return {"ok": True}


@router.post("/auth/me/theme-bg")
async def upload_theme_bg(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """上传自定义背景图(10MB限制,压缩到3MB)"""
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"文件过大,最大10MB,实际{len(raw)/1024/1024:.1f}MB")
    
    try:
        compressed, ext = _compress_image(raw)
    except Exception as e:
        raise HTTPException(400, f"图片处理失败: {e}")
    
    # 每用户1张,覆盖旧的
    user_dir = THEMES_DIR / str(user.id)
    user_dir.mkdir(parents=True, exist_ok=True)
    # 清理旧图
    for old in user_dir.iterdir():
        try: old.unlink()
        except: pass
    
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    filepath = user_dir / fname
    filepath.write_bytes(compressed)
    
    url = f"/v1/uploads/themes/{user.id}/{fname}"
    
    # 更新theme_config
    async with session_scope() as s:
        import json
        row = (await s.execute(text("SELECT theme_config FROM users WHERE id=:id"), {"id": user.id})).first()
        cfg = row[0] if row and row[0] else {}
        if isinstance(cfg, str):
            cfg = json.loads(cfg)
        cfg["bg_type"] = "image"
        cfg["bg_value"] = url
        await s.execute(
            text("UPDATE users SET theme_config=:c WHERE id=:id"),
            {"c": json.dumps(cfg), "id": user.id}
        )
    
    return {
        "ok": True,
        "url": url,
        "original_size": len(raw),
        "compressed_size": len(compressed),
        "compression_ratio": round(len(compressed) / len(raw) * 100, 1),
    }


@router.get("/uploads/themes/{user_id}/{filename}")
async def serve_theme_bg(user_id: int, filename: str):
    filepath = THEMES_DIR / str(user_id) / filename
    if not filepath.exists():
        raise HTTPException(404)
    return FileResponse(filepath, media_type="image/jpeg")


# ============ Admin预设背景管理 ============

admin_router = APIRouter(prefix="/v1/admin-api/preset-backgrounds", tags=["admin-theme"])


class PresetBgIn(BaseModel):
    name: str
    tags: list[str] = []


@admin_router.get("")
async def list_presets(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("SELECT * FROM preset_backgrounds ORDER BY id DESC")
        )).mappings().all()
        return [dict(r) for r in rows]


@admin_router.post("")
async def upload_preset(
    name: str,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin)
):
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"文件过大,最大10MB")
    
    try:
        compressed, ext = _compress_image(raw)
        # 生成缩略图
        thumb_img = Image.open(io.BytesIO(compressed))
        thumb_img.thumbnail((400, 300), Image.LANCZOS)
        buf = io.BytesIO()
        thumb_img.convert("RGB").save(buf, format="JPEG", quality=75)
        thumb_bytes = buf.getvalue()
    except Exception as e:
        raise HTTPException(400, f"图片处理失败: {e}")
    
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    thumb_fname = f"thumb_{fname}"
    (PRESETS_DIR / fname).write_bytes(compressed)
    (PRESETS_DIR / thumb_fname).write_bytes(thumb_bytes)
    
    url = f"/v1/uploads/preset-backgrounds/{fname}"
    thumb_url = f"/v1/uploads/preset-backgrounds/{thumb_fname}"
    
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO preset_backgrounds (name, url, thumbnail_url, created_by)
                    VALUES (:n, :u, :t, :uid) RETURNING id"""),
            {"n": name, "u": url, "t": thumb_url, "uid": admin.id}
        )
        return {"ok": True, "id": result.scalar_one(), "url": url}


@admin_router.delete("/{bg_id}")
async def delete_preset(bg_id: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        row = (await s.execute(
            text("SELECT url, thumbnail_url FROM preset_backgrounds WHERE id=:id"), {"id": bg_id}
        )).first()
        if row:
            for u in [row[0], row[1]]:
                if u:
                    fname = u.split("/")[-1]
                    fp = PRESETS_DIR / fname
                    try: fp.unlink()
                    except: pass
        await s.execute(text("DELETE FROM preset_backgrounds WHERE id=:id"), {"id": bg_id})
        return {"ok": True}


@router.get("/uploads/preset-backgrounds/{filename}")
async def serve_preset(filename: str):
    filepath = PRESETS_DIR / filename
    if not filepath.exists():
        raise HTTPException(404)
    return FileResponse(filepath, media_type="image/jpeg")


# 公开列表:用户挑选预设
public_router = APIRouter(prefix="/v1/public", tags=["public-theme"])

@public_router.get("/preset-backgrounds")
async def public_presets():
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT id, name, url, thumbnail_url, tags FROM preset_backgrounds
                    WHERE is_active=true ORDER BY id DESC""")
        )).mappings().all()
        return [dict(r) for r in rows]
