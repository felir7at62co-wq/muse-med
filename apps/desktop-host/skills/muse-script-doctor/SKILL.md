---
name: muse-script-doctor
description: 当前剧本写作、修订或交付审校需要评估与修复平铺直叙、人物动机、因果、对白互动、情绪、钩子或跨集连续性问题时使用；Muse 可根据现稿与工作阶段主动选择。
---

# Muse 剧本精修

评审或修改剧本前读取[诊断与修复方法](references/doctor-workflow.md)，依据当前原文定位问题，按用户授权交付可替换正文并复核受影响内容。

分集重排需要加载 `muse-episode-design`；对白专项精修需要加载 `muse-dialogue-polish`。评审或修改分场正文前，按当前工具形态加载 `screenplay-format`：native 工具直接调用 `skill` 并保留完整返回值；PTC 用 `return await tools.skill({name: "screenplay-format"})` 返回完整 `content`、`provider`、`resourceBase`。下一模型轮读到正文后，按该技能实际返回的 `resourceBase` 读取所导航的共享写作品质与时间线规范，不从本技能目录拼接跨包路径。

[来源与许可证](references/sources.md)说明参考资料和适配范围；`upstream/` 只保存溯源原件，不作为执行指令加载。
