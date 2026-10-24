---
kind: upgrade-guide
description: "Native video preparation preserves internal prompt whitespace, so unsubmitted previews made from multiline cards may need to be prepared again."
---

# Native video prompt formatting

English | [中文](guide.zh.md)

## Change

`jubian_storyboard.prepare_video` preserves internal line breaks and spacing in the saved card's prompt, trimming only its outer whitespace. Previous preparation collapsed whitespace. Payload fingerprints still cover the exact submitted content. An unsubmitted preview made from a multiline card can therefore fail the live-content comparison after upgrading.

Recorded submissions retain their original keys and read-only reconciliation. A newly prepared preview cannot create another paid submission when the ledger contains its equivalent compacted-prompt or images-then-audio request, including an unsettled intent whose remote task is not yet visible.

## Migration

1. Keep existing files under the project's `video_tasks/` and keep the submission ledger. Reconcile any recorded submission with its original preview and `idempotency_key`; do not regenerate it because its prompt formatting differs.
2. For an unsubmitted preview rejected by the live-content comparison, call `jubian_storyboard.prepare_video` again for the same card. This is a free read operation. Inspect the new preview's `payload.modelConfig` prompt, material order and duration.
3. Submit the reviewed preview within the existing authorization. Confirm that its key is used unchanged. A legacy-key conflict reports `original_idempotency_key` and sends no new PUT; continue read-only reconciliation with that original key instead of bypassing the ledger.
