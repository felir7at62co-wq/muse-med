---
description: "与桌面应用分开部署的 Muse 服务版本化源码。"
kind: "reference"
---

# Muse 服务

[English](README.md) | 中文

## Summary

[`muse-accounts`](muse-accounts/README.zh.md) 收录账号网关的源码与测试。桌面构建不会启动它；发布时需将其与对应版本的 runtime 和 global 包一起复制到独立的服务器发布目录。

[`muse-runtime`](muse-runtime/README.zh.md) 提供独立部署的工作间 broker 的优雅关闭入口。

[`muse-media`](muse-media/README.zh.md) 由私有 DTK 部署和账号授权网关组成，提供公司媒体服务；上游凭据留在服务器。

[`muse-host-retention`](muse-host-retention/README.zh.md) 盘点主机上的应用版本和归档日志并规划其保留期。账号数据库、员工项目、提供方凭据及媒体卷不作为清理目标。

[工作台登录适配器](muse-workbenches/README.zh.md)通过 Muse 网关将用户登录到剧本工坊和镜流原有的业务账号。

[`jingliu`](jingliu/README.zh.md) 收录 Muse 制片引擎镜流的后端：云端发布的后端去掉登录适配，再加上其 README 列出的尚未部署的改动。

[`workshop`](workshop/README.zh.md) 收录剧本工坊的源码：Muse 存放定稿剧本的云端剧本工作台，含 FastAPI 后端和 Next.js 前端。

[`data-station`](data-station/README.zh.md) 收录 `/data/` 数据站的源码：提供平台榜单、抖音搜索与下载，以及为每日爆款转写供片的储备看板。
