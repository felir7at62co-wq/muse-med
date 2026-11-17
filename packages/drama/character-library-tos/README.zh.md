---
description: "通过有界的 List、Head 和 Range Get，从火山引擎 TOS 的固定前缀读取经过审查的公共人物参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library-tos

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-character-library-tos` 对火山引擎 TOS 中经过审查的 Muse 人物参考前缀执行有界读取。Endpoint、region、bucket 和前缀均为固定安全约束。显式设置 `publicRead: true` 时无需凭据读取公开对象目录；否则在读取开始时解析部署凭据引用。两种模式均未配置时，报告 `readConfigured: false`。

## 目录

- [使用本包](#use-this-package)
- [读写安全](#read-and-write-safety)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Muse Web 和 Desktop 启用 `publicRead: true`，直接从 TOS 列举两个经过审查的前缀。每次目录请求都读取实时分页，因此云端新增人物、元数据修改和删除会在后续读取时生效，无需重启或发布应用。公开模式要求仅向这两个前缀开放匿名 ListObjects 访问，并允许读取其中的元数据和图片。此模式不加载凭据或 SDK。领域服务的元数据状态和图片校验规则继续生效。

要启用自动发现，请把 [`muse-public-list.policy.json`](config/muse-public-list.policy.json) 中的 statement 合并到现有桶策略中，并保留其他 statement。它仅允许对两个完整前缀进行匿名 `ListBucket` 列举。元数据和图片仍需保留现有的公开 GetObject 访问；此示例不授予对象写入权限。

需要鉴权的部署应保留 `publicRead` 为 false，并同时设置 Host `ctx.credentials` 管理的 `readAccessKeyIdRef` 和 `readSecretAccessKeyRef`。凭据引用不完整或与公开模式同时配置，都会在插件加载时被拒绝。公开模式默认为 false，鉴权读取失败不会切换模式。秘密值不会进入错误。

`connectionTimeoutMs` 默认 10000，最大 30000；`requestTimeoutMs` 默认 30000，最大 60000。运行时依赖锁定为 `@volcengine/tos-sdk@2.9.1`，并关闭 SDK 自动重试。

<a id="read-and-write-safety"></a>
## 读写安全

鉴权读取使用 `ListObjectsV2`、`HeadObject` 和带 Range 的 `GetObjectV2`。公开读取使用匿名 HTTP ListObjectsV2、HEAD 和带 Range 的 GET，范围限于以下历史前缀：

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

Provider 会再次校验服务端返回的每个 key。每次列举仅请求一页，最多 128 个对象，并保留服务端的不透明续页 token；只有安全人物目录中的 `metadata.json` 条目会进入目录记录。公开列表响应必须是 1 MiB 以内的有效 TOS JSON；当 `KeyCount` 为零时，缺少或为 null 的 `Contents` 表示空页。对象正文必须返回有效的部分内容响应，并在调用方给出的字节上限内停止。



-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>


</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [人物素材库领域服务](../character-library/README.zh.md)——store 接口和只读产品行为。
- [凭据服务](../../credentials/credentials/README.zh.md)——Host 管理的凭据引用和秘密解析。

-----

<a id="model-experience"></a>
## 模型体验

### TOS 素材库读取

#### 模型看到什么

模型不会直接看到本 Provider 的输出。它不注册工具、提示词段落或 Session 事件；独立消费方负责把 catalog 记录投影为有界内容。

#### Token 影响

`ListObjectsV2`、`HeadObject` 和带 Range 的 `GetObjectV2` 操作本身不增加模型请求 token。

#### KV Cache 影响

Provider 配置和对象读取不会改变模型请求或其可复用前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

本 Provider 有以下限制。

- 配置状态表示选定的读取模式。若公开访问被取消或引用的秘密不存在，读取仍会失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

固定的历史读取前缀是安全约束，不能作为未来上传布局的依据。

</details>
