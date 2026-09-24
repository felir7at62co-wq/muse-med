---
description: "收集固定的 BGM 原生库对应源码，并查阅源码归档的发布要求。"
---

# BGM 原生源码集合

[English](README.md) | 中文

## 概述

收集 BGM 情感运行时链接或内嵌的原生库对应源码：libsndfile 1.2.0 及其 DLL 中静态链接的编解码库（reference libFLAC 1.3.4、libogg 1.3.5、libVorbis 1.3.7、libopus 1.3.1、LAME 3.100、libmpg123 1.29.3）、内嵌 libsoxr 0.1.3 并静态链接进 `soxr_ext.pyd` 的 soxr 1.1.0 源码分发包、python-soundfile 打包配方及产出该 DLL 的归档，以及作为 GPL-2 TimGM6mb SoundFont 分发形式的 pretty_midi 0.2.10。此操作仅处理源码，不重建或替换任何 wheel 包，不编辑 BGM 运行时锁文件，也不证明安装包合格。[PyAV wheel 包源码集合](../pyav-source-bundle/README.zh.md)是媒体负载 PyAV wheel 包的独立集合，两者不可互相替代。

## 目录

- [收集与验证](#collect-and-verify)
- [分发要求](#distribution-requirements)
- [开发备注](#dev-note)

<a id="collect-and-verify"></a>
## 收集与验证

在此目录中使用 Python 3.11+；当某个组件必须下载时，需要网络访问和受信任的 CA 证书库。绝不能禁用 TLS 证书验证。生成的源码存放在仓库忽略的 `.artifacts` 目录中：

```sh
python build.py build ../../../../.artifacts/bgm-source-bundle
python build.py verify ../../../../.artifacts/bgm-source-bundle
python -m unittest test_build
```

锁文件按官方 HTTPS 地址、字节大小和 SHA-256 固定十二个归档。收集时若 `.local/bgmprep/compliance/sources` 中已有留存副本，就从该处取用，并在复用前重新核对大小与 SHA-256；仅在没有留存副本时才从固定地址下载。留存副本校验不通过会中止构建，不会静默替换。`--inputs` 可指定其他留存目录，不给则全部下载。mpg123 条目还记录了随包 DLL 内嵌的 vcpkg 构建树路径，SHA-512 前缀与该路径不符的归档会被拒绝。

输出包含 `source/`、`muse-bgm-native-corresponding-source.tar.gz`、`manifest.json` 和 `SHA256SUMS`。归档内容为未经改动的各上游源码、这些归档内部找到的许可文本，以及本配方。分发前必须通过完整收集及其内置字节校验；单元测试或部分下载不足以替代，发布维护者负责此项验证。

<a id="distribution-requirements"></a>
## 分发要求

在同一桌面版本发布中链接匹配的源码归档，并保证该链接中的组件版本与随包库一致。LGPL-2.1 适用于 libsndfile 1.2.0、LAME 3.100 和 libmpg123 1.29.3，LGPL-2.1-or-later 适用于 libsoxr 0.1.3；pretty_midi 0.2.10 随包提供的 TimGM6mb SoundFont 采用 GPL-2，pretty_midi 自身的 MIT 标注只覆盖其代码。已记录的局限：随包 DLL 不含 libogg 版本字符串，其 1.3.5 未经验证；libmpg123 没有版本横幅，其版本依据 DLL 中的构建树路径以及 vcpkg 对该归档自身的固定值；DLL 配方的 workflow 使用运行器镜像预装的 vcpkg，因此 vcpkg 基线不由该归档固定；锁定的 pretty_midi sdist 自身不含许可文件。

源码收集不提供法律结论、许可确认、编解码器专利立场或逐字节一致的重建保证。收集期间没有重新编译任何 wheel 包，也没有检查任何已构建负载。

<a id="dev-note"></a>
## 开发备注

[PyAV 源码集合决定](../../../../.agents/notes/implemented/process/2026-09-23-pyav-wheel-source-bundle.zh.md)记录了 wheel 包自身的源码分发包为何不等于其匹配源码；本配方沿用相同的锁文件、归档与校验约定。
