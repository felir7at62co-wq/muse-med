---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-muse-alpha2-message-join

[English](2026-11-04-muse-alpha2-message-join.md) | 中文

## 概述

合入 DSH 0.2.1-alpha.2 后，合并四种含消息事件的 V4 持久化历史。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-11-04-muse-alpha2-message-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "86efd0c875c9ca4b27a9990f99b728433c0736d9b0842f90afea5cba423f3ebe"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "13ea55c93a0d3abdb7a0f63e126bb7d14d1a105cdbf5fa9b304641fe21b73865"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-10-07-title-reasoning-effort","2026-10-28-jubian-video-reuse-advisory"]
    after: "da1814ad522146407f02a565bd6b88c5e292d213fbe730b8dd077a35aff7372e"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-10-05-working-directory-attribution","2026-10-28-jubian-video-reuse-advisory"]
    after: "2960e0622ba6a33314027bd45e0d97edb402184ab22ee5db4dea0dd0f1699906"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

合并后的读取器接受两边历史的记录，并保留原有的消息含义。新增来源类型仅表示归属。较早的 V4 读取器保留未知来源及其 JSON 元数据，无需解释它。标题请求的推理强度仍为可选。省略它的记录仍未记录推理强度，较早的读取器可忽略它。会话写入版本仍为 V4。

<a id="verification"></a>
## 验证

将源码提取的模式与八个前序模式比较，差异仅包含新增的合格归属类型和一个可选字段。工作目录、标题模型和剧变视频复用的测试共通过 42 项。

<a id="dev-note"></a>
## 开发备注

无。
