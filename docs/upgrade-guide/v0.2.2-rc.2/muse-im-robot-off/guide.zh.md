---
kind: upgrade-guide
description: "Muse Desktop 配置不再挂载 `@xmanrui/dsh-im` IM 机器人和飞书设置页，IM 改由 Bot 工作区提供。"
---

# Muse IM 机器人停用

[English](guide.md) | 中文

## 变更

Muse Desktop 配置此前在 `feishu-channel` 行挂载 `@xmanrui/dsh-im` 提供方，在 `feishu` 行挂载 `@deepseek-ai/dsh-feishu-settings` 页面。设置中显示“IM机器人”，每个 IM 聊天由该机器人所选工作间里的一个普通对话回答。

现在产品补丁停用这两行。设置中只有一个 IM 页面，属于 Bot 工作区：一个连接归属一个 Bot，每个聊天可以改指向另一个 Bot 或群聊，陌生发送者需要先批准，群消息必须 @ 机器人。该页面提供 Telegram、微信、飞书 / Lark、钉钉、企业微信、QQ、Discord 和 Slack。

升级后，此前配置的 IM 机器人不再应答，包括从旧版 Muse 集成导入的飞书应用。WhatsApp、企业微信应用、iMessage、邮件、Matrix 和 AI Office 不再提供，把文件发回聊天的 `dsh_im_return_file` 工具不再存在，切换聊天所用对话或工作间的聊天命令也不再生效。`@xmanrui/dsh-im` 包仍保持安装，因为账号远程访问与它一同打包。它保存在 Harness 主目录 `integrations` 下的机器人、凭据和聊天绑定既不读取也不删除，也不会迁移到新页面。

## 迁移

1. 升级前，记下每个 IM 机器人的平台、应用凭据以及使用它的聊天。
2. 升级后，打开设置 → IM，选择平台并用同一套应用凭据连接。微信通过扫描二维码连接。
3. 选择应答该连接的 Bot。要把某个聊天交给另一个 Bot 或群聊，在同一页面修改该聊天的目标。
4. 用每个需要联系 Bot 的账号发一条消息，然后在页面上批准该发送者。在群里需要 @ 机器人。
5. 如果配置补丁对 `feishu-channel` 或 `feishu` 写了 `disabled: false`，将其移除；产品补丁在配置之后应用，会让这两行保持停用。
6. 确认结果：设置中只列出一个 IM 页面，私聊消息由所选 Bot 应答，此前的机器人不再回复。
