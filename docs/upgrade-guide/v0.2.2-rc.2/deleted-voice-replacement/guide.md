---
kind: upgrade-guide
description: "Replacing a deleted shared voice adds durable retired-operation records to the Muse account gateway."
---

# Deleted shared voice replacement

English | [中文](guide.zh.md)

## Change

The Muse account gateway can retire a ready voice registration only after independently verifying that its exact project, character, period and audio asset are explicitly deleted. A new operation may then reserve its replacement. The original account and operation key remain permanently closed to another creation, including after restart. Submitted operations still never expire.

The private `MUSE_VOICE_SLOTS_DIR` retains `retired-<hash>.json` receipts alongside current slot receipts. Replacement receipts and owner responses add `replaces_asset_id`. Older gateway versions reject this metadata; downgrading requires operator review and must preserve the retired records. Deleting or restoring only current receipts can reopen a retired operation.

The client requires a matching deleted slot in its complete inventory before using replacement permission. Missing, contradictory or untracked deletion evidence still leaves registration pending. Audio deletion readback now confirms a validated deleted row as well as successful `data:null`; contradictory deletion fields remain unknown.

## Migration

1. Stop gateway writers and back up the entire private `MUSE_VOICE_SLOTS_DIR`, including retired receipts and pending locks. Retain the original local operation ledgers.
2. Upgrade the gateway and clients together. Do not clear submitted receipts, remove interrupted locks while their writer is running, or retry an uncertain registration with a new key.
3. For an intentionally deleted, previously ready voice, submit the newly authorized replacement with its own operation key. An old client or gateway cannot authorize this replacement. A missing or ambiguous asset requires reconciliation rather than another registration.
4. Confirm that the new audio asset is independently active and the original operation remains closed after gateway restart. Back up current and retired receipts together. Keep pending voice work scoped to that reference; independent production work may continue.
