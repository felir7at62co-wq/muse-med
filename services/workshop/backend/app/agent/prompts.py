"""Agent 助手 Prompt 模板。

通过 DB `prompts` 表的 stage='agent_chat' 加载,缺失时回退到内置默认。
"""
from __future__ import annotations

import logging

from sqlalchemy import text

from ..db import session_scope

logger = logging.getLogger("agent.prompts")


# 默认人设(若 DB 没有 stage='agent_chat' 的模板, fallback 到这个)
DEFAULT_SYSTEM_PROMPT = """你是 "Drama 智能助手", 专注于短剧剧本创作的 AI 编剧顾问。

【角色】
- 熟悉短剧的黄金 6 集开场, 爽点节奏, 人物弧光等创作规律
- 用中文友好回答, 简洁直接, 必要时分点说明
- 你是创作者的搭档, 不是命令执行者; 在给建议前会先理解用户意图

【你能做什么】
- 评价大纲/章节的合理性、爽点强度、市场契合度
- 帮用户头脑风暴情节转折、人物关系、世界观细节
- 改写片段(对话/旁白/剧本)
- 建议下一章如何写
- 用户问 "总结一下我这部剧" 之类的也可以

【边界】
- 用户要**某一集或某一段**的正文 / 剧本 / 小说 / 推文 —— **直接写给他**。
  这是对话里最常见的用法，不要把人推去别处。写完提一句：
  可以选中拖到右边任意一集，或点回复下方的「写入第 N 集」落进草稿。
- 用户要**整本几十集**（如"给我 60 集成稿"）时，按下面这样回答：
  「这个量级走输入框上方的**生成菜单 →「生成正文」**：它是后台长任务，
    会按你设的每集字数逐集写完 N 集并落进草稿，中途可以关页面。
    要我先写第 1 集给你看看风格对不对吗？」
  **⛔ 绝对不要说"我单次输出有字数限制/无法一次性生成多集"这类话。**
  平台本来就有批量生成能力，把自己的单次输出上限说成产品做不到，
  是在误导用户 —— 该做的是**把他领到那个能做到的入口**，
  顺带提出"先写一集验风格"，而不是道歉。
- 用户坚持要在对话里连着写好几集，就**接着写**，一集一集往下写，
  写到用户喊停为止；不要在开头先声明自己写不了。
- 用户问跟剧本无关的事时, 礼貌引导回创作话题"""


async def load_system_prompt() -> str:
    """从 DB 读取 stage='agent_chat' 最新激活模板, 缺失时返回默认。"""
    try:
        async with session_scope() as s:
            row = (await s.execute(
                text("""
                    SELECT template FROM prompts
                    WHERE stage = 'agent_chat' AND COALESCE(is_active, 1) = 1
                    ORDER BY version DESC, id DESC
                    LIMIT 1
                """)
            )).first()
            if row and row[0]:
                return row[0]
    except Exception as ex:
        logger.warning("load_system_prompt fallback: %s", ex)
    return DEFAULT_SYSTEM_PROMPT


async def seed_default_prompt() -> None:
    """启动时确保 prompts 表里有一条 stage='agent_chat'。"""
    try:
        async with session_scope() as s:
            existing = (await s.execute(
                text("SELECT id FROM prompts WHERE stage = 'agent_chat' LIMIT 1")
            )).first()
            if existing:
                return
            await s.execute(
                text("""
                    INSERT INTO prompts (name, stage, version, template, variables, is_active)
                    VALUES (:name, 'agent_chat', 1, :template, '', 1)
                """),
                {"name": "Agent 助手默认人设", "template": DEFAULT_SYSTEM_PROMPT},
            )
            logger.info("agent: 已 seed 默认 prompt")
    except Exception as ex:
        logger.warning("seed_default_prompt failed: %s", ex)
