---
description: "部署并验证 Muse 使用的私有云端媒体服务。"
kind: "package-reference"
---

# DTK 部署

[English](README.md) | 中文

## 概述

将 DTK 部署为提供平台数据和媒体下载的私有云端服务。服务只监听本机回环地址，必须保留在 Muse 公司网关之后。上游源码、发布镜像和浏览器版本固定在 [upstream.json](upstream.json) 中。

## 部署

使用安装了 Docker Compose v2 的 Linux 主机，为下载媒体保留足够磁盘，并将固定的上游源码解压到 `/opt/muse/dtk/source-v5.1.10`。将已校验的源码归档保存在 `/opt/muse/dtk/source-v5.1.10.tar.gz`。镜像获取和浏览器镜像构建参照[上游部署指南](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/v5.1.10/documents/zh/02-installation.md)。

`python3 build-browser.py --source /opt/muse/dtk/source-v5.1.10 --apt-mirror https://mirrors.aliyun.com/debian` 在校验上游文件哈希后构建独立的浏览器 Dockerfile。可选镜像只改变 Debian 软件包下载位置，保留软件包签名检查。构建元数据记录生成文件的哈希；上游源码保持不变。

在本目录运行准备脚本和 Compose 命令：

```sh
python3 prepare.py --source /opt/muse/dtk/source-v5.1.10
sh compose.sh config --quiet
sh compose.sh up -d --wait --wait-timeout 240
python3 verify.py --source /opt/muse/dtk/source-v5.1.10
```

准备脚本以 `0600` 权限创建 `/etc/muse/dtk.env` 和 `/etc/muse/dtk-admin.json`；重复运行保留原有值。新配置默认使用回环地址的 `19580` 端口，不配置转写服务 URL。Compose 包装脚本选择 `browser` 和 `downloader` profile。原有私有文件会保留，验证脚本会独立检查运行中的配置。临时构建代理不能加入运行环境。

验证脚本只初始化一次私有管理员，将受限服务密钥保存在 `/etc/muse/dtk-service-key`，并向 `/opt/muse/dtk/receipts/deployment.json` 写入不含秘密的回执。脚本检查运行版本、镜像标识、数据库迁移、辅助服务健康、匿名拒绝和 MCP 工具清单，不请求平台内容。

验证脚本的所有 HTTP 请求都直接访问回环地址，不使用安装环境的代理。私有初始化之前，脚本会检查运行中容器的实际端口发布和转写配置。已发布端口必须绑定回环地址，API 必须把 `127.0.0.1:<port>` 发布到容器的 `8000/tcp` 端口；host 或共享网络模式、缺少观测值均会导致验证失败。API 和 worker 的转写配置必须关闭，不能有运行中的转写容器；创建受限密钥之前，已登录的 API 还必须明确报告转写未配置。

就绪阶段共用一个基于单调时钟的 120 秒预算，包含探测进程启动、响应头和正文、重试及等待。`--readiness-timeout <seconds>` 接受正且有限的秒数，只调整这一阶段的预算，不限制后续初始化和运行状态检查。操作系统创建和终止进程可能产生无法中断的额外耗时；探测进程的启动耗时会扣减其剩余等待时间，不会重新获得预算。超时的匿名探测进程会先被终止并回收，再开始下一次探测。

成功回执记录实际观测的 `publishedBindings`、`networkModes` 和 `transcriberRuntime`。`profiles` 字段已移除，因为运行中的容器不能证明启动时使用了哪些 Compose profile 参数；`images` 标识实际观测的服务。使用回执时应核对退出状态和新的 `verifiedAt` 时间。验证失败不会替换旧回执。

## 访问与恢复

管理员密码和服务密钥保留在服务器，不分发给员工客户端。上游媒体归档在同一实例内共享；Muse 公司网关负责员工授权、任务归属和限额。

使用 `sh compose.sh ps -a` 查看组件状态。重建容器时保留私有文件和 Docker 卷；删除其中任何一项都可能丢失访问能力或媒体。安装或重建镜像时可能需要运维人员提供网络代理。服务运行不需要安装时使用的电脑持续连接。

## 本地验证

在仓库根目录运行：

```sh
python3 -m unittest discover -s services/muse-media/deploy -p 'test_*.py' -v
```
