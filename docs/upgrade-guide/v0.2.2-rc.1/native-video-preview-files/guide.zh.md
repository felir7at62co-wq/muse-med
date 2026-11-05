---
kind: upgrade-guide
description: 新的原生视频提交要求使用原始普通预览 JSON 文件，不再接受最终文件入口是符号链接。
---

# 使用普通原生视频预览文件

[English](guide.md) | 中文

## 变更

`jubian_storyboard` 通过 `submit_video` 或 `submit_video_batch` 发起新提交时，不再跟随最终预览文件入口的符号链接。预览必须是绑定项目 `video_tasks` 目录中的普通 JSON 文件。旧实现可以跟随这类链接。祖先目录别名经 `realpath` 解析为同一项目时仍受支持，并非禁止所有包含符号链接的路径。

## 迁移

1. 对尚未提交的预览，使用 `prepare_video` 返回的 `preview_path` 所指向的原始普通 JSON 文件，该文件应在项目 `video_tasks` 目录中。保留这份预览原来的 `idempotency_key`；不要复制预览并改用其他 key 绕过文件检查。
2. 如果原 key 已有记录的提交意图，保留其预览与账本记录，使用同一 key 调用 `jubian_storyboard(method="reconcile_video", project_dir, idempotency_key)`。该方法只读取已有提交，不会新增意图或发送生成 PUT。旧证据缺失时保持未确认，不代表允许新 key 或再次计费。
3. 确认选择的是原始普通文件，且 key 没有改变。对已有记录的请求，核对只读恢复返回已有任务或未确认结果；不要通过发起新提交验证迁移。参见[原 key 恢复](../../../../packages/jubian/tool-jubian/README.zh.md#original-key-video-recovery)。
