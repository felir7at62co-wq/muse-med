---
kind: package-reference
description: 以当前登录的 Muse 用户身份连接剧本工坊，并提供与镜流连接共用的 Muse 账号登录核心。
---

# 工作台连接

[English](README.md) | 中文

## 概述

默认导出 Host 服务 `workshopConnection`。它以当前登录 Muse 的用户身份打开剧本工坊会话，工坊工具因此使用该用户自己的工坊账号，只看得到该用户的任务。本包还导出 `WorkbenchSessions`，即 `@deepseek-ai/dsh-jingliu-connection` 连接镜流时使用的登录与请求核心。工坊和镜流的原生令牌只留在 Host 内存中，不会进入模型输入、工具参数或工具结果。

## 目录

- [配置剧本工坊](#configure-the-workshop)
- [登录](#sign-in)
- [Host API](#host-api)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configure-the-workshop"></a>
## 配置剧本工坊

把 `workshopOrigin` 设为下列部署之一。不设置时服务处于未配置状态，每次连接都报告 `WORKSHOP_UNCONFIGURED`。其他取值在插件加载时以 `WORKSHOP_ORIGIN_INVALID` 失败。`timeoutMs`（默认 30000，范围 1–120000）限定一次 JSON 请求连同响应体的时长。

| `workshopOrigin` | 登录方式 | API 根路径 |
| --- | --- | --- |
| `<Muse 网关>/jubengongfang` | Muse 网关凭 Muse 登录 Cookie 为每个请求授权 | `<origin>/v1` |
| HTTPS 源站，或 `http://127.0.0.1:<port>` / `http://[::1]:<port>` | 在 `/v1/auth/muse/challenge` 和 `/v1/auth/muse/exchange` 兑换 Muse 授权 | `<origin>/v1` |

Desktop Host 用 `MUSE_SCRIPT_WORKSHOP_ORIGIN` 挂载本服务；该变量未设置时使用 `<MUSE_BASE_URL>/jubengongfang`。

<a id="sign-in"></a>
## 登录

在 Muse 账号设置中登录即可，不需要单独登录剧本工坊。在网关挂载下，Host 通过 Muse 账号服务发送每个请求；账号服务只对签发它的网关、只对 `/jubengongfang/v1/` 路径附带 Muse Cookie。`GET /v1/auth/me` 确定工坊用户。在独立源站下，Host 先请求登录挑战，从 Muse 网关取得一次性的 `script-workshop` 授权，再兑换工坊的 `access_token`，之后以 Bearer 令牌发送。请求一律不跟随重定向；`WorkbenchSession.fetch` 传入 `redirect: 'manual'` 时返回重定向响应，由调用方检查。上游请求失败时保留其原始错误；只有 Muse 账号服务拒绝时才报告 Muse 登录失败。

会话属于打开它的 Muse 登录。Muse 通知登录变化、请求前后出现另一个登录，或工坊返回 401 时，会话即被丢弃。在这类变化期间仍在进行的请求以 `WORKSHOP_ACCOUNT_CHANGED` 失败并丢弃响应。下一次连接用当前登录重新登录。

<a id="host-api"></a>
## Host API

`ctx.workshopConnection.connection()` 返回 `WorkbenchSession`，并发调用共用一次登录。`request(path, options)` 在 API 根路径下发送 JSON 并返回解析后的响应；非 2xx 响应抛出 `WorkbenchHttpError`，带 HTTP `status`、服务的 `detail.code` 或 `WORKSHOP_HTTP_ERROR` 以及其消息。`identity` 是部署与工坊用户 ID 的摘要。`fetch(url, init)` 和 `check()` 用于读取原始媒体；镜流用它们读取制片素材。

`WorkbenchSessions` 接收 `WorkbenchDefinition`（受众、网关挂载路径、API 根路径、凭据字段和面向用户的名称）与 `WorkbenchDeployment`（已校验的源站、超时和可选的回环预览凭据）。`disconnect(signal)` 在独立源站下到 `/auth/logout` 注销原生令牌；在网关挂载下只丢弃会话。

`workshopConnection` 同时是供客户端「剧本」标签使用的 Typert Remote 服务：`scripts` 读取定稿库的一页及各阶段计数，`script` 读取一个剧本的版本列表和某一版的各集正文，`pickScript` 选用一版投产，`scriptProduction` 登记被选用剧本投产成的镜流项目。所有成员都能读定稿库；没有 `script_pick` 权限时工坊拒绝 `pickScript` 和 `scriptProduction`。`scriptList`、`scriptDetail` 和 `scriptOf` 校验响应，不符合时以 `WORKSHOP_INVALID_RESULT` 失败。

草稿编辑器以同一登录账号搜索草稿、读取分集、处理候选和定稿。只有 Muse 连接的所有者能远程调用这些草稿方法。保存针对一个分集版本，定稿针对用户审阅过的整份草稿版本。

<a id="model-experience"></a>
## 模型体验

### 工坊工具失败

#### 模型看到的内容

工坊工具可能以 `WORKSHOP_SIGN_IN_REQUIRED`、`WORKSHOP_MUSE_AUTH_UNAVAILABLE`、`WORKSHOP_UNCONFIGURED`、`WORKSHOP_MUSE_EXCHANGE_FAILED` 或 `WORKSHOP_ACCOUNT_CHANGED` 失败，每种都附有告诉用户如何处理的中文消息。授权码、Cookie 和令牌都不会出现。

#### Token 影响

本服务不增加工具定义或系统指令；只有失败调用的简短消息进入对话。

#### KV Cache 影响

登录与账号变化都不改变系统前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **剧本工坊没有登录命令** —— 不同于镜流，没有 `/workshop-login` 或 `/workshop-logout`；第一次调用工坊工具时登录，Muse 账号变化即结束会话。
- **账号绑定在服务器端** —— 没有工坊账号映射的 Muse 账号会以 `WORKSHOP_MUSE_EXCHANGE_FAILED` 失败，并提示用户请管理员核对账号绑定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者备注</summary>

工坊自己的登录路由和网关挂载定义在工作台部署目录的 `services/muse-workbenches/muse_login.py` 与 `shared-host/edge.mjs` 中。

</details>
