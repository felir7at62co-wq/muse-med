---
kind: upgrade-guide
description: Muse 受管剧本项目采用建议型审校，不再强制创作批准。
---

# Muse 自主剧本审校

[English](guide.md) | 中文

## 变更

Muse 的 `short-drama` 和 `creation` 组合将 `screenplay_project` 配置为 `reviewMode: advisory`。新旧项目均可用未审或被拒绝的事实起草，并直接采用当前候选，不要求另一审校者或 A/B/C 分轮。是否审校由 Agent 判断；采用不等于审校通过。未设置建议型策略的项目在其他部署中保留包默认的 `independent`，也可显式选择严格 `self-check`。

建议型结果包含 `review_policy: advisory`，以及 `review_advisory` 中未审/被拒绝的事实和候选数量及建议。实际审校使用 `kind: advisory`，保留真实操作者、时间、决定和理由，不编造独立审校者或分轮证据。故事清单、`story_notes` 和 C 轮语义报告均可省略；实际提供的记录仍须有有效来源引用、位置和摘要。

该策略不改变历史 `review_mode`、审校上下文摘要或审校身份。读取旧项目时在内存应用策略，下一次成功修改才持久化；只读不改写文件。建议型策略持久化后，即使后续配置改为 `independent` 或 `self-check` 仍继续生效；配置不会把该项目反向转换为严格审校。来源完整性、当前修订、集号顺序、候选摘要、真实用户授权及用户返稿保护继续生效。Muse 系统提示词不变。

保留历史不代表支持降级：回退 Muse 1.1.6 时使用升级前的项目备份，旧读取器不识别建议型审校记录。

## 迁移

1. 在 Muse 中继续使用原项目文件，无须手改 JSON 或转换 Session 日志。自定义组合需要自主审校时，将 `@deepseek-ai/dsh-screenplay-project` 配置项的 `config.reviewMode` 设为 `advisory`；新项目或尚无建议型策略的项目需要强制审校时，显式选择 `independent` 或 `self-check`。
2. 调用 `status`，使用实际来源编号、候选摘要及当前修订。确认 `review_policy: advisory`，读取 `review_advisory`，不把采用状态当作批准。不要改写历史审校记录，也不要编造审校以解除限制。
3. 起草预期的下一集，准备采用时提交当前候选。需要时仍可调用审校接口，如实报告决定和未解决项。`export`、Word 转换和呈现使用已采用候选，继续拒绝过期、被改动或未经授权的数据。
4. 确认同一项目可重新打开，历史保持完整，导出内容为预期的已采用正文。来源、引用、版本或权限错误仍须修正，不能靠审校策略豁免。其余严格策略要求见[包参考](../../../../packages/drama/screenplay-project/README.zh.md)。
