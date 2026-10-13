---
description: "Inspect local video metadata and timestamped frames through the Session filesystem and durable image attachments."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-video-inspect

English | [中文](README.zh.md)

## Summary

`video_inspect` probes local video or returns a bounded set of decoded frames to an image-capable model. `video_ocr` recognizes visible text from bounded Windows-local frame batches without invoking a model or cloud speech service. Both preserve source presentation timestamps and version evidence.

## Table of Contents

- [Use this package](#use-this-package)
- [Execution and storage](#execution-and-storage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the function plugin with `tools`, `fs`, `subprocess`, `attachments` and `sandboxPolicy`. Configure `ffmpegPath` and `ffprobePath` for the same execution world as the filesystem. Sampling requires the exact calling model to declare image input; `metadata` works without image input. Neither operation invokes a model or speech provider itself.

```json
{"file_path":"source/episode-01.mp4","method":"sample","start_seconds":0,"end_seconds":60,"frame_count":6,"manifest_path":"qa/video-01.json"}
```

Uniform samples use the middle of equally sized intervals. `timestamps_seconds` selects specific source moments instead. The default maximum is 12 frames over 120 seconds per call; the default interval is at most 60 seconds. `next_start_seconds` names the next interval when part of the source remains. Use `video_ocr` for visible or burned-in text and the existing `audio_transcribe` tool separately for spoken dialogue, under its account and billing requirements.

OCR samples use a valid positive video-stream duration when both the video and container explicitly start at zero. Otherwise they use the container duration. This avoids planning a nonexistent frame at the video endpoint when audio runs slightly longer. General inspection metadata, contact sheets and ASR range checks retain the container duration; failed samples inside the requested interval remain incomplete coverage.

`video_ocr` samples a requested video range, sends bounded JPEG batches to one Windows OCR bridge process per batch, and creates both raw JSON evidence and a timestamped merged TXT file inside the workspace. Each extraction batch limits filter output before recording timestamps, so diagnostics refer only to the encoded batch frames. The raw evidence retains every recognized line, word box, source timestamp, scan range and conservative classification. Long-lived, spatially stable exact text may be labelled `persistent_text_candidate`; this describes visual persistence, not whether the text is narrative. Both classes remain content candidates and count toward `segment_count`; text is never silently removed. Equal-time lines retain OCR reading order.

```json
{"file_path":"source/episode-01.mp4","start_seconds":0,"end_seconds":120,"frame_interval_seconds":0.5,"language":"zh-Hans-CN","raw_json_path":"transcript/raw/episode-01-ocr.json","merged_text_path":"transcript/raw/episode-01-ocr.txt"}
```

`scan_status` distinguishes `complete`, `partial` and `failed`. `text_status=no_text_detected` is possible only after every planned sample in that call was processed, but sampled OCR still cannot prove that the video has no subtitles. `next_start_seconds`, unscanned ranges and failed timestamps make incomplete coverage explicit. A missing requested Windows language, decode failure or timeout remains `indeterminate`; the tool has no ASR fallback and cannot authorize or bill a cloud request. Deployments configure language, interval bounds, range/frame/batch limits, image and JSON byte limits, deadlines and text-persistence thresholds. A bridge failure stops subsequent batches rather than repeating an unavailable recognizer. No OCR language pack is installed at runtime. On unsupported platforms, including macOS, report this capability and reuse supplied subtitles or transcripts. A consumer may use separately authorized ASR for this material and purpose under its existing billing and receipt flow; OCR failure never authorizes a new paid request or changes ASR evidence into OCR.

`video_contact_sheet` returns timestamp-labelled overview images. The default layout is three columns and three rows; `columns: 3, rows: 2` gives six cells. Cells run left to right and top to bottom in source order. `frame_count` can span multiple pages; `timestamps_seconds` selects exact moments, or `frame_interval_seconds` requests uniform spacing without a frame count. `strategy: scene` prioritizes detected cut sides. Each manifest retains the full extracted frame references for detail follow-up. First obtain successful `video_inspect method=metadata` for the current source, then sample a bounded interval containing the selected time. Only overview pages enter this result as image blocks; grids do not issue trusted inspection receipts.

Overview configuration uses `contactColumns` and `contactRows` (both default 3), `contactTileWidth` (320 pixels), `maxContactFrames` (32), `maxContactRangeSeconds` (300 seconds), `maxContactPixels` (16,000,000 per page) and `maxContactBytes` (8 MiB across pages). Cells preserve the source aspect ratio; labels use actual decoded timestamps. Image-store dimension limits also apply. Oversized layouts, conflicting sampling arguments, changed sources and existing manifests fail rather than silently dropping cells. Follow `next_start_seconds` to inspect longer videos; overview thumbnails are not sufficient for detailed identity or action approval.

`strategy=scene_dialogue` selects frames before and after actual FFmpeg scene transitions and, when `transcript_path` points to the matching `audio_transcribe` JSON, spoken utterance midpoints. Speaker identifiers distinguish ASR voices rather than named characters. The caller must use a transcript from the same complete clip; a range check alone cannot establish that association. `sampling_plan.selected` explains the returned observations; `sampling_plan.deferred` lists unviewed points. Read these remaining timecodes with `timestamps_seconds` in subsequent bounded calls, and inspect ambiguous actions or speaker identity in narrower intervals. A cut detector can miss gradual transitions.

The deployment can configure `sceneThreshold` (default 0.25), `scenePaddingSeconds` (0.12), `maxPlanPoints` (1000) and `maxTranscriptBytes` (2097152). A candidate-plan overflow rejects the call with a shorter-interval instruction instead of hiding events. An absent transcript still permits scene-based sampling. Transcript changes during reading or extraction abort publication.

Creation deployments can enable `trustedEvidence` (default false). A real `metadata` call then returns `window_plan`, partitioning the complete probed duration into contiguous windows no longer than `min(60, maxRangeSeconds)`. Trusted sampling requires a successful metadata call for the same current video first. Planned windows remain unviewed until subsequent successful sample calls return actual frames; narrow follow-up calls can inspect conflicts, causes, consequences, endings and uncertain moments. Scene cuts and ASR timecodes select candidates, without identifying story meaning.

## Execution and storage

Reads resolve through `ctx.fs`; probes and decoders execute through `ctx.subprocess` under the current Session file policy. Confined execution requires an available sandbox provider. FFmpeg accepts only local file and pipe protocols. Source size, encoded image area (`maxSourcePixels`, default 33,177,600), duration, frame dimensions, complete image bytes, process deadlines and concurrent inspections are deployment-configurable. Each command awaits process-range termination, including cancellation and failure. Removing the plugin cancels and awaits its active inspections.

On Windows, the packaged `scripts/ocr_bridge.ps1` receives bounded base64 JPEG JSON through stdin. It creates one Windows OCR engine per batch and returns bounded JSON through stdout; it does not use predictable temporary images, shell interpolation, network access or runtime installation. The fixed packaged script uses process-scoped `ExecutionPolicy Bypass` so the application never changes the machine or user policy. Explicit language selection fails closed when that recognizer is unavailable. Source mutation aborts publication, output paths must be distinct and inside the workspace, and existing files are never replaced.

Frames enter the normalized attachment store before returning as image blocks. The manifest is created inside the current workspace without replacing an existing file, then read back. A changed source version aborts publication. Source media is unchanged, and no remote media URL or account credential enters the result. No invariant companion is published because each manifest and attachment has one authoritative storage owner.

Adaptive sampling trims decoded source timestamps to the requested interval before emitting scene metadata. It divides that interval by the returned-frame budget and prioritizes cuts, then utterances, within each temporal bucket. A burst of cuts near the opening cannot consume the whole overview. Every remaining observation stays deferred; an overview remains sampled evidence, not continuous viewing.

The Host-only `resolveTrustedVideoEvidence` export matches an imported manifest to this registration's actual execution record. It requires unchanged canonical tool output, successful enclosing executions, committed tool results, and a later completed image-capable AgentLoop request whose provider projection retains every returned image. Its receipt binds source path and filesystem version, probed duration, metadata plan, the actual sampled interval, requested times, decoded timestamps, attachments, original manifest-byte hashes, projected model-input digest and Session event references. `verified_readback` establishes only manifest readback; model-supplied JSON cannot issue a receipt. An individual receipt never establishes that every planned window has been sampled.

An observation without a saved Host-issued receipt requires live registration evidence; unloading or restarting requires inspection again. The Host can supply a saved observation receipt to the same helper before or after episode acceptance, with no current Session required. Recovery reads the original Session through `sessionQuery`, verifies real video-tool results and successful execution ancestry, and reconstructs the later model's image-containing input before checking current source versions, manifests and attachments. It does not rerun media commands or a model. Missing original logs or changed files block recovery. The receipt relies on trusted Host Session storage, rather than a signature resistant to administrator changes to that storage. The exported `TRUSTED_VIDEO_INSPECTION_RECEIPT` parser validates file fields; parsing alone establishes no trust.

## Model Experience

### The `video_inspect` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-video-inspect) records the parameters. Results append compact metadata, a manifest path, the sampled interval, the next interval when applicable, and actual image blocks preceded by source timestamps. The result explicitly says “These are sampled frames, not continuous viewing. Audio has not been transcribed.” A generic persisted tool card exposes the call and metadata.

#### Token effect

The schema adds a fixed request cost. Results add bounded text and at most the configured number of image inputs; image pricing and request resizing belong to the selected provider. Full video bytes are never placed in model context. Opt-in metadata plans add one interval per planned window. Host evidence checks and accepted-record recovery add no model request or model-visible context.

#### KV Cache effect

Tool results append without rewriting earlier messages. Schema or description changes alter the reusable request prefix; frame attachments add visual inputs to later requests until the ordinary image offload policy applies.

### The `video_ocr` tool

#### What the model sees

The model receives a compact source-labelled summary: source version, requested and scanned interval, scan and text status, coverage counts and ranges, a bounded segment preview, and paths to the full raw JSON and merged TXT. Full word boxes and all segments remain in files rather than inflating every tool result. OCR and ASR source records are never merged by this tool.

#### Token effect

The schema adds a fixed request cost. A result adds bounded text only, controlled by `ocrPreviewSegments`; frame bytes and raw OCR JSON do not enter model context. Continuing a long scan requires further tool calls, but each call exposes an explicit continuation point and never adds a model round or ASR request internally.

#### KV Cache effect

The result appends without rewriting earlier messages. The fixed schema changes the reusable request prefix; evidence-file contents enter context only when the caller deliberately reads them.

## Known Limitations and Deferred Work

- Sampled frames can miss short actions, transitions and lip movement. Inspect uncertain timecodes and additional intervals; sampling does not establish complete video coverage.
- Sampled OCR can miss short-lived, stylized, moving or low-contrast subtitles. Even `complete` plus `no_text_detected` describes the planned samples, not mathematical proof that the video contains no subtitles. A user-facing workflow must keep fallback decisions explicit.
- Windows OCR quality and supported languages depend on locally installed recognizers. This package reports missing language or engine support and does not install it.
- Visual observations do not establish dialogue, speaker identity or consistent timbre. Speech transcription and human listening remain separate.
- Decode support depends on the installed FFmpeg build. This tool does not fetch web links, use native provider video input or identify characters automatically.
- A later image-input receipt requires every target frame to remain visible, excluding offloaded images. It establishes delivery of sampled frames, without proving attention, story interpretation, artistic quality or continuous viewing. Story coverage, unresolved critical issues and semantic decisions remain the caller's responsibility.
- Evidence recovery requires the original model route and its image-capable projection to remain available. Private assistant replay state from another provider blocks issuance when the adapter-specific projection cannot be reconstructed; use a fresh Session for that provider switch.

### Dev Note

Focused tests use original synthetic FFmpeg media, real PTC execution, filesystem reads, normalized attachments and a keyless scripted model. They inspect actual image blocks in its requests and exercise registration loss and log-backed accepted recovery. The recorded Session scenario loads the plugin through the shipped profile and substitutes only deterministic media process output.

`frameFormat` selects `png` (default) or `jpeg`; `frameJpegQuality` selects the FFmpeg JPEG quantizer from 1 to 31 (default 2, ignored for PNG). Creation mode uses JPEG and four default observations per call to reduce request upload size while preserving source timestamps. Choose sufficient frame dimensions for subtitle and identity inspection; encoding does not establish that the model observed a frame.

OCR unit tests exercise multilingual evidence, MJPEG boundaries, exact overlay labelling and partial coverage without a recognizer. Windows integration tests use real FFmpeg frame extraction and a deterministic in-process substitute only for the OCR bridge output. The packaged PowerShell bridge and installed-language behavior still require Windows package acceptance testing.
