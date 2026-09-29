---
description: "Transcribe authorized local media through the current Muse Account and keep versioned, timed project outputs."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

English | [中文](README.zh.md)

## Summary

The Host tool `audio_transcribe` turns a local audio or video file into a timed transcript through the signed-in Muse account. `start` saves an idempotent receipt before it asks the gateway to submit a billable cloud task. `status` reads the same task and publishes nonempty TXT, JSON, and SRT under `transcript/raw/` without replacing an existing version.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Desktop mounts this tool in Standard, PTC, Creative, Editing, and Short Drama presets, excluding Minimal. Sign in to Muse Account before starting a task; the gateway separately enables transcription. The model cannot supply provider credentials.

```json
{"method":"start","project":"<project root>","input":"<authorized local audio or video>","language":"zh"}
{"method":"status","project":"<same project root>","receipt":"<start receipt path>"}
```

`start` probes the source, extracts 16 kHz mono PCM WAV with FFmpeg, and stores the job ID and audio digest in `transcript/jobs/`. On Unix, tool-owned transcript directories use mode 0700 and staged audio, receipts, and published files use mode 0600. An uncertain submit retains the receipt. Query that receipt before another request; a confirmed absent server task can be retried with the same key and staged audio. A complete task writes `transcript/raw/<media>-vN.txt` , `.json`, and `.srt`; a silent task keeps only its receipt. The offline Python skill remains available only on an explicit offline request.

| Config | Default | Meaning |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | Desktop supplies its bundled paths through `DSH_FFMPEG_PATH` and `DSH_FFPROBE_PATH`. |
| `commandTimeoutMs` | 600,000 | Local probe or extraction timeout. |
| `maxDurationSeconds` | 18,000 | Maximum media duration accepted locally. |
| `chunkSeconds` | 600 | Maximum seconds per cloud job; source inputs remain bounded by `maxDurationSeconds`. |
| `maxAudioBytes` | 100,000,000 | Maximum extracted audio chunk size; the server enforces its own limit. |

## Understand the implementation

The Host account service reads its origin-bound saved session and sends the audio to `POST /api/asr/jobs`, then queries `GET /api/asr/jobs/:id` under the same account. It never returns the cookie, signed TOS URL, or provider keys to the model. The gateway owns account isolation, quota, provider execution, and temporary audio cleanup. Standard jobs use private TOS objects; flash jobs send private staged audio directly. Unknown submissions retain their IDs without automatic recharging. The server's configuration and release procedure live in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

The gateway selects standard or flash recognition. Flash uses the [recording-file flash API](https://www.volcengine.com/docs/6561/1631584?lang=zh), with at most two hours and 100 MB per request. The tool splits long inputs into configured chunks, keeps a source SHA-256 and per-part IDs in the receipt, then merges sentence and word timestamps onto the original media clock. Default ten-minute PCM chunks use about 19.2 MB each. Completed outputs publish atomically without overwriting different contents; repeated status calls reconcile identical outputs. Flash requests with unknown outcomes remain unresolved and are not automatically charged again.

No runtime invariant companion is published because task receipts and registered tools each have one owning storage or registry, with no independently observed state to reconcile.

## Model Experience

### The `audio_transcribe` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-audio-transcribe) records the start/status schema. Results contain the status, receipt path, job ID, and completed output paths. A generic persisted tool card displays the call and result. Media bytes, account cookies, object URLs, and provider credentials are omitted; tool calls and returned paths remain Session data.

#### Token effect

The schema adds a fixed request cost. Each result adds a short status and local paths.

#### KV Cache effect

Tool results append without rewriting previous messages. Changing the description or schema changes the reusable request prefix.

## Known Limitations and Deferred Work

- Cloud recognition requires a signed-in Muse account and a deployed gateway with ASR configured. The tool does not fetch web links; source media must be readable locally.
- No speech produces no raw transcript. Provider timing and accuracy still require human review, and the offline model is never selected as an automatic fallback.
- If a remote task remains unresolved past retention, the gateway removes its temporary audio. The next `status` call removes the local staged audio while preserving the receipt and original job ID for read-only reconciliation.

### Dev Note

Run the focused runner and account-client tests before changing receipt recovery or response validation. Gateway tests in `services/muse-accounts` cover account isolation, limits, and ambiguous provider submits without making paid calls.
