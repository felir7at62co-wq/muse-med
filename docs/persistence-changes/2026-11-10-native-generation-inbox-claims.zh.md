---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-native-generation-inbox-claims

[English](2026-11-10-native-generation-inbox-claims.md) | 中文

## 概述

记录可选启用的持久 inbox claim 及显式暂停的生成通知，不改写已发布 Session 代际。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-native-generation-inbox-claims
baseline: false
changes:
  - root: "event:agent/inbox/claim"
    previous: null
    after: "a0e0ccee6eafb5768d3d70a18b770f2e46f0cb433b5166071794f45b7f2aa226"
    decision: same-version
  - root: "event:agent/inbox/claim-filtered"
    previous: null
    after: "5693a3ce83271b322c4f9b90578ea06aebc3188348df9aea477831e0b3057d23"
    decision: same-version
  - root: "event:agent/inbox/claim-settled"
    previous: null
    after: "dd3cf0360eea7a8a61f65b2f6a39b392e388753520aa8692e3f1269397fd4a6b"
    decision: same-version
  - root: "event:jubian/generation-notice-parked"
    previous: null
    after: "982bd7ddda1aaac568bb802815acdb1a2321eedf020858982a4667226dd0bd52"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 4。三个 claim 事件记录原排队消息 ID、轮次、步骤、过滤及结算；暂停通知事件记录生产者卸载前移出的自动输入。这些事件必须被读取方理解；不认识新事件的旧读取方拒绝该日志，避免静默丢失或重复消费。本版本仍读取没有这些事件的旧日志；未启用 durableInboxClaims 的配置保持原事件顺序。恢复保留未入档 claim 的原消息 ID，仅按已有用户取消或 fork 决策丢弃；已经送入模型但结果不明的输入保持 unknown，不重放。Fork 子 Session 不继承活动 claim。不改写任何已提交格式代际、迁移输入或原 JSONL 夹具。

<a id="verification"></a>
## 验证

独立复核的 Client、Inbox、真实 AgentLoop SDK server 与 TypeScript SDK 测试 143 项通过；Python SDK 透传测试 34 项通过。SDK 客户端夹具证明事件传输，不代表双语言全链路真实调用。确定性离线模型下，八项真实 Session、模型、工作区原生续聊测试及原独立卸载回归通过。真实 keyless Web 队列回放 24 项通过，保留一项仅录制模式跳过；持久 claim 变体保留原人类输入 ID。最终构建、完整 SDK 录制输出、打包及全候选整合尚未完成。

<a id="dev-note"></a>
## 开发备注

无。
