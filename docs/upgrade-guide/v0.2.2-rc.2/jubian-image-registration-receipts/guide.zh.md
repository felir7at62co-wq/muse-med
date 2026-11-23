---
kind: upgrade-guide
description: "图片登记核对精确请求身份，并保存私有回执供同 key 恢复。"
---

# 图片登记回执

[English](guide.md) | 中文

## 变更

图片类别 1、2、3 的 `jubian_asset register` 只确认与原项目、类别、名称和上传 URL 全部匹配的唯一新增资产。`new_asset_ids` 不再包含无关的并发创建，重放时为空。`created_asset_id` 保留首次核验的 ID；`verified_readback` 单独报告其当前身份是否仍匹配。登记核验不代表已采用该图片作为制作参考。

工具将版本化请求证据保存在 `<ledgerRoot>/asset-registration-receipts/`。没有这些证据的旧 key 返回 `status: receipt_missing`，不猜资产，也不重发请求。

## 迁移

1. 备份或移动 `ledgerRoot` 时，将回执目录与原账本一起保留。恢复时保留原 `idempotency_key`、项目、类别、名称和 URL。
2. 调用方须结合 `created_asset_id` 与 `verified_readback` 判断，不能把项目库存差集中的所有 ID 当成本次创建。未确认、缺失或身份变化时只读检查，不替换其他 ID，也不换新 key 重发。
3. 使用原参数与 key 检查已知登记。已保存资产匹配时返回原 ID 和 `verified_readback: true`，不再发 POST。旧 key 返回 `receipt_missing` 时，须人工核对原结果与当前项目资产。
