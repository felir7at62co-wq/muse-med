---
description: "Main Session task cards, execution-chat navigation and native file actions in the existing conversation dock."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-coordinator

[English](README.md) | 中文

<a id="summary"></a>
## 概述

此可选界面插件在主会话中展示真实任务状态、执行会话入口、原生交付文件和停止操作。普通会话保持原来的输入区。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

与[协调服务](../../session/session-coordinator/README.zh.md)共同加载。任务卡通过 `useResource` 消费所有者权限的 Remote 观察流，不进行模型轮询。原生会话导航保留当前执行上下文，文件按钮通过原生打开能力访问执行会话的实际交付路径。停止先显示请求状态，账本确认后才显示已停止。

所有注册、观察流、生成的 Remote 绑定与反馈提示都随 Cordis 卸载释放；重新加载会从账本读取现有任务，不派发任务或修改普通会话。

Muse 小蜘蛛按钮位于“新会话”上方，打开默认工作间中固定的主会话。停用插件时同时移除入口与任务卡；重新启用后保留同一主会话。

<a id="model-experience"></a>
## 模型体验

### 可见任务

#### 模型可见内容

界面不添加模型输入；模型输入由协调服务的 `coordinator_report` 结果与回执负责。

#### Token 影响

零；读取卡片和展开列表不调用模型。

#### KV Cache 影响

零；界面观察不修改会话日志。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 卡片报告执行会话状态与文件声明，不认证作品质量或用户验收。

### 开发备注

停用此插件恢复原生输入区；协调账本与执行会话仍由各自所有者管理。
