---
description: "与桌面应用分开部署的 Muse 服务版本化源码。"
kind: "reference"
---

# Muse 服务

[English](README.md) | 中文

## Summary

[`muse-accounts`](muse-accounts/README.zh.md) 收录账号网关的源码与测试。桌面构建不会启动它；发布时需将其与对应版本的 runtime 和 global 包一起复制到独立的服务器发布目录。
