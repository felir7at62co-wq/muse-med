---
kind: upgrade-guide
description: Muse removes the Conversation/Bot mode switch and opens ordinary Sessions directly.
---

# Use the ordinary conversation entry

English | [中文](guide.zh.md)

## Change

Muse opens ordinary Sessions directly. The Conversation/Bot mode switch and Bot registration settings are unavailable. New work uses `short-drama`; the archived Bot interface and its phone entry do not load. The complete affected-feature list and profile backups are in [ordinary Sessions](../muse-session-product/guide.md).

Existing Bot identities, including older automatic entries, keep their saved files. Session logs, memory files and model defaults are not migrated or removed. Their underlying Sessions remain readable from native history, without reactivating Bot ownership or orchestration.

## Migration

1. Use the ordinary conversation entry. Existing profiles using the bundled Muse composition need no manual Session-data migration.
2. Open existing underlying Sessions through native history. New Bot registration and conversion of Sessions into Bots are unavailable.
3. Preserve the source archive and old Bot data. A separately maintained archived deployment must use its own profile; the reserved Desktop profile rejects re-enabling the retired bundle.
4. Verify that creating a conversation offers no Bot switch, while previous native history and saved model selections remain available.
