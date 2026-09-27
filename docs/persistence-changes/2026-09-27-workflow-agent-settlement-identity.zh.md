---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-workflow-agent-settlement-identity

[English](2026-09-27-workflow-agent-settlement-identity.md) | 中文

## 概述

在持久化的 workflow 成员结算记录上，记录该成员对应哪个子 agent，以及它为何失败。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-workflow-agent-settlement-identity
baseline: false
changes:
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "86d346e960ae99afd17e93e196fd21ec4af124c9291e9a8dfdb120b21e2b2b61"
    decision: same-version
  - root: "event:tool-workflow/agent-end"
    previous: "2026-09-11-initial"
    after: "97f28ee66b90659375a15144c1629b784d4f4a70978d0b414e6bdde2e20d5da0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

`tool-workflow/agent-end` 的三个成员都是既有载荷的可选新增，因此此前写下的每条日志仍可读取并保持原意：`label` 与 `childId` 只是重复 `tool-workflow/agent-start` 已为同一 run 与 seq 记录的内容，而缺少 `reason` 本来就是更早每次结算的状态。忽略这三者的读取方仍能像以前一样重建运行、成员及其结果；相邻的 v0-to-v1 校验器在成员存在时接纳它并校验其类型。Session 格式版本、事件信封与事件词汇均未改变。此处同时记录的 `event:request/header` 条目确认本工作树中并行工作为同一载荷根新增的可选成员 `config.responseFormat`；其兼容性论据是：缺少响应格式时，此前的每个请求读起来都与原来一致。

<a id="verification"></a>
## 验证

`packages/workflow/tool-workflow/tests/invariant.spec.ts` 覆盖了实时追加与冷历史两条路径上的新增检查：`failed` 结算缺少原因、无法识别的原因种类、空的 structured-output 详情、完成成员携带原因、成员身份与其开始记录不一致、以及空的 child id 都会让持久记录 invariant 失败，而省略重复身份的结算仍可读取。`packages/workflow/tool-workflow/tests/tool-workflow.spec.ts` 固定了完成成员的记录载荷。`packages/session/session-format-v0-to-v1/tests/` 覆盖了接纳这三个可选成员的已发布载荷校验器。两次聚焦运行均通过。

<a id="dev-note"></a>
## 开发备注

无。
