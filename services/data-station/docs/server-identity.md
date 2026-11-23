# Independent server identity

The default `local-preview` mode binds to loopback and supplies the existing local preview administrator. It must remain local. `server` mode also binds to loopback and requires `MUSE_DATA_PUBLIC_ORIGIN` plus `MUSE_DATA_IDENTITY_FILE`; it never falls back to a preview account. The public origin is an exact HTTPS origin such as `https://muse.aigc-pipeline.cn`, without the `/data/` mounting path, a trailing slash, query, fragment or credentials. Proxy identity settings are rejected unless server mode is explicit.

The independent reverse proxy performs its own Basic authentication, overwrites `X-Muse-Data-Key` with a random 32-byte key encoded as 64 hexadecimal characters, and overwrites `X-Muse-Data-User` with its authenticated username. It clears client Authorization and Cookie headers and forwards a fixed loopback Host. The public entry can strip its `/data/` prefix before proxying. Node does not interpret forwarded Host, scheme, role, cookies or Basic credentials. Only the private shared key plus a known username resolve an account; roles come exclusively from the private account file. The data station has no company SSO, self-registration or Muse account dependency.

`MUSE_DATA_IDENTITY_FILE` points to a new file owned by this data station. It must be an absolute canonical path without symbolic links, a regular file no larger than 1 MiB, and have exactly mode 0600 or 0640. Identity JSON has only `version`, `proxySecret` and `users`. Version is `1`; `proxySecret` is a securely generated 64-character hexadecimal key. Each user has only `username`, `id`, `name` and `role`. Usernames contain 1–64 ASCII letters, digits, dots, underscores or hyphens; IDs and names are nonempty trimmed strings of at most 200 characters without control characters. Roles are `admin` or `member`. Both usernames and stable IDs must be unique. No password is stored in this file; the reverse proxy owns password verification.

## Muse sign-in

With `MUSE_DATA_AUTHENTICATION=muse-session`, the data station reuses the Muse website's Feishu sign-in instead of a proxy password. Use `deploy/nginx-data-location.muse-session.conf.example`: the proxy still overwrites `X-Muse-Data-Key`, clears `X-Muse-Data-User` and Authorization, and forwards the browser's Cookie header. The data station reads only the `__Host-muse` session cookie and asks the Muse account gateway at `MUSE_DATA_MUSE_GATEWAY` (a loopback HTTP origin, default `http://127.0.0.1:19389`) for `GET /api/muse/identity`, sending that cookie and the public Host. The cookie is never logged or returned.

In this mode the identity file's `username` values are Muse usernames, which may be non-ASCII; the file is the access list, and roles still come only from it. A listed account receives its file identity plus `muse: { username, admin }`; the Muse admin flag only decides which Muse links the shared top bar shows. Accepted and refused accounts are cached by a SHA-256 of the session token for `MUSE_DATA_MUSE_SESSION_CACHE_SECONDS` (default 60, 0–3600), so a revoked Muse session or list change in a restarted service takes effect within that time; a missing sign-in is never cached.

A page load without a Muse sign-in is redirected with 303 to `/login`; API requests receive 401 with `X-Muse-Data-Login: /login`, which the page follows. A signed-in Muse account that is not listed receives a 403 notice, and an unreachable or failing gateway gives 503. Requests without the private proxy key still receive a plain 401. Muse sends signed-in users to its workbench after login; they reach the data station from the 数据站 link in the Muse top bar.

For example, a user record is `{"username":"maker","id":"person-002","name":"制作成员","role":"member"}`. The enclosing document is `{"version":1,"proxySecret":"<securely generated 64 hexadecimal characters>","users":[<user records>]}`; placeholders are explanatory and are not a usable account file. Accounts are loaded once before database initialization. Role changes and revocation require updating this independent account file and restarting only the data-station service; proxy password changes belong to its independent password file. Account IDs should remain stable when names or passwords change because per-user shelves use the ID. Key rotation must update both the private proxy configuration and this account file.

Every server-mode path, including static assets, SPA routes and unknown paths, requires a confirmed account. Exact GET and HEAD requests to `/api/health` are the sole Node authentication exception, and still require an allowed loopback Host and request URL. A reverse proxy may retain its own authentication on the public health URL. Every mutation requires Origin equal to the configured HTTPS public origin. Provided Origin values on reads must also match. Missing or different write origins, forged forwarded headers, unknown accounts and incorrect keys cannot bypass these checks. Host validation checks both the HTTP Host header and request URL.

