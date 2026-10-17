---
kind: upgrade-guide
description: "内置旧创作指南、总控、资产提取和镜头创作技能不再提供名称调用和随包资源路径。"
---
# 创作技能移除

[English](guide.md) | 中文

## 变更

Muse 不再内置或展示 `jubian-asset-library`、`muse-creation`、`tweet-drama-pipeline`、`tweet-drama-asset-extract`、`shot-script-creator-9-16`、`shot-script-creator-16-9-3d` 和 `tweet-drama-early-shot-script`，指向这些技能的显式调用和随包资源路径不再可用。Muse 产品预设也不再注册 drama_shot。资产生成与视觉审核继续提供，现有项目资产、脚本和清单不变；编译器包保留用于旧格式兼容测试。

## 迁移

1. 从自定义提示词和脚本中删除这些技能名称的调用及其随包目录引用。编辑任务按实际需要选择仍在维护的 muse-script-editing、muse-script-doctor 或 screenplay-format 技能。
2. 在项目要求中描述资产与镜头创作需求，使用现有生成工具和视觉审核技能处理资产，通过原生分镜 prepare_video 预览，再用 submit_video 或 submit_video_batch 提交视频包。
3. 新建会话，确认技能目录不再列出被移除的名称，工具列表不再包含 drama_shot，视觉审核与原生视频工具仍在。
