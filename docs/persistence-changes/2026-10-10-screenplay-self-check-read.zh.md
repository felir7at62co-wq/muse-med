---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-screenplay-self-check-read

[English](2026-10-10-screenplay-self-check-read.md) | 中文

## 概述

新增仅用于标注来源的 screenplay-project-read，将自检所需的规范读回内容带入后续模型请求。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-screenplay-self-check-read
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-08-output-continuation"
    after: "43c9631e85711dc95bc3890c95c52354323a0a8436896702132bc3b486e19938"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-08-output-continuation"
    after: "6bf8a9fa142947d06dee146cf90c146adc26650e3b617dbaf73b2fe793d8b7c8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-08-output-continuation"
    after: "decd24e81bfba1a30dacbb0985809f6c08df3ed9fa0713aad0c2df54c28f9bb8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-08-output-continuation"
    after: "397bd8bdd7463f4f0eb2d16e80903cae955732238a1839c56ca7b87e594696a3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有 Session 事件仍然有效，语义不变。读取方保留未知 user/developer 来源标注，因此无需增加 Session 写入版本。实际读回证据由宿主管理，重启后失效，仅有来源标记不能授权自检。独立的剧本项目文件新增可选自检模式、产出轮及审校与撤销证据字段；省略字段时保持历史独立审校规则和原会话身份。

<a id="verification"></a>
## 验证

screenplay-project 定向测试共 189 项通过，包含真实 Headless PTC 模型轮、实际 Adapter 请求中的规范文本与图像、未打印的读回、同轮不同根调用、失败外层程序、AbortSignal 中断、后置策略拒绝及值与内容替换、双进程冷恢复、摘要与修订拒绝、历史独立审校回放、修订分支恢复和自检撤销修正。

<a id="dev-note"></a>
## 开发备注

无。
