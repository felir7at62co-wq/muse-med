---
kind: upgrade-guide
description: "Muse Desktop no longer loads the local Douyin downloader; douyin_download now queues Douyin works on the data station, and douyin_download_task and douyin_data are removed."
---

# Douyin downloads move to the data station

English | [中文](guide.zh.md)

## Change

Previously, every Muse Desktop preset except Minimal loaded `muse-douyin-download`. Its `douyin_download` saved verified MP4 files into the Session workspace, `douyin_download_task` inspected, resumed or cancelled those local tasks, and `douyin_data` read page metrics and could download with `download: true`. `muse_media_download` also saved Douyin works to the company cloud.

Now no preset loads `muse-douyin-download`. `@deepseek-ai/dsh-muse-account` registers a deferred `douyin_download` when `douyinDownloadTool` is true, and the Desktop composition enables it. The tool uses the signed-in Muse account to queue one work or a whole series on the data station and returns public storage addresses; it writes no local file. Its arguments are `action` (`download`, `query` or `quota`), `url`, `aweme_id`, `mix_id` and `wait_seconds`; `urls`, `publicOnly` and `mode` are gone. `douyin_download_task` and `douyin_data` are no longer available in Desktop. `muse_media_download` returns `douyin-unsupported` for Douyin targets; TikTok and Bilibili are unchanged.

Saved Sessions and local task records remain on disk, but Desktop no longer resumes or cancels an unfinished local Douyin task. Prompts, skills and custom tool lists that name the removed tools no longer find them.

## Migration

1. Before upgrading, let unfinished local Douyin tasks finish, or note their links to submit again. Files already saved under `source/media/douyin/` stay in their workspaces.
2. Make sure each Muse user is on the data station's team list; the station returns `team-access-required` otherwise. The daily allowance is shared with the station's web page.
3. Replace `douyin_download_task` and `douyin_download` calls that used `urls`, `mode` or `publicOnly` with one `douyin_download` call per work or series, for example `{ "action": "download", "url": "<share link>", "wait_seconds": 60 }`, followed by `{ "action": "query", "aweme_id": "<id>" }` while works remain `preparing`.
4. Read Douyin page metrics with `muse_media_data` instead of `douyin_data`. Point Douyin `muse_media_download` calls at `douyin_download`.
5. A custom composition that still needs local Douyin files can load `muse-douyin-download` itself. Its `douyin_download` fails to register beside the account tool in the same scope and shadows it from an agent preset scope, so keep `douyinDownloadTool: false` in that composition.
6. Confirm with `{ "action": "quota" }`: a working setup returns `state: "ok"` with `enabled: true`.
