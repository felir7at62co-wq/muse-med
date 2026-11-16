---
kind: upgrade-guide
description: "Desktop 不再包含已退役的红果 Java 和 Python 运行时，番茄改用主 Python 运行时。"
---

# Desktop 共用主 Python 运行时

[English](guide.md) | 中文

## 变更

Desktop 安装包排除 `runtime/hongguo`，其中原有的旧下载器、Java、对应源码归档和第二套 Python 均不再随包分发。当前红果引擎使用 Node.js、FFmpeg 与独立 ByteVC2 辅助程序。番茄通过 `MUSE_FANQIE_PYTHON_PATH` 使用主 Python 中的 PyCryptodome。

已有用户视频、收据和设备文件保持不变。独立旧运行时的准备程序仍可使用，但当前 Desktop 启动要求更新后的主运行时，不会静默回退到已退役的运行时。

## 迁移

1. 安装版用户升级完整应用即可，无需迁移账号或视频。
2. 源码构建者在启动新应用前重新准备 Desktop 运行时。自定义 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 时，也须按当前共享锁文件重建，使分发版本表包含 `pycryptodome`。
3. 独立番茄配置将 `MUSE_FANQIE_PYTHON_PATH` 或 `pythonExecutable` 指向包含 PyCryptodome 的 Python。原有显式 Python 配置仍受支持。
4. 打包前验证已准备运行时的 Python/AES 检查及安装后红果引擎检查。主运行时缺少 PyCryptodome 时启动失败，不会改选无关解释器。
