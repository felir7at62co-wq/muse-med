---
kind: package-reference
description: "在 Muse 会话中查找并调用镜流影视制作工作流。"
---

# @deepseek-ai/dsh-tool-jingliu

[English](README.md) | 中文

## 概述

在会话中用 `jingliu_projects` 搜索并确认制片项目。`jingliu_studio` 可回读分集、导入共享素材和校对字幕文字与时间，`jingliu_image` 默认使用 GPT Image 2。通过 `jingliu_workflows` 和 `jingliu_run` 调用镜流制片流程。Muse 撰写并锁定分镜提示词后提交已审校的镜头。导出剪映时，工具将可编辑轨道和经核验的媒体放入指定的本机草稿目录，在聊天中返回路径。

请求使用当前账号的[镜流连接](../jingliu-connection/README.zh.md)。

## 目录

- [运行工作流](#running-a-workflow)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="running-a-workflow"></a>
## 运行工作流

每次调用都会读取当前目录。项目操作优先使用本会话确认的项目。尚未关联时可以按用户要求给出具体项目编号。服务声明为修改、生成或计费的操作会请求一次确认，计费操作展示服务端报价。服务要求额外确认不可逆修改时，Muse 展示原服务器的具体原因，获准后以原调用编号提交。桌面工具网关收到的调用编号来自发起会话与工具调用，异步任务返回的任务 ID 可用于查看进度或等待完成。

`jingliu_narration` 支持解说剧·角色开口流程，包括读取状态和核对报告、切换项目可用模型、拆台词、出片或单镜重做、接受单句差异和导出剪映草稿。拆解与出片使用服务端报价。Muse 在自身私有目录记录任务提交，同一调用重新执行时可取回已确认的任务编号。提交中断时，应先核对项目里的任务。

<a id="model-experience"></a>
## 模型体验

### 查找和运行工作流

#### 模型看到什么

模型使用 `jingliu_projects` 确认项目，使用 `jingliu_studio` 审校素材和字幕，通过 `jingliu_image` 生图。发现工具分页返回简要说明，或返回一个工作流的完整参数定义。执行工具按此定义校验业务参数，连同工作流名称和项目编号返回服务器结果。解说剧工作流使用同一账号和项目编号。

#### Token 影响

仅所选工作流的参数与结果进入会话。工具目录按页读取，不向系统提示写入完整目录。

#### KV 缓存影响

服务端更新目录不会改变这些工具的定义。目录查询结果记录在发起会话中。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 需要已开放桌面工具网关的镜流服务和可登录的账号。生成任务与媒体保存在项目服务器。
- 解说剧任务接口可对运行中的任务去重，但没有可持久重放的请求标识。提交后丢失响应时，实际支出可能尚无法确定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
