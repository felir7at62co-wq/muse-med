---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-generation-watch-attribution

[English](2026-11-06-generation-watch-attribution.md) | 中文

## 概述

将生成任务通知记录为新增生产者归属，群聊回传依据独立持久化记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-generation-watch-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "6c37a088618b135bd4c0abb19be92614188d624c53e08eaccdbe589d59506296"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "e227a3a9ea5ff1ee20967f7a6bb3f7209138142ff57328b1bdeb6fe7b2c84a0e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "0b01cb0d38b2c5bd015a193722ecb3b9e7eb5d82ce577e4dc16aad30a29db7cc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "328787366ef0ced90e9b84802d060418f88be8d79465489b7bc0ca3aa902aa7b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V4 事件仍可读取。未加载生产者的读取方保留通知正文、身份和来源元数据，不解释群聊字段。群聊路由仅依据独立保存且与执行者、通知和回执 ID 匹配的回传记录。重建缺失记录必须在执行者 Session 历史中找到原始 bot/room 分工，来源元数据不能建立或改发记录。证据缺失的通知仍可读取，并报告群聊回传待复核。合法回传记录保留重启接续、去重和暂停行为。无需更改 Session 头或事件封套。

<a id="verification"></a>
## 验证

生成任务通知 Loader 与原生来源接入测试 37 项、群聊工作测试 64 项通过。覆盖未加载生产者时保留完整群聊元数据及模型历史、合法分工重建、缺少分工拒绝、篡改来源委派人、执行者或通知身份不符、重启、委派人回执去重和已暂停回传恢复。实际重新提取将四个受影响根分类为同版本归属新增。

<a id="dev-note"></a>
## 开发备注

无。
