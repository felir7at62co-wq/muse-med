---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-working-context-target

[English](2026-10-31-working-context-target.md) | 中文

## 概述

为 request/context 添加可选 workingTokenLimit，记录所选路由的压缩工作目标。

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
    after: "6b8aae0eeb37a056c0770d57276b41b3ca1364abc5f9c233906d3f359fda5c6f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新字段可省略，已有 Session 代际仍可读取。缺失值保留模型窗口显示，并清除上一路由的目标。不替换规范日志或迁移代际。

<a id="verification"></a>
## 验证

定向上下文压力投影与上下文计量组件测试覆盖记录目标、旧记录缺省值、目标移除和路由切换；最终结果记录在修复报告中。

<a id="dev-note"></a>
## 开发备注

无。
