---
kind: upgrade-guide
description: "Muse 番茄工具默认直连，不再默认使用环境变量或操作系统发现的代理。"
---

# Muse 番茄连接模式

[English](guide.md) | 中文

## 变更

Muse 番茄工具默认使用 `networkMode: direct`。此前版本继承 Python urllib 的代理发现行为，包括 macOS 系统代理。网络需要代理的用户须显式选择 `networkMode: system`。此配置仅影响番茄引擎，不修改电脑的代理设置。两种模式均不会关闭 TLS 验证，也不会自动通过另一模式重试。

Muse 会收到失败的请求阶段、目标主机、所选模式和安全错误详情。诊断字段和下载收据见[番茄包参考](../../../../third_party/plugins/muse-fanqie-download/README.zh.md)。

## 迁移

1. 直接访问时保留默认值。需要保留代理发现时，将以下行添加到在番茄 bundle 行之后应用的 Cordis 补丁中。先将 `MUSE_FANQIE_PYTHON_PATH` 或 `MUSE_HONGGUO_PYTHON_PATH` 设为既有 Python 可执行文件路径。

   ```yaml
   - id: muse-fanqie-download
     config:
       pythonExecutable: !!js process.env.MUSE_FANQIE_PYTHON_PATH || process.env.MUSE_HONGGUO_PYTHON_PATH || ''
       networkMode: system
   ```

2. 在映射中保留自定义运行时路径和限制：行补丁会替换完整 `config`。应用补丁后重启配置。无效网络模式无法通过配置验证。
3. 运行 `fanqie_search` 并匹配目标书名及作者，然后使用 `fanqie_download_info` 检查其目录。失败时会标明阶段和模式。验证下载时，运行 `fanqie_download`，确认声明及已下载章节计数、逐章收据、TXT 文件及其 SHA-256。目录检查成功本身不能证明整书已下载。
