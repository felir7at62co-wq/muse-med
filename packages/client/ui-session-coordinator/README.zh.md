---
description: "Retained Main Session navigation with native execution conversations and chat result reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-coordinator

[English](README.md) | 中文

<a id="summary"></a>
## 概述

此可选界面插件打开固定主会话，并提供侧栏入口。执行会话使用原生侧栏行，结果通过主会话聊天消息返回；会话标题下方和会话行中均不展示任务气泡。

成功配对的 `coordinator_show_report` 调用在所属轮次的聊天记录中内联展示任务汇报，位于折叠过程详情之外。带版本的结果元数据保留任务身份、执行修订、工作目录、状态、汇报和交付文件，以供历史重放。只有相同执行修订的当前观察结果可以更新卡片；新修订、不可用的观察流和已移除任务均保留原回执，并标明历史状态。部分汇报保留实际展示数量和任务总数。

<a id="table-of-contents"></a>
## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

与[协调服务](../../session/session-coordinator/README.zh.md)共同加载。任务派发、完成回执以及唤醒主会话转告结果均由协调服务负责。通过普通侧栏行打开执行会话，即可查看执行过程。

每份汇报可以打开对应执行会话和交付文件。文件预览使用执行会话的身份与目录解析路径，包括相对路径。汇报不提供修改任务的按钮。无效、不支持、嵌套或失败的工具结果仍保留在普通工具详情中，不添加汇报卡片。汇报身份包含其轮次，模型在后续轮次复用调用编号时不会替换此前的汇报。

所有注册、观察流、生成的 Remote 绑定与反馈提示都随 Cordis 卸载释放；重新加载会恢复导航，不派发任务或修改普通会话。

启动时在权限可用且未被用户导航或草稿取代时打开固定主会话。Muse 小蜘蛛按钮位于“新会话”下方，在展开侧栏中与其左右边缘对齐，可从其他对话返回主会话。普通工作区列表不展示主会话，执行会话仍正常展示。停用插件时移除入口及导航注册；重新启用后保留同一主会话。

<a id="model-experience"></a>
## 模型体验

### 主会话导航

#### 模型可见内容

界面不添加模型输入；模型输入由协调服务的 `coordinator_show_report` 结果和执行会话回执负责。

#### Token 影响

零；导航到会话不调用模型。

#### KV Cache 影响

零；界面观察不修改会话日志。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 执行会话的完成回报由协调服务负责；完成不代表作品质量或用户验收。

### 开发备注

停用此插件移除主会话入口；协调账本与执行会话仍由各自所有者管理。
