"""用户长期记忆模块 - 读写 + embedding + cosine 召回

## 剧本隔离（2026-10-10 修复）

**事故**：用户 246 在改《开局被圣女追杀》时，AI 把另一部小说《全球大考》的配角
「姬敛尘」当成这部剧的男二写进了人物小传。查生产库确认这是真的 —— 该用户记忆库
里有 32 条含「姬敛尘」的记录，来自 19 个不同会话（即 19 部不同的剧）。

**根因**：记忆按 user_id 存，`scope`/`scope_ref` 两个字段虽然建了表却从未写入，
265/561 条全是默认的 `global`；召回时也没有任何剧本过滤。于是"上一部剧的角色表"
可以完整流进"这一部剧"的提示词，模型无从分辨。

**修法（2026-10-10 定稿，Option C）**：记忆分成两级，而且**判定用白名单**：

  · **作者级**（``_AUTHOR_LEVEL_TYPES``）—— 写作偏好、风格、禁忌、期望字数。
    这些描述的是**这位作者**怎么写作，跨剧通用，任何对话都可召回。
  · **剧本级** —— **其余全部**：角色表、世界观、情节模式、事实(fact)、
    项目设定，以及**任何没登记过的新类型**。只在所属草稿的对话里召回。

⚠️ **为什么是白名单而不是黑名单**：最早写成"列几个剧本级类型"，实测立刻漏了
   —— ``fact`` 类型里装的大多是剧本专属内容（"用户正在创作《指尖逆袭成女王》，
   40 集"），291 条里 216 条如此；``preference`` 里也混进过角色名
   （"删减冗余角色如姬敛尘、石磊"）。黑名单**漏一个类型就等于没修**，而
   抽取提示词还会产出新的类型名（生产库里已有 project_* / format_standard 等
   11 种未登记取值）。白名单的失败方向相反：新类型默认被隔离，
   最坏结果只是"某条通用偏好没被复用"，不会串台。

⚠️ 没有草稿归属的对话（``draft_id is None``）**只召回作者级**。这条是硬边界：
   判断不出属于哪部剧时，宁可不给记忆，也不能拿别的剧的去猜。

**不丢失"问当前这部剧的设定"**：那部分本来就不靠记忆 ——
``context_loader.build_draft_context`` 直接从当前草稿的 ``outline`` 注入角色表
(``_characters_block``) 与世界观 (``_world_block``)。生产 2226 个草稿里
1658 个有角色表、1675 个有世界观，走的是这条路径，与记忆无关。
"""
from __future__ import annotations
import logging, json, math, re
from typing import Any
from sqlalchemy import text as sql_text
from ..db import session_scope
from ..models.embed import embed_texts

logger = logging.getLogger("agent.memory")

#: **作者级**记忆 —— 描述"这位作者怎么写作"而非"这部剧是什么"。跨剧通用。
#:
#: ⚠️ 这是**白名单**：不在表里的类型一律按剧本级隔离，包括未来新加的类型。
#: 原因见模块文档 —— 黑名单漏一个类型等于没修，白名单的失败方向相反（只是
#: 少复用一条通用偏好，不会串台）。
#:
#: 刻意**不收录** fact / character_template / world_setting / plot_pattern 等：
#: 生产实测 fact 里 216/291 条是剧本专属（"正在创作《XX》，40集"），
#: preference 里也混过角色名，故宁缺毋滥。
_AUTHOR_LEVEL_TYPES = frozenset({
    "preference", "habit", "style_summary", "style", "style_pattern",
    "forbidden_topics", "preferred_length", "format_standard",
})


def scope_for_type(mem_type: str, draft_id: int | None) -> tuple[str, str | None]:
    """按记忆类型决定它该落在哪一级作用域。

    返回 (scope, scope_ref)。**作者级**类型 → global；
    **其余一切**（含未知类型）→ 剧本级，需带 scope_ref。

    剧本级但拿不到 draft_id 时退回 global：宁可漏隔离一部分，也不能让
    scope_ref 为空 —— 那会让所有剧的这类记忆互相可见，比修复前更糟。
    """
    if mem_type in _AUTHOR_LEVEL_TYPES:
        return "global", None
    if draft_id is not None:
        return "draft", str(draft_id)
    return "global", None


