---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-15-session-activity-source

[English](2026-11-15-session-activity-source.md) | 中文

## 概述

新增 session-activity 用户消息来源，父会话收到其关注会话的进展摘要时写入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-session-activity-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "e8c6fc6673990685c3ccdb4331417519950a67f7e7aeac35d3d815a123410037"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "a2d6e48ca336be861ef5878ef441238b10cb5c167492d69ca4331b2c2d56052a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "b99ed1595d045fbf7d06e0f802343409972a2dd6c2d74cf2ef496d24e55da34f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-muse-main-coordinator-attribution-join"
    after: "95221de83f281e153f237219268fb343d48447ff67a31c970d9049ffc7ab0ccd"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该来源是可合并扩展的 MessageSourceMap 新 kind，形式为带摘要的 notice；旧读者对未知 kind 走默认分支，把消息当作普通用户内容展示，消息正文是普通文本。未改动任何既有事件或来源，因此会话格式版本不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-activity packages/session/session-coordinator/tests/activity.spec.ts

<a id="dev-note"></a>
## 开发备注

无。
