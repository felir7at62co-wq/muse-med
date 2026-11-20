---
description: "通过浏览器只读访问 Host 人物参考库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-character-library

[English](README.md) | 中文

## 概述

本插件通过 `characterLibraryBrowser` Remote 命名空间，向浏览器提供组合中的[人物素材库](../../drama/character-library/README.zh.md)。支持状态查询、有界目录浏览和已核验图片预览，不提供上传、编辑、删除或 metadata 审批操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host composition 在本插件之前提供 `characterLibrary`。`status()` 不读取对象存储，只报告其只读配置状态。`browse()` 将分类、查询和游标校验交给领域服务。`preview()` 返回已核验图片的内存 data URL 和 SHA-256，不暴露对象存储 URL 或凭据。领域读取失败返回稳定的 `character-library/read-failed` Remote 错误并附带领域错误码。

[浏览器插件](../../client/ui-character-library/README.zh.md)挂载本包生成的 Remote contribution，并展示这些读取操作。

<a id="model-experience"></a>
## 模型体验

### 浏览器参考图读取

#### 模型看到什么

`characterLibraryBrowser` 命名空间不提供模型工具、提示词或 Session 事件。浏览器导航和图片预览不增加模型上下文。

#### Token 影响

浏览器读取不消耗模型 token。

#### KV Cache 影响

浏览器读取不改变模型请求前缀或其 KV 缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Provider 负责云端连接和凭据。挂载浏览器接口本身不会使未配置的人物库可读。
- 图片预览沿用领域服务的字节上限和图片核验，浏览器不会获得永久公开下载 URL。

<a id="dev-note"></a>
### 开发备注

Remote 方法保持只读。Agent 参考图选择由独立的人物参考工具插件负责。
