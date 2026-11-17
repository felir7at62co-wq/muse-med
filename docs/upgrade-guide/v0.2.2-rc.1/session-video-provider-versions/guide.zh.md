---
kind: upgrade-guide
description: "提供者视频检测现在返回所下载内容的版本。"
---

# 提供者视频检测返回内容版本

[English](guide.md) | 中文

## 变更

`sessionVideo.detect` 以前在下载视频后继续返回提供者 URL 版本。就绪结果现在标识所下载的内容，可能与请求中的 `remote-only` 版本不同。此前缓存的提供者版本播放地址不再有效。

## 迁移

1. 检测 `remote-only` 来源后，再次调用 `sessionVideo.list`，仅将结果与 `version` 等于结果 `sourceVersion` 的本地来源配对。
2. 如果本地来源不可用或版本不同，刷新清单并重新检测。确认播放和检测到的镜头使用相同版本。
