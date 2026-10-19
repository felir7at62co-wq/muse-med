---
kind: upgrade-guide
description: 剧变 generate 调用改为先准备原生预览再付费提交，不再走旧的直接生成路径。
---

# generate 使用原生视频流程

[English](guide.md) | 中文

## 变更

`jubian_storyboard generate` 调用方不再从已保存的卡片直接提交新的付费请求。新调用没有 `preview_path` 时，必须提供 `storyboard_id` 和已绑定的 `project_dir`；它执行免费的 `prepare_video`，返回真实预览和指纹。可选 `content_duration_ms` 仅按原生规则交叉核对已保存时长。独立的 4–14 秒、9:16 和 720p 限制不再适用。

提供 `preview_path` 的调用是 `submit_video` 的兼容别名，保留原 fingerprint key、预算、任务证据、素材身份和会话选择校验。启用会话选择时，以其模型和分辨率为准；同步保留已存比例、提示词、素材和时长。分镜删除检查以及拒绝活动生成任务的规则继续有效。

原 key 已在账本记为 `storyboard_generate` 时，只返回已保存的账本事实，不重投，也不声称重新核验过远端。只需 `method: generate` 和原 `idempotency_key`，无需分镜、时长或项目参数。未知结果在完成对账前保持未解决，不授权换 key。

## 迁移

1. 新请求调用 `prepare_video`，或保留 `generate` 并提供 `storyboard_id` 与含有正确 `project_config.json` 的 `project_dir`。保留 `generate` 时确认 `canonical_method: prepare_video`；检查实际返回的预览、所选设置、素材和时长。确认准备没有创建生成任务或收费；免费的会话模型同步可用 `isGenerate=0` 保存原卡。
2. 用已检查的 `preview_path` 和返回的 `idempotencyKey`（原预览指纹）作为 `idempotency_key`，调用 `submit_video` 或 `generate`。不要换成任意 key 或绕开原生检查。报告生成已提交前，核实返回的任务证据。
3. 保留原 key 与回执。对于已记录的 `storyboard_generate` key，以同一 key 调用 `generate`，确认 `canonical_method: legacy_generate_replay` 并检查账本结果；不得再次发出生成请求。`outcome: unknown`、超时或缺少任务证据，都不授权创建新 key。提交和对账判定见[原生视频参考](../../../../packages/jubian/tool-jubian/README.zh.md)。
