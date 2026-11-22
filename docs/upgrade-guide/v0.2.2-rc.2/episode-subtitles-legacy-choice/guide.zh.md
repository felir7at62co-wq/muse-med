---
kind: upgrade-guide
description: "镜流里来源不明的旧字幕改由用户决定是否替换，jingliu_studio 的 edit_subtitle 只改文字，批量转写遇到无法证明来源的旧收据时拒绝。"
---

# 旧字幕改由用户决定

[English](guide.md) | 中文

## 变更

镜流 `auto_subtitles` 的 segments 任务不再删除 `origin` 为空的字幕行（可能是用户手加的）：除非 payload 带 `replace_legacy: true`，这些镜头被拒为 `legacy_subtitles`；被替换的、不是 Muse 写的行先存进 `subtitle_clip_archive`；与手加字幕时间重叠的 Muse 字幕列为待核项 `manual_overlap`。有台词却只有手加字幕的镜头现在是 `missing`，镜流自己转写的行是 `unverified`。

`episode_subtitles` 把这样的集列在 `unverified` 下，附带写着问题和两种调用的 `ask`，不给 `next`；新增参数 `replace_legacy`。`jianying_draft` 以同样的 `ask` 拒绝这些集，新增参数 `keep_legacy_subtitles`。本机 build 会把手做或手改过的 `editing/NN.srt` 移到 `NN.srt.manual-<时间>`，并在 `manual_srt_kept` 写出；本机草稿遇到台词、人名、选择或规则已变的 SRT 时，以 `changed_inputs` 拒绝。

`jingliu_studio` 的 `edit_subtitle` 不再接受 `duration` 和 `start_offset_sec`。批量 `audio_transcribe` `start` 遇到只有同用途已结束、却没有源文件摘要的旧收据的文件时，以 `{input, error}` 停下，不再新建计费版本。

校验这些工具 schema、回放已录制调用或依赖原先删除行为的调用方受影响。

## 迁移

1. 结果带 `ask` 时，把其中的 `question` 问用户，按用户的选择调用 `keep` 或 `remake`。
2. 字幕时间通过 `episode_subtitles` 修改，`edit_subtitle` 只传 `text`。
3. 批次在旧收据处停下时，用 `status` 读取该收据，或对这个文件单独 start，重新转写当前字节（会计费）。
