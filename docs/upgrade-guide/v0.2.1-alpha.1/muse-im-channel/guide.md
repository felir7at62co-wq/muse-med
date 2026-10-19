---
kind: upgrade-guide
description: "Muse replaces the previous Feishu channel with the native IM settings and channel provider."
---

# Muse IM channel settings

English | [中文](guide.zh.md)

## Change

Muse uses `@xmanrui/dsh-im` for IM connections, and the default Desktop bundle mounts that canonical provider. Bot management moves to Settings → IM bots. The legacy `feishu-channel` row imports enabled Feishu credentials once; native IM stores then own settings. The bridge root now fails explicitly, its `./client` entry is absent, and `@wenbin_wb/dsh-bridge/remote` continues account remote access.

Messages and cards use only the native IM policy; legacy allowlists and owner-only cards no longer apply. Registered owners retain native privileges. Allowed members can answer their own questions, including custom answers, without command permission; others receive an explicit notice. Management buttons require command permission. Group access does not alter Agent tool permissions or sandbox settings.

A Feishu bot's direct and group chats use the workspace selected in its IM settings. They share files and materials, while each chat keeps its own Session history. Per-chat directory overrides no longer apply. Startup detaches bindings whose recorded Session working directory differs from the bot workspace, without moving or deleting their Session logs or files. Matching bindings retain their Session IDs. Unreadable Session metadata blocks reuse and leaves the binding intact. Conversation commands cannot assign a different workspace to just one chat.

## Migration

1. Finish running tasks, then restart Muse after updating. Profile preparation backs up the package manifest and replaces the previous Feishu bundle. Keep the original credential patch, Session logs and `feishu/accounts` directory until migration succeeds.
2. Open Settings → IM bots → Feishu. Check the bot's connection and direct/group message and command permissions. From an allowed member's account, mention the exact bot in a group and confirm its reply. Disable command permission: the member can answer their own task's question, including a custom answer, but cannot use management buttons. Another member cannot answer that question. Legacy allowlists no longer override the saved settings.
3. Check the bot's current workspace in its settings. Select the directory containing the files and materials that its direct and group chats should share. Changing this selection affects subsequent work in all the bot's chats; it does not move old files or rewrite history.
4. Send a message from an existing authorized conversation. A matching workspace retains the original Session ID. A binding to a different working directory starts a separate Session in the selected workspace on the next message. A private legacy binding additionally requires a real incoming message to prove the old chat ID and authorized peer. Confirm that direct and group chats use the selected directory and retain separate histories. Other native bots and their settings are not overwritten.
5. Manage connections in IM bots. Custom profiles must replace a bridge root plugin row with `@xmanrui/dsh-im`; keep `./remote` for account access. If import reports an unknown owner or invalid data, correct the old configuration before retrying; the importer preserves old files and keeps access closed.
