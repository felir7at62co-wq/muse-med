---
kind: upgrade-guide
description: Muse Desktop 用内置本地运行时替代继承的红果源码和解释器路径。
---

# Muse 红果本地运行时

[English](guide.md) | 中文

## 变更

Muse Desktop 提供经过校验的 Java 17、CPython 3.11、PyCryptodome 及原签名和解密资源。桌面外壳用内置路径替代继承的 `MUSE_HONGGUO_LEGACY_APP_DIR`、`MUSE_HONGGUO_JAVA_PATH` 和 `MUSE_HONGGUO_PYTHON_PATH`，并启用 `bootstrapDevices`。首次使用由原生成器创建一份私有设备。Muse 在重启后保留该设备，并延迟启动带认证的本机签名器。现有独立 profile 保留显式配置。

插件 tarball 包含 Python 桥接脚本，不含本机运行时、原字节码、已保存设备和令牌。仅安装 tarball 不会提供 Desktop 运行时。

`maxEpisodes` 已删除。全集下载按原源声明的总集数执行，并要求完整连续的剧集目录。工具不再对原源、manifest、公开目录或选定集号另设集数上限。公开可访问性和文件验证仍然适用。

## 迁移

1. 安装配套 Muse Desktop 包，使用自动本地配置。选择内置签名器时，移除继承的 `MUSE_HONGGUO_SIGN_SERVER` 和 `MUSE_HONGGUO_SIGN_TOKEN`。仅在显式管理外部签名器时保留这些配置。
2. 独立 profile 保留原源码及兼容的媒体可执行文件。提供 `javaExecutable` 并省略 `signServer` 来启动受管签名器，或保留显式 `signServer` 和 `signTokenEnv` 来使用外部签名器。仅为包含锁定原 `devicepool.pyc` 的通用源码启用 `bootstrapDevices`；现有设备配置会保留。
3. 调用 `hongguo_download_info` 确认声明总集数。调用 `hongguo_download` 时传入多个 `seriesIds` 并省略 `episodes` 下载全集。确认每部请求剧集都有 `complete: true`、`fullDecodeChecked: true` 和最终清单。来源可用本身不代表成功下载。
4. 从独立配置中删除 `maxEpisodes`。此字段会作为未知字段被拒绝，无需替代配置。

时限及媒体要求见[插件配置](../../../../third_party/plugins/muse-hongguo-download/README.zh.md)。不可变源码被修改时会明确失败；Muse 不覆盖已保存设备或凭据。
