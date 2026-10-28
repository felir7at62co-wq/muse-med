---
kind: upgrade-guide
description: "Muse 保留用户技能目录，合法导入文件不再因当前会话未发现而删除。"
---

# Muse 用户技能保留

[English](guide.md) | 中文

## 变更

Muse 发现当前项目 `.muse/skills`、`.dsh/skills`、`.agents/skills` 中的技能，继续排除未配置的共享用户目录。Desktop 启动保留显式配置的 `customSkillDirs`。创造模式在批准的内置目录之外，也提供用户、项目及显式自定义技能。合法导入在尚未发现或当前会话不可见时仍保留文件，面板分别报告保存与可用状态。

## 迁移

1. 应用升级时保留现有 `<Muse home>/skills` 与项目技能目录，此变更不清空或自动移动目录。
2. 额外的已有技能目录继续写在 `skill-filesystem.config.customSkillDirs` 中，Desktop 保留这些配置；共享用户目录仍需显式指定。
3. 自定义提供方配置可使用 `includeDefaultRoots: false`、`includeProjectRoots: true`，只发现项目及显式配置目录。不设置新字段时保留提供方原行为。
4. 在面板核对导入后的保存位置。发现尚未完成时，重新打开对应项目或会话并查看可用状态提示，保留已保存文件。
5. 此前已回滚删除的导入没有可迁移内容；原始源文件仍在时重新导入，不用内置副本覆盖存量用户文件。
