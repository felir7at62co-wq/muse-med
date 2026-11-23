---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-23-video-review-grid

[English](2026-11-23-video-review-grid.md) | 中文

## 概述

在 video/review 开始与更新事件的画面中持久化可选的网格页图片引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-video-review-grid
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-11-22-video-character-observations"
    after: "4edcc6a88477ef1bf4c25584f970653cc92e6ba362e08bcd9736239241c4245a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有审看记录没有网格引用时仍可读取，并保持单图准入。较早的读取方会丢弃该字段，保留全部已记录的图片、展示状态和观察；它们自身不会发送网格页。观察报告不含该字段，因此任何读取方得到的报告字节和摘要都不变。Session 外层格式和写入版本不变。

<a id="verification"></a>
## 验证

视频检查测试覆盖请求失败并重载插件后的网格准入、跨网格批次的逐帧计数、共享网格页的卸载，以及不含网格引用的报告。既有视频观察与审看生命周期快照继续回放。

<a id="dev-note"></a>
## 开发备注

无。
