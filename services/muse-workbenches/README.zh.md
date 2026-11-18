# 剧本工坊与镜流的 Muse 登录

此目录适配 2026-11-17 备份内的剧本工坊和镜流。两个 FastAPI 服务分别向 Muse 账号服务验证身份，再用各自原生的签发函数登录原来的业务账号。工坊保留剧本归属、额度和功能权限。镜流保留项目归属和协作者检查。两个前端使用原有的业务页面。

[English](README.md) | 中文

## 安装

在从备份提取的发布副本运行。脚本会预先核对挂载位置，重复运行可更新适配代码。工坊修改 Next 源码后须使用原项目的构建方式重新构建，镜流直接发布修改后的静态目录。生产运行原 FastAPI、Web 及工作队列，适配器随业务后端加载。

```sh
python3 install.py --audience script-workshop \
  --backend "$EXTRACTED/01-drama/code/services/orchestrator" \
  --frontend "$EXTRACTED/01-drama/code/apps/web"
python3 install.py --audience jingliu \
  --backend "$EXTRACTED/02-jingliu/backend/backend" \
  --frontend "$EXTRACTED/02-jingliu/frontend/dist-prod"
```

## 服务配置

每个工作台的 API 进程都需要以下环境变量。把凭据和绑定文件存放在仅管理员可写、服务用户可读的目录。使用单独的测试数据和密钥验证迁移。

| 变量 | 内容 |
| --- | --- |
| `MUSE_WORKBENCH_ISSUER` | Muse 账号网关的 HTTPS origin，例如 `https://accounts.example.com` |
| `MUSE_WORKBENCH_PUBLIC_ORIGIN` | 浏览器实际打开这个工作台的 HTTPS origin，同源提供页面和 API |
| `MUSE_WORKBENCH_SECRET` | 对应该工作台的专用服务密钥，与网关注册值相同。两个服务各设独立的随机密钥 |
| `MUSE_WORKBENCH_BINDINGS` | 该服务的账号绑定 JSON 文件绝对路径，每次登录读取最新配置 |
| `MUSE_WORKBENCH_STATE_DB` | 该服务专用 SQLite 文件绝对路径，父目录预先创建并限制为服务用户可读写。同一实例的多个进程共用此文件 |
| `MUSE_WORKBENCH_PARENT_ORIGIN` | Muse 桌面填 `dsh-app://app`，Muse 网页填实际顶层 origin。留空时只启用独立站登录 |

HTTP 开发地址限本机回环。工坊须配置 `AUTH_REQUIRED=true`、独立随机的 `JWT_SECRET`（至少 32 字符）以及原应用使用的数据库等参数。镜流须配置非空的 `FW_AUTH_UPSTREAM`，该开关启用原项目的逐请求鉴权和协作者检查。可填 Muse 账号网关 origin，互换登录码使用 `MUSE_WORKBENCH_ISSUER`。配置遗漏会阻止服务启动。每次登录请求仅保存在对应服务的本地 SQLite 文件；多副本部署需使同一客户端的挑战、交换和浏览器回调落到同一副本。

在 Muse 账号网关的 `MUSE_WORKBENCH_LOGIN_CONFIG` 分别注册 `script-workshop` 与 `jingliu` 的密钥和固定回调。示例部署使用 `https://scripts.example.com/v1/auth/muse/callback` 与 `https://jingliu.example.com/fwp/v2/auth/muse/callback`。启用方式和配置格式见[账号网关](../muse-accounts/README.zh.md)。

### 旧账号关联

请管理员从 Muse 账号记录核对稳定的账户 ID，从原业务库核对工坊 `users.id` 或镜流 `known_users.user_id`。每个服务维护自己的映射，同一个 Muse 用户可在两份数据库中对应不同编号。新团队成员先在业务库中由管理员建立或确认个人账户，再加入对应绑定。原库中的同名、邮箱和飞书标识均不会触发自动认领。未绑定或被禁用的工坊用户登录时会收到明确提示。

