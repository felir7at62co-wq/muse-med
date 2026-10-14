---
description: "将人物参考 metadata 适配为按来源区分的目录记录，并通过调用方提供的读取器核对图片字节。"
kind: "package-reference"
---

# @deepseek-ai/dsh-character-asset-catalog

[English](README.md) | 中文

## 概述

将扁平人物 metadata、明确标明版本的 Phase 1 v2 metadata 及无版本的旧别名适配为目录记录，保留来源声明。提供确切的 metadata key 与只读读取器，即可测量图片字节并比较已声明的大小或 SHA-256。目录、参考、项目和供应商身份分别保存。解析和字节核验都不授予发布、复用或绑定批准。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

调用方需要从字段名不同的 metadata 得到一致的人物记录时，使用这个库。它通过 [`src/index.ts`](src/index.ts) 导出模块 API，不注册插件、工具或 profile 配置。

`parseCharacterMetadata(json, source, key)` 使用部署方配置的逻辑来源命名空间和确切的相对 metadata key 解析 JSON。扁平 metadata 使用 `asset_id` 和 `file_name`；旧别名为 `id` 和 `images[0].filename`。两组别名同时存在时，值必须一致。只有明确的 `schema_version=2` 才标识 Phase 1 v2；仅含旧字段的无版本记录标为 `legacy_aliases`。解析器保留来源 JSON 数据，并记录每个值采用的别名。图片 key 由 metadata 所在目录和声明文件名推导，每层目录都保留。

`adapted.asset_id` 和 `adapted.file_name` 明确提供归一化别名；`identity.original_asset_id` 仍是以独立类型表示的原始身份。

`loadCharacterAssets(source, metadataKeys, reader)` 通过调用方提供的 `CharacterObjectReader`，仅读取明确列出的 metadata key 及其引用图片。它返回实测字节数和 SHA-256，存在声明值时进行比较，并拒绝同一来源内重复的目录身份。对象不可读、metadata 非法、别名冲突或图片不一致时，调用失败且不返回部分记录。读取器的访问策略和副作用由调用方负责；本包不提供 TOS 客户端、凭据解析、对象列举或存储写入。

### 身份与来源声明

| 身份 | 含义 |
|---|---|
| 存储来源 ID | 部署方配置的稳定逻辑命名空间，与 bucket 或对象 key 无关。 |
| 原始资产 ID 与目录资产 ID | metadata 的本地 ID，以及带命名空间的 `character:<source>:<original-id>` 目录身份。两者都不是供应商资产 ID。 |
| Phase 1 参考 ID | 原始 v2 参考身份；扁平 metadata 不会自动获得该身份。 |
| 项目角色与供应商 asset/material ID | 分别保存的身份；关联类型明确携带项目或供应商/账号范围。解析不创建任何关联。 |

记录区分保留的 metadata、适配后的声明、推导的 key、实测字节和未知权限依据。明确标明 v2 的 `style` 转为场景时代分类声明；扁平格式的 `style` 转为画风声明。无版本旧别名不推断这两种风格含义。年代、性别和外观仍是来源声明，外观条目保留其 metadata 位置。`approved` 和 `rejected` 状态文字转为批准或拒绝声明，不成为权威决定。审核、权利、复用范围和 TOS 对象版本保持未知；`can_publish`、`can_reuse` 和 `can_bind` 保持 false。

`raw.metadata` 保留完整的解析后来源对象。`unknown.metadata_fields` 将未识别的顶层键和值原样保存为自身的数据属性，包括 `__proto__` 这样的名称，与未知的审核、权利、复用及 TOS 权限字段分别保存。保留字段不表示其含义已经校验，也不使其成为权威依据。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

[`src/metadata.ts`](src/metadata.ts) 校验适配所需字段、解析一致的别名，并将逻辑命名空间与原始身份组合。加载器通过调用方提供的读取操作，区分图片字节实测值和 metadata 声明值。[`src/types.ts`](src/types.ts) 将这些观测与来源声明、审批权威分别保存；[`tests/metadata.spec.ts`](tests/metadata.spec.ts) 覆盖格式区分与拒绝行为。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Phase 1 人物参考检索](../tool-character-reference/README.zh.md) —— 独立的本地草稿推荐工具及其隔离 QA 范围。
- [带品牌的身份类型](../../util/brand/README.zh.md) —— 在编译期区分底层表示相同的身份。
- [架构](../../../docs/architecture.zh.md) —— 产品能力的组成与职责归属。

-----

<a id="model-experience"></a>
## 模型体验

### 目录记录

#### 模型看到什么

本库不贡献模型工具、提示词或 Session 事件。调用方通过模块 API 得到 `CharacterMetadataRecord` 或 `VerifiedCharacterAsset` 值，并负责后续展示；现有 Phase 1 QA 工具没有接入本库。

#### Token 影响

本库不增加请求 token。调用方展示记录时，自行负责选择模型可见内容并控制大小。

#### KV Cache 影响

本库不构建或修改模型请求，不定义请求前缀或缓存复用行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 对象发现、来源适配器、TOS 访问、索引发布、UI、项目绑定和供应商操作由调用方或独立包负责，本包均不提供。
- 字节核验只检查大小和 SHA-256，不检查图片解码、视觉内容、身份、年龄、年代适配或来源授权。
- 解析器校验适配字段，不校验每个保留的 metadata 字段或完整 v2 JSON Schema。它仅适配 `images` 数组的第一个条目。
- 来源状态与审核字段仍是声明。本包不能批准发布或复用，也不改变现有 Phase 1 QA 流程。

<a id="dev-note"></a>
### 开发备注

无。
