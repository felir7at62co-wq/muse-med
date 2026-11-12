---
kind: upgrade-guide
description: "Muse hides preset selection and ignores the saved default when creating ordinary Sessions."
---

# Muse Session entry

English | [中文](guide.zh.md)

## Change

Muse no longer displays the preset selector. New ordinary Sessions use the short-drama preset even when an earlier user-selected default is saved. The retained Main Session opens on startup and through the Muse entry; it no longer appears in the Workspace session list. Its history and existing ordinary Sessions remain available.

## Migration

1. Open Muse to see the retained Main Session and its prior conversation. Use the Muse entry above New Session to return from another conversation.
2. Use New Session for short-drama work and open existing Sessions from their Workspace as before. Saved historical preset selections are not changed.
3. If a custom profile depends on the earlier default-selection behavior, review its `agent-preset-registry` configuration and set `allowUserDefault: true` only where that behavior is required.
