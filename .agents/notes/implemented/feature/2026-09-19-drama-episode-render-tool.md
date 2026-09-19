# Agent Note: Short-drama episode rendering as a tool

Status: implemented

English | [中文](2026-09-19-drama-episode-render-tool.zh.md)

## Problem

The short-drama pipeline's delivery style — 1440x2560 at 60 fps with a 24M target and a 30M ceiling, SimHei 68 subtitles with the single bottom-right `内容由AI生成` mark, a two-second ending frozen from the last shot's real tail frame, and a three-source audio mix finished with `alimiter=0.95` — lived in the `tweet-drama-background-render` skill and was executed by a Python script the skill told the model to launch. A session that skipped the skill, or launched the script with the wrong flags, could still deliver something: the style was advice, and the only enforcement was an operator reading the result.

Three things made that the wrong home. The style is decidable — resolution, frame rate, bitrate floor, subtitle geometry, ending length, and the audio gain are all measurable on the delivered file — so a rule that can be checked should be checked where the file is written. Two of the steps fail silently rather than loudly: `-sseof -0.05` returns exit code 0 without writing a tail frame on some sources, and a GPU encoder probe that fails looks exactly like a GPU encoder that worked unless the reason is carried out of the call. And the result was a printed JSON blob rather than a value the session could act on.

## Decision

A second `drama/` package, `@deepseek-ai/dsh-tool-episode-render`, registers one model-facing tool, `drama_render`, with three methods.

`prepare` builds the directory layout a render consumes without encoding picture: each source video is copied to `video/<集>/shot_00N.mp4`, the timeline is laid out in `editing/<集>-timeline.json` from the **ffprobe-measured** durations rather than declared ones, the episode master is assembled in `audio/<集>.wav` by placing each shot's own sound at its own start with no gain and no per-shot resampling, and the subtitle is installed at `editing/<集>.srt`. A cue that ends past the assembled picture is reported as a warning.

`render` produces the delivery in the operator-approved style and returns its measured parameters: resolution, frame rate, bitrate, duration, size, and encoder. Body clips are re-encoded under their own timeline durations and cached per episode; the ending is rebuilt from the last body shot's proved tail frame; the body and the ending are concatenated with stream copy; the ASS script is burned in; and the three audio sources are mixed and muxed with a fast-start index.

`verify` checks a delivered file against its timeline and its subtitle: duration, streams, frame rate, overall bitrate floor, black stretches, silent stretches, and whether any subtitle cue would be burned outside the picture.

A problem that makes a render impossible — a missing argument, a missing input, a failed command, a tail frame that cannot be proved — throws with a Chinese repair instruction. A problem in the delivered file itself does not: it comes back as a check with `ok: false`, one repair line per failed check, because the operator still needs the file and the measurement. `verify` never throws on a bad file at all.

The delivery style is not configurable. Geometry, frame rate, rate control, the subtitle style, the ending length, the effect speed, and the limiter are constants in `src/delivery.ts`, because they are the operator-approved specification rather than a per-deployment choice. What `Config` exposes is what genuinely varies: the ffmpeg and ffprobe executables, the two audio gains the operator approved, whether the GPU encoder is probed, and where libass finds the subtitle font.

## The two traps

**The tail frame is proved, not assumed.** The seek window is `-sseof -0.1`, because `-sseof -0.05` returns exit code 0 without writing a file on some sources — a 13.041667-second erased cut among them — which produced an ending built from the wrong frame with nothing in the log to say so. Widening the window is not enough on its own: after extraction the frame's `framemd5` is compared against the last frame of a full sequential decode of the same source. When the two differ, the frame is re-extracted by index; when that still does not match, the render stops rather than freeze an unproved frame. The comparison's three hashes and two booleans are returned in `tail_frame`, so a session can see what was frozen and why.

**The encoder fallback is recorded.** The probe encodes one frame of a `color=black:s=256x256:d=0.1` source; the size matters because several NVIDIA generations reject smaller frames as below NVENC's minimum, which would report a working card as unusable. An old driver, a missing NVENC build, and a busy GPU session all fail the same way, and the delivery must still happen, so a failure falls back to `libx264` by design — with the probe's own output collapsed to one line in `encoder_fallback_reason` and written to the render log. `preferNvenc: false` skips the probe and records that reason instead.

## Alternatives considered

**Keep the Python renderer and wrap it.** A tool that shells out to `render_episode.py` would have kept one implementation and shipped immediately. It would also have made the delivery style unrepresentable in this repository: the style would still be argparse defaults in a file this repository does not own, the two traps would still be undocumented, and the result would still be a printed blob instead of a value checked against a schema.

**Port only the render method.** `prepare` is where the pipeline's own layout decisions live — which durations the timeline uses, where each shot's sound starts, what a missing audio track means. Leaving it in a separate hand-written script would have split one clock across two implementations, which is exactly the drift that produced the re-cut this port had to reproduce.

**Make the delivery style configurable.** Every value could have been a `Config` field. It is not, because a field is a promise that varying it is supported: a 1080x1920 delivery, a 12M bitrate, or a different subtitle font is not a deployment choice here but a different delivery the operator has not approved. The four fields that are exposed are the ones whose variation the operator already exercises.

**Return the delivered file's defects as an error.** A render that misses the bitrate floor could throw instead of returning `ok: false`. It does not, because the file already exists by then: refusing to report it would waste the render and hide the measurement the operator needs to decide whether to re-encode.

**Write the Python renderer's `exports/render_tasks.json` state file.** The Python appended each render's result to a project state file. This package writes a per-episode render log instead, and returns the same facts: the pipeline's single state file is `pipeline_state.json`, and a second one written by a tool would compete with it for authority.

## Consequences

The delivery style now has one executable home, and the two silent failures have somewhere to be recorded. A session that never reads the skill still cannot deliver a file outside the specification without the result saying so, and it can read every defect from one call.

The cost is a second implementation during the transition. `render_episode.py` stays the production path until sessions move over, so the style exists twice for a while; the Python remains the reference for the byte layout the operator has already approved, and the package's Dev Note lists the five places the port deliberately differs. The `tweet-drama-background-render` skill is untouched.

Three limits are deliberate and recorded in the package README: the ending is rebuilt on every render rather than reused from the cache, because a cached ending could predate a re-cut and the proof is the point of the step; `render` is not transactional, so an interrupted run can leave a partial `base.mp4` that the next run overwrites rather than validates; and the audio mix is not metered, so `alimiter=0.95` is the only ceiling and a source louder than the master it replaced can still clip before it.

The package holds no state between calls and publishes no invariant companion: every answer is a function of the files it reads and the processes it starts, with no independently changing observation to check.

## Testing

`packages/drama/tool-episode-render/tests/` covers each module through its own spec: the process edge against a real spawned Node process, and everything above it against a stub channel that answers ffprobe reports, `framemd5` lines, and the tail-frame seek. `npx vitest run packages/drama/tool-episode-render --coverage` reports per-file 100% statements, branches, functions, and lines across the twelve source modules. The tool spec mounts the plugin and validates every returned value against the tool's own `output.schema`, so a canonical value that drifts from its declared schema fails the suite rather than a session. The tail-frame proof is pinned by the three cases it exists for: a seeked frame that matches the sequential decode, one that does not and is replaced by index, and one that cannot be proved at all.
