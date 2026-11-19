---
kind: upgrade-guide
description: "The Muse Desktop profile no longer mounts the `@xmanrui/dsh-im` IM robot or the Feishu settings page; IM now belongs to the Bot workspace."
---

# Muse IM robot turned off

English | [中文](guide.zh.md)

## Change

The Muse Desktop profile mounted the `@xmanrui/dsh-im` provider in the `feishu-channel` row and the `@deepseek-ai/dsh-feishu-settings` page in the `feishu` row. Settings showed “IM机器人”, and each IM chat was answered by an ordinary conversation in the workspace chosen for that bot.

The product patch now disables both rows. Settings shows one IM page, which belongs to the Bot workspace: a connection belongs to one Bot, each chat can be pointed at another Bot or a group chat, unknown senders wait for approval, and a group message must mention the bot. That page offers Telegram, WeChat, Feishu / Lark, DingTalk, WeCom, QQ, Discord and Slack.

IM bots configured earlier stop answering after the upgrade, including a Feishu app imported from the older Muse integration. WhatsApp, the WeCom app, iMessage, Email, Matrix and AI Office are no longer offered, the `dsh_im_return_file` tool that sent a file back to a chat is gone, and the chat commands that switched a chat's conversation or workspace no longer apply. The `@xmanrui/dsh-im` package stays installed, because account remote access is packaged with it. Its saved bots, credentials and chat bindings under the Harness home's `integrations` directory are neither read nor deleted, and nothing migrates them to the new page.

## Migration

1. Before upgrading, note for each IM bot its platform, its app credentials and which chats used it.
2. After upgrading, open Settings → IM, choose the platform and connect it with the same app credentials. WeChat connects by scanning a QR code.
3. Pick the Bot that answers the connection. To send one chat to another Bot or to a group chat, change that chat's target on the same page.
4. Send a message from each account that should reach the Bot, then approve the sender on the page. In a group, mention the bot.
5. Remove a profile patch entry that sets `disabled: false` on `feishu-channel` or `feishu`; the product patch applies after the profile and keeps both rows off.
6. Confirm the result: Settings lists one IM page, a direct message gets an answer from the chosen Bot, and no reply comes from the earlier robot.
