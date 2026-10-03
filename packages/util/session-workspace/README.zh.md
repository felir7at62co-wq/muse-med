---
description: "只读解析会话工作目录并验证生产根目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-workspace

[English](README.md) | 中文

## 概述

解析会话记录的工作目录，并验证插件可使用的生产目录。这些辅助函数读取会话元数据与文件系统状态；目录创建和写入由调用方负责。

## 目录

- [使用本包](#use-this-package)
- [实现方式](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

从 `@deepseek-ai/dsh-session-workspace` 导入辅助函数。本包不注册插件或配置段。

| 辅助函数 | 行为 |
|---|---|
| `sessionLookup` | 读取可选的 Host `sessions` 服务。 |
| `sessionDirectory` | 返回存活会话记录的 `cwd`；身份无效、服务缺失或会话未知时抛出 `DomainRecordError`。 |
| `trySessionDirectory` | 返回 `cwd`；身份缺失、服务缺失、会话未知或查询失败时返回 `undefined`。 |
| `verifiedDirectory` | 要求现有绝对目录，拒绝符号链接或 realpath 解析发生重定向的路径。 |
| `resolveProductionRoot` | 优先验证非空的会话目录；仅在未指定会话目录时使用配置根目录。返回根目录与 `fromSession`。 |
| `productionSubdirectory` | 在已验证根目录下解析可信路径片段，拒绝越界和现有片段中的重定向。不创建缺失目录。 |
| `unknownFailureMessage` | 在调用方的回退消息后附加错误类别与最多 300 个字符的详细信息。 |

已指定的会话目录无效时直接失败，不会回退到其他项目的配置根目录。存活会话可以没有 `cwd`，此时 `sessionDirectory` 正常返回目录为 undefined 的结果。

-----

<a id="understand-the-implementation"></a>
## 实现方式

[session.ts](src/session.ts) 只依赖它读取的会话查询字段。[root.ts](src/root.ts) 通过文件系统观察验证可信元数据路径。[errors.ts](src/errors.ts) 提供带错误码的领域错误；目录解析使用 `INVALID_ARGUMENT`、`NOT_FOUND`、`DEPENDENCY_MISSING` 与 `OUTSIDE_WORKSPACE`。调用方按错误码分支，不依赖消息文本。

本包不发布运行时不变量伴随插件：辅助函数没有可独立改变的注册表或缓存目录状态需要核对。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 包](../../core/session/README.zh.md) — 记录的会话身份与工作目录。
- [工具组](../README.zh.md) — 共享工具包。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与触发条件

#### 模型能看到什么

`sessionDirectory` 和 `resolveProductionRoot` 是供调用方使用的辅助函数。本包不增加工具 schema 或提示词；消费工具负责显示路径或 `DomainRecordError` 消息。

#### Token 影响

辅助函数不直接贡献模型 token。

#### KV Cache 影响

辅助函数不改变模型请求历史或前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 目录检查观察当前文件系统状态，无法阻止其他进程随后替换路径。
- 根目录和子目录输入来自可信的会话元数据或部署配置；这些函数不为模型传入的路径提供沙箱。
- 目录创建、项目身份记录、布局与写入授权由消费者负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
