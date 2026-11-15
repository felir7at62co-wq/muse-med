---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-native-generation-attribution-join

[English](2026-11-10-native-generation-attribution-join.md) | 中文

## 概述

将分别记录的有界 Skill 目录与生成通知来源归属合入同一 Session 读取词汇。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-11-10-native-generation-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "0da2bc98d93287c3cd9dc67c6179bc79f69a0b3dbfe8702aa6b1f7da7a7e58a5"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "a3ace94fa9010ad4fe4d45afa59957cac6e8ab6b10e3c89b1abf502bea409d8c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "4896470c2ca4757968191be32548102b56f12718391b06ef9e0cb570ef2a3944"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-06-generation-watch-attribution","2026-11-09-bounded-skill-catalog"]
    after: "c07728572cd84036fe0a8103ac1fd8b921faf914c38c67fd8e165fc8ceb397b4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保留格式 4 及两条原前驱记录。合并后的消息来源保留各前驱的全部字段和仅标注归属的声明策略。当前读取方接受两种旧来源；未加载生产者的展示读取方保留正文与消息身份。来源归属不授权路由、生成或审核。本 Desktop 组合继续归档 DS Bot，旧群组通知保留待核实。必须理解的持久 claim 与暂停通知事件另外记录；不认识这些事件的读取方拒绝读取，而非静默丢弃输入。

<a id="verification"></a>
## 验证

生产者缺席时的真实 JSONL 回读测试保留通知正文、身份及模型历史。隔离候选内的原生普通 Session 恢复测试通过。修正四个旧所有者夹具后，最终真实 Loader、原生恢复和绑定组合的 25 项测试通过；初次失败及诊断保留在修复报告中。最终构建、完整 keyless 与打包尚未完成。

<a id="dev-note"></a>
## 开发备注

无。
