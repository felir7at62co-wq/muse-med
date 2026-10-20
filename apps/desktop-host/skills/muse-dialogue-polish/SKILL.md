---
name: muse-dialogue-polish
description: 小说或视频转剧本、已有稿修改或审校中，需要精修对白、处理书面腔、人物同腔、接话与动作衔接问题时使用；Muse 根据场景需要主动选择。
---

# 台词精修

先读 [对白方法](references/dialogue-workflow.md)，按用户本轮目标在原作基础上保留、润色，结合本场人物的目标、已知信息和说话策略改稿，保留原意与有效的原台词。在用户授权范围内交付完整可替换场景，再简述具体变化和未解决项；只要任务包含修改，就不能以泛泛点评结束。

写替换稿前，按当前工具形态加载 `screenplay-format`：native 工具直接调用 `skill` 并保留完整返回值；PTC 用 `return await tools.skill({name: "screenplay-format"})` 返回完整 `content`、`provider`、`resourceBase`。下一模型轮读到正文后，按该技能实际返回的 `resourceBase` 读取所导航的共享写作品质与时间线规范，不从本技能目录拼接跨包路径。

明确逐字稿、字幕或来源事实整理只修排版与有依据的错字；小说或视频改编可在实际作品授权内口语化、调整节奏和强化互动，保留故事因果、关系立场与关键揭晓，不把新写表达冒称来源原话。篇幅与素材容量的取舍沿共享写作品质处理。

方法来源和适配范围见 [来源说明](references/sources.md)。
