---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-muse-session-coordination

[English](2026-11-10-muse-session-coordination.md) | 中文

## 概述

为原始任务转交与持久执行回执加入 muse-coordination 来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-muse-session-coordination
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "78c1bfd071f366299851eb956debf7aec6060c336c963e232ef705c254e5abce"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "b0bc35050a0d87821c0f8387ab35aac642d429f124f4b42d069bf1e45faa1cd6"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "e65d27076fb62bdb29f7594eb88945023656e112ba9a3a469615638abbe3efc7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-09-bounded-skill-catalog"
    after: "360c8dfde0769908bc6b076b88f420ea56717492d5c5887f6026e6e6a3948912"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新来源仅标记消息归属，已有消息字段、会话封装和代际文件名不变。读取者保留未知来源与普通消息正文，没有新增必读会话事件。独立任务账本使用自己的经校验存储域。

<a id="verification"></a>
## 验证

原生 AgentLoop 调度与任务卡回归覆盖已记录任务输入、显式汇报、幂等送达和取消。无需密钥的 muse-main-session-role 场景通过正式 headless 配置启动，确认业务工具被拒绝且没有创建其尝试输出的文件。

<a id="dev-note"></a>
## 开发备注

无。
