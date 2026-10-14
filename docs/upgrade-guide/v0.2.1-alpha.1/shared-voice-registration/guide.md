---
kind: upgrade-guide
description: "New shared character-period audio registrations require the authenticated Muse coordinator instead of independent asset creation."
---

# Enable shared voice registration coordination

English | [中文](guide.zh.md)

## Change

A new `jubian_asset register` request with both `character_id` and `voice_period_id` requires the Host Muse account provider and an enabled gateway coordinator before creating an audio asset. Missing or busy coordination returns a pending result without a provider POST. Existing audio reuse, original-ledger reconciliation and untagged legacy registrations retain their behavior. This does not change Session generations or migrate existing audio assets.

## Migration

1. Upgrade the gateway and Desktop runtime together. Mount `muse-account` beside `tool-jubian` and sign in through the existing Muse account settings.
2. Set `MUSE_VOICE_SLOTS_DIR` to an absolute private persistent directory outside the gateway release. Preserve its receipts across restarts and upgrades. See [server configuration](../../../../services/muse-accounts/README.md#shared-voice-registration) for timeouts and lock handling.
3. Run `node --test services/muse-accounts/voice-slots.test.mjs`. Verify an unauthenticated coordinator request returns 401 and an unconfigured authenticated request returns 503. The mocked concurrent test grants only one new registration start.
4. Reconcile submitted or unknown registrations with the original key. Do not clear submitted receipts to retry, change the lease, or remove a lock until its writer is stopped and inspected. Use existing complete audio inventories for reuse, and [shared use queries](../../../../packages/drama/tool-drama-assets/README.md#shared-project-uses) before inspecting any duplicate cleanup.
