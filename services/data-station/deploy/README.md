# 独立数据站发布

这些文件只描述数据站自有服务和 `/data/` 入口，部署由操作者单独执行。应用代码使用 `/srv/muse-data-web/app` 的稳定真实目录，状态使用其中实际的 `.data/live` 子目录；不使用状态目录符号链接，不读取旧 Web、Muse、账号服务或既有 24 小时 dry-run 的数据、凭据、定时器和进程。外部入口与旧站共享 HTTPS Origin，隔离范围是路径、身份映射、进程与存储。

## 本地准备

先完成源码检查、根构建和 `/data/` 浏览器验收，提交已审查的改动。本地打包需要 Node、pnpm、tar 和 Python 3；Python 仅用标准库 `tarfile` 只读归档成员，不解压文件。然后在 Muse 仓库的 `services/data-station` 目录运行 `node scripts/prepare-cloud-release.mjs`；该目录有未提交改动、缺少服务端构建或静态资源 base 不正确都会拒绝打包，清单的 `sourceCommit` 记录 Muse 仓库的提交。打包器不会调用根构建，也不会改动根 `dist` 或根 `node_modules`。

客户端单独使用 `pnpm exec vite build --base=/data/ --outDir=.data/cloud-release-pack/dist`。生产依赖在独立 staging 的 `app` 中执行 `pnpm install --prod --frozen-lockfile --ignore-scripts`，禁止将根依赖目录符号链接到 staging。脚本只复制构建产物、生产依赖、版本锁、必要的番茄源文件和私有 Python 环境初始化脚本，以及所需许可证；不复制 `.env`、数据库、缓存、正文、测试、浏览器资料、账号文件或部署密钥。

打包前要求 checkout 中没有实际 `.env` 系列文件，仅允许 Vite 不会加载的 `.env.example` 模板；即使跳过客户端构建也执行该检查。打包器仅检查文件名，不读取其内容，避免 Vite 自动加载私有 dotenv。部署身份与密钥始终放在包外的私有 `access` 中。

结果位于 ignored `artifacts/cloud-release-*`，包括 `app/` tarball、SHA-256 和清单。清单记录源码提交、服务端 SHA、`/data/` base、每个文件的 SHA、目录（包括空目录）、锁文件及包清单 SHA、实际生产依赖版本和目标平台。归档明确禁用 macOS AppleDouble、扩展属性和 ACL 元数据，并在生成后核对实际成员的名称、类型和链接目标；除清单文件、链接、目录及自身 `RELEASE.json` 外的成员、重复或缺失成员都会拒绝发布，失败的归档会删除。WASM 可随包发布；发现 `.node`、ELF、Mach-O、PE 或依赖的 `os`/`cpu` 限制时脚本明确拒绝便携打包，需在目标 Linux x64 自有 Node 环境重新安装依赖后再完成验证，不能把本机原生依赖当作 Linux 版本。

`prepareCloudRelease({cwd,nodeModulesRoot,buildClient:false,allowDirty:true})` 仅用于隔离 fixture 测试；CLI 不提供 dirty 或提供依赖树的绕过选项。fixture 的依赖根必须是自身项目内真实目录，禁止绝对链接、逃出 bundle 的相对链接和指向根依赖目录的链接；正常 pnpm 的内部相对链接保留。

## 自有运行环境

使用已核对 SHA 的官方 Node `24.21.0` Linux x64 发行文件，在数据站自有 `runtime` 目录保留完整运行时，并将 `/srv/muse-data-web/runtime/node` 设置为其可执行文件或指向该自有文件的链接。不要替换系统 Node 或现有应用运行时。以目标机实际版本、架构和动态链接检查确认其可运行。

创建独立系统用户 `muse-data-web`。代码和运行时由 root 控制并允许服务读取执行；预先创建 `app/.data`、`app/.data/live`，仅这部分交给该服务用户写入。首次解压使用 `tar --no-same-owner --no-same-permissions`，避免继承构建机器的用户 ID；归档不包含 `.data`，不得覆盖现有状态目录。`WorkingDirectory` 必须是实际 `app` 目录，以便路径校验、WASM 和番茄源目录都解析到同一项目。

