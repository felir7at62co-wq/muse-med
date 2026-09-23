---
description: "离线 muse-med 安装包所用的固定版本 Windows x64 FFmpeg 交叉构建、配套依赖源码与发布验收。"
---

# 自建 FFmpeg 与对应源码

[English](README.md) | 中文

## 概述

本目录拥有手动 [FFmpeg 工作流](../../../../.github/workflows/muse-ffmpeg.yml)，而不是桌面安装包。它从固定源码版本准备带 libx264、libass 与 zlib 的 GPLv3 Windows x64 FFmpeg/ffprobe，并将每个二进制 ZIP 与其源码归档配对。它不发布 release、不更新桌面媒体锁文件，也不在最终用户电脑上安装工具。本 checkout 尚无成功交叉构建或原生 smoke 结果记录；发布验收要求工作流实际成功运行。

## 目录

- [输入与工具](#inputs-and-tools)
- [构建与重建](#build-and-rebuild)
- [产物与发布交接](#artifacts-and-release-handoff)
- [验证与限制](#verification-and-limitations)
- [开发备注](#dev-note)

<a id="inputs-and-tools"></a>
## 输入与工具

[lock.json](lock.json) 固定 BtbN 构建脚本、FFmpeg 9.0.2 源码版本以及 Linux amd64 下载器／工具链容器摘要。选定的依赖根为 x264/libass/zlib；BtbN 解析其自身的传递依赖及固定源码版本。这不是 Gyan 二进制，也不包含它的全部功能。生成配置包含字体、iconv、XML 与字幕支持；不请求 BtbN 完整构建中无关的 GPU、AV1、x265 或网络库依赖。

固定版本的 Mingw 源码已用优先级为零的构造函数初始化栈保护 guard。构建配方将 BtbN 已过时的构造函数修改替换为对该优先级的精确断言；遇到非预期源码或构建脚本版本时会失败，而不会削弱栈保护。这项本地构建脚本调整包含在归档补丁中。

构建需要 Linux amd64、Python 3.11+、Bash、Git、带 buildx 的 Docker、访问固定公开仓库／镜像的网络，以及容纳镜像和源码缓存的临时磁盘空间。它不调用宿主包安装器。GitHub 专用 Ubuntu job 执行交叉编译；独立 Windows job 运行产出的 PE 二进制。源码下载阶段在归档前，按记录的 gitlink 版本递归初始化依赖子模块，包括 FreeType 的 dlg 源码。依赖编译和 FFmpeg 编译均在 Docker 禁网条件下运行；构建期间不补下载缺失源码。

<a id="build-and-rebuild"></a>
## 构建与重建

工作流仅手动触发，仓库权限只读。Linux 构建与 Windows smoke 两个 job 都必须通过。本地 Linux 入口如下；输出目录不得已存在。这些构建／重建命令需要远端验收，尚未在当前 Windows 开发主机上执行。

```sh
python3 -B apps/desktop/scripts/ffmpeg-source-build/build.py build /absolute/new-output
```

解压后的源码归档包含构建配方、完整 FFmpeg 源码、BtbN 脚本与本地补丁、生成的 Dockerfile、每个选定依赖的源码缓存及构建证据。源码离线重建使用这些文件，不抓取源码仓库。它仍需要 Docker 与记录的工具链镜像，Docker 可能按摘要下载镜像；源码归档不内嵌数 GB 的编译器镜像。

```sh
tar -xzf muse-ffmpeg-9.0.2-corresponding-source.tar.gz
python3 -B source/recipe/build.py build /absolute/new-output --sources source
```

<a id="artifacts-and-release-handoff"></a>
## 产物与发布交接

工作流产物包含四个文件：Windows 二进制 ZIP、对应源码 tarball、`build-manifest.json` 与 `SHA256SUMS`。manifest（元数据清单）绑定两个归档、两个可执行文件的哈希、源码缓存哈希与锁定输入；校验清单还覆盖 manifest 本身。源码证据包括 FFmpeg configure 输出、编译器版本、工具链和依赖镜像身份以及 Docker 版本。依赖版权／许可文件保留在源码缓存中，并复制到二进制 ZIP 的 `licenses/` 目录；无法识别的许可布局会让构建失败并要求审核。

只有两个工作流 job 都通过后，维护者才能用这份精确二进制 ZIP 及哈希替换桌面媒体锁文件中仅供开发验证的 FFmpeg 条目。必须一并保留运行时 ZIP 的 `ffmpeg/bin`、`LICENSE.txt`、`README.txt` 与 `licenses/`。在桌面 release 旁发布对应源码 tarball、manifest 与校验清单，并在分发该二进制期间保留它们。GitHub Actions 的 30 天产物保留不是源码分发。替换运行时后，重新执行桌面完整的已安装产物／离线媒体 smoke；本工作流不执行安装包集成。

<a id="verification-and-limitations"></a>
## 验证与限制

以下无密钥检查无需 Docker 或网络，可在本地运行，覆盖锁定输入验证、依赖输入选择、完整归档配对、二进制／manifest 篡改检测、缺失源码拒绝及安全复制依赖许可：

```sh
python -B apps/desktop/scripts/ffmpeg-source-build/test_build.py
```

原生 Windows smoke 验证配对哈希、GPL/x264/libass configure 标志、H264/AAC 输出、可见 SRT/ASS 字幕像素及 ffprobe。它使用系统字体与 ASCII 字幕；桌面发布仍需实际中文字体和渲染器 smoke。本工作流不承诺重建字节完全一致、第三方容器持续可用、法律合规或编解码专利许可。发布前审核记录的工具链、全部依赖许可声明及适用的分发条款；[GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) 与 [FFmpeg 许可页面](https://ffmpeg.org/legal.html)仅是起点，不是法律意见。

<a id="dev-note"></a>
## 开发备注

[源码配对决策](../../../../.agents/notes/implemented/process/2026-09-23-muse-ffmpeg-source-pairing.zh.md)说明独立构建与发布前置要求。
