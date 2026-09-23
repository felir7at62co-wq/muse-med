---
description: "选择剧变 HTTP 客户端、业务数据辅助库或模型可调用工具，用于读取资产与提交媒体任务。"
kind: "package-group"
---

# jubian/ — 剧变媒体任务与资产

[English](README.md) | 中文

## 概述

读取剧变项目、资产和媒体任务，或提交已明确授权的生成请求。认证传输与写入记账用 `jubian`，提供方数据与请求构造用 `jubian-api`，模型可调用操作用 `tool-jubian`。付费提交需要凭据和预算授权；这些包不决定创作内容，也不替代短剧工作流。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

按调用方需要选择入口：

| 包 | 职责 |
|---|---|
| [`jubian`](jubian/README.zh.md) | 认证 HTTP 传输、响应大小限制、安全错误，以及本地写入账本与预算检查 |
| [`jubian-api`](jubian-api/README.zh.md) | 类型化读取、请求构造、模型选择与经校验的媒体下载 |
| [`tool-jubian`](tool-jubian/README.zh.md) | 模型可调用工具，以及设置页使用的 token 与图片通道 Remote 命名空间 |

<a id="related-documentation"></a>
## 相关文档

- [工具子系统](../../docs/subsystems/tools.zh.md) —— 注册、参数校验、执行与模型可见结果。
- [凭据子系统](../../docs/subsystems/credentials.zh.md) —— 主机负责的凭据查找与授权。
- [Typert 子系统](../../docs/subsystems/typert.zh.md) —— 设置页消费方使用的类型化 Remote 方法。
- [短剧包](../drama/README.zh.md) —— 提供方适配器之外的镜头准备、BGM 合成与分集交付。

<a id="dev-note"></a>
## 开发备注

无。
