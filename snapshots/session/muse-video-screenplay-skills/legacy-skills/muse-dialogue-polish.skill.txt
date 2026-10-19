---
name: muse-dialogue-polish
description: 当前中文剧本起草、修改或审校需要提高台词质量，或发现人物同腔、对白互不回应、解释过多及情感表达生硬时使用；Muse 根据场景需要主动选择。
---

# 台词精修

先读 [对白方法](references/dialogue-workflow.md)，按本场人物的目标、已知信息和说话策略改稿，保留有效的原台词。在用户授权范围内交付完整可替换场景，再简述具体变化和未解决项；只要任务包含修改，就不能以泛泛点评结束。

写替换稿前，按当前工具形态加载 `screenplay-format`：native 工具直接调用 `skill` 并保留完整返回值；PTC 用 `return await tools.skill({name: "screenplay-format"})` 返回完整 `content`、`provider`、`resourceBase`。下一模型轮读到正文后，按该技能实际返回的 `resourceBase` 读取所导航的共享写作品质与时间线规范，不从本技能目录拼接跨包路径。

明确逐字、字幕或历史严格视频整理只修排版与有依据的错字；新创作模式的故事忠实路径可在实际作品授权内口语化和强化互动，不能改重大因果、关系立场或关键揭晓，也不能增加冒称来源的事实。

方法来源和适配范围见 [来源说明](references/sources.md)。
