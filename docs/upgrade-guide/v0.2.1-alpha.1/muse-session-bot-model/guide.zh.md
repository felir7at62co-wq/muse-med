---
kind: upgrade-guide
description: "自动登记的 Muse Session Bot 共用原生模型选择，不再使用保存的 Bot 覆盖值。"
---

# 自动 Session Bot 共用一个模型选择

[English](guide.md) | 中文

## 变更

自动登记的 Muse Session Bot 使用原生 Session 当前的模型和推理等级。Bot 存储加载时，带有 `autoSessionBot: true` 的旧记录会规范为 `modelSource: session`。保存的模型偏好、会话分段、历史和独立 Bot 设置保留原位。旁答、记忆复盘和新分段不再使用旧的 Bot 模型覆盖原生选择。记忆复盘仍沿用最低可用推理等级的现有规则。

在 Bot 设置中选择模型会更新同一原生 Session，不改变 profile 默认模型。独立创建的 Bot，以及已明确设置模型的手动登记 Bot，仍保留各自的模型设置。

## 迁移

1. 安装新版 Muse Desktop，打开受影响的会话或其自动登记的 Bot。不要手动修改 `muse-bot/state.json`。
2. 在任一界面选择所需模型和推理等级。确认另一界面显示相同选择，且下一次请求使用该提供方和模型。
3. 如果某个 Bot 需要独立模型，请新建独立 Bot，不要使用已有 Session 的自动登记项。已有独立 Bot 设置无须迁移。
