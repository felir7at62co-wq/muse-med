---
kind: upgrade-guide
description: "Muse 改为通过欢畅通道初始化新的视频选择，不再默认使用方舟。"
---

# Muse 默认视频通道

[English](guide.md) | 中文

## 变更

Muse Desktop 配置的 `defaultVideoModel` 从 `FANG_ZHOU` 通道的 `doubao-seedance-2-5-260628` 改为 `FZ_HUAN_CHANG` 通道的 `doubao-seedance-2.5`，仍为 480p。此变更只影响未保存视频选择的会话。已有明确选择、项目默认值和已提交任务保留原身份。

账号实时目录必须提供新组合。默认组合不可用时明确报错，Muse 不会静默选择其他通道。

## 迁移

1. 更新 Muse 并登录剧变。自定义 Desktop 覆盖配置若设置了 `defaultVideoModel`，仍使用自己的配置；需要相同默认值时，明确修改此字段。
2. 已有会话若仍使用方舟，打开视频模型菜单，选择 `FZ_HUAN_CHANG` 下的 Seedance 2.5，按需选择 480p 或 720p。此选择影响后续生成，不改动已提交任务。
3. 读取会话视频设置，核对通道、模型和分辨率。读到目录不代表生成成功；宣布可交付前，仍需另行核对费用及已完成任务。
