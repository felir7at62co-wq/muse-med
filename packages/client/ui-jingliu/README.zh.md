---
description: "Muse 右侧栏的镜流制片工作台。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jingliu

[English](README.md) | 中文

## 概述

镜流与 Muse 同站挂载在 `/jingliu/` 时，制片项目、共享资产、余额和项目设置在 Muse 中打开。右侧「环境」显示本机工作间及当前会话已确认的云项目。「添加工作间」可选择或新建本地文件夹，也可关联制片项目。独立镜流站点使用原版标签页。

「共享素材 → 角色」显示镜流共享目录中人物的原图和特征。

内嵌标签保留所打开的文档。切换账号时重新登录。

## 目录

- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 打开工作台

#### 模型看到什么

打开制片页面 `/sfp/` 不会添加提示词、工具或会话事件。确认制片项目后，Host 将项目名和编号作为通知记入当前会话。

#### Token 影响

打开面板不消耗模型 token。

#### KV 缓存影响

浏览工作台不改变模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

- 独立部署的嵌入页需要允许 Muse 显示页面。部署[工作台登录适配器](../../../services/muse-workbenches/README.zh.md)后，镜流通过 Muse 账号网关登录。
- 镜流管理项目和账号会话。在当前对话中确认项目后，会话工具即可使用它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
