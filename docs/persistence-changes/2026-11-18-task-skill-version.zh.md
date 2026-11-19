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
    previous: "2026-11-18-muse-router-production"
    after: "3ecea67d7461aad0997293128ef9f73b33357d58e128fd3645ad4c1cb20fcb80"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-muse-router-production"
    after: "3882ae20f501500f7de29ca4405de601723d3f0b763cb09d7f0d24479a8bfa4f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-muse-router-production"
    after: "40e2889044487ee7fca767922de15b5d68570afceba27931ef9484a1754fef29"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-muse-router-production"
    after: "57d7977bf84c7519143fb285f05f0c20acd5c836a4b3437221361b3cb82fce05"
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
