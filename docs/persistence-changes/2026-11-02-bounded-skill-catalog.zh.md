---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-bounded-skill-catalog

[English](2026-11-02-bounded-skill-catalog.md) | 中文

## 概述

为持久化的 skill（技能）目录来源元数据增加可选 bounded 标记。四个受影响的事件根通过 same-version 确认记录保持当前 Session 格式。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-bounded-skill-catalog
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "4b9599858dc5a5a9d7f120e4b57ea2d0ff3171245b369dd39afa9dabdb475bf5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "86570a1d97f83ba130d5754ff29bfb9d484d52ec8ce6ea7742c0ccbd9a3455f6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "1b4648416a7646623c1af3190cfda7a0e8cdc600440becb2da3d5e314fdc413f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-jubian-video-reuse-advisory"
    after: "fcdab486414b444359406acad9066f78a3918325afa9e89f27bd2d07f18211cc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录缺少 bounded 时仍然有效，并保留完整目录的含义。新记录可以设置 bounded: true，表示摘要曝光受来源限制；该标记既不授予也不禁止 skill 调用。旧读取方回放已记录的目录文本和条目时可以忽略这一可选标记。新读取方将缺少标记的目录视为旧式完整目录。已有事件种类、必需字段和 Session 头保持不变；无需迁移或提高写入版本。

<a id="verification"></a>
## 验证

本地 Vitest 运行 packages/skill/tool-skill/tests/tool-skill.spec.ts 和 packages/skill/tool-skill/tests/catalog-selection.spec.ts，共 81 个测试通过：61 个运行时测试和 20 个筛选辅助函数测试。两个真实 Session 替换用例在没有新的直接用户输入时保留最近持久化目录中仍有效的名称，且不会在压缩后重新注入 Skill 正文。apps/desktop-host/tests/muse-market.spec.ts 中的两个测试通过本地 Loader 和 AgentLoop，使用离线脚本化适配器运行。所属模块内的预期事件投影检查已记录的目录和调用事件；它不是顶层会话记录快照。未进行外部模型或 UI 验收。持久化分类器仅在 event:agent/inbox/spliced、event:developer/message、event:session/title-llm-request 和 event:user/message 的 bounded 字段报告 optional-property-added；每项变化的 requiresVersionBump 均为 false。

<a id="dev-note"></a>
## 开发备注

无。
