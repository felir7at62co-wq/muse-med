---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-muse-main-coordinator-attribution-join

[English](2026-11-12-muse-main-coordinator-attribution-join.md) | 中文

## 概述

合并已审查的原生生成通知历史与 rc2 Muse 协调消息归属信息历史。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 2
id: 2026-11-12-muse-main-coordinator-attribution-join
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "ccdb89d7ba379d888bb0ca854645817db837d41ae747ae0147a4fea622b1ee2a"
    decision: same-version
  - root: "event:developer/message"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "f56413cdaaeb1bef403968875ba34d8a97b9a6780770fc2bedad5ed40f8a1e8b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "67228b88c322fdbf06fdd41285d839af5f721013ebf29d505cdcb32cfb5f672a"
    decision: same-version
  - root: "event:user/message"
    previous: ["2026-11-12-muse-main-native-attribution-review","2026-11-12-muse-rc2-message-attribution-join"]
    after: "85e62d0f19735e3b9b0b37b43dfc8425d1ed23cd10d0594e5db0ca56c1f8cfd5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 4。[原生审查记录](2026-11-12-muse-main-native-attribution-review.zh.md)显式确认其 retry 来源联合转换。本次合并保留该审查后的模式，相较 [rc2 消息合并记录](2026-11-12-muse-rc2-message-attribution-join.zh.md)仅新增已限定的 generation-watch 归属信息。当前模式在收件箱拼接、开发者消息、标题请求及用户消息中保留两个前驱。当前读取方保留前驱形式；未安装生产者的读取方保留文本、身份及 JSON 来源元数据。归属信息本身不授予路由、协调、审阅或生成权限。两个前驱记录、其后置模式、Session 头部、事件信封、写入版本及已提交的格式代次保持不变。

<a id="verification"></a>
## 验证

原生来源准入、空提示词、续聊和结算消息四个套件的 102 个测试全部通过，覆盖未安装生产者时在 none 与 zstd 压缩下读回、追加写入后原字节前缀不变、重试标识去重、拒绝非空重试控制，以及不含停止原因的历史结算。在写入任何新文件前，包含本次审查转换及集成合并的完整历史已在内存中通过 validatePersistenceHistory。 `pnpm --silent run verify-persistence-changes --json` 通过：74 个根与 48 条历史记录一致。

<a id="dev-note"></a>
## 开发备注

无。
