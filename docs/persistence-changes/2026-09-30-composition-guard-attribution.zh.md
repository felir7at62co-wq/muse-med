---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-composition-guard-attribution

[English](2026-09-30-composition-guard-attribution.md) | 中文

## 概述

将 composition-guard 记录为已持久化 user 和 developer 消息源的合格归属信息，包括 inbox 与辅助标题请求中的消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-composition-guard-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "dc8960018e69c0820980ac5f43df7d64473d3549e52c67973fc58019ee4a2829"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "949bae661f6e9f3e961a1ec974d06923d79ec4b141b3c6c8e427206793d703ae"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "49ece5a41cb4d3856f4ac01090e19d1a834587637027bd98dcde3d4154777aa3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "61ab6f6e21398c16fb9492b4f8ea7b87c94847a3c51e85661e4deeee0d16f70e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

所有变更前 schema 已带有消息源归属保留策略。新的 composition-guard kind 不存在于这些快照中，并符合既有策略。它的 notice 形式和摘要描述会话记录展示；记录的正文承载模型可见警告。守卫及其不变式均不读取此消息源来决定工具可用性、基线有效性或重复抑制：这些决策使用运行时记录集与当前注册表。原生及 detached 读取器保留消息源自身的 JSON 字段，并在没有生产者时派生消息。新标记保留完整的 form 与 summary 声明，不引入新的校验或权限要求，也不改变已有 kind 分组。已有 V4 记录以及所有历史声明、快照和代际文件保持不变；无需迁移或递增写入器版本。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run scripts/persistence-changes.spec.ts scripts/persistence-formats.spec.ts packages/guard/composition-guard/tests/composition-guard.spec.ts packages/guard/composition-guard/tests/invariant.spec.ts packages/session/session-format-v3-to-v4/tests/attribution.spec.ts --maxWorkers=2 通过五个文件中的 202 项测试。原生归属用例对 user 和 developer 角色的 composition-guard 通知执行编码和解码，在没有生产者时通过 detached Session 接纳恢复，派生完整记录正文与消息源元数据，并复现相同物理行。守卫测试覆盖注册表工具撤回、基线检查与报告抑制。源码审查未发现守卫或其不变式消费通知消息源。

<a id="dev-note"></a>
## 开发备注

无。
