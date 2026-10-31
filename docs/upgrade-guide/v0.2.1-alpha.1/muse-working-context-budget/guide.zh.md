---
kind: upgrade-guide
description: Muse 为所有桌面模型启用自适应工作上下文预算。
---

# Muse 估算工作上下文预算

[English](guide.md) | 中文

## 变更

Muse Desktop Host 默认值与 `standard`、`ptc`、Cordis、`short-drama`、`creation` 和 `bot-coordinator` 预设对所有模型使用统一自适应策略：475,000-token 估算工作目标、`0.45` 压力比例、16,384-token 余量与摘要输出上限，以及目标 65,536-token 近期尾部。窗口较小时会下调余量、保留尾部、摘要输出和最终请求准入上限。模型物理窗口、正常对话输出上限和路由不变。估算不保证与提供方 tokenizer 一致。`minimal` 不挂载自动压缩。

本地工作预算拒绝会保留当前步骤输入和工具更新，压缩平衡的历史，并只在收到持久化确认后重试。摘要失败或未达到目标时，只有保留的上下文仍低于已知模型窗口扣除输出预留和余量后的预算，才允许继续。容量未知、取消、提交失败或 flush 失败均不允许这样恢复。

上下文指示器区分工作目标与模型容量。记录了工作目标及对应输入估算时，使用最近一次请求准备时的校准估算。旧日志在新请求记录这些元数据前，继续显示模型窗口用量。

## 迁移

1. 同步升级压缩运行时、[Host 默认值](../../../../apps/desktop-host/config/defaults.cordis.patch.yml)和各受影响预设。旧运行时会拒绝 `adaptiveBudget`。
2. 个人 profile 补丁可以设置 `adaptiveBudget: false`，并按[压缩参考](../../../../packages/compaction/compaction-basic/README.zh.md#tuning-when-condensation-starts)配置自己的 `modelPolicies`、阈值、工作预算、余量、保留尾部和摘要上限。物理上无效的输出预留仍会明确失败。
3. 保持自动压缩启用，并为 `ctx.sessions.flush()` 提供持久化监听器；缺少或未收到确认会停止恢复。`maxOverflowRetries` 限制重试次数，`auto: false` 禁用检查。
4. 运行[无需密钥的准入测试](../../../../packages/compaction/compaction-basic/tests/working-context-limit.spec.ts)，核对选用适配器的模型容量。只更新服务器目录不会安装此行为。不要重写 Session 日志或恢复旧数据库：已提交的摘要和工具收据仍有效。
