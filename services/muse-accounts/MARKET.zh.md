---
description: "配置独立 Muse 市场 profile 及带认证的账号网关代理。"
kind: "reference"
---

# Muse 市场部署

[English](MARKET.md) | 中文

## 概述

账号网关在桌面转发前处理 `/market`。独立 `dsh` profile 管理 SQLite 目录、受限发布包校验和私有文件存储。桌面离线时仍可使用网页市场。本页描述部署配置，不代表生产容量或合作组验收已经通过。

## 目录

- [Profile 与网关](#profile-and-gateway)
- [运维](#operations)
- [开发说明](#dev-note)

-----

<a id="profile-and-gateway"></a>
## Profile 与网关

使用包含 `@deepseek-ai/dsh-muse-market` 和对应 CLI 的发行版。将 [market-profile](market-profile/package.json) 复制到独立 Harness 主目录的 `profiles/muse-market/` 中，将 `cordis.patch.yml` 保留在清单旁。通过 `dsh --profile muse-market` 启动市场进程，`MUSE_MARKET_PORT` 设为未占用的回环端口，`MUSE_MARKET_POLICY` 设为策略文件绝对路径。云端 profile 与用户桌面 profile、机器级偏好补丁保持分离。此 profile 不打开智能体或模型提供方。

市场策略文件包含以下字段。路径随部署环境设置；创建私有共享密钥文件，内容为 32–256 个 URL 安全字符，不把实际内容放入配置示例或日志。

```json
{
  "root": "/var/lib/muse-market/catalog",
  "secretFile": "/etc/muse/market-secret",
  "limits": { "archiveBytes": 16777216, "expandedBytes": 67108864, "fileCount": 512 },
  "maxReleases": 1000,
  "maxActiveUploads": 2,
  "allowedPlugins": ["@deepseek-ai/dsh-persona", "@deepseek-ai/dsh-tool-skill"]
}
```

在账号网关上将 `MUSE_MARKET_CONFIG` 指向另一个由管理员维护的 JSON 文件：

```json
{
  "upstream": "http://127.0.0.1:19389",
  "secretFile": "/etc/muse/market-secret",
  "archiveBytes": 16777216,
  "requestTimeoutMs": 60000
}
```

端口须与 `MUSE_MARKET_PORT` 一致。网关与目录进程由不同系统用户运行时，分别为各用户准备仅所有者可读的密钥文件，内容相同，配置中分别指定各自的路径。策略文件不能是链接，不能允许组或其他用户写入；POSIX 上密钥文件还须仅所有者可读写。网关使用共享密钥转发其已认证的账号身份，并对上传下载采用受限数据流。浏览器提交的身份头和 Cookie 不会转发。市场目录拒绝未经认证的直接访问。未设置 `MUSE_MARKET_CONFIG` 时关闭全部市场路由；已配置文件无效会阻止启动。

管理员在网页版创作者中心为已有账号 ID 开通发布团队。受邀作者上传 ZIP 为私有草稿，检查导出内容后提交。管理员下载并检查同一份包，验证案例后审核通过。草稿内容不可变，修正需要新版本。审核须携带当前展示的修订号。下架停止公开分发；已安装文件仍保留在本地。[包参考](../../packages/host/muse-market/README.zh.md) 说明发布格式、本地启用与恢复限制。

[共享市场网页](../../apps/market-web/README.zh.md)可在反向代理层替换网关 HTML，同时继续由网关处理账号和 API 路由。其公开配置仅包含资源限制和允许的插件名，不包含网关密钥或存储路径。

<a id="operations"></a>
## 运维

一个目录根只运行一个市场进程。实测宿主后分别限制进程内存、CPU、请求时间和磁盘；即使发布包大小受限，解压仍占用内存。目录保存在发行树之外。监控上传失败、磁盘使用、进程健康与数据库错误，不记录凭据或包内容。示例版本数与上传限制属于策略示例，不是容量评估。

要获得一致的文件备份，先正常停止市场 profile，复制完整目录，再启动服务。另行备份账号存储并保留发布者账号 ID。恢复到另一私有目录，以同一发行版启动，验证已发布包摘要、作者可见性与未经授权的下载。不要只复制运行中的 SQLite 主文件而遗漏 WAL。桌面备份同时包含会话与市场安装目录。单独复制会话不会携带独立 Skill 的绑定。

先构建，再运行 `node --test services/muse-accounts/market.test.mjs`；此集成使用构建后的云端插件、真实 HTTP 载体、已认证网关与流式代理。验证 `/market` 可公开访问、匿名 `/api/market/v1/me` 返回 401、受邀作者可上传、读者不能查看草稿，以及停用账号后后续访问失效。Linux/macOS 安装检查、真实合作组案例与生产备份恢复仍属于发行验收要求。

构建网页 TypeScript 程序和市场包后，`node --test services/muse-accounts/market-host.test.mjs` 联合验证真实浏览器适配层、已认证网关、云端目录和 Muse Host。它分别通过网页下载与 Host 下载导入两个交接包，启用准确版本，在真实智能体作用域中读取 Bot 与独立 Skill 指令，再验证重启恢复。账号、端口与数据目录均为隔离测试素材；它不验证生产浏览器登录，也不发起模型请求。

<a id="dev-note"></a>
## 开发说明

`market-proxy.mjs` 不包含数据库或压缩包解析器。云端插件仅信任回环网关的私有凭据。发布包校验在独立 profile 进程中执行；审核者在不含生产凭据的独立环境中运行案例。网页使用受限内容安全策略，并以文本渲染发布字段。
