"""飞书机器人：在飞书私聊里跟镜流说话，由服务端 Agent 按**发消息的人**的身份办事。

两种收事件方式，飞书后台「事件配置 → 订阅方式」选哪种这里就配哪种（`feishu_bot_mode`）：

```
长连接（默认，飞书推荐）  后端用官方 SDK 主动连飞书；不需要公网地址与 Token/Encrypt Key
POST /feishu/events      事件地址方式（不在 /v2 下：飞书不带 Bearer，见下）
```

## 认人（用户裁定 2026-10-30：按「消息是谁发的」决定操作谁的项目）

事件里的发送者带 `union_id`（同一开发者下所有应用一致）。镜流用户每次飞书扫码登录时
`auth._remember_user` 把它写进 `known_users.feishu_union_id`，所以：

    发送者 union_id → known_users → 镜流 user_id → 该用户能进的项目

**没有「点链接完成绑定」这一步，也不需要**：绑定键就是飞书身份本身，持有链接证明不了
任何事。没登录过镜流的人，机器人回一句「先去网页或桌面端用飞书登录一次」。
这比一次性链接更不容易被冒用：链接会被转发，飞书身份不会。

## 权限

后台任务里没有请求上下文；`access` 对「没有调用者」的判定是 **owner + 看全部项目 + 不计费**
（`access.project_role` 第 2 条、`charge.should_charge`）。所以处理每条消息时**先**
`access.set_current_user(发送者)`，之后的项目可见性、档位、计费全部按这个人走，
与网页、桌面端是同一口径。模型拿到的项目由 runner 按 `run.user_id` 重新判档
（`agent.runner._role_of`），不信任消息里的任何 id。

- 默认只接私聊（`feishu_bot_allow_groups`）。群里开了也只按发送者办事，不接受代发。
- 认不出发送者（没有 union_id / 没登录过）一律拒绝，不降级成任何默认身份。
- 动手（新起一轮 / 插话 / 确认）要求编辑者以上，与 `agent_run` 路由的盖章一致。

## 花钱与确认

复用服务端 Agent 的同一套确认闸门（`agent.policy.needs_confirm`）。闸门挂起时
机器人把要确认的内容发过去，用户回「确认」或「取消」；超过 `feishu_bot_confirm_ttl_sec`
后回「确认」不再生效，这一步按「不批准」收尾。

## 审计

每条进出消息记一行 `feishu_bot_log`（open_id、union_id、user_id、项目、run、已花金额）。
工具调用本身照常落在 `agent_steps`（与桌面端、网页端的 Agent 同一张表），按 run_id 关联。

## 事件协议

明文或加密（AES-256-CBC，key = sha256(Encrypt Key)，iv = 密文前 16 字节）。填了 Encrypt Key
就要求加密并校验 `X-Lark-Signature = sha256(timestamp + nonce + encrypt_key + body)`；
Verification Token 一律比对。飞书 3 秒内收不到 200 会重推，所以收到即回 200、
后台处理，并按 `event_id` 去重。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import Float, Integer, String, Text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from . import access, drama_bridge, feishu_front
from .config import get_settings
from .db import Base, get_session
from .redact import redact_text

logger = logging.getLogger("fw.feishu_bot")

router = APIRouter(tags=["feishu-bot"])


# ---------------------------------------------------------------------------
# 表
# ---------------------------------------------------------------------------

class FeishuBotEvent(Base):
    """收到过的事件 id：飞书会重推，同一事件只处理一次。"""
    __tablename__ = "feishu_bot_events"
    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    received_at: Mapped[float] = mapped_column(Float)


class FeishuBotChat(Base):
    """每个发送者一行：当前项目、当前这一轮、待确认的事。"""
    __tablename__ = "feishu_bot_chats"
    open_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer)
    chat_id: Mapped[str] = mapped_column(String(64))
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    project_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 在等「确认/取消」的那一轮与截止时刻（epoch 秒）。
    confirm_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    confirm_expires_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: 上次「项目」列表的 id 顺序（JSON 数组），「切换 2」按它取。
    last_list: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 还没选项目时说的那句话：选好项目后接着办，不让用户再说一遍。
    pending_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 当前平台：空或 jingliu = 镜流，script = 剧本平台。
    platform: Mapped[str | None] = mapped_column(String(12), nullable=True)
    script_conversation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    script_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[float] = mapped_column(Float)


class FeishuBotLog(Base):
    """审计：每条进出消息一行。"""
    __tablename__ = "feishu_bot_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[float] = mapped_column(Float)
    open_id: Mapped[str] = mapped_column(String(64), index=True)
    union_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: in / out
    direction: Mapped[str] = mapped_column(String(4))
    kind: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    spent_fen: Mapped[int | None] = mapped_column(Integer, nullable=True)


# ---------------------------------------------------------------------------
# 事件协议
# ---------------------------------------------------------------------------

class EventRejected(Exception):
    """事件不可信（token/签名不对、该加密却没加密、解不开）。"""


def decrypt(encrypt_key: str, encrypted: str) -> dict:
    """解开 `{"encrypt": ...}` 里的密文。

    @raises EventRejected: 密文不是合法的 AES-256-CBC / PKCS7 / JSON。
    """
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    try:
        raw = base64.b64decode(encrypted)
        key = hashlib.sha256(encrypt_key.encode()).digest()
        dec = Cipher(algorithms.AES(key), modes.CBC(raw[:16])).decryptor()
        padded = dec.update(raw[16:]) + dec.finalize()
        unpad = padding.PKCS7(128).unpadder()
        plain = unpad.update(padded) + unpad.finalize()
        value = json.loads(plain.decode("utf-8"))
    except Exception as e:  # noqa: BLE001 — 任何一步失败都等于「不是飞书发的」
        raise EventRejected(f"事件解密失败：{type(e).__name__}") from None
    if not isinstance(value, dict):
        raise EventRejected("事件不是 JSON 对象")
    return value


def signature_ok(encrypt_key: str, timestamp: str, nonce: str, body: bytes, signature: str) -> bool:
    """`X-Lark-Signature` = sha256(timestamp + nonce + encrypt_key + 原始 body) 的十六进制。"""
    digest = hashlib.sha256((timestamp + nonce + encrypt_key).encode() + body).hexdigest()
    return hmac.compare_digest(digest, signature or "")


def open_event(body: bytes, headers: dict[str, str]) -> dict:
    """校验并取出事件正文（明文或已解密）。

    @raises EventRejected: 没开机器人、没配 token、token/签名不对、该加密却是明文。
    """
    s = get_settings()
    if not s.feishu_bot_enabled:
        raise EventRejected("飞书机器人未开启")
    if not s.feishu_bot_verification_token:
        raise EventRejected("开启了飞书机器人但没有配置 Verification Token")
    try:
        outer = json.loads(body.decode("utf-8"))
    except ValueError:
        raise EventRejected("事件不是 JSON") from None
    if not isinstance(outer, dict):
        raise EventRejected("事件不是 JSON 对象")
    if s.feishu_bot_encrypt_key:
        if not isinstance(outer.get("encrypt"), str):
            raise EventRejected("配置了 Encrypt Key，事件却没有加密")
        event = decrypt(s.feishu_bot_encrypt_key, outer["encrypt"])
        # 地址校验请求不带签名；其余事件必须带且对得上。
        if event.get("type") != "url_verification":
            if not signature_ok(s.feishu_bot_encrypt_key, headers.get("x-lark-request-timestamp", ""),
                                headers.get("x-lark-request-nonce", ""), body,
                                headers.get("x-lark-signature", "")):
                raise EventRejected("签名不对")
    else:
        event = outer
    token = event.get("token") if event.get("type") == "url_verification" \
        else (event.get("header") or {}).get("token")
    if not hmac.compare_digest(str(token or ""), s.feishu_bot_verification_token):
        raise EventRejected("Verification Token 不对")
    return event


def first_time(event_id: str) -> bool:
    """记下事件 id；之前见过返回 False。"""
    with get_session() as s:
        s.add(FeishuBotEvent(event_id=event_id[:64], received_at=time.time()))
        try:
            s.commit()
        except IntegrityError:
            s.rollback()
            return False
    return True


# ---------------------------------------------------------------------------
# 认人与发消息
# ---------------------------------------------------------------------------

def resolve_sender(sender_id: dict) -> dict | None:
    """飞书发送者 → 镜流用户 `{"id","username","role","display_name"}`；认不出返回 None。

    先按 union_id（登录时记下），再按租户 user_id（审批同步时记下）。角色取最近一次会话
    （含 `admin_user_ids` 本地提权），没有会话退到名录。
    """
    from .auth import AuthSession, KnownUser, effective_role

    union = (sender_id or {}).get("union_id") or ""
    tenant_uid = (sender_id or {}).get("user_id") or ""
    with get_session() as s:
        row = None
        if union:
            row = s.query(KnownUser).filter(KnownUser.feishu_union_id == union).first()
        if row is None and tenant_uid:
            row = s.query(KnownUser).filter(KnownUser.feishu_user_id == tenant_uid).first()
        if row is None:
            return None
        sess = (s.query(AuthSession).filter(AuthSession.user_id == row.user_id)
                .order_by(AuthSession.expires_at.desc()).first())
        role = effective_role(row.user_id, sess.role if sess else row.role)
        return {"id": row.user_id, "username": row.username, "role": role,
                "display_name": row.display_name or row.username}


def _send_sync(chat_id: str, text: str) -> None:
    from . import feishu_open
    feishu_open.call("POST", "/open-apis/im/v1/messages",
                     params={"receive_id_type": "chat_id"},
                     body={"receive_id": chat_id, "msg_type": "text",
                           "content": json.dumps({"text": text}, ensure_ascii=False)},
                     timeout=10.0)


async def reply(chat: dict, text: str, *, kind: str, run_id: str | None = None,
                spent_fen: int | None = None) -> None:
    """发一条文字并记审计。发送失败只记日志：用户那边看不到，但不该让处理流程崩掉。"""
    text = text[:4000]
    log(chat, "out", kind, text, run_id=run_id, spent_fen=spent_fen)
    try:
        await asyncio.to_thread(_send_sync, chat["chat_id"], text)
    except Exception as e:  # noqa: BLE001
        logger.warning("[feishu-bot] 发消息给 %s 失败：%r", chat.get("open_id"), e)


def log(chat: dict, direction: str, kind: str, text: str, *, run_id: str | None = None,
        spent_fen: int | None = None) -> None:
    with get_session() as s:
        s.add(FeishuBotLog(ts=time.time(), open_id=chat.get("open_id") or "",
                           union_id=chat.get("union_id"), user_id=chat.get("user_id"),
                           project_id=chat.get("project_id"), run_id=run_id or chat.get("run_id"),
                           direction=direction, kind=kind, text=text[:2000], spent_fen=spent_fen))
        s.commit()


# ---------------------------------------------------------------------------
# 会话状态
# ---------------------------------------------------------------------------

def load_chat(open_id: str, user_id: int, chat_id: str, union_id: str | None) -> dict:
    """取（或建）发送者的会话行。换了镜流账号（同一飞书身份重新绑到别人）时清空项目与轮次。"""
    with get_session() as s:
        row = s.get(FeishuBotChat, open_id)
        if row is None:
            row = FeishuBotChat(open_id=open_id, user_id=user_id, chat_id=chat_id, updated_at=time.time())
            s.add(row)
        elif row.user_id != user_id:
            row.user_id, row.project_id, row.project_title = user_id, None, None
            row.run_id, row.confirm_run_id, row.confirm_expires_at, row.last_list = None, None, None, None
            row.pending_text = None
            row.platform, row.script_conversation_id, row.script_run_id = None, None, None
        row.chat_id = chat_id
        idle = time.time() - row.updated_at
        row.updated_at = time.time()
        s.commit()
        return {"open_id": row.open_id, "idle_sec": idle, "platform": row.platform or "jingliu",
                "script_conversation_id": row.script_conversation_id, "script_run_id": row.script_run_id, "union_id": union_id, "user_id": row.user_id,
                "chat_id": row.chat_id, "project_id": row.project_id,
                "project_title": row.project_title, "run_id": row.run_id,
                "confirm_run_id": row.confirm_run_id, "confirm_expires_at": row.confirm_expires_at,
                "last_list": json.loads(row.last_list) if row.last_list else [],
                "pending_text": row.pending_text}


def save_chat(chat: dict, **fields: Any) -> None:
    chat.update(fields)
    with get_session() as s:
        row = s.get(FeishuBotChat, chat["open_id"])
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, json.dumps(v, ensure_ascii=False) if k == "last_list" else v)
        row.updated_at = time.time()
        s.commit()


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------

def my_projects(limit: int = 20) -> list[tuple[str, str]]:
    """当前调用者能进的项目（最近更新的在前）。"""
    from .db import Project
    with get_session() as s:
        q = access.visible_projects_query(s)
        order = getattr(Project, "updated_at", None) or getattr(Project, "created_at", None)
        if order is not None:
            q = q.order_by(order.desc())
        return [(p.id, p.title) for p in q.limit(limit).all()]


def pick_project(chat: dict, query: str) -> tuple[str, str] | str:
    """按序号（上次列表）、id、片名全等、片名包含（唯一）选项目；选不中返回原因。"""
    query = query.strip()
    mine = my_projects(200)
    if query.isdigit() and chat.get("last_list"):
        i = int(query) - 1
        if 0 <= i < len(chat["last_list"]):
            pid = chat["last_list"][i]
            hit = [p for p in mine if p[0] == pid]
            if hit:
                return hit[0]
    exact = [p for p in mine if p[0] == query or p[1] == query]
    if exact:
        return exact[0]
    part = [p for p in mine if query and query in p[1]]
    if len(part) == 1:
        return part[0]
    if len(part) > 1:
        return "有好几个片名都含「" + query + "」：" + "、".join(t for _, t in part[:5]) + "。请写全片名或用序号。"
    return f"没找到你能进的项目「{query}」。回复「项目」看列表。"


def role_in(project_id: str) -> str | None:
    with get_session() as s:
        return access.project_role(s, project_id)


# ---------------------------------------------------------------------------
# 处理一条消息
# ---------------------------------------------------------------------------

#: 机器人的 Agent 用的思考模型（用户 2026-11-01 裁定）。
AGENT_MODEL = "deepseek-flash"
#: 隔这么久没说话，下一件事开新的一轮：旧上下文和累计金额都不再带着。
NEW_RUN_IDLE_SEC = 1800
MAX_IMAGES = 4

_MENTION = re.compile(r"@_user_\d+\s*")

#: 每个发送者的消息按顺序处理（同一人连发两句不能并行起两轮）。
_LOCKS: dict[str, asyncio.Lock] = {}
#: 正在盯的 run（一轮只盯一次），以及后台任务的强引用（否则会被回收）。
_WATCHING: set[str] = set()
_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def _post_parts(content: dict) -> tuple[list[str], list[str]]:
    """富文本消息里的文字与图片。收到的结构可能带语言层（`{"zh_cn": {...}}`），也可能不带。"""
    body = content if "content" in content else next((v for v in content.values() if isinstance(v, dict)), {})
    texts, images = [str(body.get("title") or "")], []
    for line in body.get("content") or []:
        for node in line:
            if node.get("tag") == "text":
                texts.append(str(node.get("text") or ""))
            elif node.get("tag") == "img" and node.get("image_key"):
                images.append(str(node["image_key"]))
    return [t for t in texts if t], images


def message_parts(message: dict) -> tuple[str, list[str]] | None:
    """消息的文字和图片 key；既不是文字也不是图片时返回 None。"""
    kind = message.get("message_type")
    try:
        content = json.loads(message.get("content") or "{}")
    except ValueError:
        return None
    if kind == "text":
        return _MENTION.sub("", str(content.get("text") or "")).strip(), []
    if kind == "image":
        return "", [str(content.get("image_key") or "")]
    if kind == "post":
        texts, images = _post_parts(content)
        return _MENTION.sub("", "\n".join(texts)).strip(), images
    return None


def _image_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".jpg"


async def _see_image(message_id: str, image_key: str) -> str:
    """下载一张图、存进素材目录、让视觉模型描述。失败时如实写进消息，由模型告诉用户。"""
    from . import feishu_open
    from .media import UPLOAD_DIR
    from .providers.llm import LLMProvider

    try:
        data = await asyncio.to_thread(feishu_open.download_image, message_id, image_key)
        from .media_store import store_bytes_async
        dest = UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}{_image_ext(data)}"
        url = await store_bytes_async(data, dest)
    except Exception as e:  # noqa: BLE001
        logger.warning("[feishu-bot] 下载图片失败：%r", e)
        return f"[用户发来一张图片，但下载失败：{str(e)[:120]}]"
    try:
        seen = await LLMProvider().complete_vision(
            "描述这张图片，供不能看图的同事理解：画面内容、人物、文字原文。不超过 300 字。", "描述这张图片。", url)
    except Exception as e:  # noqa: BLE001
        logger.warning("[feishu-bot] 看图失败：%r", e)
        return f"[用户发来一张图片，地址 {url}，但现在看不了内容]"
    return f"[用户发来一张图片，地址 {url}。内容：{seen.strip()[:600]}]"


async def handle_event(event: dict) -> None:
    """处理一个已校验、已去重的 `im.message.receive_v1` 事件。"""
    ev = event.get("event") or {}
    sender = ev.get("sender") or {}
    message = ev.get("message") or {}
    sender_id = sender.get("sender_id") or {}
    open_id = sender_id.get("open_id") or ""
    chat_id = message.get("chat_id") or ""
    if sender.get("sender_type") != "user" or not open_id or not chat_id:
        return
    lock = _LOCKS.setdefault(open_id, asyncio.Lock())
    async with lock:
        await _handle(open_id, sender_id, chat_id, message)


async def _handle(open_id: str, sender_id: dict, chat_id: str, message: dict) -> None:
    s = get_settings()
    anon = {"open_id": open_id, "union_id": sender_id.get("union_id"), "user_id": None,
            "chat_id": chat_id, "project_id": None, "run_id": None}
    parts = message_parts(message)
    text = parts[0] if parts else None
    if message.get("chat_type") != "p2p" and not s.feishu_bot_allow_groups:
        # 群里一律静默：不回「我只在私聊里办事」。
        # 2026-11-09 起机器人被拉进了外部群（常读平台通知群），在那里发任何一句都是
        # 对第三方成员的打扰；用户明确要求不打扰群成员，所以这里只记账、不回复。
        log(anon, "in", "group_ignored", text or "")
        return
    user = resolve_sender(sender_id)
    if user is None:
        log(anon, "in", "unknown_sender", text or "")
        await reply(anon, "还认不出你是谁：请先在镜流（网页 " + s.feishu_bot_login_url
                    + " 或桌面端）用飞书扫码登录一次，然后再来找我。", kind="unbound")
        return
    # 之后的一切（项目可见性、档位、计费）都按这个人走。
    access.set_current_user(user)
    chat = load_chat(open_id, int(user["id"]), chat_id, sender_id.get("union_id"))
    if parts is None:
        log(chat, "in", "non_text", message.get("message_type") or "")
        await reply(chat, "这种消息我还看不了，发文字或图片吧。", kind="non_text")
        return
    text, images = parts
    seen = [await _see_image(str(message.get("message_id") or ""), key) for key in images[:MAX_IMAGES] if key]
    text = "\n".join([text, *seen]).strip()
    log(chat, "in", "text", text)
    if not text:
        return
    # 只有这几句绕过模型：花钱和找不回来的操作，只认用户的原话。
    cmd = text.rstrip("。.!！~～ ")
    if cmd in ("确认", "取消") and chat.get("confirm_run_id"):
        await _decide(chat, cmd == "确认")
        return
    if cmd in ("停止", "停") and await _active_run(chat):
        await _cancel(chat)
        return
    if cmd == "继续" and await _interrupted(chat):
        await _resume(chat)
        return
    await _front(chat, text)


def _fw_run(chat: dict):
    from .agent import store

    run = store.get_run(chat["run_id"]) if chat.get("run_id") else None
    return run if run is not None and run.user_id == chat["user_id"] else None


async def _active_run(chat: dict) -> bool:
    if chat["platform"] == "script":
        return await _script_run_status(chat) in ("queued", "running", "awaiting_approval")
    run = _fw_run(chat)
    return run is not None and run.status in ("pending", "running", "waiting_approval")


async def _interrupted(chat: dict) -> bool:
    if chat["platform"] == "script":
        return False
    run = _fw_run(chat)
    return run is not None and run.status == "interrupted"


async def _script_run_status(chat: dict) -> str | None:
    if not chat.get("script_run_id"):
        return None
    try:
        return (await drama_bridge.get_run(chat["union_id"] or "", chat["script_run_id"])).get("status")
    except drama_bridge.BridgeError:
        return None


async def _front(chat: dict, text: str) -> None:
    async def delegate(args: dict) -> dict:
        task = str(args.get("task") or text).strip() or text
        return await (_delegate_script(chat, task) if chat["platform"] == "script" else _delegate_jingliu(chat, task))

    async def list_projects(_args: dict) -> dict:
        mine = my_projects(20)
        save_chat(chat, last_list=[pid for pid, _ in mine])
        return {"projects": [{"no": i, "title": t} for i, (_, t) in enumerate(mine, 1)]}

    async def select_project(args: dict) -> dict:
        hit = pick_project(chat, str(args.get("query") or ""))
        if isinstance(hit, str):
            return {"ok": False, "error": hit}
        save_chat(chat, project_id=hit[0], project_title=hit[1], run_id=None,
                  confirm_run_id=None, confirm_expires_at=None)
        return {"ok": True, "project": hit[1]}

    async def switch_platform(args: dict) -> dict:
        platform = "script" if args.get("platform") == "script" else "jingliu"
        if platform == "script" and not drama_bridge.enabled():
            return {"ok": False, "error": "这个环境还没接通剧本平台"}
        save_chat(chat, platform=platform, confirm_run_id=None, confirm_expires_at=None)
        return {"ok": True, "platform": platform}

    pending = "有一步在等用户确认：他要回复「确认」或「取消」。" if chat.get("confirm_run_id") else ""
    try:
        said = await feishu_front.turn(chat, text, {"delegate": delegate, "list_projects": list_projects,
                                              "select_project": select_project, "switch_platform": switch_platform},
                                       pending=pending)
    except Exception as e:  # noqa: BLE001  模型挂了也要回一句，不能让用户干等
        logger.warning("[feishu-bot] 前台失败：%r", e)
        said = "我这边暂时连不上模型，过一会儿再试。"
    if said:
        await reply(chat, said, kind="front")


def _http_detail(e: HTTPException) -> str:
    d = e.detail
    if isinstance(d, dict):
        return str(d.get("message") or d)
    return str(d)


async def _run_background(background: BackgroundTasks) -> None:
    """跑路由排进 BackgroundTasks 的作业（它们继承本任务的调用者上下文）。"""
    _spawn(background())


def _can_act(chat: dict) -> str | None:
    """能不能让 Agent 动手；不能时返回给用户看的原因。"""
    role = role_in(chat["project_id"])
    if role is None:
        return "你已经不在这个项目里了。回复「项目」重新选。"
    if access._RANK[role] < access._RANK[access.ROLE_EDITOR]:
        return f"你在「{chat.get('project_title')}」里是{access._ROLE_CN.get(role, role)}，不能让 AI 动手。"
    return None


async def _delegate_jingliu(chat: dict, task: str) -> dict:
    from .routers import agent_run

    if not chat.get("project_id"):
        mine = my_projects(20)
        if len(mine) != 1:
            save_chat(chat, last_list=[pid for pid, _ in mine])
            return {"ok": False, "need": "project",
                    "projects": [{"no": i, "title": t} for i, (_, t) in enumerate(mine, 1)],
                    "next": "请用户选一个项目，再 select_project、delegate。没有项目就告诉他去网页或桌面端建一个。"}
        save_chat(chat, project_id=mine[0][0], project_title=mine[0][1])
    refused = _can_act(chat)
    if refused:
        return {"ok": False, "error": refused}
    pid = chat["project_id"]
    run = _fw_run(chat)
    if run is not None and run.project_id != pid:
        run = None
    if run is not None and run.status == "waiting_approval":
        return {"ok": False, "error": "这一轮在等用户确认，先回复「确认」或「取消」"}
    # 隔久了算另一件事，开新的一轮：旧上下文和累计金额都不再带着。换了思考模型的旧轮次同样不接着用。
    idle = run is not None and run.status in ("done", "failed", "cancelled") \
        and (chat.get("idle_sec", 0) > NEW_RUN_IDLE_SEC or run.model != AGENT_MODEL)
    background = BackgroundTasks()
    try:
        if run is None or idle:
            out = await agent_run.create_run(pid, agent_run.RunIn(goal=task, model=AGENT_MODEL), background)
            run_id = out.id
            save_chat(chat, run_id=run_id)
        else:
            await agent_run.say(pid, run.id, agent_run.SayIn(text=task[:2000]), background)
            run_id = run.id
    except HTTPException as e:
        return {"ok": False, "error": _http_detail(e)}
    await _run_background(background)
    _watch(chat, run_id)
    return {"ok": True, "project": chat.get("project_title"), "note": "Agent 已接手，结果它会自己发给用户"}


async def _delegate_script(chat: dict, task: str) -> dict:
    if chat.get("confirm_run_id"):
        return {"ok": False, "error": "这一轮在等用户确认，先回复「确认」或「取消」"}
    conv = None if chat.get("idle_sec", 0) > NEW_RUN_IDLE_SEC else chat.get("script_conversation_id")
    try:
        out = await drama_bridge.start_turn(chat["union_id"] or "", task, conv)
    except drama_bridge.BridgeError as e:
        return {"ok": False, "error": redact_text(str(e))}
    save_chat(chat, script_conversation_id=out["conversation_id"], script_run_id=out["run_id"])
    _spawn(_watch_script(dict(chat), out["run_id"]))
    return {"ok": True, "note": "剧本平台的 Agent 已接手，结果它会自己发给用户"}


async def _decide(chat: dict, ok: bool) -> None:
    from .agent import store
    from .routers import agent_run

    run_id = chat.get("confirm_run_id")
    if not run_id:
        await reply(chat, "现在没有要你确认的事。", kind="nothing_to_confirm")
        return
    expired = (chat.get("confirm_expires_at") or 0) < time.time()
    save_chat(chat, confirm_run_id=None, confirm_expires_at=None)
    if chat["platform"] == "script":
        approve = ok and not expired
        try:
            await drama_bridge.decide(chat["union_id"] or "", int(run_id), approve)
        except drama_bridge.BridgeError as e:
            await reply(chat, str(e), kind="confirm_failed")
            return
        await reply(chat, "好，继续。" if approve else "这次确认已过期，没有执行。要做的话再说一遍。" if ok else "好，这一步不做。",
                    kind="confirmed" if approve else "declined")
        _spawn(_watch_script(dict(chat), int(run_id)))
        return
    run = store.get_run(run_id)
    if run is None or run.status != "waiting_approval" or not chat.get("project_id"):
        await reply(chat, "这件事已经不用确认了（可能在网页上处理过）。", kind="confirm_stale")
        return
    refused = _can_act(chat)
    if refused:
        await reply(chat, refused, kind="refused")
        return
    if expired and ok:
        ok, reason, note = False, "飞书确认超时", "这次确认已过期，没有执行。要做的话请重新说一遍。"
    else:
        reason = "飞书回复确认" if ok else "飞书回复取消"
        note = "好，继续。" if ok else "好，这一步不做。"
    background = BackgroundTasks()
    try:
        await agent_run.approve(run.project_id, run_id, agent_run.ApproveIn(ok=ok, reason=reason), background)
    except HTTPException as e:
        await reply(chat, _http_detail(e), kind="confirm_failed")
        return
    await _run_background(background)
    await reply(chat, note, kind="confirmed" if ok else "declined", run_id=run_id)
    _watch(chat, run_id)


async def _cancel(chat: dict) -> None:
    from .agent import store
    from .routers import agent_run

    if chat["platform"] == "script":
        try:
            await drama_bridge.cancel(chat["union_id"] or "", chat["script_run_id"])
        except drama_bridge.BridgeError as e:
            await reply(chat, str(e), kind="stop_failed")
            return
        save_chat(chat, confirm_run_id=None, confirm_expires_at=None)
        await reply(chat, "已停止。", kind="stopped")
        return
    run = store.get_run(chat["run_id"]) if chat.get("run_id") else None
    if run is None or run.user_id != chat["user_id"]:
        await reply(chat, "现在没有在跑的这一轮。", kind="nothing_to_stop")
        return
    try:
        out = agent_run.cancel(run.project_id, run.id)
    except HTTPException as e:
        await reply(chat, _http_detail(e), kind="stop_failed")
        return
    save_chat(chat, confirm_run_id=None, confirm_expires_at=None)
    await reply(chat, "已停止。" if out.get("status") != "done" else str(out.get("note") or "已结束"),
                kind="stopped", run_id=run.id)


async def _resume(chat: dict) -> None:
    from .agent import store
    from .routers import agent_run

    run = store.get_run(chat["run_id"]) if chat.get("run_id") else None
    if run is None or run.user_id != chat["user_id"]:
        await reply(chat, "没有可以继续的这一轮。直接说要做什么就行。", kind="nothing_to_resume")
        return
    if run.status == "waiting_approval":
        await reply(chat, "这一轮在等你确认：回复「确认」或「取消」。", kind="awaiting")
        return
    refused = _can_act(chat)
    if refused:
        await reply(chat, refused, kind="refused")
        return
    background = BackgroundTasks()
    try:
        await agent_run.resume(run.project_id, run.id, agent_run.ResumeIn(), background)
    except HTTPException as e:
        await reply(chat, _http_detail(e), kind="resume_failed")
        return
    await _run_background(background)
    await reply(chat, "好，接着做。", kind="resumed", run_id=run.id)
    _watch(chat, run.id)


# ---------------------------------------------------------------------------
# 盯一轮，结束 / 要确认时回消息
# ---------------------------------------------------------------------------

def approval_text(payload: dict) -> str:
    """把审批挂起时的内容写成一段给人看的话。"""
    lines = [str(payload.get("question") or "这一步需要你确认：")]
    for c in (payload.get("calls") or [])[:8]:
        what = c.get("summary") or c.get("what") or c.get("tool")
        est = int(c.get("estimate_fen") or 0)
        lines.append(f"· {what}" + (f"（约 ¥{est / 100:.2f}）" if est else ""))
    total = int(payload.get("estimate_fen") or 0)
    if total:
        lines.append(f"合计约 ¥{total / 100:.2f}；这一轮已花 ¥{int(payload.get('spent_fen') or 0) / 100:.2f}。")
    return "\n".join(lines)


def _pending_approval(run_id: str) -> dict:
    from .agent import store
    for step in reversed(store.list_steps(run_id)):
        if step.kind == "approval" and step.approval == "pending":
            try:
                value = json.loads(step.args or "{}")
            except ValueError:
                value = {}
            return value if isinstance(value, dict) else {}
    return {}


def _last_seq(run_id: str) -> int:
    from .agent import store
    return store.next_seq(run_id) - 1


def _watch(chat: dict, run_id: str) -> None:
    from .agent import store

    if run_id in _WATCHING:
        return
    run = store.get_run(run_id)
    _WATCHING.add(run_id)
    _spawn(_watch_run(dict(chat), run_id, baseline=_last_seq(run_id),
                      start_status=run.status if run else None))


async def _watch_run(chat: dict, run_id: str, *, baseline: int, start_status: str | None,
                     interval: float = 3.0, limit: float = 7200.0) -> None:
    """盯一轮直到它结束或停下来要人。

    批准 / 继续之后，作业真正起跑之前 run 仍停在 `waiting_approval` / `interrupted`；
    这两种状态只有在**有了新步骤**（`baseline` 之后）或状态变过之后才算「又停下了」，
    否则会把刚回答过的问题再问一遍。
    """
    from .agent import store

    s = get_settings()
    started = time.time()
    told_progress = False
    moved = False
    first = store.get_run(run_id)
    start_spent = int(first.spent_fen or 0) if first else 0
    try:
        while time.time() - started < limit:
            await asyncio.sleep(interval)
            run = store.get_run(run_id)
            if run is None:
                return
            if not moved:
                moved = run.status != start_status or _last_seq(run_id) > baseline
                if not moved:
                    continue
            spent = int(run.spent_fen or 0)
            if run.status == "done":
                delta = max(0, spent - start_spent)
                await reply(chat, (run.summary or "做完了。") + (f"\n（这次花了 ¥{delta / 100:.2f}）" if delta else ""),
                            kind="done", run_id=run_id, spent_fen=spent)
                return
            if run.status == "failed":
                await reply(chat, "没做成：" + (run.error or "未知原因"), kind="failed", run_id=run_id, spent_fen=spent)
                return
            if run.status == "cancelled":
                return
            if run.status == "interrupted":
                await reply(chat, "这一轮中断了。回复「继续」接着做。", kind="interrupted", run_id=run_id, spent_fen=spent)
                return
            if run.status == "waiting_approval":
                save_chat(chat, confirm_run_id=run_id,
                          confirm_expires_at=time.time() + max(30, int(s.feishu_bot_confirm_ttl_sec)))
                minutes = max(1, int(s.feishu_bot_confirm_ttl_sec) // 60)
                await reply(chat, approval_text(_pending_approval(run_id))
                            + f"\n回复「确认」继续，回复「取消」不做（{minutes} 分钟内有效）。",
                            kind="ask_confirm", run_id=run_id, spent_fen=spent)
                return
            if not told_progress and time.time() - started > s.feishu_bot_progress_after_sec:
                told_progress = True
                await reply(chat, "还在做，做完告诉你。", kind="progress", run_id=run_id)
        await reply(chat, "这一轮跑得很久，我先不盯了。去网页上看进度。", kind="watch_timeout", run_id=run_id)
    except Exception as e:  # noqa: BLE001 — 盯梢失败不能影响这一轮本身
        logger.warning("[feishu-bot] 盯 run %s 失败：%r", run_id, e)
    finally:
        _WATCHING.discard(run_id)


async def _watch_script(chat: dict, run_id: int, *, interval: float = 3.0, limit: float = 7200.0) -> None:
    """盯剧本平台的一轮：结束发结果，要确认时把内容发过去。"""
    s = get_settings()
    started = time.time()
    told_progress = False
    try:
        while time.time() - started < limit:
            await asyncio.sleep(interval)
            run = await drama_bridge.get_run(chat["union_id"] or "", run_id)
            status = run.get("status")
            if status == "done":
                await reply(chat, run.get("final_text") or "做完了。", kind="done")
                return
            if status == "failed":
                await reply(chat, "没做成：" + str(run.get("error") or "未知原因"), kind="failed")
                return
            if status in ("canceled", "cancelled"):
                return
            if status == "awaiting_approval":
                asks = [a for a in run.get("approvals") or [] if a.get("status") == "pending"]
                if not asks:
                    continue
                save_chat(chat, confirm_run_id=str(run_id),
                          confirm_expires_at=time.time() + max(30, int(s.feishu_bot_confirm_ttl_sec)))
                body = "\n".join(str(a.get("description") or a.get("tool")) for a in asks)
                minutes = max(1, int(s.feishu_bot_confirm_ttl_sec) // 60)
                await reply(chat, f"{body}\n回复「确认」继续，回复「取消」不做（{minutes} 分钟内有效）。", kind="ask_confirm")
                return
            if not told_progress and time.time() - started > s.feishu_bot_progress_after_sec:
                told_progress = True
                await reply(chat, "还在做，做完告诉你。", kind="progress")
        await reply(chat, "这一轮跑得很久，我先不盯了。去网页上看进度。", kind="watch_timeout")
    except Exception as e:  # noqa: BLE001  盯梢失败不能影响这一轮本身
        logger.warning("[feishu-bot] 盯剧本平台 run %s 失败：%r", run_id, e)


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@router.post("/feishu/events")
async def feishu_events(request: Request) -> JSONResponse:
    body = await request.body()
    try:
        event = open_event(body, {k.lower(): v for k, v in request.headers.items()})
    except EventRejected as e:
        logger.warning("[feishu-bot] 拒收事件：%s", e)
        return JSONResponse({"msg": "rejected"}, status_code=403)
    if event.get("type") == "url_verification":
        return JSONResponse({"challenge": event.get("challenge")})
    return JSONResponse({"msg": _accept(event)})


async def _handle_safely(event: dict) -> None:
    try:
        await handle_event(event)
    except Exception as e:  # noqa: BLE001 — 一条消息处理失败不能拖垮事件入口
        logger.exception("[feishu-bot] 处理事件失败：%r", e)


# ---------------------------------------------------------------------------
# 长连接（飞书推荐的收事件方式）
# ---------------------------------------------------------------------------
#
# 官方 SDK 的长连接客户端是阻塞的、自带事件循环（模块级 `loop`），所以放在独立线程里跑，
# 收到事件后交回后端主循环处理——与事件地址走同一条 `_accept`（类型过滤、去重、后台处理）。
# 不用 SDK 的事件模型：它只调 `do_without_validation(原始字节)`，这里直接解析成与
# 事件地址同形的 `{"schema","header","event"}`，两种方式共用一套处理代码。

class _RawEventHandler:
    """SDK 只需要这一个方法；返回 None = 回飞书 200。"""

    def __init__(self, main_loop: asyncio.AbstractEventLoop) -> None:
        self._loop = main_loop

    def do_without_validation(self, payload: bytes) -> None:
        try:
            event = json.loads(payload.decode("utf-8"))
        except ValueError:
            logger.warning("[feishu-bot] 长连接收到非 JSON 事件，已丢弃")
            return None
        if isinstance(event, dict):
            self._loop.call_soon_threadsafe(_accept, event)
        return None


def _accept(event: dict) -> str:
    """已确认来自飞书的事件：类型过滤、去重、交给后台处理。返回处理结论（给事件地址回包用）。"""
    header = event.get("header") or {}
    if header.get("event_type") != "im.message.receive_v1":
        return "ignored"
    event_id = str(header.get("event_id") or "")
    if not event_id or not first_time(event_id):
        return "duplicate"
    _spawn(_handle_safely(event))
    return "ok"


_LONG_CONNECTION: dict[str, Any] = {"thread": None}


def start_long_connection(main_loop: asyncio.AbstractEventLoop) -> bool:
    """按配置启动长连接；没开机器人、不是长连接模式或没配应用时什么都不做。返回是否启动。

    连不上（凭据错、网络断）由 SDK 自己按间隔重连，只记日志，不影响后端其他功能。
    """
    import sys
    import threading

    s = get_settings()
    if not s.feishu_bot_enabled or (s.feishu_bot_mode or "").strip() != "long_connection":
        return False
    if not (s.feishu_app_id and s.feishu_app_secret):
        logger.warning("[feishu-bot] 开了长连接但没配 FW_FEISHU_APP_ID / FW_FEISHU_APP_SECRET，不连")
        return False
    if _LONG_CONNECTION["thread"] is not None:
        return True
    if s.feishu_bot_sdk_path and s.feishu_bot_sdk_path not in sys.path:
        sys.path.append(s.feishu_bot_sdk_path)

    def _run() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            import lark_oapi as lark
            import lark_oapi.ws.client as ws_client
            ws_client.loop = loop          # SDK 的模块级循环是导入时取的那个，换成本线程的
            domain = lark.FEISHU_DOMAIN if "feishu" in (s.feishu_base_url or "feishu") else lark.LARK_DOMAIN
            client = lark.ws.Client(s.feishu_app_id, s.feishu_app_secret,
                                    event_handler=_RawEventHandler(main_loop),  # type: ignore[arg-type]
                                    # 不用 INFO：SDK 在 INFO 级把连接地址（含 access_key 与 ticket）整条写进日志。
                                    domain=domain, log_level=lark.LogLevel.WARNING)
            logger.info("[feishu-bot] 长连接启动")
            client.start()
        except ModuleNotFoundError:
            logger.error("[feishu-bot] 长连接需要官方 SDK：pip install --target %s lark-oapi==1.4.24",
                         s.feishu_bot_sdk_path)
        except Exception as e:  # noqa: BLE001 — 长连接线程挂了不能拖垮后端
            logger.exception("[feishu-bot] 长连接退出：%r", e)
        finally:
            _LONG_CONNECTION["thread"] = None

    thread = threading.Thread(target=_run, name="feishu-bot-ws", daemon=True)
    _LONG_CONNECTION["thread"] = thread
    thread.start()
    return True
