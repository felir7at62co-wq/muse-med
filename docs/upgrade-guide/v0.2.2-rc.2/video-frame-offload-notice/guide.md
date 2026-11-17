---
kind: upgrade-guide
description: "Video review preserves pending frame images, uses explicit removal notices, and can wait for inspection slots."
---

# Video frame review and removal notices

English | [中文](guide.zh.md)

## Change

Video reviews configured with `offloadObservedFrames` retain the latest tool-result image of each unrecorded frame until `observe` records it or its review closes. Tool errors and unrelated replies no longer age that image out. Previously recorded frames and revisit copies can leave after the next successful reply.

`image/offload` can include optional `notice`; projected image blocks carry it as `offloadNotice`. Subsequent requests send the image identity and this explanation, so a previously displayed frame is distinguishable from a request-limit omission. Historical events retain their old interpretation. An older image-offload plugin refuses notice-bearing events; update the consuming plugins together before reopening such a Session.

`slotWaitMs` configures the inspection queue deadline in milliseconds, defaulting to zero. The Muse short-drama preset uses 300000 while retaining two active inspections. Queue exhaustion reports the structured `VIDEO_INSPECT_BUSY` code; cancellation and plugin disposal stop queued work.

## Migration

1. Update the LLM, DeepSeek adapter, token meter, image-offload and video-inspection plugins together so displayed text and request estimates agree.
2. Keep existing Session files. The current reader supports decisions without a notice; no log conversion is required.
3. For a custom concurrent transcription profile, set `slotWaitMs` to its acceptable queue deadline. Do not increase decoder concurrency just to hide ordinary queueing.
4. When reviewing history, use `revisit` to see a recorded frame again; a removal notice alone is not evidence of a missing image or a failed observation.
