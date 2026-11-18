---
description: "Muse 右侧栏的原版剧本工坊和镜流制片工作台。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

[English](README.md) | 中文

## 概述

将 `workshopOrigin` 设为剧本工坊站点，`studioOrigin` 设为镜流站点。两者均支持 HTTPS 源站或本地 HTTP 回环 IP 地址。配置好的应用会分别出现在右侧栏的文件、终端和浏览器下方。**剧本工坊**打开原版写作首页 `/v2`，可以创建、编辑和查看草稿。**镜流**打开制片页面 `/sfp/`。

切换标签时各自保留当前页面。达到最小缩放比例后，较窄的面板支持横向滚动，也可以使用侧栏的全屏按钮扩大写作或制片区域。

## 目录

- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 打开工作台

#### 模型看到什么

打开编剧页面 `/v2` 或制片页面 `/sfp/` 均不会添加提示词、工具或会话事件。镜流工作流工具使用 Host 侧的独立账号会话。

#### Token 影响

打开面板不消耗模型 token。

#### KV 缓存影响

浏览工作台不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 两套服务都需要允许 Muse 嵌入其页面。剧本工坊提供自己的登录界面，支持飞书扫码。
- 两套应用各自管理账号会话、草稿和项目。选择页面或切换标签不会将草稿导入镜流，也不会替会话工具选择项目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
