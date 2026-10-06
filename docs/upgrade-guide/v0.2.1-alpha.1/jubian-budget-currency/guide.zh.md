---
kind: upgrade-guide
description: "剧变计费调用会拒绝账本中存在不同于授权币种的项目，包括混币历史或缺少报价币种。"
---

# 剧变预算要求统一使用授权币种

[English](guide.md) | 中文

## 变更

项目账本同时包含 CNY 和其他币种时，过去可能通过使用 CNY 授权的计费预算检查。现在只要该项目任一已记录报价币种不同于授权币种，或计费记录缺少报价币种，检查就会拒绝计费调用，并且不会新增 intent 或发送计费提供方请求。所有已记录币种均与授权一致的项目保持原有行为。

## 迁移

1. 对受影响项目，检查 `<ledgerRoot>/authorization.json` 的 `projects["<script_id>"].unit`，以及 `<ledgerRoot>/*.ndjson` 中该项目的 `script_id`、`quoted_amount` 和 `quote_unit` 字段。保留原始文件，按提供方收据核对记录；不要换算币种、丢弃消费记录或提高上限来绕过拒绝。
2. 用 `jubian_budget` 的 `action: "read"` 和同一 `script_id` 读取项目。混币历史和缺少报价币种的记录都会返回 `accounting_complete: false` 和 `remaining_cents: null`。预算更新工具无法解决这类历史；恢复计费操作前，应由账本操作人核对已记录金额和币种。
3. 核对完成后，确认预算读取返回 `accounting_complete: true`，且所有已记录报价币种均与授权一致。计费调用仍须有有效报价或估算，并有足够的剩余额度。其他拒绝条件见[剧变账务规则](../../../../packages/jubian/jubian/README.zh.md)。
