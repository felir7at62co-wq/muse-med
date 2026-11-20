---
kind: upgrade-guide
description: "Image registration confirms exact request identities and preserves private receipts for same-key recovery."
---

# Image registration receipts

English | [中文](guide.zh.md)

## Change

`jubian_asset register` for image categories 1, 2 and 3 confirms only a unique new asset matching the original project, category, name and uploaded URL. `new_asset_ids` no longer contains unrelated concurrent creations and is empty on replay. `created_asset_id` retains the first verified ID; `verified_readback` separately reports whether its current identity still matches. A verified registration does not adopt the image as a production reference.

The tool stores versioned request evidence in `<ledgerRoot>/asset-registration-receipts/`. Legacy keys without this evidence return `status: receipt_missing` without guessing an asset or resending the request.

## Migration

1. Keep the receipt directory with the original ledger when backing up or moving `ledgerRoot`. Retain the original `idempotency_key`, project, category, name and URL for recovery.
2. Consumers must use `created_asset_id` together with `verified_readback`, rather than treating every ID in a project inventory difference as this operation's creation. An unconfirmed, missing or changed identity requires read-only inspection; do not substitute another ID or resend under a new key.
3. Verify a known registration with the original arguments and key. A matching saved asset returns its original ID and `verified_readback: true` without another POST. Old keys returning `receipt_missing` need manual inspection of the original result and current project assets.
