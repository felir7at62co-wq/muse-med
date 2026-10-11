---
kind: upgrade-guide
description: "Native Jubian video episode and candidate-scan failures now use VIDEO_TASK_EVIDENCE_INVALID instead of CONTRACT_CHANGED."
---

# Jubian native video task evidence

English | [中文](guide.zh.md)

## Change

Native video task checks report `VIDEO_TASK_EVIDENCE_INVALID` for invalid episode fields, contradictory episode axes and candidate-scan overflow, instead of the remote-envelope message under `CONTRACT_CHANGED`. Consumers of `JubianErrorCode` must handle the new category. Episode IDs may remain null in `NativeClaimExpectation`; callers can provide the independent `episodeCount`. Missing IDs are no longer coerced to zero. Conflicting or malformed supplied episode fields fail rather than silently broadening the scan.

## Migration

1. Update consumers of `JubianErrorCode` to handle `VIDEO_TASK_EVIDENCE_INVALID` as a read-only ownership check failure, not permission to resend a paid request.
2. Build native claim expectations with `nativeEpisodeScope(preview.payload)`; never use `Number(null)` or infer a provider ID from `episodeCount`.
3. Keep existing preview files and original idempotency keys. A recorded intent only reconciles; do not delete its ledger entry or issue a new key to bypass a check.
4. Run the native tool regression tests and verify missing-ID previews exclude explicitly different episode numbers, while ambiguous history refuses before any new paid PUT. No Session or ledger migration is required.
