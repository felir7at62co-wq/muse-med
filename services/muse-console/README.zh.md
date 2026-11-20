---
description: "部署并验证给管理员用的只读 Muse 管理台：任务、生成记录和服务状态。"
kind: "package-reference"
---

# Muse console

[English](README.md) | 中文

## Summary

Muse 管理台是一个单独部署的只读网页服务，挂在 Muse 主站的 `/console` 下，只给管理员看。它只补现有页面没有的两块：每次模型调用的估算花费，和公司各服务的运行状态；任务（`/workbench`）、账号（`/admin`）、用量（`/admin/usage`）和意见（`/feedback`）用主站现有页面，从同一个导航进入。它不持有网关凭据、供应商密钥，也不保存任何对话内容。

## Pages

- `/console` 直接跳到生成记录。
- **生成记录**（`/console/records`）：按北京时间整天算的今天、7 天、30 天合计；按人、按部门的花费；每次模型调用一行，含线路、结果、token 数、耗时和估算花费；可按部门、人、线路、模型、状态筛选；可导出最多 10,000 行 CSV。导出的单元格如果像表格公式开头，会在前面加 `'`。
- **服务**（`/console/services`）：每个配置的服务在 systemd 里的状态、启动时间、重启次数和发布版本，以及最近 24 小时每条模型线路的调用量、失败率和平均耗时。

## Access

管理台把访问者自己的 `__Host-muse` 登录 Cookie 转给本机的账号网关。`/api/muse/profile` 确认是谁；`/api/workbench?scope=organization` 返回 `administrator: true` 才能进管理台。没登录返回 401 并给出登录链接；其他账号返回 403。网关出错返回 502，不会退回更宽松的检查。每个登录的结果缓存 30 秒。暂不支持部门负责人，因为网关没有把部门成员关系保存到进程之外。

## Data

`export.mjs` 由网关的服务账号运行，每分钟一次。它以只读方式打开网关的 `requests.sqlite`，把同样的元数据列写进 `export.sqlite`；每次重读最近 30 分钟，让已结束的请求覆盖进行中的旧记录；另外维护一张按天、按账号、线路和模型汇总的表，用来算区间合计。数据保留 120 天。目标库用回滚日志模式、权限 0640、属组 `muse-console`，管理台只读打开。第一次运行会复制全部历史：285 万行约 3.5 分钟、760 MB。

估算花费按版本化的价目表（`MUSE_CONSOLE_PRICES_FILE`）逐线路、逐模型计算：未命中缓存的输入、命中缓存的输入、输出，单位为元/百万 token。没有对应价格的调用记为「未定价」，不按 0 算。估算不是供应商账单。

## Configuration

所有变量见 `deploy/console.example.env`。`MUSE_CONSOLE_GATEWAY_ORIGIN` 必须是纯本机 HTTP 地址。`MUSE_CONSOLE_SERVICES_FILE` 列出 `{id, name, unit, release?}`；`release` 是一个符号链接，它指向的目录名就是运行中的版本。配置不合法时进程启动即退出。

## Deployment

1. 建系统账号和组 `muse-console`；建 `/var/lib/muse-console/export`，属主 `muse-gateway:muse-console`，权限 2750；把本目录复制到 `/opt/muse/console/` 下的一个发布目录，并让 `current` 指向它。
2. 环境变量文件放在 `/etc/muse/console.env`（由 systemd 读取）；价目表和服务清单放在 `/etc/muse-console/`，属主 `root:muse-console`，目录 0750、文件 0640；再安装 `deploy/` 里的 systemd 单元。管理台账号进不了 `/etc/muse`。
3. 先手动跑一次 `muse-console-export.service`，等第一次复制完成；再启用 `muse-console-export.timer`，启动 `muse-console.service`。
4. 把 `deploy/nginx-console.conf` 放进主站 TLS server 块、兜底 location 之前，检查配置后重载 nginx。
5. 验证 `/console/healthz` 返回 `ok`、未登录访问返回 401、管理员能看到三个页面。

回滚：删掉 nginx 里这两段 location，停掉管理台和定时任务；不碰网关。管理台收到 SIGTERM 后 10 秒内退出。

## Tests

在本目录用 Node 22.12 或更高版本运行 `node --test`。
