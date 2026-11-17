---
kind: upgrade-guide
description: "红果下载 0.2.0 替换旧运行时配置，并移除 v2 健康检查工具。"
---

# 红果开源下载引擎

[English](guide.md) | 中文

## 变更

`muse-hongguo-download` 改为固定版本的 jackotom 引擎，默认 1080p，目录和下载工具名称保留。桌面预设不再选择旧 v1/v2 运行时目录、签名器或授权服务。移除 `hongguo_download_health`。ByteVC2 明确不支持。已有文件和进度保留，不同引擎或画质标识不复用。

## 迁移

1. 按[插件说明](../../../../third_party/plugins/muse-hongguo-download/README.zh.md)将自定义配置替换为 `quality`、`ffmpegExecutable` 和 `ffprobeExecutable`。移除 v2 运行时选择和签名配置；`legacyBackend: v2` 现在会在加载时报错。
2. 使用 `hongguo_download_info` 查询目录，使用 `hongguo_download` 取得真实分集验证与恢复回执。目录成功不等于下载成功。
3. 认定交付前核对返回路径、清晰度验证、哈希和 `complete`。旧文件保留待人工审查。
