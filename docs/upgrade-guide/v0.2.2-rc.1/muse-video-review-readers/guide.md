---
kind: upgrade-guide
description: "Video review consumers retain an awaited domain reader and programmatic Muse tool compositions await startup."
---
# Retain video review readers during plugin startup

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-video-inspect` consumers no longer read review state through the projection registry by key. `videoReviewSummaries` now receives a `VideoReviewReader` as its first argument, and `readVideoSourceTimeline` receives it as its final argument. The reader retains an awaited private projection registration and keeps reading the same Session events throughout the consumer's lifetime.

Programmatic `apply` calls for `tool-video-inspect`, `screenplay-project`, and `tool-shot-script` are asynchronous. Loader-managed compositions already await plugin startup. `screenplay-project` also requires the `agents` service to read the current turn boundary.

## Migration

1. In the consuming plugin's startup, call `const reader = await createVideoReviewReader(ctx)` from `@deepseek-ai/dsh-tool-video-inspect`. Mount `sessionProjections` before the consumer and retain the reader in that consumer's closure.
2. Replace calls with `videoReviewSummaries(reader, session)` and `readVideoSourceTimeline(ctx, session, id, options, signal, reader)`. Keep returning evidence through the ordinary logged context or tool result path.
3. Await direct `apply(ctx, config)` calls for the three packages before issuing tools. Custom screenplay compositions must mount `agents`; custom PTC compositions must mount `workingDirectory` with their real filesystem provider.
4. Verify a recorded review remains readable after another plugin registration unloads, and verify source-version changes still reject stale evidence. Existing Session logs and screenplay files require no edits.
