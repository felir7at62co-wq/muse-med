---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-23-video-observation

[English](2026-10-23-video-observation.md) | 中文

## 概述

新增必要的 video/review 事件，保存整集扫描、图片进入模型及逐图观察进度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-23-video-observation
baseline: false
changes:
  - root: "event:video/review"
    previous: null
    after: "a51ea1c0eeabeaf78e7339560ea6bd1b776373db63e4831e7eceb73f1e66d489"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有事件和会话封装不变。忽略新事件会丢失待完成的交付检查，因此旧运行时拒绝包含该事件的会话；增量更新在重载后重建 Host 内部投影。

<a id="verification"></a>
## 验证

真实 FFmpeg 和实际模型调度测试覆盖全范围切镜、累计运镜变化、未查看图片拒绝、图像请求失败、同程序确认、待完成交付、源变化和插件重载。

<a id="dev-note"></a>
## 开发备注

无。
