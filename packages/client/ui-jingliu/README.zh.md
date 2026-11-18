---
description: "Muse 右侧栏里的镜流原版 ShotFlow 工作台。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

[English](README.md) | 中文

## 概述

将 `studioOrigin` 设置为专用 HTTPS 源站，或本地镜流服务的 HTTP 回环地址。在右侧栏的文件、终端和浏览器下方打开**镜流**。标签页加载原版 `/sfp/` 页面。项目、媒体、选择、登录和任务状态由镜流管理。不配置源站时隐藏此入口。

镜流保留桌面布局，随侧栏宽度调整缩放。面板较窄时可以横向滚动，也可以使用侧栏的全屏按钮扩大工作区。

## 目录

- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 打开工作台

#### 模型看到什么

打开 `/sfp/` 不会添加提示词、工具或会话事件。镜流工作流工具使用 Host 侧的独立账号会话。

#### Token 影响

打开面板不消耗模型 token。

#### KV 缓存影响

浏览工作台不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 镜流部署必须允许 Muse 嵌入工作台页面。飞书登录在外部打开授权页，工作台轮询授权结果。
- 页面会话保存在工作台自身的源站。页面选中的项目不决定工具调用的目标。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
