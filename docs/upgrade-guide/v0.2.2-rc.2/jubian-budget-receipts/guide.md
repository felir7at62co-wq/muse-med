---
kind: upgrade-guide
description: "Jubian write receipts replace ambiguous budget totals with separate submission reservations and project accounting."
---

# Jubian write budget receipts

English | [中文](guide.zh.md)

## Change

Jubian write receipts replace `budget.settledCents` and `budget.reservedCents`. These fields contained the project's local quote or estimate totals before submission, not the current task's actual charge. Callers that display or parse these receipts must use `budget.this_submission` and `budget.project_accounting`. Existing Session tool results retain their recorded fields.

## Migration

1. Replace reads of `budget.settledCents` and `budget.reservedCents` with `budget.project_accounting.accepted_reservations_cents` and `budget.project_accounting.pending_reservations_cents`. Check for null first. The group states `scope: project_before_submission`, `basis: local_reservations` and its currency `unit`; report these as project reservation totals.
2. Read the current estimate from `budget.this_submission.reservation` only when its status is `recorded`, using `amount` and `unit`. Handle `not_required` for nonpaid methods and `unavailable` for paid historical records with incomplete quote data. Neither state supplies a zero actual charge.
3. Handle `budget.status: not_rechecked` on replay: the reservation comes from the original ledger record, project accounting is null, and no repeated write or authorization check occurs. Fresh writes retain `authorized`; native single submission, batch submission, original-key recovery and legacy generation replay use the same receipt fields. Each fresh batch item retains its actual authorization result, its own reservation and the project totals observed before the batch. `budget.this_submission.provider_billing: not_observed` requires a separate provider task-row `real_cost` observation before reporting an actual charge.
4. Verify with an offline paid request that reserves `13.36 CNY` after `97.69 CNY` of accepted project reservations. Its receipt must show `13.36` for this submission and `9769` only in project accounting. Replay the same key and confirm the original estimate returns without a second provider request.
