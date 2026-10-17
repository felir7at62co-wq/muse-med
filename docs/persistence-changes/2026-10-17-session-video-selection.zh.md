---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-session-video-selection

[English](2026-10-17-session-video-selection.md) | 中文

## 概述

记录用户明确选择的会话视频模型、分辨率及其追加的上下文通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-session-video-selection
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "f085dd54110dec859015f00be03b3cca9f89ee4453f13c15475ed4d29b355bad"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "8a6b94a4953dffa0e75b7719513e3723c0120a05ccf19d2bdb24002e97407c6a"
    decision: same-version
  - root: "event:jubian/video-selection"
    previous: null
    after: "5d51147a01535f1aa01a7c6cd9d2a27ba2f9262c6f51e81d59c90de0dfa7128b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "31f3c9d54f3f5607a53c45aad9ef7120b4f1ed7707f6ec607dee674664aafab4"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-10-screenplay-self-check-read"
    after: "c7c997c0ccfa257322588cf64eac056323ce2826d9a3f9263b97e82e83377ec9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话仍可读取。必读的 jubian/video-selection 事件在重载、分叉与压缩后保留用户选择；不认识该事件的旧构建拒绝读取新日志，避免重建出不同的生成配置。切换视频模型不替换系统提示词，不修改已提交的服务商任务。

<a id="verification"></a>
## 验证

video-session 与 video-selector 定向测试通过，覆盖 25 秒视频包与 15 秒模型的冲突、明确选择模型、拒绝过期预览、视频卡同步与原 key 对账。

<a id="dev-note"></a>
## 开发备注

无。
