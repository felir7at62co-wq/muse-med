---
kind: upgrade-guide
description: "红果 v2 下载使用独立收据，原始传输字段可以为 null。"
---

# 红果 v2 下载收据

[English](guide.md) | 中文

## 变更

将 `muse-hongguo-download` 配置为 `legacyBackend: v2` 的调用方会收到 `origin: engine-output`。原版引擎输出已解码文件，下载器无法独立核实原始传输信息，因此 `sourceBytes`、`sourceSha256` 和 `encryptedSource` 为 `null`。最终的 `bytes`、`sha256` 和 `fullDecodeChecked` 仍描述已验证的本地 MP4。已有 v1 配置和收据含义不变。

V2 断点使用独立版本和运行时标识，不复用 v1 断点，也不会将不完整剧集标为全集成功。

## 迁移

1. 按[插件说明](../../../../third_party/plugins/muse-hongguo-download/README.zh.md)准备本地运行时和私有设备状态，同时配置 `legacyBackend: v2`、`v2RuntimeDir` 和 `v2StateDir`。运行时缺失或无效时明确失败，不自动切换来源。
2. 收据消费者应使用最终 `bytes` 和 `sha256` 验证本地文件。当 `origin` 为 `engine-output` 时，接受原始传输字段为空；不要用零替代未知值，也不要据此推断源文件是否加密。
3. 先下载指定单集，检查其路径、最终哈希及 `fullDecodeChecked`。下载全集时，还需确认 `complete: true` 且声明集数与下载集数一致。原有收据和已验证视频应保留到正常保留策略允许清理为止。
