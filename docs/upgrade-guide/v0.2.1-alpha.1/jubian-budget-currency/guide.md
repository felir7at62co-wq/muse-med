---
kind: upgrade-guide
description: "Jubian paid calls refuse project ledgers containing a currency different from the authorized currency, including mixed-currency history or a missing quote currency."
---

# Jubian budgets require one authorized currency

English | [中文](guide.zh.md)

## Change

Previously, a project ledger containing both CNY and another currency could pass the paid-call budget check when its authorization used CNY. The check now refuses a paid call whenever any recorded quote currency for that project differs from the authorization currency or a paid record has no quote currency. It refuses before appending a new intent or sending a paid provider request. Projects whose recorded currencies all match their authorization keep the same behavior.

## Migration

1. For an affected project, inspect `<ledgerRoot>/authorization.json` at `projects["<script_id>"].unit` and that project's `script_id`, `quoted_amount` and `quote_unit` fields in `<ledgerRoot>/*.ndjson`. Keep the original files and compare the entries with provider receipts; do not convert currencies, discard spending records or raise the limit to bypass the refusal.
2. Read the project with `jubian_budget` using `action: "read"` and the same `script_id`. Mixed-currency history and missing quote currencies report `accounting_complete: false` and `remaining_cents: null`. The budget update tool cannot resolve that history; have the ledger operator reconcile the recorded amounts and currencies before resuming paid work.
3. After reconciliation, confirm the budget read reports `accounting_complete: true` and that every recorded quote currency matches the authorization. Paid calls still need a valid quote or estimate and sufficient remaining budget. See the [Jubian accounting rules](../../../../packages/jubian/jubian/README.md) for the other refusal conditions.
