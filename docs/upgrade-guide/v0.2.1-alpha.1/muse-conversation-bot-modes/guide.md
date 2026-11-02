---
kind: upgrade-guide
description: Ordinary Muse Sessions no longer automatically become persistent Bots.
---

# Separate Conversation and Bot modes

English | [中文](guide.zh.md)

## Change

Muse uses `autoSessionBots: false` by default. Opening Bot mode no longer registers ordinary Sessions or forks in the team roster. The switch beside the MUSE account at the bottom of the sidebar selects Conversation or Bot mode and retains each mode’s last selection.

Existing Bot identities, including older automatic entries, keep their Sessions and memory. Session logs, memory files and model defaults are not migrated or removed. Bot-owned Sessions remain accessible in the native history for compatibility.

## Migration

1. Use Conversation for ordinary Sessions and Bot for persistent team members. Existing profiles using the bundled Muse composition need no manual data migration.
2. To turn a Session into a Bot, use Settings → Bots → Use an existing conversation. Registration keeps its original history.
3. Custom deployments that intentionally need the previous automatic roster can set `autoSessionBots: true` on their own `ds-bot` entry; the bundled Muse desktop composition requires `false`.
4. Verify that creating an ordinary Session leaves the Bot roster unchanged, and that existing Bots and their memory remain available after switching modes and restarting.
