---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-muse-main-native-attribution-review

[English](2026-11-12-muse-main-native-attribution-review.md) | 中文

## 概述

对照原生生成通知消息历史，审查合并后的重试控制元数据与协调归属信息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-muse-main-native-attribution-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "ccdb89d7ba379d888bb0ca854645817db837d41ae747ae0147a4fea622b1ee2a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "f56413cdaaeb1bef403968875ba34d8a97b9a6780770fc2bedad5ed40f8a1e8b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "67228b88c322fdbf06fdd41285d839af5f721013ebf29d505cdcb32cfb5f672a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-10-native-generation-attribution-join"
    after: "85e62d0f19735e3b9b0b37b43dfc8425d1ed23cd10d0594e5db0ca56c1f8cfd5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 4。当前模式保留原生前驱的消息形式，并为 retry 来源联合增加浏览器关联及调用方元数据，补入可选的子代理结算 stopReason 和 Muse 协调归属信息。retry 联合及其传递至标题请求的消息联合经过显式的同版本兼容性审查。既有 V4 原生来源准入保留所有非空且不等于已退休 plugin 包装的生产者 kind，无需安装生产者便保留 JSON 元数据。因此，即使旧读取方不提供手动重试控件，仍保留新增元数据和空重试消息。当前读取方保留前驱形式，包括缺失停止原因的结算。重试输入仍遵循失败 Session 的既有准入和空内容检查；来源元数据不授予用户授权、路由、审阅或生成权限。[原生归属信息合并记录](2026-11-10-native-generation-attribution-join.zh.md)、其模式及全部已提交的格式代次保持不变。必需的持久领取与停放通知事件保留各自的记录及拒读规则。

<a id="verification"></a>
## 验证

原生来源准入、空提示词、续聊和结算消息四个套件的 102 个测试全部通过，覆盖未安装生产者时在 none 与 zstd 压缩下读回、追加写入后原字节前缀不变、重试标识去重、拒绝非空重试控制，以及不含停止原因的历史结算。在写入任何新文件前，包含本次审查转换及集成合并的完整历史已在内存中通过 validatePersistenceHistory。 `pnpm --silent run verify-persistence-changes --json` 通过：74 个根与 48 条历史记录一致。

<a id="dev-note"></a>
## 开发备注

无。
