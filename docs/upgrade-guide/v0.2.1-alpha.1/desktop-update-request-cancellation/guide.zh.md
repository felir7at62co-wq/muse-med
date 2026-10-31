---
kind: upgrade-guide
description: "已批准的 Desktop 更新会在安装前取消活动 HTTP 请求并暂停 Remote 流。"
---
# Desktop 更新会取消活动客户端请求

[English](guide.md) | 中文

## 变更

用户批准更新后，Desktop 会在停止 Host 前取消现有 HTTP 客户端请求并暂停 Remote socket 流。进程内 Remote 流必须结束或关闭后才能安装。此前在更新准备期间继续的读取或下载可能因此中断。

## 迁移

1. 确认安装前，完成或保存客户端操作。若更新失败且准入恢复，请重试被中断的客户端请求。
2. 客户端路由和 Remote 流实现必须处理取消并完成清理。确认在途处理程序和 socket 流迭代器结束之前不会继续安装更新。