def _scope_clause(draft_id: int | None, where: list[str], params: dict) -> None:
    """把"本次允许看到哪些记忆"追加进 where。

    这是隔离的唯一收口点 —— 召回与列举都走它，避免两处各写一份判据而漂移。

    **判据以类型为准，scope_ref 只负责收窄**：

      · 作者级类型           → 永远可召回（跨剧通用）
      · 剧本级类型           → 仅当 scope='draft' 且 scope_ref 正好等于当前草稿

    ⚠️ 这里**刻意不完全依赖 scope 列**。存量库里有一大批剧本级记忆因为推不出
    归属仍是 ``global``（生产 9,368 条：它们的来源会话本身没绑草稿）。如果只判
    ``scope='global' 放行``，这批会照旧跨剧流动 —— 等于没修。改成"按类型判"以后，
    它们在任何没有匹配 scope_ref 的地方都召回不出来，**自动失效**，
    不必依赖回填是否跑过、跑得全不全。
    """
    params["at"] = sorted(_AUTHOR_LEVEL_TYPES)
    if draft_id is not None:
        where.append("(type = ANY(:at) OR (scope = 'draft' AND scope_ref = :dr))")
        params["dr"] = str(draft_id)
    else:
        # 没有草稿归属 → 只能看作者级记忆。剧本级的一条都不给。
        where.append("type = ANY(:at)")

PII_PATTERNS = [
    re.compile(r"\b1[3-9]\d{9}\b"),  # 手机号
    re.compile(r"\b\d{17}[\dXx]\b"),  # 身份证
    re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),  # 邮箱
]

def _sanitize_pii(s: str) -> str:
    if not s: return s
    for p in PII_PATTERNS:
        s = p.sub("[PII]", s)
    return s

def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b): return 0.0
    dot = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(x*x for x in b))
    if na == 0 or nb == 0: return 0.0
    return dot/(na*nb)

async def _embed_one(text: str) -> tuple[list[float] | None, str]:
    try:
        vecs = await embed_texts([text])
        if vecs and len(vecs) > 0 and vecs[0]:
            import os
            return vecs[0], os.environ.get("EMBED_MODEL", "text-embedding-v3")
    except Exception as e:
        logger.warning("embed failed: %s", e)
    return None, ""

async def get_or_create_profile(user_id: int) -> dict:
    async with session_scope() as s:
        row = (await s.execute(sql_text("SELECT * FROM user_profiles WHERE user_id=:u"), {"u": user_id})).mappings().first()
        if row: return dict(row)
        await s.execute(sql_text("INSERT INTO user_profiles (user_id) VALUES (:u) ON CONFLICT DO NOTHING"), {"u": user_id})
        row = (await s.execute(sql_text("SELECT * FROM user_profiles WHERE user_id=:u"), {"u": user_id})).mappings().first()
        return dict(row) if row else {"user_id": user_id}

async def update_profile(user_id: int, **patches) -> dict:
    """部分字段更新; patches 中 None 值会被忽略."""
    if not patches: return await get_or_create_profile(user_id)
    await get_or_create_profile(user_id)
    cols = []
    params = {"u": user_id}
    for k, v in patches.items():
        if v is None: continue
        cols.append(f"{k} = :{k}")
        params[k] = v
    if not cols: return await get_or_create_profile(user_id)
    cols.append("updated_at = NOW()")
    sql = f"UPDATE user_profiles SET {', '.join(cols)} WHERE user_id = :u"
    async with session_scope() as s:
        await s.execute(sql_text(sql), params)
    return await get_or_create_profile(user_id)

async def insert_memory(
    user_id: int, *, type: str, content: str,
    title: str | None = None, scope: str | None = None, scope_ref: str | None = None,
    importance: int = 5, source_conv_id: int | None = None, source_message_id: int | None = None,
    pinned: bool = False, draft_id: int | None = None,
) -> int:
    """写入一条记忆。

    ``draft_id``：这条记忆是从哪部剧里提炼出来的。**决定它的可见范围** ——
    世界观/角色/情节类会被标成 ``scope='draft'``，只在该草稿的对话里召回；
    偏好类仍是 ``global``，跨剧通用。不传 draft_id 时剧本级类型退回 global。
    """
    content = _sanitize_pii(content or "")
    if not content.strip(): return 0
    # scope 可由调用方显式指定（用户手动建记忆时的选择）；否则按类型自动判定。
    if scope is None:
        scope, auto_ref = scope_for_type(type, draft_id)
        if scope_ref is None:
            scope_ref = auto_ref
    # 去重: 简单按 content prefix 比对(避免每次都 embed)
    async with session_scope() as s:
        existing = (await s.execute(sql_text("""
            SELECT id, content FROM user_memories
            WHERE user_id=:u AND archived=FALSE AND type=:t
              AND substring(content for 80) = substring(:c for 80)
            LIMIT 1"""), {"u": user_id, "t": type, "c": content})).first()
        if existing:
            await s.execute(sql_text("UPDATE user_memories SET hit_count = hit_count+1, last_accessed_at=NOW() WHERE id=:i"), {"i": existing[0]})
            return existing[0]
    emb, emb_model = await _embed_one(content)
    async with session_scope() as s:
        result = await s.execute(sql_text("""
            INSERT INTO user_memories
              (user_id, type, scope, scope_ref, title, content, embedding, embedding_model,
               source_conv_id, source_message_id, importance, pinned)
            VALUES
              (:u, :t, :sc, :sr, :ti, :ct, :emb, :em, :scv, :sm, :imp, :pin)
            RETURNING id"""),
            {"u": user_id, "t": type, "sc": scope, "sr": scope_ref, "ti": title, "ct": content,
             "emb": emb, "em": emb_model, "scv": source_conv_id, "sm": source_message_id,
             "imp": importance, "pin": pinned})
        new_id = result.scalar()
    logger.info("memory inserted: user=%d type=%s id=%d", user_id, type, new_id)
    return new_id

