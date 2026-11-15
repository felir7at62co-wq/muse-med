---
kind: upgrade-guide
description: "分镜创建拒绝调用方提供的素材绑定，须先由项目正式选材核验。"
---

# 先创建分镜，再选择素材

[English](guide.md) | 中文

## 变更

`jubian_storyboard` 的 `create` 和 `create_batch` 方法会在发送任何创建请求前，拒绝非空或格式错误的 `storyboardMaterialList` 与 `modelConfig.materialList` 字段。检查覆盖 JSON 编码的列表、`body_path` 文件，以及批内后续无效项。此前这些字段可以将未经核验的名称、身份和 URL 写入新卡。省略字段、null 和空数组仍可使用；创建仍强制 `isGenerate=0`。

显式 `select_assets` 现在按选定的正式记录刷新已有 `assetName` 与 `materialName` 名称字段，并保留无关的服务端字段。已有卡片不会自动修改。

## 迁移

1. 在每份新分镜请求体或 `body_path` JSON 文件中，省略两份素材列表或设为 `[]`。保留目标提示词和模型设置，不复制旧卡 ID 或其素材绑定。
2. 调用 `create` 或 `create_batch`，回读每个返回的分镜 ID，再以提示词中的有序 key 和同项目已确认的父资产 ID 调用 `select_assets`。上传音频通过 `audio_preview` 和 `audio_apply` 绑定。
3. 回读已存卡片，在 `prepare_video` 前核对身份、URL、名称和顺序。创建和选材不代表已授权生成视频；现有授权与提交检查仍适用。
4. 创建返回 `UNVERIFIED_STORYBOARD_MATERIALS` 时，先修正请求体再重试。本次单卡或整批调用均未发送创建 POST。若此前请求结果不明，沿用原幂等 key 对账，不另建卡片。
