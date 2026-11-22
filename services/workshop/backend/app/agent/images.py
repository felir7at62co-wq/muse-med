"""对话工坊的图片附件：落盘 + 元数据入库 + 按轮次组装成多模态消息。

## 为什么要有这个模块（2026-10-28 用户需求）

> "用户希望对话工坊中能给AI发送图片。最好支持粘贴/拖动到浏览器页面中上传"

在此之前对话工坊只吃 .txt/.md/.docx/.pdf 文本。用户想"让 AI 看这张图"，
只能自己把图里的东西描述一遍——而他们描述不清，这正是要图的原因。

## 两条硬约束决定了一切

### 1. 图片**不随对话历史**每轮重发
多模态消息是按轮次发的：这一轮想让它看到图，就得把图放进这一轮的 message。
如果按"历史里有图就带上"，那么第 20 轮会重新上传第 1~19 轮的所有图，
上下文和费用随轮数平方增长，很快就撞上游限制。

所以：图片只在**发送它的那一轮**喂给模型。之后的历史轮次里它只以一行
文字引用（`[图片: 名字]`）存在，模型靠对话文字回忆。用户要再看，重发即可。
这与 `doc_context` 处理长文档是同一个思路，只是取舍点不同（文档是检索注入）。

### 2. 入库前必须压缩
原图动辄 3~8MB，base64 再涨 4/3。实测把 1920px / 质量 75 的 JPEG 控制在
~300KB，看图任务完全够用（模型看到的不是印刷品）。不压缩会同时顶到
上游 payload 上限和本服务的内存。

## 模型支持

2026-10-28 在 dev 实测（同一张纯色测试图，问颜色）：
gemini-3.8/3.6/3.1-pro、gpt-6-sol、claude-opus-5-5、grok-4.7 **全部正确识别**。
即：现有所有文本渠道都支持 `image_url` 多模态输入，不需要为此新增渠道。
"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
import os
from pathlib import Path

from sqlalchemy import select

from ..db import session_scope
from ..db.models_phase5 import AgentImage

logger = logging.getLogger(__name__)

#: 图片落盘目录。与其它上传（draft-covers / themes）同放在 /app/uploads 下，
#: 这个目录是 compose 里 bind-mount 进来的持久卷。
IMAGE_DIR = (Path(os.environ["UPLOADS_DIR"]) / "chat-images")

#: 单张原图上限。10MB 与 .docx 上传保持一致，不必让用户记两套数字。
MAX_IMAGE_BYTES = 10 * 1024 * 1024
#: 压缩后的目标（超过就继续降质量）。300KB 是实测的经验值：
#: 再往上对识别质量没有可感提升，却明显拖慢每轮请求。
TARGET_BYTES = 300 * 1024
#: 最长边。1920 够看清界面截图里的文字，又不会让 token 爆掉。
MAX_DIM = 1920

#: 只收浏览器粘贴/拖拽最常见的这几种。不收 SVG —— 它可以内嵌脚本，
#: 而我们对外提供的是静态文件服务，没必要冒这个险。
ALLOWED_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
}


def _compress(raw: bytes) -> tuple[bytes, str, int, int]:
    """压到 TARGET_BYTES 以内，返回 (data, ext, width, height)。

    透明通道一律铺白底转 JPEG：模型看的是内容，不是 alpha；而带 alpha 的 PNG
    往往比 JPEG 大好几倍。GIF 只取第一帧（对话场景没有人在问动图）。
    """
    from PIL import Image

    img = Image.open(io.BytesIO(raw))
    # 动图/多帧只取第一帧 —— 后续帧对"看这张图"没有意义，还会让 frames 遍历很慢
    if getattr(img, "is_animated", False):
        img.seek(0)
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        bg.paste(rgba, mask=rgba.split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    if img.width > MAX_DIM or img.height > MAX_DIM:
        img.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)

    data = b""
    for quality in (85, 75, 65, 55, 45, 35):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        if len(data) <= TARGET_BYTES:
            break
    return data, "jpg", img.width, img.height


async def save_image(*, user_id: int, raw: bytes, filename: str,
                     mime: str, conversation_id: int | None = None) -> dict:
    """压缩 + 落盘 + 入库。返回给前端展示所需的元数据（不含正文）。

    ⚠️ 落盘失败必须显式报错，不能静默降级成"只存库里"——那会让这条消息
    看起来发出去了、模型却什么也没看到，是最难排查的一类故障。
    """
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"图片超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB 上限")
    if not raw:
        raise ValueError("图片为空")

    data, ext, w, h = await asyncio.to_thread(_compress, raw)

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    stored = f"{uuid.uuid4().hex}.{ext}"
    path = IMAGE_DIR / stored
    await asyncio.to_thread(path.write_bytes, data)

    async with session_scope() as s:
        row = AgentImage(
            user_id=user_id, conversation_id=conversation_id,
            filename=(filename or "image")[:255], stored_name=stored,
            mime="image/jpeg", byte_size=len(data), width=w, height=h,
        )
        s.add(row)
        await s.flush()
        img_id = row.id

    logger.info("chat image saved: id=%d user=%d %dx%d %dKB",
                img_id, user_id, w, h, len(data) // 1024)
    return {"id": img_id, "filename": filename or "image", "stored_name": stored,
            "width": w, "height": h, "byte_size": len(data)}


async def load_for_message(*, user_id: int, message_id: int) -> list[dict]:
    """取某条用户消息挂着的图片，返回 [{path, mime, filename}]。

    `user_id` 是越权闸门：图片行上记着上传者，只认本人。消息 id 在前端是
    可控参数，少这一道就能让任何登录用户读到别人的截图。
    """
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentImage).where(
                AgentImage.message_id == message_id,
                AgentImage.user_id == user_id,
            ).order_by(AgentImage.id)
        )).scalars().all()
        return [{"path": str(IMAGE_DIR / r.stored_name), "mime": r.mime,
                 "filename": r.filename} for r in rows]


async def bind_to_message(*, user_id: int, image_ids: list[int],
                          message_id: int, conversation_id: int) -> int:
    """把上传后待发的图片挂到刚落库的那条用户消息上。返回实际绑定数。

    只绑 `message_id IS NULL` 且属于本人的行 —— 防止有人把自己的图片 id
    塞进别人的会话里，也防止同一张图被重复绑到多条消息。
    """
    if not image_ids or not message_id:
        return 0
    async with session_scope() as s:
        res = await s.execute(
            AgentImage.__table__.update()
            .where(AgentImage.id.in_(image_ids),
                   AgentImage.user_id == user_id,
                   AgentImage.message_id.is_(None))
            .values(message_id=message_id, conversation_id=conversation_id)
        )
        return res.rowcount or 0


async def list_for_conversation(*, user_id: int, conversation_id: int,
                                message_ids: list[int]) -> dict[int, list[dict]]:
    """给历史回放用：一次查出这批消息各自挂着哪些图片。

    历史里图片**不重复喂给模型**，但界面上要能重新显示出来（用户翻回去
    看见一条没有图的消息会以为图丢了）。一次 IN 查询，不做 per-row 查询。
    """
    if not message_ids:
        return {}
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentImage).where(
                AgentImage.message_id.in_(message_ids),
                AgentImage.user_id == user_id,
            ).order_by(AgentImage.id)
        )).scalars().all()
        out: dict[int, list[dict]] = {}
        for r in rows:
            out.setdefault(r.message_id, []).append({
                "id": r.id, "filename": r.filename, "stored_name": r.stored_name,
                "width": r.width, "height": r.height, "byte_size": r.byte_size,
            })
        return out


def build_content(text: str, images: list[dict]) -> str | list[dict]:
    """把「文字 + 图片」组装成 LLM 认的 content。

    没有图片就返回**纯字符串**（保持老行为，别把每一条普通消息都变成数组）。
    有图片才给 OpenAI 兼容的多模态数组，图片走 base64 data URL ——
    `path` 是容器本地文件，模型侧访问不到，只能内联。
    """
    if not images:
        return text or ""

    import base64

    parts: list[dict] = []
    if text:
        parts.append({"type": "text", "text": text})
    for img in images:
        try:
            raw = Path(img["path"]).read_bytes()
        except OSError as e:
            # 文件没了（被清理/迁移漏了）：不要让整轮失败，退化成一行说明，
            # 模型至少知道"用户发过一张图但取不到"，比静默当没发过好。
            logger.warning("chat image missing: %s (%s)", img.get("path"), e)
            parts.append({"type": "text",
                          "text": f"[图片 {img.get('filename','')} 已不可读，请让用户重新发送]"})
            continue
        b64 = base64.b64encode(raw).decode()
        parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:{img.get('mime','image/jpeg')};base64,{b64}"},
        })
    return parts


def text_ref(names: list[str]) -> str:
    """图片在**后续轮次**的历史里留下的文字痕迹。

    只写文件名，不写内容 —— 这个字符串会进每轮上下文，必须足够短。
    """
    if not names:
        return ""
    return "【用户随消息附了图片：" + "、".join(names) + "】"


__all__ = [
    "IMAGE_DIR", "MAX_IMAGE_BYTES", "ALLOWED_MIME",
    "save_image", "load_for_message", "bind_to_message",
    "list_for_conversation", "build_content", "text_ref",
]
