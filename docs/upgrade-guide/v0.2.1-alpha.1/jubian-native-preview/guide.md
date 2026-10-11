---
kind: upgrade-guide
description: Jubian native video previews now include an explicit backup-model list and report attempted submissions accurately.
---

# Jubian native video previews

English | [中文](guide.zh.md)

## Change

Native preparation supplies `backupModelList: []` when the saved setting is missing or null, preserving any explicit list and rejecting other values. The list participates in the frozen payload and fingerprint. An unsubmitted older preview without the field no longer matches current preparation.

`submit_video` reports `put_sent: true` when a PUT was attempted, including a provider refusal or transport failure. Previously an exception incorrectly reported false. The result now includes `put_error` with the credential-redacted provider diagnostic or a generic local error. Neither field confirms a task or a charge; ambiguous requests retain their reservations and cannot be resubmitted under the same key.

## Migration

1. Re-run `prepare_video` for previews without ledger records, review the resulting file and use its own key.
2. For recorded keys, keep the original preview and use the same key for read-only reconciliation. Do not replace it merely to retry an ambiguous request.
3. Display `put_error` as submission diagnostics, and claim generation only when a matching task is read back. Verify no second PUT occurs on replay.
