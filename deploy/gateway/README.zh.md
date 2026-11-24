# 从一个 main 提交发布账号网关

[English](README.md) | 中文

从 Muse `main` 的单个提交 S 发布账号与模型网关（云服务器上的 `muse-minimal-accounts.service`）。新发布版用 S 中的 [`services/muse-accounts`](../../services/muse-accounts/README.zh.md) 和 `integrations/localminidrama` 替换运行中发布版的这两个目录，其余内容沿用运行中的发布版。

在能通过 SSH 访问 Git 主机和服务器的任意机器上运行发布脚本。Git 命令只在 Git 主机上执行。每个脚本都接受短或完整提交 ID 作为 S，提交不是本地 `main` 或其祖先时拒绝执行；设置 `ALLOW_OFF_MAIN=1` 可以放宽该限制。

| 变量 | 含义 |
|---|---|
| `MUSE_RELEASE_GIT_HOST` | Git 主机的 SSH 目标，例如 `user@host` |
| `MUSE_RELEASE_GIT_REPO` | 本仓库在 Git 主机上的路径 |
| `MUSE_RELEASE_SERVER` | 云服务器的 SSH 目标，使用 root |
| `MUSE_GATEWAY_RELEASES` | 可选；服务器上的发布根目录，默认 `/opt/muse/platform/releases` |
| `MUSE_GATEWAY_OPS` | 可选；服务器上的运维根目录，默认 `/opt/muse/platform/operations` |
| `NPM_CONFIG_REGISTRY` | 可选；服务器上 `npm ci` 使用的 npm 源 |

`$OPS` = `<运维根目录>/gateway-main-<S 短 ID>`（仅 root 可访问），存放服务器脚本、日志、`prepared.json`、`diff.txt`、保存的 drop-in 和 `activation.json`。

## 步骤

| 步骤 | 命令 | 服务 |
|---|---|---|
| 0 | `./prepare.sh S --check-only` | 不变（只读） |
| 1 | `./prepare.sh S [--from=<发布名>]` | 不变 |
| 2 | 在服务器上阅读 `$OPS/diff.txt`：只应出现 S 要改动的文件 | 不变 |
| 3 | `./switch.sh S check` | 不变（只读） |
| 4 | 在空闲时段、通知云端转写负责人后运行 `./switch.sh S activate` | 停止并启动一次，通常不超过 15 秒 |
| 失败时 | `./switch.sh S rollback` | 停止并启动一次 |

每次网关重启都会影响所有 Muse 用户：把改动合并到一个发布版中，只重启一次。每一轮都记录在服务器的网关变更队列（`<运维根目录>/gateway-queue.md`）中。

## 各脚本的操作与影响范围

- **prepare.sh** 解析 S，把 `git archive S services/muse-accounts integrations/localminidrama` 经运行脚本的机器转发到服务器，并在两端校验 sha256，然后以临时单元 `muse-gateway-prepare-<短 ID>` 运行 `server/prepare-server.sh`：
  1. 基准为该单元正在运行的发布版（取自其 `WorkingDirectory`），或 `--from` 指定的发布版。
  2. 用 `cp -a` 把基准复制到 `<发布根目录>/<北京时间日期>-main-<短 ID>.partial`。这样会沿用共享的 `gateway/services/node_modules`、`gateway/deployment` 和 `gateway/third_party` 链接、`studio/`、`runtime/` 以及私有的 studio 配置，这些内容目前都不由本仓库构建。
  3. 用归档替换 `gateway/services/muse-accounts` 和 `gateway/integrations/localminidrama`，然后用 `npm ci --omit=dev --ignore-scripts` 安装网关锁定的依赖。
  4. 对这两个目录中的每个 `.mjs`、`.js` 和 `.cjs` 文件运行 `node --check`。
  5. `diff.txt`：按 sha256 列出相对基准变更、新增和删除的文件，不含 `node_modules`。
  6. 去掉目录名中的 `.partial`，`SOURCE_COMMIT` 记录 S，`prepared.json` 记录新发布版、基准和线上发布版。
  - 它从不改动服务单元、其 drop-in、`/etc` 或 `/var/lib` 下的配置，也不改动其他发布版。
- **switch.sh** 把服务器脚本复制到 `$OPS` 并运行 `server/switch.py`；`activate` 和 `rollback` 以临时单元运行，SSH 连接中断也不会让它们只做一半。
  - `check` 和 `activate` 要求该单元仍在运行 prepare 记录的线上发布版，否则拒绝执行。生效的 drop-in 是按文件名排序最后一个设置 `ExecStart` 的文件；它还必须设置 `WorkingDirectory`，并至少两次写出线上发布版路径。
  - `activate` 保存该 drop-in，把其中的线上发布版路径替换为新发布版，运行 `daemon-reload` 和 `systemctl restart --no-block`，25 秒后仍未停止的旧主进程会被结束；然后最多等待 150 秒，直到新主进程从新发布版运行，并且在该单元的 `MUSE_PORT` 上以其 `MUSE_PUBLIC_ORIGIN` 的主机名请求 `GET /login` 返回 200。失败时恢复 drop-in 并重启上一发布版。完成后写入 `activation.json`。
  - `rollback` 恢复保存的 drop-in 并重启上一发布版，健康检查相同。
  - 模型目录（`MUSE_MODEL_CONFIG`）、环境文件和密钥不属于发布版；作为单独的步骤修改并记录。

## 发布可能需要的配置

网关新功能在配置前保持关闭；[生产源码表](../../services/muse-accounts/README.zh.md#production-source)列出了相关设置及默认值。`activate` 之前，把该单元的环境文件与 S 中网关启动时会拒绝的设置对照：移除供应商直连后，`MUSE_DESKTOP_MODEL_TRANSPORT` 取 `relay` 以外的值，以及已退役的 `MUSE_ZHIPU_DIRECT_*` 和 `MUSE_USAGE_RATE_PER_MINUTE` 变量，都会阻止启动，`switch.py` 随后自动回滚。除非飞书登录配置把 `organizationSync` 设为 `false`，否则登录时会查询飞书部门；首次发布含此功能的版本前，确认飞书应用已开通并发布三项用户身份通讯录权限，或设为 `false`。环境文件和配置文件的修改与发布版放在同一次重启中，并记录这次修改。
