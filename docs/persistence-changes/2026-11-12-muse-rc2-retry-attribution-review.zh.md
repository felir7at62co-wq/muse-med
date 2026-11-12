---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-muse-rc2-retry-attribution-review

[English](2026-11-12-muse-rc2-retry-attribution-review.md) | 中文

## 概述

在合流保留的历史前，对照重试控制前驱审查合并后的消息来源声明。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-muse-rc2-retry-attribution-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "20aa4dc56feb4c842f717fbb80f4dd6e62add01b34e82dc099e79f73511c54d0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "50d2dd6a64f0f38a80d30e7e9c1604ad2b7e7b7714affe74d4e01334d7e2ca77"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "5d25d2c02fdde40c58d77c42c5207fb6f60f079020535647c63c039d32794cc8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "775923a37d6fa613ba733d996523b819af4cb2fbb7529455dee6000841366d00"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保留 Session 格式 4。此项经过显式审查的转换保留前驱的全部来源字段，并补入合并后的声明；事件判别值、信封、头部和代际文件名不变。retry 控制归因表示带浏览器关联标识的空消息，不构成新的用户授权；旧读取方可保留该空消息，但不提供较新的手动重试控件。历史 structured-output-missing 停止原因仍是 subagent-settled 消息上的可选归因。原生 V4 来源准入与 Muse 前驱一致：接受非空且不等于已退休 plugin 包装的生产者 kind，无需安装生产者便保留全部 JSON 元数据。因此，旧读取方可保留新增元数据；当前读取方继续保留历史上缺失的停止原因、普通来源和 Muse 来源。运行时结算将 structured-output-missing 表示为未完成。当前续聊仅接纳已授权的空 retry 路径，拒绝非空 retry 内容。消息来源增量同时传入收件箱、developer-message 与标题请求引用。此次不把未知事件改判为可忽略，也不引入回退读取器或写入降级。

<a id="verification"></a>
## 验证

原生来源准入、空提示词、续聊投影与结算消息四个套件共 102 项无密钥测试通过。五种明确归因涵盖 retry 控制、Muse 派发和缺失、完成、structured-output-missing 结算，在 none 与 zstd 压缩下分别以只读和写入方式解码，无需安装生产者插件；追加写入后原始字节前缀保持完整。控制测试保留原始用户请求、按重试标识去重，并拒绝空的新任务与非空 retry 控制。结算测试保留完整结束文本，并将缺失结构化结果标记为未完成。在写入任何新文档前，所有旧历史与两项拟议审查转换及相同模式汇合已通过所有者的内存历史验证。

<a id="dev-note"></a>
## 开发备注

无。
