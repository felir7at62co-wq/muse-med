# 部署中央 Muse Web

[English](README.md) | 中文

回环网关在 `/central/` 下提供现有的 Muse Web。网关在每个新请求到达时验证已有 Muse 账号的登录会话，并将访问限制在配置中的生产账号 ID。公开账号网关负责登录、选择设备和撤销账号访问。原生 Web Host 保留私有监听地址和浏览器鉴权。

## 安装私有服务

创建系统用户及组 `muse-central-web`，用户无需登录 shell。将账号服务中的 `central-web.mjs` 和本目录的 `refresh-backend-cookie.py` 安装到 `/opt/muse/central-web`，文件归 root 所有。服务单元使用 Cloud Web 已有的 Node 运行时。运行时变更时核对其路径。

创建 `/etc/muse-central-web/config.json`，权限设为 `0640`，文件归属设为 `root:muse-central-web`。填写已获准访问中央 Muse 的生产账号 ID。配置无需密码或原生凭据。

```json
{
  "publicOrigin": "https://muse.aigc-pipeline.cn",
  "accountsOrigin": "http://127.0.0.1:19389",
  "backendOrigin": "http://100.123.97.104:19490",
  "ownerAccountId": "<existing 16-character account ID>",
  "allowedAccountIds": ["<owner account ID>", "<another authorized account ID>"],
  "backendCookieFile": "/run/muse-central-web-auth/backend-cookie",
  "port": 19584
}
```

将 service 和 timer 单元安装到 `/etc/systemd/system`。将 `muse-central-web.tmpfiles.conf` 安装为 `/etc/tmpfiles.d/muse-central-web.conf`。仅 root 运行的服务通过私有网络交换 Cloud Web 当前进程的启动令牌，并以原子操作把原生 Cookie 写入运行时目录。网关进程具有 Cookie 的读取权限，运行时目录的写入权限和 Cloud Web 日志的读取权限均不授予网关。

```sh
systemd-tmpfiles --create /etc/tmpfiles.d/muse-central-web.conf
systemctl daemon-reload
systemctl start muse-central-backend-cookie.service
systemctl start muse-central-web.service
```

添加 Nginx include 前，先通过网关验证本地访问。正在运行的 `muse-cloud.service` 对应的日志中须有原生启动 URL。定时器每分钟刷新私有 Cookie，并在 Cloud Web 重启后使用新的启动 URL。

设置 `allowedAccountIds` 时，列表必须包含 `ownerAccountId` 和所有获准进入中央 Muse 的账号 ID。每个请求都需要有效且启用的生产账号会话。省略列表时，拥有者还必须保有管理员角色。

可选的 `backendResponseTimeoutMs` 默认是 15000 毫秒。网关分别限制连接等待时间和完整转发请求后的响应头等待时间，任一环节超时即返回 HTTP 504。连接建立后的上传和收到响应头后的流式传输沿用原有行为。

## 启用 HTTPS 访问

将 `nginx.central-web.conf` 复制到 `/etc/nginx`，并将其加入生产账号域名现有 HTTPS server 块的 include。保留现有账号网关及工作台路由。配置的回环端口变化时，同步更新 include 中的端口。重新加载 Nginx 前运行 `nginx -t`。

检查浏览器登录页、拥有者访问、已登录普通账号被拒绝的行为，并确认现有用户仍可打开设备选择页。在中央页面检查静态资源、会话列表和 `/central/` 下的双向 WebSocket 流。核验已撤销的登录失去访问权限。这些检查通过后，为网关和 Cookie 刷新定时器启用开机启动。

## 回滚

从 HTTPS server 块移除中央 Web include，验证并重新加载 Nginx。停止并禁用 `muse-central-web.service` 和 `muse-central-backend-cookie.timer`。停止辅助服务会关闭现有的中央浏览器流。账号网关和私有 Cloud Web 继续运行。
