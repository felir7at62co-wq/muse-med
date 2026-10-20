---
kind: upgrade-guide
description: 红果下载失败后保留已验证视频及进度收据，不再删除整个请求目录。
---

# 红果续下载

[English](guide.md) | 中文

## 变更

`hongguo_download` 在失败、取消或卸载后保留已验证 MP4 和 `resume-state.json`。假定失败后没有文件的脚本需要处理保留的续下载目录。只有完整请求成功后才写入 `download-manifest.json`。媒体查询使用当前 video-tab 接口；原有私有设备配置保持不变。

## 迁移

1. 保留失败结果的 `checkpoint` 和 `resume` 字段。核对来源错误后，将 `resume` 参数传回 `hongguo_download` 继续；不要立即重复已用尽重试的来源请求。
2. 使用 `retainedEpisodeCount` 和 `remainingEpisodeCount` 展示进度。读取结果中每集的真实 `path`；复用文件可能保留在早先的下载目录。
3. 只有不再需要其中的视频时，才删除放弃的续下载目录。独立宿主需提供与宿主版本匹配的 `@deepseek-ai/dsh-atomic-write`。
4. 确认续下载跳过完整文件、变化文件重新下载，且只有请求范围内全部视频通过验证后返回 `ok: true`。
