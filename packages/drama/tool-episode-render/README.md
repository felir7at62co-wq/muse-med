---
description: "The short-drama episode renderer as one model-facing tool: lay out render inputs, encode the 1440x2560 delivery with its fixed subtitle and audio style, and check the delivered file, for users and maintainers running the Jubian drama pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-render

English | [中文](README.zh.md)

## Summary

Use this package when a short-drama session must turn reviewed shot videos into one delivered episode without hand-written FFmpeg command lines. One tool, `drama_render`, owns the operation: `prepare` builds the directory layout a render consumes, `render` produces the delivery in the operator-approved style and reports its measured parameters, and `verify` checks a delivered file against its timeline and subtitle. The delivery style lives here as constants, not as advice in a skill, so the operation that produces the artifact is the operation that enforces it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin as one row of a short-drama preset; it needs only the tool registry, and `ffmpeg` plus `ffprobe` on `PATH`:

```yaml
- id: tool-episode-render
  name: '@deepseek-ai/dsh-tool-episode-render'
  config:
    ffmpegPath: ffmpeg          # default
    ffprobePath: ffprobe        # default
    masterVolume: 1.45          # episode master gain, default
    bgmVolume: 0.24             # BGM gain, default
    preferNvenc: true           # probe h264_nvenc before each render, default
    fontsDir: 'C:/Windows/Fonts' # where libass finds SimHei, default
```

| Field | Default | Meaning |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | The ffmpeg executable to start |
| `ffprobePath` | `ffprobe` | The ffprobe executable to start |
| `masterVolume` | `1.45` | Gain applied to the episode's own master audio; 0–8 |
| `bgmVolume` | `0.24` | Gain applied to the BGM bed; 0–8 |
| `preferNvenc` | `true` | Whether the GPU encoder is probed at all |
| `fontsDir` | `C:/Windows/Fonts` | Directory libass resolves the subtitle font from |

### The three methods

| Method | Reads | Writes | Use it for |
|---|---|---|---|
| `prepare` | The shot-sources manifest and the subtitle | `video/<集>/shot_00N.mp4`, `audio/<集>.wav`, `editing/<集>-timeline.json`, `editing/<集>.srt` | Building every input a render reads, without encoding picture |
| `render` | The timeline, the prepared shots, the master, the subtitle, the BGM, the ending sound and effect | The delivered MP4 and `exports/.render_cache/<集>/render.log` | Producing the delivery and returning its measured parameters |
| `verify` | The delivered file, its timeline, and its subtitle | Nothing | Checking a delivery after the fact, or re-checking one from an earlier session |

| Parameter | Required | Meaning |
|---|---|---|
| `method` | always | `prepare`, `render`, or `verify` |
| `project` | always | Project root holding `video/`, `audio/`, `editing/`, and `exports/` |
| `episode` | always | Episode number; padded to two digits on every path |
| `shots` | `prepare` | Shot-sources manifest: `{"shots":[{"shot":1,"video":"media/02/p1-clean.mp4","audio":"optional"}]}` |
| `timeline` | `render`, `verify` | Timeline JSON, normally the one `prepare` wrote |
| `subtitle_srt` | always | The SRT to install, burn, or check |
| `last_shot` | `render` | Last body shot this delivery covers; the timeline must hold exactly that many clips up to it |
| `bgm` | `render` | The BGM bed, looped to the body end |
| `ending_audio` | `render` | The ending sound, delayed to the body end |
| `ending_effect` | `render` | The ending effect video blended over the frozen frame |
| `output` | `verify` (`render` optional) | The delivered file; `render` defaults to `exports/<集>.mp4` |
| `force` | optional | `render` ignores its per-shot cache and re-encodes every clip |

A method missing one of its own arguments fails before any file is opened. Everything that makes a render impossible — a missing input, a failed command, a tail frame that cannot be proved — throws with a Chinese repair instruction. The delivered file's own properties do not throw: they come back as checks, so one call reports every defect while still handing back the measurement.

### What prepare writes

`prepare` copies each source video to `video/<集>/shot_00N.mp4`, lays the timeline out from the ffprobe-measured durations rather than declared ones, assembles the episode master by placing each shot's own sound at its own start (no gain, no per-shot resampling, one 48 kHz lossless write), and installs the subtitle at `editing/<集>.srt`. It encodes no picture. A cue that ends after the assembled picture is reported as a warning.

### The fixed delivery style

