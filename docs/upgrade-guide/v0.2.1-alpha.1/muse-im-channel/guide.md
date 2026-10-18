---
kind: upgrade-guide
description: "Muse replaces the previous Feishu channel with the native IM settings and channel provider."
---

# Muse IM channel settings

English | [中文](guide.zh.md)

## Change

Muse uses `@xmanrui/dsh-im` for IM connections. Bot management moves to Settings → IM bots. The legacy `feishu-channel` row imports an enabled, configured Feishu app once; subsequent bot settings and credentials belong to the native IM stores. The account's independent desktop remote provider remains unchanged.

A Feishu bot's direct and group chats use the workspace selected in its IM settings. They share files and materials, while each chat keeps its own Session history. Per-chat directory overrides no longer apply. Startup detaches bindings whose recorded Session working directory differs from the bot workspace, without moving or deleting their Session logs or files. Matching bindings retain their Session IDs. Unreadable Session metadata blocks reuse and leaves the binding intact. Conversation commands cannot assign a different workspace to just one chat.

## Migration

1. Finish running tasks, then restart Muse after updating. Profile preparation backs up the package manifest and replaces the previous Feishu bundle. Keep the original credential patch, Session logs and `feishu/accounts` directory until migration succeeds.
2. Open Settings → IM bots → Feishu. Confirm that the existing bot is connected. The import retains access from previously allowed groups and still requires an exact bot mention. Registered owners may also use the bot in a new group by mentioning that exact bot. Native access policy still applies; other new-group members gain no local permissions, and control commands and operation cards remain owner-only. Private messages retain the configured owner identities.
3. Check the bot's current workspace in its settings. Select the directory containing the files and materials that its direct and group chats should share. Changing this selection affects subsequent work in all the bot's chats; it does not move old files or rewrite history.
4. Send a message from an existing authorized conversation. A matching workspace retains the original Session ID. A binding to a different working directory starts a separate Session in the selected workspace on the next message. A private legacy binding additionally requires a real incoming message to prove the old chat ID and authorized peer. Confirm that direct and group chats use the selected directory and retain separate histories. Other native bots and their settings are not overwritten.
5. Manage further connections in IM bots. Do not use the legacy switch to edit an imported bot. If import reports an unknown owner or invalid data, correct the old configuration before retrying; the importer leaves the old files intact and does not open access.
