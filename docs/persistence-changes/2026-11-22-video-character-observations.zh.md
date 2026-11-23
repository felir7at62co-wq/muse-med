---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-22-video-character-observations

[English](2026-11-22-video-character-observations.md) | 中文

## 概述

在 video/review 的开始与更新事件中，为逐帧观察保存可选的角色比对结果。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-22-video-character-observations
baseline: false
changes:
  - root: "event:video/review"
    previous: "2026-10-29-video-review-follow-up"
    after: "1494cebd6a70f38c07d1b10fbfa12b2e6e373b564b44548772324383f887aacc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

缺少角色比对的历史审看仍可读取，并沿用现有来源检查。旧读取器仍能读取原观察字段并保留 Session 事件，继续执行已有的证据和选源审核。审看报告与投影观察的字节不一致时，已有证据检查会拒绝。支持该字段的读取器可以按角色比对执行严格选源。不改变 Session 封装或写入版本。

<a id="verification"></a>
## 验证

视频审看测试覆盖缺少可选比对、角色匹配和仍待处理的结论，也验证恢复同一会话后继续拒绝未通过的选片。源码和构建版审看回放确认只修改普通备注时保留角色疑点。既有视频观察与审看生命周期会话仍可回放。

<a id="dev-note"></a>
## 开发备注

无。
