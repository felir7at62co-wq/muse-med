# 镜流的 Muse 登录与制片服务

[English](README.md) | 中文

此适配器连接 2026-11-17 版镜流后端和前端。Muse 登录后，镜流按已绑定的原用户 ID 检查项目权限、协作者和余额。桌面和网页共用同一套项目和素材库。

## 安装

在解压的镜流副本运行安装器。它会核对挂载位置、接入 Muse 登录与共享角色，并为普通制片和解说剧适配剪映的视频、音频与字幕轨。

```sh
python3 install.py --audience jingliu \
  --backend "$EXTRACTED/02-jingliu/backend/backend" \
  --frontend "$EXTRACTED/02-jingliu/frontend/dist-prod"
```

## 配置

| 变量 | 内容 |
| --- | --- |
| `MUSE_WORKBENCH_ISSUER` | Muse 账号网关的 HTTPS origin，例如 `https://accounts.example.com` |
| `MUSE_WORKBENCH_PUBLIC_ORIGIN` | 浏览器实际打开这个工作台的 HTTPS origin，同源提供页面和 API |
| `MUSE_WORKBENCH_SECRET` | 对应该工作台的专用服务密钥，与网关注册值相同 |
| `MUSE_WORKBENCH_BINDINGS` | 该服务的账号绑定 JSON 文件绝对路径，每次登录读取最新配置 |
| `MUSE_WORKBENCH_STATE_DB` | 该服务专用 SQLite 文件绝对路径，父目录预先创建并限制为服务用户可读写。同一实例的多个进程共用此文件 |
| `MUSE_WORKBENCH_PARENT_ORIGIN` | Muse 桌面填 `dsh-app://app`，Muse 网页填实际顶层 origin。留空时只启用独立站登录 |

将 `FW_AUTH_UPSTREAM` 设为 Muse 网关地址以启用镜流原生鉴权。网关的 `MUSE_WORKBENCH_LOGIN_CONFIG` 读取 `jingliu` 注册项，独立站点的回调地址为 `https://jingliu.example.com/fwp/v2/auth/muse/callback`。服务账号须能读取绑定文件并写入登录请求数据库。

### 原有账号与共享素材

绑定文件的 `issuer` 对应 Muse 网关，`users` 将已核验的 Muse 账号 ID 映射到镜流 `known_users.user_id`。管理员核实原有角色后可通过 `jingliuRoles` 显式绑定。镜流在签发会话前核对角色与权限。

已有站点可使用 `install.py --audience jingliu --library-only` 更新素材库适配。用镜流服务环境运行 `import_character_references.py <已核验的导出目录>`，按原图摘要导入角色，重复导入保留已有素材。

### 网页与桌面

[路径代理](shared-host/nginx_locations.py)将镜流挂载在 Muse 域名的 `/jingliu/`，逐次校验 Muse 登录与账号绑定。镜流使用自己的凭据、SQLite 数据库与媒体目录。独立站点从 `/fwp/v2/auth/muse/embed` 登录后打开 `/sfp/`，嵌入页按当前标签页和账号保存会话。桌面工具以当前 Muse 登录访问同一业务账号。

[前端适配](shared-host/prepare.py)使用 `--studio <静态目录>` 准备路径部署。[服务配置](shared-host/provision.py)初始化凭据与首个已核验成员。[系统服务](shared-host/units.py)运行镜流与账号代理。

配置 `FW_TOS_BUCKET`、`FW_TOS_REGION`、`FW_TOS_ENDPOINT`（主机名）、`FW_TOS_KEY_PREFIX=jingliu/prod/`、`FW_TOS_ACCESS_KEY_ID`、`FW_TOS_ACCESS_KEY_SECRET`。镜流身份只在自己的前缀内执行素材所需的操作。默认 `FW_TOS_DIRS` 覆盖 `uploads` 和 `generated`。已导入的共享角色图在 `character-references`，应先迁移、核对已有图片，再把这个目录纳入存储和本地缓存回收。
