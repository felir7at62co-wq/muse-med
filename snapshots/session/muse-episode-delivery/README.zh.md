---
description: "通过已交付 Headless profile 和可控本地渲染器免 Key 验证整集受理与发布。"
kind: "reference"
---

# 已审批片段整集交付

[English](README.md) | 中文

本 authored 场景在已交付 Headless profile 中，通过普通 Loader 加载生产 Jubian 插件。原生 executor 调用仅供测试的 `snapshot_episode_delivery` 桥接工具，再由它调用实际整集服务的就绪检查、受理和定向状态方法。服务来自生产 Settings 入口的组合；夹具不替换服务，也不增加生产模型工具。

可控本地渲染器通过屏障延后完成。场景检查工作仍在等待时受理已返回、重复请求保留原任务身份，以及发布字节与所选候选一致。原生成账本必须保持不变。私有回环端点记录并拒绝提供方请求；夹具检查实际请求列表及 PUT 计数。工具结果与 `workspace.expected/episode-proof.json` 保存实际观测结果。

渲染器写入可控字节并提供夹具媒体事实。本场景不运行 FFmpeg，也不证明媒体解码、播放、试听、画面质量或 Windows 已验收。可变项目和账本文件保存在忽略的私有 `.dsh` 工作区内。`platform: posix` 标明重放通道；真实媒体及认证 Gateway 检查各有独立 owner。
