---
description: "通过已交付 Headless profile，免 Key 验证原整集任务查找及离线回执恢复。"
kind: "reference"
---

# 原整集任务历史与恢复

[English](README.md) | 中文

本 authored 场景在已交付 Headless profile 中，通过普通 Loader 加载生产 Jubian Settings 组合。原生 executor 调用仅供测试的 `snapshot_episode_history` 桥接工具。可控本地渲染器先发布一集；夹具随后删除其源文件与交付回执，释放整个 Jubian 插件作用域，并在同一进程内挂载新的生产作用域。

新服务通过有界历史查找原任务及摘要，不检查就绪情况，也不把历史记录计作活动任务。桥接工具明确选择该条目、查询当前状态，再继续原任务以离线补回执。断言核对输出设备号和 inode 保持不变、渲染器仅调用一次、原生成账本不变，以及提供方请求为零。工具结果与 `workspace.expected/episode-history-proof.json` 保存这些事实。

可控渲染器提供夹具字节和媒体事实。本场景不运行 FFmpeg，也不证明 Host 进程重启、媒体解码、播放、试听、画面质量或 Windows 已验收。服务单元测试另行销毁整个 Context，并在不具有渲染器的新 Context 中检查历史查找。可变项目文件留在忽略的私有 `.dsh` 工作区中；本场景独立持有其规范 Session。
