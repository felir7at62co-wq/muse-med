---
kind: upgrade-guide
description: "移除自动视频复用提示及其 existingVideoAdvisory 配置项。"
---

# 移除自动视频复用提示

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-jubian` 不再因新用户消息匹配视频或音频提取关键词而注入提示，`existingVideoAdvisory` 配置项移除。已有视频来源查询、分页证据与准备结果继续可用。已保存的 `jubian-video-reuse` 消息保留历史内容与来源归属。

## 迁移

1. 从 `cordis.yml` 或补丁中的工具插件配置删除 `existingVideoAdvisory`。
2. 保持已有会话文件不变。使用 `jubian_video sources` 查询既有媒体，不依赖自动提示。
3. 确认新的提取请求发往模型时，没有新增 `jubian-video-reuse` 提示。
