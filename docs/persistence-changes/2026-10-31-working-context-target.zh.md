---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-working-context-target

[English](2026-10-31-working-context-target.md) | 中文

## 概述

为 request/context 增加可选 workingTokenLimit 和 workingContextTokens，分别记录压缩目标与准备请求时的校准估算。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-working-context-target
baseline: false
changes:
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "e6880c6e32739d438c181803047edba233b56f4392753f40217b96b2c1595fe9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个字段均为可选，因此已有会话日志仍有效。缺失值沿用旧的模型窗口显示，并清除之前记录的值。上下文压力状态版本 6 会丢弃旧的版本 5 缓存，从未改动的持久日志重新归并。不替换任何规范日志或迁移世代。

<a id="verification"></a>
## 验证

72 项定向 token 压力、上下文表盘及请求重建测试通过，覆盖配对估算、旧值缺失、旧缓存重新归并、目标清除、路由切换与请求准备元数据清除。

<a id="dev-note"></a>
## 开发备注

无。
