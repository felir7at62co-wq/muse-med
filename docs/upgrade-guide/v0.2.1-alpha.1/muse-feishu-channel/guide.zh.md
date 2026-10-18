---
kind: upgrade-guide
description: "Muse Desktop 改用内置 PGZXB 飞书提供方，旧 Session 未记录聊天归属时需要显式恢复。"
---

# 恢复现有 Muse 飞书会话

[English](guide.md) | 中文

## 变更

Muse Desktop 在现有 `feishu-channel` 设置项中使用内置 `@dsh-feishu/dsh-feishu` 提供方。独立的 `@wenbin_wb/dsh-bridge/remote` 提供方继续支持 Muse 账号连接。profile 中安装的副本不能替换这两个应用入口。其他 profile 插件继续按普通规则解析。

现有凭证、启用状态、发送者策略和 Session（会话）日志保留原位。旧通道没有持久保存 `activeSessionId` 所属的聊天。新通道保留该恢复候选，要求在获授权的聊天中显式选择后再继续，不会将旧 Session 分配给第一个发来消息的聊天。新的聊天绑定按应用和注册用户分别持久保存。视频以可下载文件附件发送。

## 迁移

1. 升级并重启 Muse Desktop。保留现有机器人凭证和飞书设置，无需重新注册。
2. 在获授权的飞书聊天中发消息；现有群策略要求时需 @ 机器人。如果 Muse 提示存在旧 Session，使用提示的 ID 发送 `/resume <session-id>`，或通过 `/new` 新建会话。`/sessions` 可查看会话。恢复会保留原工作目录，已有聊天绑定优先。
3. 发送消息，确认回复出现在该聊天。重启 Muse，再发一条消息，检查是否继续同一会话。不要通过删除旧 Session 文件解决聊天绑定缺失。
4. 若初始化报告通道状态格式损坏，保留该文件以便修复。不要用空映射替换，否则会丢弃已有聊天绑定。中断的消息不会自动重放；再次要求执行前，先检查会话和生成回执。
