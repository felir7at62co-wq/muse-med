---
description: "Muse 右侧栏的原版剧本工坊和镜流制片工作台。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

[English](README.md) | 中文

## 概述

将 `workshopOrigin` 设为剧本工坊站点，`studioOrigin` 设为镜流站点。两者均支持 HTTPS 源站或本地 HTTP 回环 IP 地址。各应用入口位于右侧栏的文件、终端和浏览器下方。**剧本工坊**打开写作首页 `/v2`，可以创建、编辑和查看草稿。**镜流**打开制片页面 `/sfp/`。

将 `editorOrigin` 设为本机 [OpenChatCut](https://github.com/0xsline/OpenChatCut) 的 HTTP 回环 IP 地址和端口。右侧栏「剪辑」打开原版时间线、混音和导出界面。同时连接镜流后，「从镜流导入」可将所选分集已完成的镜头复制到一个新的本地剪辑工程。

将 `editorTokenFile` 设为本地剪辑器的 MCP 令牌文件，即可从 Muse 主聊天框剪辑当前会话打开的工程。开发启动器会从当前 OpenChatCut 配置目录找到这个文件。Muse 每完成一步剪辑，右侧时间线和播放器就会预览这次改动。可以在这里应用或拒绝整份剪辑提案。收起侧栏后，工程仍与所属会话连接。同一会话打开多个工程时，Muse 可以按名称查找。素材检测、渲染和编码均在用户电脑上执行，包括透明动效片段。单独打开 OpenChatCut 时可使用它自己的 Agent。

面板分别从 `/v1/auth/muse/embed` 和 `/fwp/v2/auth/muse/embed` 验证桌面账号后进入原页面。切换标签保留当前页面。切换 Muse 账号或重新连接 Host 后，面板重新登录。达到最小缩放比例后，较窄的面板支持横向滚动，也可以使用侧栏的全屏按钮扩大写作或制片区域。

## 目录

- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 打开工作台

#### 模型看到什么

打开编剧页面 `/v2` 或制片页面 `/sfp/` 均不会添加提示词、工具或会话事件。镜流工作流工具通过 Host 当前登录的 Muse 账号认证。

#### Token 影响

打开面板不消耗模型 token。

#### KV 缓存影响

浏览工作台不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 两套服务都需要允许 Muse 嵌入其页面。部署[工作台登录适配器](../../../services/muse-workbenches/README.zh.md)后，两套工作台通过 Muse 账号网关登录。
- 镜流和剧本工坊各自管理项目。OpenChatCut 工具需要在当前会话打开剪辑工程。转写和生成素材使用执行该操作的工具所配置的服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