用自有 Node 运行包内 `scripts/setup-novel-runtime.mjs --python /usr/bin/python3`，在应用私有 `.data/novel-runtime` 创建环境并安装固定的 Python 依赖；不修改系统 Python 包。核对 Linux CA 后再设置可选的 CA 文件，保持 TLS 验证。服务只监听 `127.0.0.1:19617`，不开放新公网端口。

审查并安装 `muse-data-web.service`，先使用 `systemd-analyze verify` 检查目标系统支持的选项。它只启动、停止和重启数据站，限制为 2 GiB 内存、200% CPU，并给停止请求六十秒等待任务取消和数据库关闭。`ProtectHome` 阻止读取用户家目录，`ProtectSystem=strict` 只开放实际 `app/.data` 与私有临时目录；日志有独立标识及速率限制。

## 独立身份与路径

复制非敏感 `server.env.example` 到 root 控制的 `access/server.env`，填写真实 HTTPS Origin。该 Origin 不含 `/data/` 路径。secret 不放环境变量；只在私有 `identities.json` 的 `proxySecret` 和私有 Nginx header 配置中使用同一个足够长的随机值，绝不打印到日志或终端。示例中的无效占位符必须替换后才能启动。

身份文件使用严格的 `version/proxySecret/users` JSON。每人使用不同的稳定 ID，用户名、ID 不重复；角色取本文件配置，不接受浏览器提供的角色。测试共享成员账号意味着共享同一成员身份，不代表已接入公司全体账号。`identities.json` 建议 `root:muse-data-web`、0640；Nginx 独立 `htpasswd` 使用 `root:<实际 worker 组>`、0640。`access` 可由 root 持有并设为 0711，允许两种进程按已知文件名穿过而不能列目录；私有 Nginx 配置由 root 控制，不放静态目录。

仅将 location 模板加入现有 HTTPS server 的新入口：`/data` 重定向到 `/data/`，`^~ /data/` 要求独立 BasicAuth，末尾带 `/` 的 `proxy_pass` 剥去此前缀。Host 固定为环回地址，覆盖专用密钥与用户名，清空上游 Authorization、Cookie 和转发身份相关头。21 MiB 上传限制只作用于这个新 location。不要给旧根路径、旧 `/api` 或其他 backend 增加认证或改路由。

若改用 Muse 网页的飞书登录，在 `access/server.env` 设置 `MUSE_DATA_AUTHENTICATION=muse-session`，location 改用 `nginx-data-location.muse-session.conf.example`（不再要求 BasicAuth，转发浏览器 Cookie 供数据站向本机 Muse 网关核对登录）；`identities.json` 的 `username` 改为 Muse 用户名，名单即访问范围，角色仍以该文件为准。

先备份目标 Nginx 文件，替换私有密钥占位符，执行 `nginx -t`，通过后仅 graceful reload Nginx；不要输出包含密钥的完整配置。仅启动数据站服务，并核验未认证、错误凭据、伪造 header 拒绝，成员与管理员权限分离，静态资源和所有 API 都受保护。根页面、旧 Web、Muse 和既有 dry-run 的响应、PID 及启动时间应保持原样。

## 后续升级与恢复

PGlite 必须只有一个写进程；不能让两份服务或蓝绿实例共享同一 `.data/live`。未来升级先停止数据站并等待 worker、子进程和数据库完全关闭，检查自有锁，再对自有状态做一致性备份。先在独立目录检查新包，在服务停止期间移动真实状态目录并替换稳定 `app`，最后只启动数据站；不要以符号链接替代 `.data`，不要在旧服务未退出时重开数据库。

保留旧发布清单、包和状态备份。恢复须先核对数据兼容性，不自动降级或覆盖已更新数据库；发现残留锁先检查拥有者，不能仅按时间删除。整个流程不包含旧站、Muse 或已有 dry-run 的停止、重启、清理脚本。
