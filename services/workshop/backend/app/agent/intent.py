"""意图识别 - 用 gemini 判断用户消息是否要触发 OperationCard."""
from __future__ import annotations
import json, logging, re
from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("agent.intent")

INTENT_SYSTEM = """你是意图分析助手。判断用户消息是否要修改剧本/大纲/角色等具体资产。

返回 JSON (仅 JSON, 不要 Markdown):
- 纯聊天: {"intent":"chat"}
- 操作意图: {"intent":"operation","op_type":"...","target_chapter_order":N(可选),"payload":{...},"confidence":0.0-1.0,"reasoning":"为什么","risks":[]}
- 不明确: {"intent":"needs_clarification","ask":"想改什么?"}

# op_type 枚举
- replace_chapter: 整章替换 (payload.new = 新正文, target_chapter_order=N)
- replace_chapter_section: 章节内一段替换 (payload.old_match=要找的旧段, payload.new=新段, target_chapter_order)
- append_to_chapter: 末尾追加 (payload.new, target_chapter_order)
- replace_episode_synopsis: 改大纲某集梗概 (payload.new, target_chapter_order)
- replace_episode_title: 改大纲某集标题 (payload.new, target_chapter_order)
- add_episode: 加新集 (payload.new_ep={order,title,synopsis}, payload.after_order)
- update_world: 改世界观 (payload.patches={...})
- add_character: 加角色 (payload.character={name,role,traits,...})
- update_character: 改角色 (payload.name, payload.patches)
- replace_storyboard: 替换剧本 (payload.shots, target_chapter_order)
- add_to_snippets: 加片段库 (payload.new=内容, payload.category)
- add_to_memories: 记下偏好 (payload.new=内容, payload.mem_type=preference|fact|plot_pattern|character_template|world_setting, payload.title)
- set_custom_instructions: 改用户全局指令 (payload.new)

# 规则
1. 必须用户**明确**说"放进/替换/加到/改成/记一下/以后都/我喜欢/不要再"等动词
2. 没指定章节号又必须用时, 返回 needs_clarification
3. payload.new 必须是用户给出的具体新内容, 不是 AI 生成
4. confidence < 0.7 也走 chat
5. 用户表达"我喜欢XX""我不喜欢XX""下次别用XX"→ add_to_memories"""


def _parse_json(text: str) -> dict | None:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try: return json.loads(m.group(0))
            except: return None
    return None


async def detect_intent(user_message: str, context: dict) -> dict:
    """识别用户消息的意图.

    context: { draft_id, chapter_orders, episode_count, draft_title }
    返回 {"intent":"chat|operation|needs_clarification", ...}
    """
    if not user_message or not user_message.strip():
        return {"intent": "chat"}
    ctx_text = "\n".join([
        f"- 当前 draft_id: {context.get('draft_id')}",
        f"- 当前 draft 标题: {context.get('draft_title') or '(无)'}",
        f"- 已有章节: {context.get('chapter_orders') or []}",
        f"- 已有大纲集数: {context.get('episode_count') or 0}",
    ])
    prompt = [
        {"role": "system", "content": INTENT_SYSTEM},
        {"role": "user", "content": f"# 上下文\n{ctx_text}\n\n# 用户消息\n{user_message}"},
    ]
    try:
        resp = await ainvoke_with_fallback(prompt, role="extract", temperature=0.1, max_tokens=600)
        raw = getattr(resp, "content", "") or ""
        data = _parse_json(raw)
        if not data: return {"intent": "chat"}
        intent = data.get("intent", "chat")
        if intent == "operation":
            conf = float(data.get("confidence", 0.0) or 0.0)
            if conf < 0.65:
                return {"intent": "chat", "_low_conf": data}
            # 默认 target_draft_id 取上下文当前 draft
            if not data.get("target_draft_id") and context.get("draft_id"):
                data["target_draft_id"] = context["draft_id"]
        return data
    except Exception as e:
        logger.warning("intent detect failed: %s", e)
        return {"intent": "chat"}


EXTRACT_SYSTEM = """你是记忆抽取助手。读完用户和AI的对话, 把"有跨会话价值"的事抽成 JSON.

输出 JSON (仅 JSON):
{
  "profile_updates": {                      // 可选, 仅当对话明确表达
    "preferred_genres": ["..."],
    "forbidden_topics": ["..."],
    "preferred_length": 3000,
    "preferred_pace": "fast|medium|slow",
    "style_summary": "对用户风格的一句话总结(增量补充, 不要覆盖)",
    "tone_keywords": ["..."]
  },
  "new_memories": [
    {
      "type": "preference|fact|plot_pattern|character_template|world_setting",
      "content": "20-200字, 简洁, 不要包含手机号/身份证等PII",
      "importance": 1-10,
      "title": "可选, 短标题"
    }
  ],
  "snippet_candidates": [                   // 用户称赞的好段落 (可选)
    {"category": "opening|twist|dialogue_witty|climax|other", "content": "...", "rating": 1-10}
  ]
}

# 抽取原则
1. 只记**跨对话有用**的事(偏好/习惯/约束/世界观), 不记寒暄/打招呼/单次问答
2. 用户明确说"记一下""下次都""以后别"必抽
3. 用户骂某种写法时, 记成"用户反感XX"的负向 memory
4. 同一信息不要重复抽
5. 不要包含 PII"""


async def extract_memories(messages: list[dict]) -> dict:
    """从对话消息列表抽取记忆."""
    if not messages: return {}
    convo = "\n\n".join(f"[{m.get('role','?')}] {m.get('content','')[:1000]}" for m in messages[-20:])
    prompt = [
        {"role": "system", "content": EXTRACT_SYSTEM},
        {"role": "user", "content": f"# 对话内容\n\n{convo}"},
    ]
    try:
        resp = await ainvoke_with_fallback(prompt, role="extract", temperature=0.2, max_tokens=2000)
        raw = getattr(resp, "content", "") or ""
        data = _parse_json(raw)
        return data or {}
    except Exception as e:
        logger.warning("extract failed: %s", e)
        return {}
