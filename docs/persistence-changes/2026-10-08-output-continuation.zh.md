---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-output-continuation

[English](2026-10-08-output-continuation.md) | 中文

## 概述

为日志中的用户角色输入增加由生产方拥有的 output-continuation 来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-output-continuation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-composition-guard-attribution"
    after: "38b41de66ce068ed4f34146e46b2d2bacc489e87baf8ec2b238f24e7dbc1d81c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-composition-guard-attribution"
    after: "18497142905a51d3d0cdc72ca4f015bf271532ff534654de7358904c321c41dd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-composition-guard-attribution"
    after: "8eb9f501473d8d167b979409fc71e36d4d5b61e7dcc887ba6882bfde871b2df3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-composition-guard-attribution"
    after: "7ffbd33ebbc58c33886896a3b4f8eb5e332bb53872f05cc48130cd88bc73f69d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话世代保持不变并继续有效。新记录将自动输入归属于续写插件，相邻步骤事件标识轮次和前一个回答。通用来源读取器保留未知生产方元数据。该来源不授权重启后自动继续运行。

<a id="verification"></a>
## 验证

生产循环及续写测试共 463 项通过，受影响运行文件的语句、分支、函数和行覆盖率均为 100%。新增 SDK 录制会话在同一轮完成三段回答，历史手动继续场景保持不变。

<a id="dev-note"></a>
## 开发备注

无。
