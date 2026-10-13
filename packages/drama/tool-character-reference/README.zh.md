---
description: "在隔离 QA 中从未发布的本地草稿索引最多推荐一个经过文件校验的人物参考，不上传、不绑定、不写入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-character-reference

[English](README.md) | 中文

## 概述

在隔离 QA profile 中使用 `drama_character_references`，把有长度限制的角色需求与未发布的本地人物参考草稿比较。工具先核验索引、v2 metadata 和图片哈希，再最多返回一个参考及其证据与不确定项。年代未经确认、证据不足或评分相同时不推荐。检索从不上传素材、绑定生产项目、写入文件或发起付费请求。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只在隔离 QA composition 中挂载本插件，并提供未发布 `character_reference_index.draft.json` 的绝对路径。正式 profile 不加载本插件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `referenceIndexPath` | 必填 | QA profile 固定的绝对路径；它不会成为 Agent 工具参数，也不是 TOS URL。 |

插件只注册 `drama_character_references`。调用方提供从剧本提取的 `role_description`，以及确有依据的风格、标签或年代要求。`pending_review` 条目可以继续参与候选比较，但返回参考不等于批准或素材绑定。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts)在部署配置中固定索引路径并注册只读工具。[`src/reference.ts`](src/reference.ts)确保引用的 metadata 和图片位于配置的草稿根目录内，核验草稿与文件哈希，再按明确登记的证据评分。结果报告 `read_only=true`、`apply_allowed=false`、`local_writes=0`、`remote_writes=0` 和 `paid_requests=0`。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### `drama_character_references` 工具

#### 模型看到什么

模型获得固定的 `drama_character_references` 工具，输入包含 `role_description` 以及可选的 `style`、`desired_tags` 和 `era`。结果是 `recommended`、`no_match` 或 `needs_review`；它最多包含一个本地 QA 参考、理由、带来源的证据、不确定项和明确的零写入标记。模型必须把该条目说明为参考，不得写成已批准或已绑定的生产素材。

#### Token 影响

工具 schema 固定。追加的一条结果最多包含一个推荐及其证据，或无法可靠推荐的简短说明。

#### KV Cache 影响

工具结果只追加，不改写此前消息。工具描述或 schema 变化会改变可复用的请求前缀；本地草稿变化只影响后续工具结果。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本包仅供明确配置的隔离 QA profile 使用；正式发布的生产 profile 不注册它。
- 本包只读取一个固定的本地草稿，不提供上传、TOS 发布、索引写入、正式人物素材库 UI、导入操作或生产项目绑定。
- 匹配使用本地已登记标签和明确证据，不调用视觉模型，不做语义评分，也不核验调用方提供的角色描述是否符合剧本原文。
- `pending_review` 不代表批准。版权、复用权利、身份、年龄、性别和制作适用性仍须由负责人完成人工审核。
- 离线工具检查和模拟 Agent Session 不等于真实模型验收；真实 Agent Session 仍单独待验。

<a id="dev-note"></a>
### 开发备注

无。
