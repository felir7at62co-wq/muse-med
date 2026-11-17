---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-muse-rc2-message-attribution-join

[English](2026-11-12-muse-rc2-message-attribution-join.md) | 中文

## 概述

以当前合并后的真实类型声明，合流重试控制与 Muse 会话协调两条消息归因历史。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-11-12-muse-rc2-message-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "20aa4dc56feb4c842f717fbb80f4dd6e62add01b34e82dc099e79f73511c54d0"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "50d2dd6a64f0f38a80d30e7e9c1604ad2b7e7b7714affe74d4e01334d7e2ca77"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "5d25d2c02fdde40c58d77c42c5207fb6f60f079020535647c63c039d32794cc8"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-12-muse-rc2-coordination-attribution-review","2026-11-12-muse-rc2-retry-attribution-review"]
    after: "775923a37d6fa613ba733d996523b819af4cb2fbb7529455dee6000841366d00"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

[重试控制审查](2026-11-12-muse-rc2-retry-attribution-review.zh.md)与[会话协调审查](2026-11-12-muse-rc2-coordination-attribution-review.zh.md)分别确认各分支的联合类型差异；此次汇合记录二者一致的当前模式。四个既有事件根保留两个前驱的全部声明。当前源码在原有 UserMessage 内容上接受 retry 控制元数据和 muse-coordination 转发及回执，并覆盖收件箱、developer-message 与标题请求中的引用。此次增量不引入新的必需事件判别值，不改变 Session 头、事件信封、代际文件名或写入版本。旧读取方保留可扩展的消息归因和普通内容，可能以通用形式展示陌生归因；当前读取方继续读取两个前驱，不会将归因视作新的用户授权。合流分类器逐个对照保留的前驱与生成后的真实模式；原有记录和模式快照保持不变。

<a id="verification"></a>
## 验证

会话协调、外部执行和停放等待套件共 49 项测试通过；消息归因和完整结果保留套件 16 项通过。model-switch-compaction 与 deepseek-messages-system-prompt 两个无密钥历史输入场景在仅更新当前写入 oracle 后回放通过，canonical 输入哈希保持不变。持久化历史与历史格式的所有者检查另行验证此次合流。

<a id="dev-note"></a>
## 开发备注

无。
