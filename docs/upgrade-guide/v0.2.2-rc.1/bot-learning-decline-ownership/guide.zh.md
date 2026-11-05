---
kind: upgrade-guide
description: "缺少所属 Bot 的旧技能拒绝记录不再抑制学习提案。"
---
# 技能拒绝记录归属于单个 Bot

[English](guide.md) | 中文

## 变更

Bot 学习会在 `<Bot home>/learning/state.json` 中为新拒绝的技能提案保存所属 Bot 标识。学习审查只接收该 Bot 的技能拒绝记录。缺少 Bot 标识的旧技能拒绝记录会继续保留，但不再进入模型请求或抑制提案，因为无法安全确认其来源。因此，升级后可能再次出现以前拒绝过的想法。AGENTS.md 拒绝记录继续使用原有的项目目录范围。

## 迁移

1. 保留现有 Bot 主目录和 `learning/state.json`，无需编辑文件或迁移 Session 日志。
2. 如果旧想法再次出现，在原 Bot 的会话中拒绝其卡片。新的拒绝记录会保存该 Bot 的标识。
3. 确认卡片关闭，且该 Bot 后续的学习审查会识别这次拒绝。其他 Bot 的学习审查不会收到这条记录。
