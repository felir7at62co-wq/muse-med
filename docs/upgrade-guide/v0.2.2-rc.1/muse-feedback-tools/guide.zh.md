---
kind: upgrade-guide
description: "Muse 账号的显式注入列表须包含反馈目标校验所需的会话存储。"
---

# 更新 Muse 反馈工具配置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-muse-account` 现在除 `tools`、`llm`、`sessionProjections`、`agentDefaultModel` 外，还依赖 `sessions`。自定义 `cordis.yml` 或补丁行若使用不含 `sessions` 的显式 `inject` 列表，须先更新才能启用账号插件。沿用包声明注入项的行会自动获得此依赖，但对应 profile 仍须提供会话存储。

可选配置 `feedbackTools` 默认 `false`，Muse 桌面设置为 `true`。该配置注册 `muse_feedback_submit` 和 `muse_feedback_status`，用于用户明确提出的反馈及本人收据查询。既有反馈 Remote 方法和弹窗提交保持兼容。

## 迁移

1. 在每个自定义账号行的 `inject` 列表中加入 `sessions`，保留既有服务，并保持 profile 的会话存储提供方启用。随产品交付的桌面组合已包含这些配置。
2. 自定义 profile 需要反馈工具时，在账号行设置 `config.feedbackTools: true`，保留原有 `baseUrl`、账号存储及其他设置。使用 `dsh --profile <profile> --dump-config` 检查最终配置，确认账号行包含 `sessions`，且工具开关符合预期。
3. 通过 `dsh --profile <profile>` 启动 Host，确认账号插件成功启用、账号登录和模型选择仍可使用，且启用后的工具发现包含两个反馈工具。此启动检查不需要提交真实意见。
4. 部署匹配的反馈网关后，才具备 `requestId` 重复保护。旧网关返回匹配收据时仍可确认反馈已保存，但工具报告 `deduplication: unavailable`；此时查询原收据，不要重新提交。结果不确定时，不得改用新的提交编号重试。提交与查询行为见[账号包说明](../../../../packages/host/muse-account/README.zh.md)。
