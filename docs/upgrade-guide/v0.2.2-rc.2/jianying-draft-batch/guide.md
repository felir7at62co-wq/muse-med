---
kind: upgrade-guide
description: "jianying_draft no longer requires request_file and drafts_dir; it adds a batch form keyed by episodes."
---

# `jianying_draft` gains a batch form

English | [中文](guide.zh.md)

## Change

The `jianying_draft` tool schema used to require `request_file` and `drafts_dir`. Both are now optional: `drafts_dir` defaults to the root saved by `drama_draft_dir`, and a call names either `request_file` (one episode, as before) or `source`, `project` and `episodes` (the batch form), never both. The batch form reads the version 2 clock receipt that `episode_subtitles` writes and returns `created`, `existing`, `refused`, `needs_review`, `music_missing` and `not_started` instead of the single-episode result. Request files gain optional `ending` and `watermark` booleans; `false` removes that element.

Callers that validate the tool schema, replay recorded calls or pass both forms are affected.

## Migration

1. Keep existing single-episode calls as they are; they still return the generator result. A call without `drafts_dir` now needs a saved draft root, set with `drama_draft_dir`.
2. For several local episodes, run `episode_subtitles` until it reports `ready`, then call `jianying_draft` with `source: "local"`, `project` and `episodes`.
3. Confirm with a repeated batch call: an unchanged episode returns `existing`, and an episode whose shots changed returns `subtitles_stale` with `changed_shots`.
