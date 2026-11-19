---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-muse-router-production

[English](2026-11-18-muse-router-production.md) | 中文

## 概述

在已有消息中记录本机主会话的首次问候上下文，以及用户确认的镜流制片项目。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-muse-router-production
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-16-frame-offload-notice"
    after: "8554cf1b722e52582f19badc44dd0baf3d07e789247f5223c630e3d808b4e8b4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "dc0fbfdb30a76f059e8d2fcfba6c7854c9f2fc6a6625271ade3593e78dd97206"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-16-frame-offload-notice"
    after: "90e81fcda543d7c3249523608e4128d7004e47f518cbbbc29a3675679679d99b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-16-frame-offload-notice"
    after: "0160ba58fbfc1a805012ea62c8e68aa27afe0f76cce0a47edb4be7391af00bf5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两种来源均携带通知形式、摘要与正文。原有消息仍可读取。未识别新来源的读者按通知展示，主会话派发任务仍需用户的实际请求。

<a id="verification"></a>
## 验证

主会话和项目测试覆盖首次开场、派发所需用户输入及不同本机会话和镜流账户的项目隔离。

<a id="dev-note"></a>
## 开发备注

无。
