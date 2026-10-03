---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-muse-v4-request-header-join

[English](2026-09-30-muse-v4-request-header-join.md) | 中文

## 概述

合流两份已确认的请求头历史，同时保留 V4 禁用的 system 字段、工具延迟加载标记和可选的响应格式配置。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-09-30-muse-v4-request-header-join
baseline: false
changes:
  - root: "event:request/header"
    previous: ["2026-09-16-session-format-v4","2026-09-27-workflow-agent-settlement-identity"]
    after: "a17b7c32461547b1546b59e8adfa07159a369204c52fd0c9f016a0061e3cd8d8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

request/header 的 after schema 保留两个前驱 schema。相对 V4 确认记录，仅新增可选的 config.responseFormat；相对工作流结算确认记录，仅新增可选的 tools[].deferLoading 和禁用 system 字段声明。已有请求头仍可读取；缺少响应格式或延迟加载标记不改变其含义。system 属性仍为可选 never，原生读取器仍拒绝 JSON 值。旧读取器可忽略其不使用的可选配置。此同版本合流保留已接受的 V4 请求头版本变更、两份原始机器声明与快照，以及所有已提交的 Session 代际文件；不改变写入版本，也不引入迁移。独立根类型上的工作流 agent-end 确认记录保持不变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run scripts/persistence-changes.spec.ts --maxWorkers=1 通过 80 项测试。合流用例检查两个保留的前驱声明、合并后的可选字段、缺失或重复的前驱、未合流的终端分支、删除或改型任一前驱字段、双语记录生成以及定版检查点重建。记录生成器将当前源码生成的 schema 分别与每个前驱比较，未发现破坏性差异。

<a id="dev-note"></a>
## 开发备注

无。
