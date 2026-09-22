---
description: "在本地与发布构建的侧栏和会话首屏展示 muse-med 蜘蛛图案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包在所有构建 profile 的侧栏和会话首屏展示 muse-med 蜘蛛图案。侧栏提供本地化的 muse-med 名称，并保留版本、提交和工作区修改状态元数据。本包保留内部标识，不保留运行时状态，也不影响模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 muse-med 部署的浏览器插件名单中挂载本插件。其图片填充在本地与发布构建中都会注册。

### 图案与构建 profile

Web 应用以 `./muse-med-logo-black.webp` 和 `./muse-med-logo-white.webp` 提供原始透明的 1254 × 1254 图案。品牌图案在应用解析后的浅色主题中使用黑色，在深色主题中使用白色，支持手动选择和跟随系统模式。浏览器 favicon 始终使用黑色图案，不跟随应用主题。打包的桌面图标与 PWA 安装图标不随主题变化。`DSH_CLIENT_BUILD_PROFILE` 不限制注册。本插件不占据 `sidebar.brand.name`；侧栏拥有本地化名称与构建元数据。

### 替换品牌

使用其他品牌的部署不组合本包，而是组合另一个占据侧栏与首屏图片 slot 的包。占据 slot 是组合路径；本包没有品牌配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半部 [`src/client/index.ts`](src/client/index.ts) 为 `sidebar.brand.mark` 与 `conversation.hero.brand.mark` 安装两个独立、感知声明的 `ctx.slots.inject()` effect。各注册等待自己的声明，声明消失时撤回，并随插件 fiber 释放。node 半部是一个空 Loader 座位。浏览器标题位于 slot 系统之外：`DSH_CLIENT_TITLE` 覆盖 Web 构建默认的 `muse-med` 标题。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明渲染图案的 slot 与外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


品牌呈现依赖宿主应用的资源和 slot 声明。

- **宿主拥有图案**——Web 应用必须提供两个主题图案 URL；插件不内嵌图片。插件更新现有的 `link[rel="icon"]`，卸载时恢复其原始 URL 和类型。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包不保留可变状态；两个 slot occupant 分别由独立的插件 fiber effect 拥有。
