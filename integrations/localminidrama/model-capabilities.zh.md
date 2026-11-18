---
kind: reference
description: "Muse 单个制作包的视频模型文档限长及显式配置能力。"
---

# 模型能力

[English](model-capabilities.md) | 中文

每个制作包拥有自己的提示词、目标镜头时长和生成历史。一集包含有序的多个包，整集总时长独立于供应商单次请求的限制。

官方方舟来源、火山协议和明确 Seedance 2.5 模型的公开配置摘要包含 4–30 秒范围及默认 720p。适配器保留请求的 20 秒镜头，支持供应商的 `-1` 自动时长，并在请求前拒绝无效显式时长。首尾帧生成使用供应商要求的自适应比例。规则依据[官方任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)；配置检查不证明实际模型访问已验证。

不会推测不透明部署 ID 的限长。其 AI 配置 `settings` 可明确包含 `muse_model_capabilities: {"ep-example": {"profile": "seedance-2.5"}}`，或逐模型设置 `max_duration_seconds` 与 `default_resolution`。配置值标为配置来源；未知限长保持 null。公开摘要不包含凭据或任意设置。

查询视频任务时，只把真实供应商 token 字段存到原生成记录所属的操作，包括恢复查询。重复轮询更新同一资源的用量记录。缺失字段保持未知，保存失败可见，不会因此提交新生成或丢弃已完成视频。
