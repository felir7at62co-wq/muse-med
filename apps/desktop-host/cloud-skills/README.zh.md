# 云端技能

[English](README.md) | 中文

本目录存放只有云端 Muse 部署才加入的技能，由其 skill-filesystem 配置中的 `customSkillDirs` 加入。目前没有任何技能，桌面端也从不扫描它。云端配置把它列为技能根目录，因此它为空时也保留在仓库中。云端 Bot 的技能以 DS Bot 能力的形式提供。

技能发现读取每个子目录中的 `SKILL.md`，也把顶层 Markdown 文件当作技能读取。本说明没有技能 frontmatter，因此技能发现会跳过它并记录一条警告。