| Element | Value |
|---|---|
| Picture | 1440x2560 at 60 fps, H.264 high@5.1, `yuv420p` |
| Rate control | 24M target, 30M peak, 48M buffer, 120-frame GOP |
| Overall bitrate floor | 4.6 Mbps over the delivered file |
| Endings | 2.000 seconds frozen from the last body shot's real tail frame, with the ending effect screen-blended over it at 0.90 |
| Subtitles | SimHei 68, spacing -2, 7px black outline, bottom-centred, plus the single bottom-right `内容由AI生成` mark |
| Audio | Episode master at 1.45, BGM at 0.24 to the body end, ending sound delayed to the body end, `amix` normalised off, `alimiter=0.95` |
| Container | AAC 192k at 48 kHz, `+faststart` |

### The two known traps

- **The tail frame.** `-sseof -0.05` returns exit code 0 without writing a file on some sources, so the frame was silently wrong. This package always seeks with `-sseof -0.1`, and it does not trust the result: the extracted frame's `framemd5` must equal the last frame of a full sequential decode. When it does not, the frame is re-extracted by index; when that still does not match, the render stops instead of freezing an unproved frame. The evidence is returned in `tail_frame`.
- **The GPU encoder.** A driver too old for NVENC, a missing build, or a busy GPU session all fail the probe the same way. The probe encodes one frame of a 256x256 source — some NVIDIA generations reject smaller frames — and a failure falls back to `libx264` by design, with the probe's own output recorded in `encoder_fallback_reason` and in the render log.

### Check codes

`render` runs the five delivery checks; `verify` runs all of them. `ok` is true exactly when no `failure`-severity check failed.

| Code | Severity | Passes when |
|---|---|---|
| `duration` | failure | The measured duration is within 0.15 s of body end plus the ending |
| `video_stream` | failure | 1440x2560 H.264 |
| `frame_rate` | failure | 60 fps within 0.01 |
| `audio_stream` | failure | An AAC 48 kHz audio stream is present |
| `bitrate_floor` | failure | The overall bitrate reaches 4.6 Mbps |
| `black_frames` | failure | No black stretch reaches 1.0 s |
| `fade_to_black` | warning | No black stretch reaches 0.3 s |
| `silence` | failure | No silent stretch reaches 3.0 s |
| `long_pauses` | warning | No silent stretch reaches 1.0 s |
| `subtitle_bounds` | failure | Every cue lies inside `0`–`body_end` and inside the file |
| `subtitle_present` | warning | The subtitle carries at least one cue |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one call is executed and where the code lives; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on four commitments:

