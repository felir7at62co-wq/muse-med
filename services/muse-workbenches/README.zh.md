# 剧本工坊与镜流的 Muse 登录

此目录适配 2026-11-17 备份内的剧本工坊和镜流。两个 FastAPI 服务分别向 Muse 账号服务验证身份，再用各自原生的签发函数登录原来的业务账号。工坊保留剧本归属、额度和功能权限。镜流保留项目归属和协作者检查。两个前端使用原有的业务页面。

[English](README.md) | 中文

镜流安装器为普通制片与解说剧的剪映导出适配已固定版本的草稿库，包括创建轨道及放置音频、字幕。

[剧本工坊全功能汇报（2026-11-18）](reports/剧本工坊全功能汇报-20261118.html) · [打印版 PDF](reports/剧本工坊全功能汇报-20261118.pdf)

## 安装

在从备份提取的发布副本运行。镜流后端源码位于 [`../jingliu`](../jingliu/README.zh.md)，`install.py --audience jingliu` 把此适配写入其发布副本。工坊源码位于 [`../workshop`](../workshop/README.zh.md)，已含 `--audience script-workshop` 及上传路径、base path、视频转剧本和剧本库的改动；在从该源码构建发布之前，工坊的安装路径保留。脚本会预先核对挂载位置，重复运行可更新适配代码。工坊修改 Next 源码后须使用原项目的构建方式重新构建，镜流直接发布修改后的静态目录。生产运行原 FastAPI、Web 及工作队列，适配器随业务后端加载。

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

同域部署在 Muse 账号站的 `/jubengongfang/` 提供剧本工坊，`/jingliu/` 提供镜流。[路径代理](shared-host/nginx_locations.py)为每次业务请求核验当前 Muse 登录和对应工作台的账号绑定，业务接口接收自己的令牌。入口页按浏览器标签页和关联账号保存原版页面所需的状态。两个应用共享 Muse 网页源，这些路径只应提供公司管理的应用代码。

用 [prepare.py](shared-host/prepare.py) 适配两套原版前端，用 [prepare_uploads.py](shared-host/prepare_uploads.py) 配置工坊上传目录，再以 `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang` 构建 Next。服务器上的 [provision.py](shared-host/provision.py) 在 `/srv/muse-workbenches/config` 下初始化各服务凭据和首名已核验成员。账号代理和业务接口共用各应用的 `bindings/*.json` 文件。工坊使用独立的 PostgreSQL、Redis 和任务进程。镜流将 SQLite 和素材保存在自己的数据目录。桌面和网页共用已登录账号的素材目录。已有部署先运行 `install.py --audience jingliu --library-only --backend <backend> --frontend <studio-site>`，再使用镜流服务的环境和 Python 路径运行 `import_character_references.py <verified-export>`。导入会校验每张原图的摘要、保留元数据和使用范围，重复执行时跳过相同记录。[activate.py](shared-host/activate.py) 检查生成的路径配置后平滑重载现有 Muse HTTPS 站点。

### Muse 桌面与独立站

工坊面板以 `/v1/auth/muse/embed`、镜流面板以 `/fwp/v2/auth/muse/embed` 启动。Muse 切换账号或退出时，宿主销毁当前 iframe。重新进入时，新文档从空白登录页获取挑战，经父页面确认当前 Muse 会话后换取业务凭据，再跳到工坊的 `/v2` 或镜流的 `/sfp/`。嵌入页只接受来自配置的父 origin 和父窗口的响应。其本地存储按浏览器标签页、工作台、已绑定的业务用户隔离。独立打开网页时通过顶层浏览器跳转，在 Muse 登录、确认，再回到原工作台，沿用原站原生存储。

聊天工具通过同一服务的 `POST .../auth/muse/challenge` 获得 `requestId`、`challenge`，通过当前 Muse 登录获取该 audience 的一次性授权码，再向 `POST .../auth/muse/exchange` 发送 `{"requestId":"…","code":"…"}`。两端以原格式返回自己的会话。后台任务和项目读取继续遵守各工作台原有权限。工作台已签发的独立站令牌按原产品有效期和撤销方式管理，移除绑定会阻止新登录。切换时要立即撤销历史独立站会话，应同步在两套原应用中处理会话或禁用相应用户。

## Muse 视频反推

