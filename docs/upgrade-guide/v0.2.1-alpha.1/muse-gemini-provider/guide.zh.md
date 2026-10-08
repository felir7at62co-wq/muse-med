---
kind: upgrade-guide
description: "Muse Desktop 隐藏独立 Gemini 账号提供方，保留云映 Gemini。"
---

# 为保存的独立 Gemini 对话选择云映 Gemini

[English](guide.md) | 中文

## 变更

Muse Desktop 从模型目录排除独立账号提供方 `aa`，其本地注册标识为 `muse-cloud-aa`。已有对话若使用该提供方，须先选择可用模型再继续。`muse-cloud-yunying/gemini-3.1-pro`、其他云映供应模型、官方 DeepSeek 和个人提供方仍可使用。已有对话日志仍可读取；其模型选择与 Session 格式不会被重写。

## 迁移

1. 安装更新后的 Muse Desktop 并登录，打开受影响对话的模型选择器。
2. 选择 **Muse · 云映 → gemini-3.1-pro** 或其他可用模型，然后继续。确认下一次记录的请求使用所选提供方和模型。
3. 自定义部署可在 `@deepseek-ai/dsh-muse-account` 配置行中将 `excludedProviderIds` 设为精确的网关提供方 ID。插件默认值为 `[]`；桌面产品补丁设置 `['aa']`。不要改用 `gemini` 模型前缀过滤，否则也会移除云映 Gemini。
