---
kind: upgrade-guide
description: "Legacy Jingliu subtitles are kept until the user chooses, jingliu_studio edit_subtitle edits text only, and batch transcription refuses unproven legacy receipts."
---

# Legacy subtitles become a user choice

English | [中文](guide.zh.md)

## Change

A Jingliu `auto_subtitles` segments job no longer deletes subtitle rows with no `origin`, which may have been added by hand: it refuses those shots as `legacy_subtitles` unless the payload sets `replace_legacy: true`, archives every replaced row Muse did not write in `subtitle_clip_archive`, and lists Muse cues that overlap hand-added subtitles as `manual_overlap` review items. A shot with spoken lines and only hand-added subtitles is now `missing`, and rows from Jingliu's own transcription are `unverified`.

`episode_subtitles` reports such episodes under `unverified` with an `ask` holding the question and the two calls, and suggests no `next`; it takes a new `replace_legacy` argument. `jianying_draft` refuses them with the same `ask` and takes a new `keep_legacy_subtitles` argument. A local build moves a hand-made or hand-edited `editing/NN.srt` to `NN.srt.manual-<stamp>` and names it in `manual_srt_kept`, and local drafts refuse an SRT whose script lines, names, decisions or rules changed with `changed_inputs`.

`jingliu_studio` `edit_subtitle` no longer accepts `duration` or `start_offset_sec`. A batch `audio_transcribe` `start` stops with `{input, error}` at a file whose only ended same-purpose receipt has no source digest, instead of starting a new billable version.

Callers that validate these tool schemas, replay recorded calls or relied on the old deletions are affected.

## Migration

1. When a result carries `ask`, put its `question` to the user and make the `keep` or `remake` call they choose.
2. Change subtitle times through `episode_subtitles`, and send only `text` to `edit_subtitle`.
3. For a batch that stops on a legacy receipt, read that receipt with `status`, or start that file alone to transcribe the current bytes again (charged).
