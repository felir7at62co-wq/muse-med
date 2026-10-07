---
kind: package-reference
description: "Muse Desktop Host 的产品配置与智能体预设默认值。"
---

# Muse Desktop Host

[English](README.md) | 中文

私有 Host 为[桌面应用](../desktop/README.zh.md)提供 Muse 组合。内置预设文件使用普通 Cordis 配置。用户自有模型提供方与凭据独立于 Muse 账号目录。

桌面账号组合将网关与知识库请求的 `requestTimeoutMs` 设置为 60,000 毫秒，包含项目参与组合扫描。个人覆盖文件可修改这一经过验证的账号配置；底层插件默认值仍为 15,000 毫秒。超时仍报告服务不可用，不能据此判断远程写入是否完成。

<a id="compaction-defaults"></a>
## 压缩默认值

Host 默认值与 `standard`、`ptc`、`cordis`、`short-drama`、`editing` 预设为[选定目录](../../services/muse-accounts/README.zh.md#selected-model-budgets)中的八款账号模型声明精确策略。每条策略预留 16,384 tokens 的额外压缩余量，将摘要上限设为 8,192 tokens；正常对话保留提供方输出预算。其他路由继承后端默认值；`minimal` 不挂载自动压缩。

每个创作预设拥有隔离的压缩后端，因此策略同时位于各预设的 `agent.cordis.yml` 和 Host 默认覆盖文件。个人预设可按[压缩配置](../../packages/compaction/compaction-basic/README.zh.md#tuning-when-condensation-starts)设置自己的 `modelPolicies`。后端将固定请求成本计入预算，并在相关输入改变前跳过未改变的失败选区或单独检查点的重复摘要。