```json
{"issuer":"https://accounts.example.com","users":{"verified-muse-subject":74111}}
```

镜流的历史角色同时包含旧上游授权和本地 `FW_ADMIN_USER_IDS` 提权。普通账号和仍由本地管理员名单授权的账号可以直接登录。对于与当前本地配置不相符的旧角色，管理员核对后在镜流绑定文件中增加 `"jingliuRoles":{"verified-muse-subject":"admin"}`。可选值为 `user`、`admin`、`superadmin`，原本地管理员配置继续生效。角色冲突且未确认时，登录会停在签发会话之前，保留旧角色。

### 原版网页与反向代理

工坊将 `/v1/` 以原路径转发给 FastAPI，原应用已有的 `/api/` 业务代理、静态资源和其他页面按原部署提供。新构建的 `/login`、`/register` 会进入 Muse。镜流将 `/sfp/` 指到修改后的静态站，`/fwp/` 去除前缀后转到自身 FastAPI。两端的登录入口、回调、脚本和 API 都必须与对应原版网页同源。

```nginx
# script-workshop
location = /login { return 302 /v1/auth/muse/login; }
location = /register { return 302 /v1/auth/muse/login; }
location /v1/ { proxy_pass http://workshop_api; }
# jingliu
location /sfp/ { alias /srv/jingliu/dist-prod/; }
location /fwp/ { proxy_pass http://jingliu_api/; }
```

工坊应发布重新构建的 Next 站点。对沿用预构建 Next 的临时验收副本，也可在代理上处理登录重定向，并在所有原站 HTML 文档的 `<head>` 开头同步加载 `<script src="/v1/auth/muse/storage.js"></script>`。同源代理必须允许此脚本。重新构建的工坊和安装后的镜流静态站已包含这项修改。登录/回调响应禁止缓存，网关和应用访问日志应只记录路径，省略包括登录码在内的 query。原站页面的 frame-ancestors 应允许指定的 Muse 父页面。

### Muse 桌面与独立站

工坊面板以 `/v1/auth/muse/embed`、镜流面板以 `/fwp/v2/auth/muse/embed` 启动。Muse 切换账号或退出时，宿主销毁当前 iframe。重新进入时，新文档从空白登录页获取挑战，经父页面确认当前 Muse 会话后换取业务凭据，再跳到工坊的 `/v2` 或镜流的 `/sfp/`。嵌入页只接受来自配置的父 origin 和父窗口的响应。其本地存储按浏览器标签页、工作台、已绑定的业务用户隔离。独立打开网页时通过顶层浏览器跳转，在 Muse 登录、确认，再回到原工作台，沿用原站原生存储。

聊天工具通过同一服务的 `POST .../auth/muse/challenge` 获得 `requestId`、`challenge`，通过当前 Muse 登录获取该 audience 的一次性授权码，再向 `POST .../auth/muse/exchange` 发送 `{"requestId":"…","code":"…"}`。两端以原格式返回自己的会话。后台任务和项目读取继续遵守各工作台原有权限。工作台已签发的独立站令牌按原产品有效期和撤销方式管理，移除绑定会阻止新登录。切换时要立即撤销历史独立站会话，应同步在两套原应用中处理会话或禁用相应用户。

## 验证

在已安装原业务后端依赖（FastAPI、httpx）的 Python 环境执行 `python -m unittest discover -s services/muse-workbenches -v`。测试覆盖两端登录绑定、角色差异、关闭旧入口、回放拒绝和安装器拒绝不匹配版本。浏览器验收时分别打开独立站和 Muse 面板，切换两个已绑定的 Muse 用户，确认各自项目与剧本，以及独立站原有登录状态。

执行 `node --test services/muse-workbenches/test_embedded_storage.mjs` 可在 Chromium 验证两名用户和两个工作台的嵌入存储隔离。通过 `CHROME_PATH` 可指定本机 Chrome。该浏览器用例使用本地模拟授权回复，账号网关的真实登录、授权和回调另由跨服务验收覆盖。
