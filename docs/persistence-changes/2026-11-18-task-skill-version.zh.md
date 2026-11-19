---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-task-skill-version

[English](2026-11-18-task-skill-version.md) | 中文

## 概述

显式调用任务技能时可记录完整指令正文的 SHA-256。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-task-skill-version
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-16-frame-offload-notice"
    after: "12edaf44a720c36be66769ff425a33238c819e1626fa986f879ff588e2c01326"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "902b15b30032714c0007111bf052fec90ea4f8664c8c186672a730e97fa786a1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-16-frame-offload-notice"
    after: "cfdf0992f293aa0f49892099d675beb9d95e187e4559f0290763af2b92724a3c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "255a00e63990405d8b65184475ac5757300844072583e7f11f5e268550fa5a31"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧版读取器仍按原有类型读取完整技能调用和原文。新版接受没有摘要字段的历史调用，不据此推断当前任务阶段。消息类型和会话版本沿用现有值。

<a id="verification"></a>
## 验证

技能及桌面测试覆盖普通调用、真实压缩、从 JSONL 重新打开会话、切换阶段、结束阶段与技能内容变更。

<a id="dev-note"></a>
## 开发备注

无。
