---
kind: package-reference
description: 镜流账号授权与制作服务请求。
---

# 镜流账号连接

[English](README.md) | 中文

## 概述

桌面 Host 访问所选镜流站点的 `/fwp/v2` 接口。`studioOrigin` 可配置 HTTPS 站点或明确的 IPv4、IPv6 回环地址。原版工作台入口位于 `/sfp/`，Host 请求拒绝重定向。未配置站点时，服务保持未连接状态。

## 目录

- [登录](#sign-in)
- [Host 接口](#host-api)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="sign-in"></a>
## 登录

在 Muse 会话中输入 `/jingliu-login`，打开返回的飞书授权链接。授权完成后在原会话再次运行该命令。Host 使用单独的取号密钥领取一次性票据，并按照站点保存用户凭据。`/jingliu-logout` 吊销工具使用的会话。工作台继续提供原版飞书登录。

独立本地预览将 `localPreviewToken` 设为 `true`，在 Host 环境中通过 `MUSE_JINGLIU_SESSION_TOKEN` 提供测试账号会话。这一模式仅接受回环站点，直接读取测试凭据。工具选择项目前会先向 `/auth/me` 核实用户身份。

<a id="host-api"></a>
## Host 接口

Host 插件通过 `ctx.jingliuConnection.connection()` 取得已核验的 `JingliuSession`。其中的 `identity` 标识用户和服务器，`request(path, options)` 访问相对于 V2 接口的受支持路由并返回解析后的 JSON。工作流工具选择向模型展示哪些结果。

<a id="model-experience"></a>
## 模型体验

### 工作流调用期间切换账号

#### 模型看到什么

准备请求后切换账号，工作流工具会返回 `JINGLIU_ACCOUNT_CHANGED`。授权令牌保留在 Host。

#### Token 影响

登录不增加工具定义或系统指令。

#### KV 缓存影响

切换账号不会改变系统前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 使用明文 HTTP 的远程部署需要通过可信的本地回环隧道连接，或在服务端提供 HTTPS。工作台和 Host 分别维护其授权会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护备注</summary>

无。

</details>
