---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-muse-dsh-source-attribution

[English](2026-11-05-muse-dsh-source-attribution.md) | 中文

## 概述

合并已发布 DSH 的来源归属声明与 Muse 的任务、视频来源字段，同时保留两个前置确认记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-11-05-muse-dsh-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "ea0842855309e9d6bb36eea0033afd968e975b6586b39c632c7e7d2701a611fe"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "e0b2e1b8723ec2b6217030dfe54154befd1fb185016e418367f26195911a56d0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "e144f096969e45aa427adea3655bea0a17b496c34b556b63d0353e90d55e3798"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-10-13-liveshare-share-viewer-principal","2026-10-28-jubian-video-reuse-advisory"]
    after: "a55a45812f47702b2a328e2cf8f1edc611b264e15092a8d8ed9459ddebb8b2f6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

四个普通事件根保留两个前置声明。新增来源变体通过已声明的未知来源策略保留归属信息，任务与视频新增字段仍为可选。Session 头、事件信封及写入格式不变；已有确认记录的 schema 和规范 Session 世代保持完整。

<a id="verification"></a>
## 验证

持久化历史测试覆盖两个前置分支的新增字段，并拒绝删除或改写任一前置字段的合并。内联确认图与节点表图执行相同的摘要和节点引用校验；按源码提取的检查将合并后的 schema 与当前事件声明核对。

<a id="dev-note"></a>
## 开发备注

无。
