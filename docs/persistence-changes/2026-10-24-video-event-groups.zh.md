---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-video-event-groups

[English](2026-10-24-video-event-groups.md) | 中文

## 概述

为视频观察添加可选的模型动作事件及绑定来源版本的已保存ASR引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-video-event-groups
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-23-video-observation"
    after: "3a7a2a0ae101f700a0b05dd7d4d008406f51689f5a215eb106ce578e299d8c43"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有video/review记录和投影快照在没有event_groups或transcript_reference时仍可读取。开始及更新记录中的两个字段均可选；缺失时保留原值，新视频版本均不继承。事件关联观察摘要，不证明语义正确。ASR引用保留路径、文件系统版本和SHA256，隐式回读失败只返回诊断，不阻止事件记录或交付。原观察完成要求及交付条件不变。

<a id="verification"></a>
## 验证

聚焦的视频与文稿行为测试、录制会话回放及两端SDK投影覆盖可选事件、已保存ASR引用，以及没有这些字段的旧观察记录。事件证据仍是模型笔记，这些检查不代表剧本质量通过。

<a id="dev-note"></a>
## 开发备注

无。
