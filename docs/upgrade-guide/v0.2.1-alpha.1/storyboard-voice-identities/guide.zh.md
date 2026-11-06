---
kind: upgrade-guide
description: "分镜音频编辑对共享槽和已采纳的分期声线要求显式身份，不再接受旧式仅 URL 或仅资产引用。"
---

# 绑定分镜声线时保留角色身份

[English](guide.md) | 中文

## 变更

`jubian_storyboard audio_preview` 和新的 `audio_apply` 保存会拒绝省略本地身份字段的共享槽资产 ID 引用或匹配项目已采纳分期声线的引用。此前省略这些字段会选择旧式检查，绕过角色与人生时期比对。未分期的旧引用和无关的仅 URL 音频仍受支持；没有匹配的本地已采纳配置时，仅凭 URL 无法识别远端共享槽。已认领的旧 key 继续只读对账，不再次保存。会话代际与已有音频资产不变。

## 迁移

1. 在 `project_config.json` 的 `project_bible.characters[].voice_profiles[]` 中采纳已认可声线，填写精确的 `character_id`、`voice_period_id`、`reference_audio_asset_id` 和 `reference_audio` URL。使用 `drama_project` 预览和更新，保留其他项目数据。
2. 调用 `audio_preview` 时，在对应的 `audio_references` 行提供 `audio_asset_id`、`character_id` 和 `voice_period_id`。如果尚未采纳，修正本地项目配置；不要删除身份字段后重试。
3. 检查返回的预览，使用其原指纹和 key 调用 `audio_apply`。确认 `status=applied` 且 `verified_readback=true`；仅有保存回执并不代表确认成功。音频改动后重新 `prepare_video`。
