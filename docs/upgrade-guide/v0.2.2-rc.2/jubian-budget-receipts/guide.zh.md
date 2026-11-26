---
kind: upgrade-guide
description: "剧变写入回执将易混淆的预算累计字段替换为分开的本次预留与项目占账。"
---

# 剧变写入预算回执

[English](guide.md) | 中文

## 变更

剧变写入回执替换了 `budget.settledCents` 和 `budget.reservedCents`。这两个字段表示提交前项目本地报价或估算的累计，而非当前任务的实际实扣。展示或解析这些回执的调用方必须改用 `budget.this_submission` 和 `budget.project_accounting`。已有 Session 工具结果保留原记录字段。

## 迁移

1. 将对 `budget.settledCents` 和 `budget.reservedCents` 的读取分别替换为 `budget.project_accounting.accepted_reservations_cents` 和 `budget.project_accounting.pending_reservations_cents`，并先检查该分组是否为 null。该分组声明 `scope: project_before_submission`、`basis: local_reservations` 和货币 `unit`，应将其报告为项目预留累计。
2. 仅在 `budget.this_submission.reservation` 的状态为 `recorded` 时，用其中的 `amount` 和 `unit` 读取本次估价。分别处理非付费方法的 `not_required` 和付费历史记录报价不完整时的 `unavailable`；这两个状态均不提供零元实扣。
3. 处理重放时的 `budget.status: not_rechecked`：预留来自原账本记录，项目占账为 null，且不重复写入或授权检查。新写入保留 `authorized`；原生单卡提交、批量提交、原 key 恢复与旧生成操作回放使用相同的回执字段。新批次每项保留真实授权结果、自身预留和整批提交前观测到的项目累计。`budget.this_submission.provider_billing: not_observed` 表示报告实际费用前，必须另行取得提供方任务行 `real_cost` 观测。
4. 用离线付费请求验证：项目已有 `97.69 CNY` 的已接受预留，本次预留 `13.36 CNY`。回执必须将 `13.36` 显示为本次预留，仅在项目占账中显示 `9769`。用同一 key 重放，确认返回原估价且没有第二次提供方请求。
