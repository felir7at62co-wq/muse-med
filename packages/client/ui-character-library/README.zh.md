---
description: "共用 Web/Desktop 组合中的人物参考素材只读浏览页，支持搜索、筛选、详情和本地图片预览。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-character-library

[English](README.md) | 中文

## 概述

从会话右侧栏指南浏览人物参考，不上传或绑定素材。随包加载的数据来源显示未配置状态，不发起网络请求。受控测试来源持续显示测试数据横幅；图片可预览或标为审核通过，都不授予生产使用权限。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [维护者记录](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Muse 与 Harness Web/Desktop profile 使用的共用 Web 组合在右侧栏注册一个 `character-library` 页面。打开指南入口即可查看人物库。搜索匹配展示 ID、名称和标签；分类、性别、风格、外观与审核状态筛选同时生效。缺失的可选字段保持未知。卡片打开详情，允许的内联栅格图片或浏览器对象 URL 打开受控预览。图片缺失或加载失败显示占位。来源读取失败提供重试，切换来源或卸载时取消未完成读取。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节——点击展开</summary>

Host 入口不执行操作，不注册 TOS 路由、metadata 解析器、项目绑定或写入器。[浏览器入口](src/client/index.ts)通过 Cordis effect 注册页签及正文、标题 slot，插件卸载时撤销注册。组件只接收只读来源和类型化本地化文案。`LibraryDisplayItem` 与 `LibraryBrowserSource` 是 Phase 2 内部临时展示类型，不是共享 TOS catalog 契约。目录 adapter 必须向[来源接口](src/client/types.ts)提供统一的展示记录；UI 不解析云端 metadata。合成夹具仅位于 `tests/`，不进入随包加载的数据读取器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

此浏览页使用标准 Client 组合与 Sidebar 扩展点。

- [Web Client 架构](../../../docs/subsystems/web-client.zh.md)——浏览器层级与数据流。
- [Slots 参考](../../../docs/subsystems/slots.zh.md)——注册、props 与卸载。
- [右侧 Sidebar](../ui-sidebar-right/README.zh.md)——指南页面与 tab 类型。

-----

<a id="model-experience"></a>
## 模型体验

### 仅用于浏览的人物参考

#### 模型看到的内容

无。`character-library` 页面不注册工具、提示词段落或会话事件，也不将所选卡片加入模型请求。

#### Token 影响

无；搜索、筛选和图片预览不组装模型请求。

#### KV 缓存影响

无；浏览交互不改变模型上下文。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

随包加载的读取器有以下限制。

- 默认来源未配置。本包不提供真实 TOS adapter 或云端 metadata 解析器。
- 页面只读。即使条目标为审核通过，也不提供项目绑定、持久化、上传、审批或生成动作。
- 预览接受内联 PNG/JPEG/WebP 及浏览器对象 URL。远端图片获取、私有访问与 URL 刷新属于受控来源 adapter。
- 审核标签是展示数据，不是复用授权或版权核验。浏览不会将待审核或未知素材改为已批准。

<a id="dev-note"></a>
### 维护者记录

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
