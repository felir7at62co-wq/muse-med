---
kind: upgrade-guide
description: Muse Flash 预设会在本地拒绝估算超大的请求，不再在压缩失败后继续携带超预算历史。
---

# Muse 估算工作上下文预算

[English](guide.md) | 中文

## 变更

Muse Desktop Host 默认值与 `standard`、`ptc`、`cordis`、`short-drama`、`creation`、`bot-coordinator` 预设为 DeepSeek 官方 Flash 的当前与历史 ID 启用 `workingTokenLimit: 475000`。模型物理容量元数据仍为 1,000,000 tokens；提供方路由、默认模型与正常对话输出上限不变。`0.45` 阈值会在估算 450,000 tokens 时开始主动压缩，目标近期尾部为 65,536 tokens，摘要上限为 16,384 tokens。

现有压缩后端会在发送到提供方之前检查完整的普通 agent-loop 请求。本地恢复原样保留当前步骤刚提交的输入、运行时上下文与工具更新文本，压缩更早的平衡历史，并且只在压力降至上限以下、持久化确认替换落盘后重试。失败会停止请求，不再发送超大历史。此估算不保证与提供方的精确 tokenizer 一致。未设置 `workingTokenLimit` 的 profile 保持原有行为。

## 迁移

1. 同步升级压缩运行时与 profile 策略。旧运行时会拒绝新的配置字段。[Host 默认值](../../../../apps/desktop-host/config/defaults.cordis.patch.yml)和各受影响预设的 `agent.cordis.yml` 包含 `muse-cloud-deepseek-official/deepseek-flash` 与 `muse-cloud-deepseek-official/deepseek-v4.1-flash-261017` 的精确策略；个人 profile 通过自己的 `modelPolicies` 选择启用。
2. 保持自动压缩启用，并为 `ctx.sessions.flush()` 提供持久化监听器。恢复要求返回 `true`；监听器缺失或 flush 失败会停止请求。`maxOverflowRetries` 限制恢复次数，包括本地工作预算恢复。`auto: false` 禁用检查；声明了 `purpose` 的辅助请求不参与检查。
3. 使用[无需密钥的工作预算测试](../../../../packages/compaction/compaction-basic/tests/working-context-limit.spec.ts)验证：超大请求在替换落盘前不能到达会话适配器，当前步骤输入须保持完整，flush 失败须阻止重试。确认适配器模型容量仍为 1M。只更新服务器目录不会安装此客户端／Host 行为。
4. 如需禁用最终请求检查，从实际生效的默认与精确目标策略中移除 `workingTokenLimit`，并重新加载对应 profile。已有阈值与保留设置仍然生效；若需恢复原压缩时机，另行恢复这些字段的原值。不要恢复数据库或重写 Session 日志：已提交摘要和工具收据仍有效。配置参见[压缩参考](../../../../packages/compaction/compaction-basic/README.zh.md#tuning-when-condensation-starts)。
