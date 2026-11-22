"""把主链路各阶段**最终发给模型的完整 prompt** 渲染成一份 Markdown 文档。

为什么要它：`docs/剧本平台-全部提示词框架总览.md` 是手工抄录的快照，2026-10-13 之后
代码一改就对不上（例如文档里还写着"伏笔预算（硬约束）"，代码早已改成按生命周期管理）。
手抄副本注定漂移；这里直接从代码组装，所见即模型所见。

组装方式与生产完全一致：DB 有激活模板就用 DB 模板，否则用代码常量；原则块、契约、节拍、
篇幅等按各阶段真实的拼接顺序注入。模型调用被替换为桩，不产生任何费用、不写库。

用法（orchestrator 容器内）：
    python scripts/dump_prompt_framework.py > /tmp/主链路提示词.md
然后拷回仓库 docs/剧本平台-主链路提示词（自动生成）.md
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import os
import sys

# APP_ROOT 允许对未重建镜像的工作区副本生成（默认读镜像内 /app）
sys.path.insert(0, os.environ.get("APP_ROOT", "/app"))

from app.stages import chapter_gen, drama_principles, outline_gen, story_bible, storyboard_gen  # noqa: E402
from app.stages.episode_render import build_beats_block, build_contract_block  # noqa: E402

# 一集示例大纲：只用来让契约/节拍块渲染出来，内容本身不重要
_SAMPLE = {
    "title": "（示例剧名）",
    "synopsis": "（全剧主线：主角要得到或守住什么｜谁在挡主角、为什么挡｜主角靠自己的哪样本事赢）",
    "world": {"era": "（时代）", "setting": "（场景）", "rules": ["（规则）"]},
    "characters": [{"name": "（主角）", "role": "主角"}, {"name": "（对手）", "role": "反派"}],
    "chapters": [{
        "order": 1, "title": "（第1集标题）", "synopsis": "（本集梗概）",
        "beats": [{"at": "（地点 时间）", "who": "（在场人物）", "action": "（发生了什么）", "turn": "（局面变成了什么）"}],
        "core_push": "（本集让主线哪一件往前走了一步）", "stakes": "（会失去什么）",
        "value_shift": {"from": "（开始时）", "to": "（结束时）"},
        "hook_out": {"type": "紧急危机", "strength": "迫切", "leads_to": "（下一集核心事件）"},
        "must_have": ["（关键事件）"], "characters": ["（主角）", "（对手）"],
    }, {"order": 2, "title": "（第2集标题）", "synopsis": "（第2集梗概）"}],
}


class _Resp:
    def __init__(self, c):
        self.content = c


class _Stub:
    def __init__(self, sink, key, ret):
        self.sink, self.key, self.ret = sink, key, ret

    async def ainvoke(self, prompt):
        self.sink[self.key] = prompt
        return _Resp(self.ret)


async def _collect() -> dict[str, str]:
    cap: dict[str, str] = {}
    # 故事圣经（无 DB 模板）
    cap["故事圣经"] = story_bible._BIBLE_PROMPT.format(user_input="{用户输入}")
    # 大纲：首批 / 后续批（与 generate_outline_pipeline 的拼接顺序一致）
    t1 = await outline_gen._load_prompt_or_fallback("outline_generate_first", outline_gen._OUTLINE_FIRST_PROMPT)
    t2 = await outline_gen._load_prompt_or_fallback("outline_generate_next", outline_gen._OUTLINE_NEXT_PROMPT)
    p1 = t1.format(user_input="{用户输入}", total="{总集数}", start=1, end=10, bible_block="{故事圣经}")
    p2 = t2.format(user_input="{用户输入}", total="{总集数}", start=11, end=20, bible_block="{故事圣经}",
                   ledger_block="{账本快照}", recap_block="{前文脉络}")
    cap["大纲·首批"] = outline_gen._with_principles(p1)
    cap["大纲·后续批"] = outline_gen._with_principles(outline_gen._with_mainline(p2, _SAMPLE["synopsis"]))
    # 剧本·大纲直生（主路径）
    storyboard_gen.get_llm = lambda *a, **k: _Stub(cap, "剧本·大纲直生（主路径）", "[]")
    await storyboard_gen.generate_storyboard_from_outline(
        episode_order=1, synopsis="（本集梗概）", chapter_title="（第1集标题）",
        context="【全剧主线】" + _SAMPLE["synopsis"], next_text="（下一集原文或梗概）",
        contract_block=build_contract_block(_SAMPLE, 1), beats_block=build_beats_block(_SAMPLE, 1),
        word_target=1000)
    # 剧本·由正文转换
    storyboard_gen.get_llm = lambda *a, **k: _Stub(cap, "剧本·由正文转换", "[]")
    await storyboard_gen.generate_storyboard(chapter_text="（本集正文）", chapter_title="（第1集标题）",
                                             episode_order=1, word_target=1000)
    # 章节正文
    chapter_gen.get_llm = lambda *a, **k: _Stub(cap, "章节正文", "（正文）")
    try:
        await chapter_gen.generate_chapter(outline=_SAMPLE, chapter_order=1, provider="gemini",
                                           word_target=1000, prev_chapters=[])
    except RuntimeError:
        pass  # 桩只回 4 个字，会触发"输出过短"校验；prompt 在调用前已经捕获
    return cap


def main() -> None:
    cap = asyncio.run(_collect())
    out = [
        "# 剧本平台 · 主链路提示词（自动生成）",
        "",
        f"> 生成时间：{_dt.datetime.now():%Y-%m-%d %H:%M}　生成脚本：`services/orchestrator/scripts/dump_prompt_framework.py`",
        "> 本文件由代码组装而成，内容即模型实际收到的 prompt。**不要手改本文件**——改代码后重新生成。",
        "> 规则的唯一来源是 `app/stages/drama_principles.py`；写法约定见该文件顶部。",
        "> 花括号 `{…}` 是运行时填入的内容（用户输入、故事圣经、账本等），`（…）` 是示例占位。",
        "",
        "## 规则块分配",
        "",
        drama_principles.__doc__.split("## 写法约定")[0].split("## 组织方式")[1].strip(),
        "",
    ]
    for k, v in cap.items():
        out += [f"## {k}", "", f"共 {len(v)} 字", "", "````text", v.strip(), "````", ""]
    print("\n".join(out))


if __name__ == "__main__":
    main()