async def list_memories(user_id: int, *, type: str | None = None, archived: bool = False,
                        limit: int = 100, offset: int = 0, search: str | None = None,
                        draft_id: int | None = None, all_scopes: bool = False) -> list[dict]:
    """列出记忆。

    ``all_scopes=True``（管理界面用）：返回该用户的全部记忆，含别的剧的 ——
    设置页要让用户看见并管理自己所有记忆，隔离只针对**注入模型**的那条路径。
    ``all_scopes=False``（默认，注入用）：只返回当前剧本可见的那些。
    """
    where = ["user_id=:u"]
    params = {"u": user_id, "lim": limit, "off": offset}
    if not archived: where.append("archived=FALSE")
    if type: where.append("type=:t"); params["t"] = type
    if search: where.append("content ILIKE :s"); params["s"] = f"%{search}%"
    if not all_scopes:
        _scope_clause(draft_id, where, params)
    sql = f"""SELECT id, type, scope, scope_ref, title, content, importance, hit_count, pinned,
                     archived, created_at, last_accessed_at
              FROM user_memories WHERE {' AND '.join(where)}
              ORDER BY pinned DESC, importance DESC, created_at DESC
              LIMIT :lim OFFSET :off"""
    async with session_scope() as s:
        rows = (await s.execute(sql_text(sql), params)).mappings().all()
        return [dict(r) for r in rows]

async def update_memory(user_id: int, mem_id: int, **patches) -> dict | None:
    cols, params = [], {"u": user_id, "i": mem_id}
    for k, v in patches.items():
        if v is None: continue
        if k in ("title", "content", "type", "importance", "pinned", "archived"):
            cols.append(f"{k} = :{k}"); params[k] = v
    if not cols: return None
    if "content" in patches:
        emb, emb_model = await _embed_one(patches["content"] or "")
        cols.append("embedding = :_emb"); params["_emb"] = emb
        cols.append("embedding_model = :_em"); params["_em"] = emb_model
    sql = f"UPDATE user_memories SET {', '.join(cols)} WHERE user_id=:u AND id=:i RETURNING id"
    async with session_scope() as s:
        r = await s.execute(sql_text(sql), params)
        if not r.scalar(): return None
    rows = await list_memories(user_id, archived=True)
    return next((m for m in rows if m["id"] == mem_id), None)

async def delete_memory(user_id: int, mem_id: int) -> bool:
    async with session_scope() as s:
        r = await s.execute(sql_text("UPDATE user_memories SET archived=TRUE WHERE user_id=:u AND id=:i"), {"u": user_id, "i": mem_id})
        return (r.rowcount or 0) > 0

async def recall_memories(user_id: int, query: str, top_k: int = 8,
                          types: list[str] | None = None,
                          draft_id: int | None = None) -> list[dict]:
    """混合召回: 向量相似度 + importance/pinned 加权。

    **只召回当前剧本可见的记忆** —— 见模块文档「剧本隔离」。
    draft_id 为 None 时只给用户级(global)记忆，绝不跨剧取角色表。
    """
    profile = await get_or_create_profile(user_id)
    if not profile.get("memory_enabled", True): return []
    async with session_scope() as s:
        params = {"u": user_id}
        where = ["user_id=:u", "archived=FALSE"]
        if types:
            where.append("type = ANY(:tp)"); params["tp"] = types
        _scope_clause(draft_id, where, params)
        rows = (await s.execute(sql_text(f"""
            SELECT id, type, scope, scope_ref, title, content, embedding, importance, hit_count, pinned
            FROM user_memories WHERE {' AND '.join(where)}
            ORDER BY pinned DESC, created_at DESC LIMIT 500"""), params)).mappings().all()
    if not rows: return []
    q_emb, _ = await _embed_one(query)
    scored = []
    for r in rows:
        d = dict(r)
        emb = d.get("embedding")
        cos = _cosine(q_emb, list(emb)) if (q_emb and emb) else 0.0
        score = 0.6*cos + 0.2*(d["importance"]/10.0) + (0.2 if d["pinned"] else 0.0)
        d["score"] = score
        d["cosine"] = cos
        scored.append(d)
    scored.sort(key=lambda x: x["score"], reverse=True)
    top = scored[:top_k]
    if top:
        ids = [t["id"] for t in top]
        async with session_scope() as s:
            await s.execute(sql_text("UPDATE user_memories SET hit_count=hit_count+1, last_accessed_at=NOW() WHERE id = ANY(:ids)"), {"ids": ids})
    return top

