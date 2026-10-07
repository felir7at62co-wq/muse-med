---
description: "Inspect local video metadata and timestamped frames through the Session filesystem and durable image attachments."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-video-inspect

English | [中文](README.zh.md)

## Summary

`video_inspect` probes local video or returns a bounded set of decoded frames to an image-capable model. Every image carries its source presentation timestamp. A new JSON manifest retains the source version, selected interval, frame references and metadata; the tool returns only after reading the manifest back.

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

Uniform samples use the middle of equally sized intervals. `timestamps_seconds` selects specific source moments instead. The default maximum is 12 frames over 120 seconds per call; the default interval is at most 60 seconds. `next_start_seconds` names the next interval when part of the source remains. Use the existing `audio_transcribe` tool separately for dialogue and subtitles, under its account and billing requirements.

`strategy=scene_dialogue` selects frames before and after actual FFmpeg scene transitions and, when `transcript_path` points to the matching `audio_transcribe` JSON, spoken utterance midpoints. Speaker identifiers distinguish ASR voices rather than named characters. The caller must use a transcript from the same complete clip; a range check alone cannot establish that association. `sampling_plan.selected` explains the returned observations; `sampling_plan.deferred` lists unviewed points. Read these remaining timecodes with `timestamps_seconds` in subsequent bounded calls, and inspect ambiguous actions or speaker identity in narrower intervals. A cut detector can miss gradual transitions.

The deployment can configure `sceneThreshold` (default 0.25), `scenePaddingSeconds` (0.12), `maxPlanPoints` (1000) and `maxTranscriptBytes` (2097152). A candidate-plan overflow rejects the call with a shorter-interval instruction instead of hiding events. An absent transcript still permits scene-based sampling. Transcript changes during reading or extraction abort publication.

## Execution and storage

Reads resolve through `ctx.fs`; probes and decoders execute through `ctx.subprocess` under the current Session file policy. Confined execution requires an available sandbox provider. FFmpeg accepts only local file and pipe protocols. Source size, encoded image area (`maxSourcePixels`, default 33,177,600), duration, frame dimensions, complete PNG bytes, process deadlines and concurrent inspections are deployment-configurable. Each command awaits process-range termination, including cancellation and failure. Removing the plugin cancels and awaits its active inspections.

Frames enter the normalized attachment store before returning as image blocks. The manifest is created inside the current workspace without replacing an existing file, then read back. A changed source version aborts publication. Source media is unchanged, and no remote media URL or account credential enters the result. No invariant companion is published because each manifest and attachment has one authoritative storage owner.

Adaptive sampling trims decoded source timestamps to the requested interval before emitting scene metadata. It divides that interval by the returned-frame budget and prioritizes cuts, then utterances, within each temporal bucket. A burst of cuts near the opening cannot consume the whole overview. Every remaining observation stays deferred; an overview remains sampled evidence, not continuous viewing.

## Model Experience

### The `video_inspect` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-video-inspect) records the parameters. Results append compact metadata, a manifest path, the sampled interval, the next interval when applicable, and actual image blocks preceded by source timestamps. The result explicitly says “These are sampled frames, not continuous viewing. Audio has not been transcribed.” A generic persisted tool card exposes the call and metadata.

#### Token effect

The schema adds a fixed request cost. Results add bounded text and at most the configured number of image inputs; image pricing and request resizing belong to the selected provider. Full video bytes are never placed in model context.

#### KV Cache effect

Tool results append without rewriting earlier messages. Schema or description changes alter the reusable request prefix; frame attachments add visual inputs to later requests until the ordinary image offload policy applies.

## Known Limitations and Deferred Work

- Sampled frames can miss short actions, transitions and lip movement. Inspect uncertain timecodes and additional intervals; sampling does not establish complete video coverage.
- Visual observations do not establish dialogue, speaker identity or consistent timbre. Speech transcription and human listening remain separate.
- Decode support depends on the installed FFmpeg build. This tool does not fetch web links, use native provider video input or identify characters automatically.

### Dev Note

Focused tests use actual FFmpeg, filesystem reads and normalized attachments. The recorded Session scenario loads the plugin through the shipped profile and substitutes only deterministic media process output.
