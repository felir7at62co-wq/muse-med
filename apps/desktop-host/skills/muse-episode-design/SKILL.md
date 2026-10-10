---
name: muse-episode-design
description: 当前创作、改编或审校需要设计或重排分集，处理按字数切集、剧情断裂、情绪未落地、集尾与下集脱节，或将已选大纲组织成分集时使用；Muse 根据任务阶段和稿件状态自主选择，忠实视频转写保留来源剧情。
---

# Muse 分集设计

设计或调整分集前读取[分集方法](references/episode-workflow.md)，沿用用户已定剧情与项目要求，交付可用于正文写作的分集方案。

起草、续写、修改或审校分场正文前，按当前工具形态加载 `screenplay-format`：native 工具直接调用 `skill` 并保留完整返回值；PTC 用 `return await tools.skill({name: "screenplay-format"})` 返回完整 `content`、`provider`、`resourceBase`。下一模型轮读到正文后，按该技能实际返回的 `resourceBase` 读取所导航的共享写作品质与时间线规范，不从本技能目录拼接跨包路径。需要专门处理对白互动与角色声音时加载 `muse-dialogue-polish`。

[来源与许可证](references/sources.md)说明参考资料和适配范围；`upstream/` 只保存溯源原件，不作为执行指令加载。
