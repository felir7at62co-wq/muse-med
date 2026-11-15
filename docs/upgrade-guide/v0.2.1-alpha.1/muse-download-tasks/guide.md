---
kind: upgrade-guide
description: "Persistent platform downloads require owned job services, while background Douyin playback requires matching Desktop peers."
---
# Persistent Muse download tasks

English | [中文](guide.zh.md)

## Change

`muse-douyin-download` keeps download progress in Muse's private state directory and runs downloads through Session-owned jobs. Custom compositions that previously supplied only `agents`, `tools`, and `subprocess` must also supply the job registry, its controller, and the sandbox policy service. The plugin needs a writable absolute `settingsHome` for durable task state; `publicOnly` does not remove that requirement.

Lvpaopao series tasks also require owned job services. Their outer `seriesTask.id` is separate from the existing series manifest's `data.series.taskId` and each episode's original request key. Existing version-one manifests remain valid; they are not replaced or assigned new keys by the task registry.

Desktop Host protocol 8 adds task-owned browser downloads. An older Main process can ignore the new background flag, so protocol 7 and 8 peers cannot be mixed. The internal `douyinBrowser` service remains version 4 and separately advertises `supportsBackgroundDownload: true`; background requests reject a provider without that capability.

## Migration

1. Upgrade the Muse Desktop application and its bundled Host together. Source checkouts must rebuild with `pnpm run dev:desktop`; restarting an old application against new Host output does not upgrade its Main process.
2. For custom `dsh` profiles, load `@deepseek-ai/dsh-jobs-local`, `@deepseek-ai/dsh-tool-jobs`, and `@deepseek-ai/dsh-sandbox-policy`, or retain the shipped base bundle that provides them. Set `muse-douyin-download.config.settingsHome` to Muse's private state directory when the launcher does not supply `DSH_HOME`.
3. Existing `douyin_download` calls default to `mode: wait`. Use `mode: background` to return an accepted task receipt; pass `downloadTask.id` to `douyin_download_task` for status, cancellation, or explicit resume. Its durable ID is distinct from the current `jobId` and any native transfer ID.
4. Verify a task is visible through `douyin_download_task` and the Session's job controls. Restarted work remains interrupted until explicitly resumed; verified completed items are checked locally before another acquisition. Complete ordinary login or verification in Muse's workspace browser when requested, then resume the task.
5. For Lvpaopao, use `download_series.mode: background` and retain `data.seriesTask.id` for `series_status`, `series_resume`, or `series_cancel`. Keep the qualified, logged-in WeChat source available. Resume checks saved progress and reconciles uncertain episodes with their original keys; it cannot recover an unconfirmed native cleanup or obtain new sources while WeChat is closed.

See the [Douyin reference](../../../../third_party/plugins/muse-douyin-download/README.md) and [Lvpaopao reference](../../../../third_party/plugins/muse-lvpaopao/README.md) for task states, resource limits, and recovery behavior.
