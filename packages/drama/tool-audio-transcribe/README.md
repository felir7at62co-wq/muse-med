---
description: "Transcribe authorized local media through the current Muse Account and keep versioned, timed project outputs."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

English | [中文](README.zh.md)

## Summary

The Host tool `audio_transcribe` turns a local audio or video file into a timed transcript through the signed-in Muse account. `start` saves an idempotent receipt before it asks the gateway to submit a billable cloud task. `status` reads the same task and publishes nonempty TXT and JSON under `transcript/raw/` without replacing an existing version.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The Desktop Host mounts this row after `@deepseek-ai/dsh-muse-account`; all product presets can call it. Sign in to Muse Account before starting a task. The gateway must separately enable cloud transcription. The model cannot supply Volcengine or TOS credentials.

```json
{"method":"start","project":"<project root>","input":"<authorized local audio or video>","language":"zh"}
{"method":"status","project":"<same project root>","receipt":"<start receipt path>"}
```

`start` probes the source, extracts 16 kHz mono MP3 with FFmpeg, and stores the job ID and audio digest in `transcript/jobs/`. On Unix, tool-owned transcript directories use mode 0700 and staged MP3, receipts, and published files use mode 0600. An uncertain submit retains the receipt. Query that receipt before another request; a confirmed absent server task can be retried with the same key and staged MP3. A complete task writes `transcript/raw/<media>-vN.txt` and `.json`; a silent task keeps only its receipt. The offline Python skill remains available only on an explicit offline request.

| Config | Default | Meaning |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | Desktop supplies its bundled paths through `DSH_FFMPEG_PATH` and `DSH_FFPROBE_PATH`. |
| `commandTimeoutMs` | 600,000 | Local probe or extraction timeout. |
| `maxDurationSeconds` | 18,000 | Maximum media duration accepted locally. |
| `maxAudioBytes` | 209,715,200 | Maximum extracted MP3 size; the server enforces its own limit. |

## Understand the implementation

The Host account service reads its origin-bound saved session and sends the compressed audio to `POST /api/asr/jobs`, then queries `GET /api/asr/jobs/:id` under the same account. It never returns the cookie, signed TOS URL, or provider keys to the model. The gateway owns the private temporary TOS object, account isolation, quota, provider submit/query, and cleanup. An unknown submit is queried by its original provider task ID and is not resubmitted with a new ID. The server's configuration and release procedure live in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

The implemented provider path is the Volcengine large-model recording-file **standard 1.0** v3 `/api/v3/auc/bigmodel/submit` and `/query`, resource `volc.bigasr.auc`, selected by the user's verified Pi session. Volcengine's [large-model recording-file product limit](https://www.volcengine.com/docs/6561/1354871?lang=zh) is five hours; [TOS signed GET URLs](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en) are bearer URLs and may live at most seven days. The older small-model `/api/v1/auc` documentation is a different API and does not define this implementation. Provider status codes and the 512 MiB observation came from the user's Pi run and still need a real authorized integration check before production billing.

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
- If a remote task remains unresolved past retention, the gateway removes its temporary TOS object. The next `status` call removes the local staged MP3 while preserving the receipt and original job ID for read-only reconciliation.

### Dev Note

Run the focused runner and account-client tests before changing receipt recovery or response validation. Gateway tests in `services/muse-accounts` cover account isolation, limits, and ambiguous provider submits without making paid calls.
