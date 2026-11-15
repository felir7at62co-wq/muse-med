---
kind: upgrade-guide
description: "视频复核消费方保留等待注册后的领域读取函数，代码组合的 Muse 工具须等待启动。"
---
# 在插件启动时保留视频复核读取函数

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-video-inspect` 消费方不再按 key 从投影注册表读取复核状态。`videoReviewSummaries` 的首个参数现在是 `VideoReviewReader`，`readVideoSourceTimeline` 的最后一个参数也是该读取函数。它保留等待注册后的私有投影，并在消费方的生命周期内持续读取同一份 Session 事件。

通过代码调用 `tool-video-inspect`、`screenplay-project` 和 `tool-shot-script` 的 `apply` 现在是异步操作。Loader 管理的组合已等待插件启动。`screenplay-project` 另需 `agents` 服务以读取当前轮次边界。

## 迁移

1. 在消费插件启动时，从 `@deepseek-ai/dsh-tool-video-inspect` 调用 `const reader = await createVideoReviewReader(ctx)`。先挂载 `sessionProjections`，再启动消费方，并将读取函数保留在消费方闭包中。
2. 将调用改为 `videoReviewSummaries(reader, session)` 和 `readVideoSourceTimeline(ctx, session, id, options, signal, reader)`。证据仍通过普通有日志的上下文或工具结果返回。
3. 直接组合上述三个包时，在调用工具前等待 `apply(ctx, config)`。自定义剧本组合须挂载 `agents`；自定义 PTC 组合须在真实文件系统提供方之上挂载 `workingDirectory`。
4. 验证其他插件注册卸载后仍可读取已记录复核，并验证来源版本改变后仍拒绝过期证据。已有 Session 日志和剧本文件无需修改。