An authenticated API response includes `X-Muse-Data-Authenticated: 1`, including ordinary role-denied 403 responses and binary original-text downloads. Identity and security headers apply to the final route response, including responses constructed directly; a route's explicit cache policy is retained, and otherwise `no-store` is supplied. A client can preserve a confirmed session for those permission denials while clearing account state for 401 or unconfirmed 403 responses. The marker never substitutes for server authentication. Session responses expose only the current user's ID, name, role and real mode; health exposes the real mode and `trusted-proxy` authentication label. Neither response includes the account list, proxy key, password data or identity-file path. Management role checks and per-user bookshelf ownership remain unchanged.

Startup reads the identity file with `O_NOFOLLOW`, validates file permissions and size, bounds UTF-8 JSON reads, checks for concurrent changes, and uses a Map for account lookup so prototype-like usernames have no inherited permissions. Proxy key comparison checks the hexadecimal length before constant-time byte comparison. Identity errors do not include file contents. Identity validation happens before claiming a database lock; later initialization failures close the newly opened database and release that process's lock before exiting.

Run `pnpm exec vitest run tests/server-identity.test.ts tests/server.test.ts tests/scripts.test.ts tests/novel-config.test.ts` for private-file, configuration, request-authentication, role, CSRF, static-path and startup-cleanup checks together with the existing local preview and bookshelf cases. These tests use isolated temporary files and databases; they do not read production credentials or contact existing Muse services.

## 按飞书部门放行（2026-11-15）

使用 Muse 飞书登录（`MUSE_DATA_AUTHENTICATION=muse-session`）时，数据站还可以按飞书部门放行，并在名字旁显示部门：

- **谁能进**：`identities.json` 名单里的账号照旧（角色以名单为准）；不在名单里的 Muse 账号，只要对应的飞书成员在 `MUSE_DATA_ACCESS_DEPARTMENTS` 列出的部门或其下级部门里，就以成员身份进入，ID 为 `muse-<accountId>`，名字取飞书姓名。其他账号仍是 403。网页登录和桌面 Muse（`X-Muse-Account-Token`）用同一套判断。
- **显示部门**：每个进入的人都带上飞书部门（优先显示放行部门里的那个），页面右上角显示，下载记录、立即转写的请求人记为「姓名（部门）」。
- **部门数据**：数据站用 Muse 飞书登录应用（与 Muse 登录同一个应用，open_id 才对得上）读取整棵部门树和各部门成员，默认每 60 分钟一次（`MUSE_DATA_FEISHU_SYNC_MINUTES`，5–1440）。成功的结果存到数据目录 `feishu-directory.json`；同步失败继续用上次结果，重启后也先用它。管理员可查看 `GET /api/admin/directory`。
- **账号对应**：Muse 账号文件同时存着密码散列，数据站不能读。由 root 定时任务 `export-muse-feishu-links.py` 每 10 分钟导出一份只含用户名、账号 ID、停用标记和飞书 appId/open_id 的文件（root:muse-data-web 640），数据站每 5 分钟重读一次；第一次用飞书登录 Muse 的新成员约 15 分钟内能进数据站。只保留与登录应用同一 appId 的 open_id，停用账号不放行。

配置（三项必须同时设置）：

| 变量 | 内容 |
| --- | --- |
| `MUSE_DATA_FEISHU_APP_FILE` | 绝对路径，0600/0640，JSON 含 `appId`、`appSecret`；部署时由 root 从 Muse 飞书登录配置复制，不显示内容 |
| `MUSE_DATA_FEISHU_LINKS_FILE` | 绝对路径，导出脚本写出的账号对应文件 |
| `MUSE_DATA_ACCESS_DEPARTMENTS` | 逗号分隔的部门名称或 open_department_id，例如 `用户甲组` |

部署步骤（服务器上，以 root）：

```sh
install -m 640 -o root -g muse-data-web /var/lib/muse/accounts/feishu-login-20261026.json /srv/muse-data-web/access/feishu-app.json
install -m 755 -o root -g root app/deploy/export-muse-feishu-links.py /srv/muse-data-web/runtime/   # 来自仓库 deploy/
install -m 644 deploy/muse-data-feishu-links.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now muse-data-feishu-links.timer
# server.env 增加：
# MUSE_DATA_FEISHU_APP_FILE=/srv/muse-data-web/access/feishu-app.json
# MUSE_DATA_FEISHU_LINKS_FILE=/srv/muse-data-web/access/muse-feishu-links.json
# MUSE_DATA_ACCESS_DEPARTMENTS=用户甲组
```

注意：部门名称有重名（例如多个「AIGC」「编剧」），用名称时所有同名部门都会放行；需要精确时写 open_department_id。
