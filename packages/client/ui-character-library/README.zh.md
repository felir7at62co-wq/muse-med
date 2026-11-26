---
description: "Muse 左侧功能区中的只读人物参考库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-character-library

[English](README.md) | 中文

## 概述

左侧功能区的「人物库」入口打开古装和都市人物参考的只读目录。用户可以搜索、翻阅图片卡片并查看已核验的完整图片。页面不提供上传、编辑、删除或审批控件。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

浏览器 composition 提供 slots、locale、resources 和 Remote 服务，Host 挂载[只读浏览接口](../../api/character-library/README.zh.md)。本插件管理生成的 Remote contribution 和资源 Provider。每页最多显示十二张目录卡片，分类、查询、分页和预览选择均为本地查看状态。连接缺失或读取失败在页面内提示，并提供刷新或重试操作。

图片通过框架资源模型提供，缩略卡片和完整图片视图共用同一张已核验图片资源。预览注明仅供参考，不将素材批准为项目正式资产。

Host 通过 `ui-character-library` 配置表单投射 volatile 字段 `syncIntervalMs`。只有目录加载等待该投射并验证其值，设置待定时应用仍可启动。设置缺失或无效时，目录显示读取失败，用户可通过页面重试。后续读取完成后使用最新间隔。该延时默认 30000，允许 1000 到 300000 之间的整数毫秒。目录打开时，每次请求完成后等待这段延时再次读取，因此云端新增和删除的人物参考无需重新打开页面或手动刷新即可出现。同一目录地址的订阅者共用一个读取流；离开页面或释放插件时取消正在进行的请求或等待。目录读取失败时保留上次结果，并在下个间隔重试。

<a id="model-experience"></a>
## 模型体验

### 参考图库浏览

#### 模型看到什么

本展示插件不提供模型工具、提示词或 Session 事件。浏览参考图不会将图片加入模型请求。Muse 独立的 `drama_character_references` 和 `drama_character_reference_view` 工具负责模型可见的候选检索和看图，以及对应的日志结果。

#### Token 影响

浏览人物库不消耗模型 token。

#### KV Cache 影响

图库导航和预览不改变模型请求前缀或其 KV 缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 人物库需要已配置的 Host Provider。页面不能配置云端凭据，也不能修改参考图的权限或审核状态。
- 预览使用领域服务核验过的原图字节，不另外生成缩略图。

<a id="dev-note"></a>
### 开发备注

本功能管理 `character-library` 主面板及其左侧入口。Provider 和注册项随插件一同释放。
