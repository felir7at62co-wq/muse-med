---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-market-session-binding

[English](2026-11-09-market-session-binding.md) | 中文

## 概述

在参与市场 Skill 的 Session 首次请求之前记录不可变发布版本集合，并通过带版本的投影重建。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-market-session-binding
baseline: false
changes:
  - root: "event:muse-market/bound"
    previous: null
    after: "5f1e4fe6e8aa242d8c33ece014004d8082b0429eb4bee69a93c0093c30bcac8f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 4。新增 muse-market/bound 事件必须在读取时被识别，不标记 ignorable：旧词汇表的读取器会拒绝该事件，不会改为执行当前默认版本。既有日志保持可读。事件记录精确的归档标识、清单与不依赖调用方的候选元数据；投影缓存可丢弃后重建。已执行但没有该事件的日志不获得市场版本。Fork 保留完整事件前缀。独立的私有发布台账显式从版本 1 迁移到版本 2，并保留原始备份；这不是 Session 格式转换。已接受的历史记录与已定版 schema 保持不变。

<a id="verification"></a>
## 验证

已通过普通命名 profile 与六个真实 Session 日志执行 Source Native/PTC 生命周期场景、本地迁移与 provider 测试、真实 Agent 卸载及持久化 JSONL 冷视图测试、真实 SessionStore fork 与冷投影重建，并通过已发布 V4 读取器验证当前词汇表接受、前代词汇表拒绝。11 个局部测试文件共 109 项通过且无跳过。新增 TypeScript 与 Python SDK 测试随后均通过正常构建的 CLI 执行成功，无跳过，保留必读事件与完整发布版本标识。这些检查覆盖日志与投影行为，不代表已验证桌面 GUI、云端发布或旧版已安装应用。

<a id="dev-note"></a>
## 开发备注

无。
