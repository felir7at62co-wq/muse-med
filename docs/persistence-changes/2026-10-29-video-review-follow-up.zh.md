---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-video-review-follow-up

[English](2026-10-29-video-review-follow-up.md) | 中文

## 概述

为已保存的视频观察起始及更新事件增加可选的单视频跟进状态。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-video-review-follow-up
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-24-video-event-groups"
    after: "5781c389fbe44583fcaa6b8e6e8194163bc90a27b241f5cb0efc1c7af428bdbd"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 video/review 事件仍可读取，缺失 follow_up 按 active 解释。关闭保留来源版本、缓存原图、扫描进度与观察；恢复前核对来源未变。不改变会话封装或写入版本。

<a id="verification"></a>
## 验证

无密钥审看测试覆盖保留证据缺口、重复关闭和恢复、同版本续看、来源变化拒绝复用、来源缺失后关闭、冷恢复投影及缺少 follow_up 的旧结果。

<a id="dev-note"></a>
## 开发备注

无。
