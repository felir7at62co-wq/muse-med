---
kind: upgrade-guide
description: Failed Hongguo downloads retain verified episodes and a recovery journal instead of deleting the request directory.
---

# Hongguo download recovery

English | [中文](guide.zh.md)

## Change

`hongguo_download` retains validated MP4 files and `resume-state.json` after failure, cancellation or unload. Scripts that assume a failed request leaves no files must account for retained recovery directories. Only a successful complete request writes `download-manifest.json`. Source media lookup uses the current video-tab API; existing private device configuration is retained.

## Migration

1. Keep the failed result's `checkpoint` and `resume` fields. Pass the `resume` arguments to `hongguo_download` to continue after checking the reported source failure. Do not immediately repeat exhausted source requests.
2. Use `retainedEpisodeCount` and `remainingEpisodeCount` for progress. Read each result episode's actual `path`; reused files can remain in earlier download directories.
3. Remove an abandoned recovery directory only when its retained videos are no longer needed. Standalone hosts provide `@deepseek-ai/dsh-atomic-write` matching the host version.
4. Confirm that a resumed request skips intact episodes, that changed files are downloaded again, and that only complete validated requests return `ok: true` with the requested coverage.
