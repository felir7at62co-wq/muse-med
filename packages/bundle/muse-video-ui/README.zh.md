---
description: "一起安装可选的 Muse 会话界面与已录制视频服务。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-muse-video-ui

[English](README.md) | 中文

## 概述

独立的可选插件包，提供 Muse 会话气泡、小蜘蛛视频幕布、镜头轨道和随滚动收纳的动效。它组合[界面插件](../../client/ui-session-video/README.zh.md)与[会话视频服务](../../drama/session-video/README.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在提供原生 Chat、Deliverables、配置表单和会话框架的 Web profile 上选择此插件包。它的补丁提供规范的 `session-video` 和 `ui-session-video` 条目；不要重复挂载。Muse Desktop 已自带这些贡献，无需另行安装。

在**设置 → 通用 → 视频气泡与轨道**中，可立即切换整套界面。保存的偏好在刷新页面和重启应用后仍然生效。停用时恢复原生导航与视频播放，并保留聊天记录、草稿、附件和后台任务。设置行仍可用于再次启用。卸载插件包遵循 profile 原有的插件管理生命周期；实时开关不需要配置 HMR。

<a id="understand-the-implementation"></a>
## 了解实现

此插件包只包含配置和本地化显示元数据。运行代码、清理行为和配置字段仍由各自的包拥有。界面不拥有视频生成或 Agent 执行。停用界面时，独立的媒体服务继续为其他消费者提供服务。

<a id="model-experience"></a>
## 模型体验

### 组合

#### 模型看到的内容

对 `ui-session-video.enabled` 的修改仅作为界面设置，不会成为模型输入。插件包本身不添加提示词、工具或模型请求。用户提交的镜头修改草稿遵循普通会话流程，详见界面插件说明。

#### Token 影响

切换界面不增加请求 Token。只有之后的用户提交会增加普通会话输入。

#### KV 缓存影响

切换界面不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 需要支持 Web 的 Host；视觉切镜检测需要 FFmpeg/FFprobe。
- 开关会影响共享此 profile 的客户端界面。
- 它不会删除已录制媒体或卸载其他提供方。

<a id="dev-note"></a>
### 开发备注

无。
