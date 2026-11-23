---
kind: upgrade-guide
description: "Muse transcription returns specific upload and query timeout results instead of an ambiguous unavailable state."
---

# Muse transcription deadlines

English | [中文](guide.zh.md)

## Change

Transcription status requests have a shorter account deadline, and a positive `wait_seconds` also limits any in-progress status request. Uploads have an inactivity deadline in addition to the total request ceiling. `audio_transcribe` reports `upload-timeout` or `query-timeout` with `status: "uncertain"` and the original receipt. A timed out request does not establish whether the gateway accepted the job.

## Migration

1. When automation follows an uncertain transcription result, handle `upload-timeout` and `query-timeout` by using `inspect` with the returned receipt before any recovery upload. Do not create another job ID.
2. Keep existing receipt files. Confirm that the same job ID appears when the original receipt is queried, and that completed work publishes its transcript files.
