---
kind: upgrade-guide
description: 分镜删除批次可在确认目标不存在且原操作记录有效后，继续处理响应不可读的删除。
---

# 分镜删除回读

[English](guide.md) | 中文

## 变更

`jubian_storyboard delete_apply` 原先在删除响应丢失或不可读后停止剩余批次，即使回读已确认该卡不存在。现在，只有确认该卡不存在，且原操作已结算为 `unknown` 的记录仍有效时，才继续处理已检查的目标。删除每个剩余目标前仍会重新检查。目标变化、操作记录不可读或结果未核实时，仍停止批次。

`response_status` 保留原始回执状态；`verified_readback` 表示当前删除回读核验结果。重放同一计划只读取已有尝试，绝不再次发送删除。

## 迁移

1. 更新假定回执不可读后剩余目标必定未尝试的调用方，改为逐项检查 `status` 和 `verified_readback`。
2. 保留原计划指纹和 key 用于只读对账。不要为已尝试的目标另建 key。
3. 确认已对账的删除返回 `deleted` 且 `verified_readback: true`，同时回执仍可为 `unknown`。标为 `not_attempted` 的目标仍须按剩余范围重新预览。