工坊的本地上传、视频链接、TOS 直传、失败续跑及抖音导入草稿，统一调用数据站使用的 [Muse 逐集反推](../../integrations/muse-hit-transcription/native.py)。工坊继续保存草稿归属。续跑沿用原 Muse 会话、原片摘要和参考内容，明确选择全部重做才创建新版本。语音识别、全片字幕识别、画面审查、对白比对和 Word 校验完成后，工坊在同一次数据库事务中写入可编辑的章节和本集素材索引。

已有部署使用 `install.py --audience script-workshop --reverse-only --backend <工坊目录>` 更新反推入口。[配置脚本](shared-host/configure_reverse.py)根据管理员授权的云端转写配置安装指定版本的执行程序，为工坊建立独立的 Muse 账号目录。把 `MUSE_WORKSHOP_REVERSE_CONFIG` 指向生成的私有配置文件，`VIDEO_TMP_DIR` 指向工坊上传卷内的持久目录。使用同一卷的工坊进程共用配置中的并发名额。登录后通过 `GET /v1/video/jobs/{draft_id}/episodes/{episode}/materials` 查看本集清单，按返回的序号在该路径下下载。

### 私有媒体存储

在选定地域使用私有生产媒体桶。工坊、镜流和测试环境分别使用独立前缀。剧本正文、用户权限和项目记录继续由各自的数据库管理。在两套服务的环境配置中填入下列字段。

| 服务 | 配置与权限 |
|---|---|
| 工坊上传 | `ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_REGION`、`ALIYUN_OSS_ENDPOINT_INTERNAL`、`ALIYUN_OSS_ENDPOINT_PUBLIC`、`ALIYUN_OSS_KEY_PREFIX=workshop/prod/`、`ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET`。这些旧变量实际连接火山 TOS。给工坊身份开放上传前缀内的读写和分片上传操作。网页普通上传在未配置桶时通过工坊服务器上传，配置就绪后使用可续传的 TOS 直传。批量文件夹上传使用 TOS。 |
| Muse 反推素材 | 工坊反推配置中的 `tosPrefix` 填 `reverse/prod`，给工坊身份开放该前缀的读写权限。文件逐个验证，最后写清单。章节保存桶名、清单键和摘要，鉴权后的下载链接有效期为五分钟。前缀留空时使用工坊的私有服务器磁盘。 |
| 镜流 | 配置 `FW_TOS_BUCKET`、`FW_TOS_REGION`、`FW_TOS_ENDPOINT`（主机名）、`FW_TOS_KEY_PREFIX=jingliu/prod/`、`FW_TOS_ACCESS_KEY_ID`、`FW_TOS_ACCESS_KEY_SECRET`。镜流身份只在自己的前缀内执行素材所需的操作。默认 `FW_TOS_DIRS` 覆盖 `uploads` 和 `generated`。已导入的共享角色图在 `character-references`，应先迁移、核对已有图片，再把这个目录纳入存储和本地缓存回收。 |

公网端点填写浏览器可达的区域域名。服务能访问同地域内网时，服务端读写才填写内网端点。桶 CORS 允许工作台实际的 HTTPS 来源，开放上传和预览所需的方法及请求头，并暴露分片完成所需的 `ETag`。反推和上传前缀保持私有，排除在工坊的公开 CDN 白名单之外。已有对象沿用原键名，迁移或制定过期策略前先核对数量和摘要。`ARK_TOS_BUCKET` 是旧方舟文件流程的配置，Muse 反推有独立的素材设置。[跨域规则](https://docs.volcengine.com/docs/torch-object-storage/cor-srules?lang=zh) · [桶策略](https://docs.volcengine.com/docs/torch-object-storage/bucket-policy-templates-and-parameters?lang=zh)。

## 验证

在已安装原业务后端依赖（FastAPI、httpx）的 Python 环境执行 `python -m unittest discover -s services/muse-workbenches -v`。测试覆盖两端登录绑定、角色差异、关闭旧入口、回放拒绝和安装器拒绝不匹配版本。浏览器验收时分别打开独立站和 Muse 面板，切换两个已绑定的 Muse 用户，确认各自项目与剧本，以及独立站原有登录状态。

执行 `node --test services/muse-workbenches/test_embedded_storage.mjs` 可在 Chromium 验证两名用户和两个工作台的嵌入存储隔离。通过 `CHROME_PATH` 可指定本机 Chrome。该浏览器用例使用本地模拟授权回复，账号网关的真实登录、授权和回调另由跨服务验收覆盖。
