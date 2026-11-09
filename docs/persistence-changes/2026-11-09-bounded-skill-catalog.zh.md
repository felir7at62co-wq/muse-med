---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-bounded-skill-catalog

[English](2026-11-09-bounded-skill-catalog.md) | 中文

## 概述

在持久化目录消息中区分主动选择的 Skill 摘要与发现不完整。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-bounded-skill-catalog
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "8e0c8e39545e06b6a40e7f420efcfcd5006f4f4c7a3b3e8b5e00717283121a17"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "190cc6b97d8c40f2865c8c81a7584c919610605cdb2954a5b89f39da2bd571b1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "21cebcb51e989c9ff674a8b07751d45217dc58d657b3199b968dad40f2d7e7ff"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-muse-dsh-source-attribution"
    after: "5cb9431bc3fbfdcedc2d9d0d12c12fb7f74dd6889f41a8be3a2386525f74ffb4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持 Session 格式 4。旧完整目录没有可选 bounded 字段；incomplete 保留独立的发现失败语义。source entries 仍精确记录日志中的摘要，正文明确说明受限列表是所选推荐，所属条件工具提供完整的允许元数据。当前读取器不改变旧来源的读取。旧版只展示消费者仍可渲染原条目，但不能据此推断省略名称不可用；继续受限目录的模型交互需要支持查询工具的插件构建。既有 Session 事件封装、必读市场版本绑定及已提交的存储代保持不变。

<a id="verification"></a>
## 验证

已执行十个测试文件中的 150 项局部 Source 测试，覆盖真实 AgentLoop 工具准入、独立 Agent 作用域、并发准备、调用检查、发现不完整与卸载。正常完整构建的十项检查全部通过。对应构建产物中的 Native 与 PTC 受限目录场景及三个既有市场绑定兼容场景共五项所选回放全部通过。新增 TypeScript 与 Python SDK 测试均实际执行一项并成功，无跳过，保留完整的来源、分页、游标及工具结果数据。这些检查覆盖可选目录字段及其发现行为；发布包消费者验证单独记录。

<a id="dev-note"></a>
## 开发备注

无。
