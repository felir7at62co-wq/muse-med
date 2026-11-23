---
kind: upgrade-guide
description: Storyboard deletion batches can continue after an unreadable response when exact absence and the original claim are verified.
---

# Storyboard deletion readback

English | [中文](guide.zh.md)

## Change

`jubian_storyboard delete_apply` previously stopped the remaining batch after any lost or unreadable deletion response, including when readback confirmed the card was absent. It now continues within the reviewed targets after verifying both that absence and the original settled `unknown` claim. Every remaining target is checked again before deletion. A changed target, an unreadable claim or an unverified result still stops the batch.

`response_status` retains the original acknowledgement status; `verified_readback` reports current deletion confirmation. Replaying the same plan only reads existing attempts and never sends another deletion.

## Migration

1. Update callers that assume an unreadable acknowledgement always leaves later targets unattempted. Inspect each item's `status` and `verified_readback` instead.
2. Preserve the original plan fingerprint and key for read-only reconciliation. Do not generate replacement keys for targets already attempted.
3. Confirm that a reconciled deletion reports `deleted` with `verified_readback: true`, while the acknowledgement can remain `unknown`. Targets marked `not_attempted` still require a new preview of the remaining scope.
