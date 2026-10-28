---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-28-jubian-video-reuse-advisory

[English](2026-10-28-jubian-video-reuse-advisory.md) | 中文

## 概述

增加仅标识归属的 jubian-video-reuse 来源，用于记录已有媒体提取与复用提示。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-jubian-video-reuse-advisory
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-session-video-selection"
    after: "36d9e021c14447252c9a0dc79d33b396c264282f755903159327fe325ee6ef31"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-session-video-selection"
    after: "2905955547068b8519caf2470abf2861fdc41ddba2fa8d762d454c5436e29761"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-session-video-selection"
    after: "887a4e5f9db8d6ac0451a64438ab53ae322bb3c18841db64e152abd39b31554b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-session-video-selection"
    after: "7d890878cfad3f9b08b4657f31badbd9c8d5d7f69af360935090ab352d65db14"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话记录仍有效，写入格式不变。新来源承载普通上下文，不增加校验或授权要求；没有该生产者的读取方也保留消息。Hook 根据本次新进入的真人消息工作，恢复时不依赖来源投影。

<a id="verification"></a>
## 验证

video-reuse-advisory-loader.spec.ts 覆盖已记录模型上下文、去重、后续意图变化、正常工具执行与释放。muse-existing-video-reuse 的无密钥 Headless 会话快照在不发起提供方写入的情况下回放。

<a id="dev-note"></a>
## 开发备注

无。
