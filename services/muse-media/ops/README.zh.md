---
description: "部署、验证并撤下按公司账号授权的 Muse 媒体网关。"
kind: "package-reference"
---

# 公司媒体服务运维

[English](README.md) | 中文

## 概述

将公司媒体网关与账号服务分开部署。网关使用现有账号会话、私有公司策略和只保存在服务端的 DTK 凭据。容器监听回环端口 `19581`；内部验证后，通过独立 Nginx include 开放 `/api/media/`。

## 私有部署输入

将审查过的公司策略保存在仅所有者可读的文件中。`prepare.py` 将该策略和 `/etc/muse/dtk-service-key` 复制到 `/etc/muse/media-gateway`，写入明确限额，并在 `/var/lib/muse-media` 创建可写状态目录。这些文件属于现有操作系统账号 `muse-gateway`。容器只读挂载整个 `/var/lib/muse/accounts` 目录，使账号文件被替换后仍可读到新内容。

```sh
python3 prepare.py --policy /etc/muse/company-media-policy.json --image muse-company-media:REVIEWED_INPUT_HASH
sh compose.sh config --quiet
sh compose.sh up -d --wait --wait-timeout 120
python3 verify.py
```

仅构建已审查的网关源码。`python3 bundle.py --archive PATH` 写入可重复的归档与逐文件哈希，排除凭据文件，并根据输入生成镜像标签。Compose 项目使用网关 Dockerfile 和已经部署的 DTK 基础镜像。不挂载账号服务的环境文件，不向客户端分发 DTK 密钥。

## 存储和公网启用

`python3 storage.py` 将上游归档上限设为 20 GiB、单文件上限设为 512 MiB。脚本记录原值和回读值，不打印管理员凭据。脚本不启用转写。

私有健康和鉴权检查通过后，审查当前站点文件的 SHA-256，只启用本服务的 include：

```sh
python3 nginx.py activate --expected-site-sha256 REVIEWED_SITE_SHA256
```

脚本核对审查过的哈希，执行 `nginx -t` 校验候选，只重载 Nginx。候选无效时恢复原站点文件，不重载。`nginx.py withdraw` 只移除本服务的 include，保留站点的其他修改；它同样要求重新审查当前站点哈希。这两项操作都不重启账号服务或 DTK。

## 验证与回滚

`verify.py --cookie-file PATH` 检查授权后的工具清单和调用人的任务、状态接口。Cookie 输入文件必须仅所有者可读，并且只包含一行 Cookie 请求头值。可选的 `--rate-check` 有界发送工具清单请求，直到该账号收到 HTTP 429；此操作会暂时消耗该账号的媒体请求额度。不请求内容采集或视频下载。

回执保存在 `/opt/muse/media-gateway/receipts/`，不包含 Cookie 或服务密钥。对故障候选运行 `sh compose.sh stop` 前先撤下 Nginx include；保留私有配置和 SQLite 状态，以便回滚或重新部署。

## 本地验证

在仓库根目录运行：

```sh
python3 -m unittest discover -s services/muse-media/ops -p 'test_*.py' -v
```

## 启动与复核保留期

部署前构建不可变网关镜像，并在禁用网络的容器中运行测试。原生导入器和媒体记录快照单独验证。在 `compose.env` 旁保存仅所有者可读的 `retention-qualification.json`，包含网关 `code_hash`、`passed: true`，以及名为 `gateway_runtime`、`retention_isolation`、`native_import`、`media_snapshot` 的通过检查，每项记录实际执行的正整数 `count`。资格记录必须描述已运行的检查，不能只是配置好的命令。

在不可变发布目录运行 `retention_prepare.py --image <reviewed-image>`。它拒绝重复初始化，生成一致的 SQLite 备份，保留原 Compose 环境，写入默认预演策略，确认独立 DTK 媒体清理已关闭，并只配置媒体网关环境。使用该发布的 `compose.yml` 仅重建网关，随后核对 schema 2、容器健康及成功的 `media_audits` 观察。账号服务保持运行。准备过程部分失败时，需要检查私有基线和环境备份；不能清空历史，也不能恢复已受理较新请求前的数据库。

服务器第一轮成功预演后运行 `retention_schedule.py --release <immutable-release-directory>`，安装持久化、单次执行的 systemd 复核，时间为初次观察后 24 小时再加十分钟。该服务调用 `retention_control.py promote`，先核对连续且匹配的观察、通过的资格检查及真实运行镜像，再发布批准并开启删除。预演不足、失败、变化或中断时保持预演；私有结果写入 `/opt/muse/media-gateway/receipts/retention-review.json`。定时器不是无条件开关，复核失败后不自动重试。可用 `retention_control.py review --output <private-report>` 只检查就绪情况，不启用。重启失败会把策略文件恢复为预演；重试前检查实际运行进程。

容器日志保留现有有上限的 JSON 日志策略。媒体服务不删除 journal、Nginx 日志、应用发布目录和 Docker 缓存。[主机存储报告](host_storage.py)独立列出占用，无法确认引用关系的版本目录需要运维审查后才能删除。部署命令不执行 Docker prune，也不递归删除应用发布目录。
