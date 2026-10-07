---
kind: upgrade-guide
description: "自动压力压缩可减少请求的保留预算，以容纳固定请求内容。"
---

# 压缩压力预算

[English](guide.md) | 中文

## 变更

自动压力压缩将 `retainRatio` 和 `retainTokens` 视为请求的近期历史保留预算。工具、系统提示或提供方用量修正会阻止检查点降到阈值以下时，后端可减少保留量。固定请求前缀或不可拆分的工具单元不留有效替换空间时，只报告警告，不调用摘要模型。未改变的失败选区和成功摘要后的单独检查点不会反复摘要；相关内容、路由或策略改变后可再次尝试。手动压缩及提供方确认的上下文溢出保留原有恢复行为。

[Muse Host 默认值](../../../../apps/desktop-host/README.zh.md#compaction-defaults)为三个配置为 128,000-token 窗口的云端模型使用较小的余量和摘要预算。正常对话的输出上限保持不变。

## 迁移

1. 更新应用后继续原会话。现有 Session 文件与内容仍可读取；本修复不改写历史日志。
2. 如果工作流要求特定消息逐字保留，请复核自定义 `retainRatio` 或 `retainTokens` 设置。自动压力压缩现在可能减少请求的保留量；不可缺失的源资料应保存在工作区文件中。
3. 个人组合使用小窗口模型时，按[压缩配置](../../../../packages/compaction/compaction-basic/README.zh.md#tuning-when-condensation-starts)复核 `headroomTokens`、摘要 `maxTokens` 和精确的 `modelPolicies`。Muse 内置预设已包含对应产品策略。
4. 确认普通请求能够继续，不再反复摘要同一检查点；输入确实增长时，仍能触发有效压缩。
