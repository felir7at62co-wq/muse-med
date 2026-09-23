---
description: "收集固定的 PyAV Windows wheel 包源码，并查阅独立源码归档的发布要求。"
---

# PyAV wheel 包源码集合

[English](README.md) | 中文

## 概述

收集保留的 `av-18.1.0-cp311-abi3-win_amd64.whl` 的源码输入，包括其 FFmpeg 8.1.2 DLL 依赖。此操作仅处理源码，不重建或替换 wheel 包，不编辑桌面媒体锁文件，也不证明安装包合格。独立的 [FFmpeg 9.0.2 配方](../ffmpeg-source-build/README.zh.md)不能提供与此 wheel 包匹配的源码。

## 目录

- [收集与验证](#collect-and-verify)
- [分发要求](#distribution-requirements)
- [开发备注](#dev-note)

<a id="collect-and-verify"></a>
## 收集与验证

在此目录中使用 Python 3.11+，通过 HTTPS 收集时需要网络访问和受信任的 CA 证书库。Windows 验证主机使用标准 `SSL_CERT_FILE` 指向现有的 Mozilla CA 证书包；绝不能禁用 TLS 证书验证。生成的源码存放在仓库忽略的 `.artifacts` 目录中：

```sh
python build.py build ../../../../.artifacts/pyav-source-bundle
python build.py verify ../../../../.artifacts/pyav-source-bundle
```

源码集合收集固定的 PyAV 和 pyav-ffmpeg 仓库、`pkg.py` 声明的每个源码归档（仅解析 AST，绝不执行）、精确的 MSYS2 配方及其本地／外部补丁与原生源码，以及 certifi 2026.7.22 和 tqdm 4.70.1 的 sdist。SHA256 清单记录收集的文件。固定输入归脚本的锁文件所有，不改变桌面运行时选择。

输出包含 `source/`、`pyav-18.1.0-windows-vendor-sources.tar.gz`、`manifest.json` 和 `SHA256SUMS`。收集时仅在重新核对字节内容符合固定哈希后才复用缓存归档；不匹配时直接失败，不会静默替换缓存。

分发前必须通过完整的联网构建和验证；单元测试或部分下载不足以替代。发布维护者负责此项验证。完整收集及其内置字节校验已通过。

<a id="distribution-requirements"></a>
## 分发要求

保留 SHA256 为 `ea1480b7a8d5405cb5f382b344731bf125fd2c1c6fae3964f6c48595628387ff` 的 wheel 包。保留全部版权和许可声明，并在同一桌面版本发布中链接匹配的源码归档；临时构建产物不等于分发源码提供安排。

DLL 报告的 LGPL3 不能证明其完整许可：上游 `patches/ffmpeg.patch` 从 FFmpeg 的 GPL 列表中移除了 x264/x265，而实际随包提供的 x264/x265 代码采用 GPL。许可声明和分发审查必须考虑实际包含的代码，不能只依据报告的许可字符串。源码收集不提供法律保证、编解码器专利许可、逐字节一致的重建保证，也不能证明完整安装包已就绪。

<a id="dev-note"></a>
## 开发备注

[PyAV 源码集合决定](../../../../.agents/notes/implemented/process/2026-09-23-pyav-wheel-source-bundle.zh.md)记录上游证据，以及两套 FFmpeg 源码收集保持独立的原因。
