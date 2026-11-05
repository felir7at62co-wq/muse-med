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

准备脚本以 `0600` 权限创建 `/etc/muse/dtk.env` 和 `/etc/muse/dtk-admin.json`；重复运行保留原有值。默认端口为 `19580`。启用 `browser` 和 `downloader` profile；关闭转写。临时构建代理不能加入运行环境。

验证脚本只初始化一次私有管理员，将受限服务密钥保存在 `/etc/muse/dtk-service-key`，并向 `/opt/muse/dtk/receipts/deployment.json` 写入不含秘密的回执。脚本检查运行版本、镜像标识、数据库迁移、辅助服务健康、匿名拒绝和 MCP 工具清单，不请求平台内容。

## 访问与恢复

管理员密码和服务密钥保留在服务器，不分发给员工客户端。上游媒体归档在同一实例内共享；Muse 公司网关负责员工授权、任务归属和限额。

使用 `sh compose.sh ps -a` 查看组件状态。重建容器时保留私有文件和 Docker 卷；删除其中任何一项都可能丢失访问能力或媒体。安装或重建镜像时可能需要运维人员提供网络代理。服务运行不需要安装时使用的电脑持续连接。

## 本地验证

在仓库根目录运行：

```sh
python3 -m unittest discover -s services/muse-media/deploy -p 'test_*.py' -v
```
