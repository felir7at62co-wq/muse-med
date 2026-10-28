---
description: "独立部署的 Muse 工作间 broker 的优雅关闭入口。"
kind: "reference"
---

# Muse runtime broker

[English](README.md) | 中文

`graceful-shutdown.mjs` 先关闭 HTTP 服务器，再等待已接收的操作。调用方同步拒绝新请求，提供所有待完成的 ensure Promise 和串行操作链末尾，并在 SIGTERM 或 SIGINT 后等待完成；管理员停止请求也包含在内。模块不终止容器、不退出进程；操作未结束时，关闭也不会被视为完成。

已部署的 broker 仍是单独审阅的服务器源码。发布时通过哈希绑定的派生 broker 文件引入此模块，并在部署清单中记录两者的哈希。Desktop 构建不会启动这个服务。

使用 `node --test services/muse-runtime/tests/graceful-shutdown.test.mjs` 运行隔离 HTTP 生命周期测试。
