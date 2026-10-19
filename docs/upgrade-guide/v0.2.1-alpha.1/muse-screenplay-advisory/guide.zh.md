---
kind: upgrade-guide
description: Muse 剧本项目采用建议型审校，不再强制批准或固定集序。
---

# Muse 自主剧本审校

[English](guide.md) | 中文

## 变更

Muse 的 `short-drama` 和 `creation` 组合将 `screenplay_project` 配置为 `reviewMode: advisory`。Agent 自主选择是否审校及审校时机，同一写作会话也可审校。新旧项目均可起草指定集、先保存多集再采用，并按任务需要调整采用顺序。同集采用另一候选时更换当前版本，保留历史候选、提交时间和审校记录。导出可以交付真实草稿或历史候选，不会自动采用。采用不等于审校通过。

结果通过 `review_advisory` 保留真实未审和拒绝状态。可选审校使用 `kind: advisory`，保留实际操作者、时间、决定和理由，不编造独立审校者或 A/B/C 证据。故事清单、`story_notes` 和 C 轮语义报告均可省略；实际提供的记录仍须有有效来源、位置和摘要。`rendered.continuity_advisory` 在剧本正文外报告前情知情缺项，不补造前情。`base_episode` 保留创建时计数，`next_episode` 建议第一个未采用集，不限制工作。

读取旧项目时在内存应用 `review_policy: advisory`，下一次成功修改才持久化。历史 `review_mode`、审校上下文摘要和身份保持不变。策略持久化后，即使后续配置改为 `independent` 或 `self-check` 仍继续生效，配置不会把该项目反向转换为严格审校；严格默认继续适用于没有建议型策略的项目。来源完整性、真实集号、当前修订、候选摘要、真实用户授权及用户返稿保护继续生效。Muse 系统提示词不变。

保留历史不代表支持降级：回退 Muse 1.1.6 时使用升级前的项目备份，旧读取器不识别建议型审校记录。

## 迁移

1. 在 Muse 中继续使用原项目文件，无须手改 JSON 或转换 Session 日志。自定义组合将 `@deepseek-ai/dsh-screenplay-project` 配置项的 `config.reviewMode` 设为 `advisory`；仅对新项目或尚无建议型策略且需要强制审校的项目选择严格 `independent` 或 `self-check`。
2. 调用 `status`，使用实际来源编号、候选摘要及 `expected_revision`。通过 `candidate_states` 读取各版本实际采用/审校状态，通过 `continuity_advisory` 读取已采用各集风险；建议的 `next_episode` 不是执行要求。
3. 保存任务要求的各集版本。确实需要采用时才用 `commit`，也可直接 `export` 指定真实候选。核对 `export.adoption` 与连续性建议，不编造批准，也不为解除限制而补采用缺失的前集；正常剧情衔接与安排仍遵循作品及用户要求。
4. Word 导出与交付使用实际可读文件，不要求批准收据。Word 转换固定输入并逐段核对生成正文，用户返稿保护继续生效。核对实际交付文件与审校范围；严格策略及其余完整性检查见[包参考](../../../../packages/drama/screenplay-project/README.zh.md)。
