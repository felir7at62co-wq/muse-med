---
description: "通过有界的 List、Head 和 Range Get，从火山引擎 TOS 的固定前缀读取经过审查的公共人物参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-character-library-tos

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-character-library-tos` 为 Host 提供对象存储服务，仅对火山引擎 TOS 中经过审查的 Muse 历史人物参考素材前缀执行有界读取。Endpoint、region、bucket 和两个可读前缀均为固定安全约束。未配置的 Provider 仍可安全挂载并报告 `readConfigured: false`；只有读操作开始时才会通过部署侧 `ctx.credentials` 解析凭据引用。

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

`readAccessKeyIdRef` 和 `readSecretAccessKeyRef` 必须同时指向 Host `ctx.credentials` 管理的凭据引用。只配置其中一个会在插件加载时被拒绝。Provider 不直接读取环境中的秘密变量，也不会将秘密值放入错误。

`connectionTimeoutMs` 默认 10000，最大 30000；`requestTimeoutMs` 默认 30000，最大 60000。运行时依赖锁定为 `@volcengine/tos-sdk@2.9.1`，并关闭 SDK 自动重试。

<a id="read-and-write-safety"></a>
## 读写安全

读取仅限于以下历史前缀下的 `ListObjectsV2`、`HeadObject` 和带 Range 的 `GetObjectV2`：

- `assets/reference/characters/stylized/ancient/ancient/`
- `assets/reference/characters/stylized/urban/urban/`

Provider 会再次校验服务端返回的每个 key。单次列表最多允许一个 SDK 传输请求和 128 个对象。对象正文必须返回有效的部分内容响应，并在调用方给出的字节上限内停止。



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

- 配置状态只表示凭据引用已配置。若引用的秘密不存在，首次读取仍会安全失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

固定的历史读取前缀是安全约束，不能作为未来上传布局的依据。

</details>