- **Enforce the delivery where it is produced.** The picture geometry, the rate control, the subtitle style, the ending, and the audio mix are the operator-approved specification. They are constants in one module, not parameters a caller can drift from, and the operation that writes the file is the operation that checks it.
- **Report the artifact, throw on the obstacle.** A delivered file that misses the bitrate floor is a domain outcome: the operator still needs the file, so it comes back with `ok: false` and one repair line per failed check. A missing input or a failed command is an environment problem: it throws, because there is nothing to hand back.
- **Prove the tail frame.** The ending is the one frame nobody can inspect afterwards, so its provenance is a returned value rather than a comment. The `-sseof` result is compared against a sequential decode every time, and a mismatch is either repaired by index or refused.
- **One injected process edge.** Every module takes a `MediaToolkit`; only one function starts a process. The whole pipeline therefore runs in tests against a stub channel, and the real channel is exercised by its own three-process spec.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, argument resolution, the method dispatch, and the `drama_render` schema and description |
| [`src/delivery.ts`](src/delivery.ts) | The fixed delivery specification: geometry, encoder arguments, the ASS header and timestamps, the ending filter, and the audio mix graph |
| [`src/ffmpeg.ts`](src/ffmpeg.ts) | The process edge: the spawn channel, the ffmpeg and ffprobe wrappers, and ffprobe report parsing |
| [`src/paths.ts`](src/paths.ts) | Where one episode's render inputs and outputs live, and the existence check that distinguishes a cache miss from a broken path |
| [`src/timeline.ts`](src/timeline.ts) | Reading, validating, selecting, laying out, and serializing the episode timeline |
| [`src/subtitles.ts`](src/subtitles.ts) | SRT parsing and the ASS document the delivery burns |
| [`src/encoder.ts`](src/encoder.ts) | The NVENC probe and the CPU fallback with its recorded reason |
| [`src/ending.ts`](src/ending.ts) | Tail-frame extraction with its framemd5 proof, and the ending clip |
| [`src/prepare.ts`](src/prepare.ts) | `prepare`: the shot-sources manifest, the probes, the copied layout, and the master audio graph |
| [`src/render.ts`](src/render.ts) | `render`: the encode pipeline, the concat, the burn-in, the mix, and the render log |
| [`src/verify.ts`](src/verify.ts) | The delivery verdict `render` shares, plus `verify`'s black, silence, and subtitle-bound checks |
| [`src/report.ts`](src/report.ts) | The canonical result: one shape every method fills, empty where it measured nothing |
| [`src/types.ts`](src/types.ts) | Types only: the timeline, the shot source, the measured facts, and the model-facing result |
| — | No runtime invariant companion is published: the package holds no state between calls and every answer is a function of the files it reads and the processes it starts. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-render) — the exact `drama_render` schema and description the model receives.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the pipeline every call enters.
- [drama group map](../README.md) — the sibling packages of the short-drama pipeline.

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_render` tool schema

#### What the model sees

One tool named `drama_render` in the request's tool list: this package's `description`, its twelve parameters, and the JSON schema of its result, all reproduced in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-render). The description states the three methods, the fixed delivery geometry and rate control, the ASS subtitle style and the single AI-content mark, the three-source audio mix with its limiter, the 256x256 NVENC probe and the designed CPU fallback, the `-sseof -0.1` rule with its framemd5 proof against a sequential decode, and the split between problems that throw and problems that come back as checks. The result schema declares `method`, `ok`, `project`, `episode`, `clips`, `body_end_seconds`, `expected_duration_seconds`, `written`, `output`, `encoder`, `gpu_requested`, `gpu_used`, `encoder_fallback_reason`, `encoded_shots`, `reused_shots`, `tail_frame`, `media`, `checks`, `failures`, `warnings`, `log_path`, and `summary`; the rendered content is the same value as pretty-printed JSON.

#### Token effect

Fixed schema plus a result bounded by the episode: one `clips` row per shot and up to eleven check rows, each with a Chinese detail line and its repair instruction. A render of a nine-shot episode returns nine clip rows whatever the encode cost, and a passing delivery leaves `failures` empty and every `fix` an empty string.

#### KV Cache effect

Append-only. The tool registration carries a stable name, description, and schema, so a mounted row keeps the request prefix reusable; only a change to this package's description or schema invalidates it. A call's result is appended as that call's own tool result and rewrites no earlier message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this package is and what it is not. They are current constraints, not a task backlog.

- **ffmpeg and ffprobe are external** — the package starts whatever `ffmpegPath` and `ffprobePath` name. A build without `libass`, `minterpolate`, or the `screen` blend mode fails at the command that needs it, and only that command's stderr is reported.
- **The delivery style is not configurable** — geometry, frame rate, rate control, the subtitle style, the ending length, and the limiter are constants, because they are the operator-approved specification. Only the binaries, the two gains, the encoder preference, and the font directory are `Config` fields.
- **`render` is not transactional** — the cache directory, the delivered file, and the log are written in order without a rollback. A failed render leaves the cache as it stood, which is what makes a retry cheap; it also means an interrupted run can leave a partial `base.mp4` that the next run overwrites rather than validates.
- **The ending is rebuilt on every render** — the tail frame is re-extracted and re-proved, and the ending clip is re-encoded, even when the cache holds both. The proof is the point, and a cached ending could predate a re-cut.
- **`prepare` copies, it does not link** — every source video is copied into the project, so a nine-shot episode needs room for the reviewed cuts twice. Hard links would break as soon as the source is rewritten.
- **One episode per call** — `last_shot` bounds a render to the body shots it delivers, but a call never renders several episodes, and no method reads `pipeline_state.json`.
- **The mix is not metered** — `amix` with `normalize=0` keeps the operator's gains exactly, and `alimiter=0.95` is the only ceiling. A source louder than the master it replaced can still clip before the limiter, and `verify`'s silence check does not detect it.
- **Subtitle bounds are checked, not corrected** — `verify` reports a cue that runs past `body_end`; nothing clamps it, because where a line should end is the subtitle author's decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked documents.

This package is a port of the pipeline's Python renderer (`tweet-drama-background-render/scripts/render_episode.py`). The Python script remains the production path until sessions move over, so both exist during the transition.

The ported behavior differs from the Python in five recorded places: the tail-frame seek is `-0.1` instead of `-0.05` and every extraction is proved against a sequential decode; the encoder probe failure is recorded as a reason instead of being a silent fallback; the ASS line endings are normalized to `\n` instead of following the host platform; the ending frame and clip are rebuilt on every render instead of reused from the cache; and the render log is a new file, while the Python's `exports/render_tasks.json` state file is deliberately not written.

</details>
