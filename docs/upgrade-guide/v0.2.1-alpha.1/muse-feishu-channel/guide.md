---
kind: upgrade-guide
description: "Muse Desktop replaces its Feishu channel with the bundled PGZXB provider and requires explicit recovery when an old Session has no recorded chat owner."
---

# Recover an existing Muse Feishu conversation

English | [中文](guide.zh.md)

## Change

Muse Desktop uses the bundled `@dsh-feishu/dsh-feishu` provider for its existing `feishu-channel` settings row. The separate `@wenbin_wb/dsh-bridge/remote` provider continues to supply Muse account connectivity. Profile-installed copies cannot replace these two application entries. Other profile plugins retain their normal resolution.

Existing credentials, activation, sender policy and Session logs remain in place. The old channel did not durably associate its `activeSessionId` with a chat. The new channel preserves that recovery candidate and requires an explicit choice in an authorized chat before continuing it; it does not assign a previous Session to whichever chat arrives first. New chat bindings persist separately for each app and registering user. Videos are delivered as downloadable file attachments.

## Migration

1. Upgrade and restart Muse Desktop. Keep the existing robot credentials and Feishu settings; a fresh registration is unnecessary.
2. In the authorized Feishu chat, mention the robot if the existing group policy requires it. If Muse offers the previous Session, send `/resume <session-id>` using the offered ID, or `/new` to begin another conversation. `/sessions` lists available conversations. Recovery retains the original working directory, and an existing chat binding takes precedence.
3. Send a message and confirm its reply appears in that chat. Restart Muse, then send another message and verify it continues the same conversation. Never delete old Session files to resolve a missing chat binding.
4. If initialization reports malformed channel state, preserve that file for repair. Do not replace it with an empty map: that would discard the available chat bindings. Interrupted messages are not automatically replayed; check the conversation and any generation receipts before requesting another attempt.