async def insert_snippet(user_id: int, *, content: str, category: str = "other",
                          source_type: str = "manual", source_id: int | None = None,
                          rating: int = 7, tags: list[str] | None = None) -> int:
    content = _sanitize_pii(content)
    if not content.strip(): return 0
    emb, emb_model = await _embed_one(content)
    async with session_scope() as s:
        r = await s.execute(sql_text("""
            INSERT INTO user_snippets (user_id, source_type, source_id, category, content,
                                       embedding, embedding_model, rating, tags)
            VALUES (:u, :st, :si, :ca, :ct, :emb, :em, :ra, :tg) RETURNING id"""),
            {"u": user_id, "st": source_type, "si": source_id, "ca": category, "ct": content,
             "emb": emb, "em": emb_model, "ra": rating, "tg": tags or []})
        return r.scalar()

async def list_snippets(user_id: int, category: str | None = None, limit: int = 50) -> list[dict]:
    where = ["user_id=:u"]; params = {"u": user_id, "lim": limit}
    if category: where.append("category=:c"); params["c"] = category
    async with session_scope() as s:
        rows = (await s.execute(sql_text(f"""
            SELECT id, source_type, source_id, category, content, rating, tags, created_at
            FROM user_snippets WHERE {' AND '.join(where)}
            ORDER BY rating DESC, created_at DESC LIMIT :lim"""), params)).mappings().all()
        return [dict(r) for r in rows]

async def delete_snippet(user_id: int, sid: int) -> bool:
    async with session_scope() as s:
        r = await s.execute(sql_text("DELETE FROM user_snippets WHERE user_id=:u AND id=:i"), {"u": user_id, "i": sid})
        return (r.rowcount or 0) > 0

async def recall_snippets(user_id: int, query: str, top_k: int = 3, category: str | None = None) -> list[dict]:
    rows = await list_snippets(user_id, category=category, limit=200)
    if not rows: return []
    q_emb, _ = await _embed_one(query)
    if not q_emb: return rows[:top_k]
    async with session_scope() as s:
        all_with_emb = (await s.execute(sql_text("""
            SELECT id, content, embedding, category, rating
            FROM user_snippets WHERE user_id=:u LIMIT 500"""), {"u": user_id})).mappings().all()
    scored = []
    for r in all_with_emb:
        d = dict(r)
        emb = d.get("embedding")
        cos = _cosine(q_emb, list(emb)) if emb else 0.0
        d["score"] = 0.7*cos + 0.3*((d.get("rating") or 5)/10.0)
        scored.append(d)
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]

def render_profile_block(profile: dict) -> str:
    if not profile: return ""
    parts = []
    if profile.get("preferred_genres"):
        parts.append(f"偏好题材: {', '.join(profile['preferred_genres'])}")
    if profile.get("forbidden_topics"):
        parts.append(f"忌讳: {', '.join(profile['forbidden_topics'])}")
    if profile.get("preferred_length"):
        parts.append(f"期望章节字数: {profile['preferred_length']}")
    if profile.get("preferred_pace"):
        parts.append(f"节奏偏好: {profile['preferred_pace']}")
    if profile.get("style_summary"):
        parts.append(f"写作风格: {profile['style_summary']}")
    if profile.get("tone_keywords"):
        parts.append(f"语气关键词: {', '.join(profile['tone_keywords'])}")
    if not parts: return ""
    return "==== 用户长期画像 ====\n" + "\n".join(parts)

def render_memories_block(memories: list[dict]) -> str:
    if not memories: return ""
    lines = ["==== 用户偏好和历史 (基于过往对话提炼) ===="]
    for m in memories:
        prefix = "[置顶] " if m.get("pinned") else ""
        ttl = f"《{m['title']}》 " if m.get("title") else ""
        lines.append(f"- {prefix}{ttl}{m['content']}")
    return "\n".join(lines)

def render_snippets_block(snippets: list[dict]) -> str:
    if not snippets: return ""
    lines = ["==== 用户优秀片段 (参考风格, 不要照抄) ===="]
    for i, sp in enumerate(snippets, 1):
        cat = sp.get("category", "")
        lines.append(f"\n[范例 {i}, {cat}]\n{sp['content'][:400]}")
    return "\n".join(lines)
