# Agent Note: Subtitle timing measured from each shot, without speech recognition

Status: implemented

English | [中文](2026-09-21-drama-subtitle-timing-without-asr.zh.md)

## Problem

Subtitle cue times came from transcribing the whole episode and projecting the recognized text back onto the script, then correcting the result. The recognition output was never used as subtitle text — the delivery rule is that a subtitle carries the script's own words — so the transcription existed only to recover times, and every wrong character it produced had to be undone by the same pass that consumed it.

No package owned the operation. The script that ran it had been archived out of the draft-build skill, `build_spoken_subtitles.py` only read `actual_speech_start` and `actual_speech_end`, and nothing in the skills wrote those fields. Each session therefore re-implemented timing per run: no tool schema, no coverage check, and no evidence a later session could re-read.

## Decision

`drama_render` gains a fourth method, `subtitles`. It belongs to `@deepseek-ai/dsh-tool-episode-render` because the pass is editing work and the renderer already owns what it needs: the shot-sources manifest, each shot's resolved audio path, and a timeline laid out from ffprobe-measured durations.

`subtitles` reads that manifest plus a per-shot line plan and writes `editing/<集>.srt`. For every shot it runs `silencedetect=noise=-35dB:d=0.15` over that shot's own audio — before any music bed is mixed under it — inverts the silent stretches into the moments the shot speaks, and gives each declared line the stretch it occupies. A cue's time is the shot's start on the timeline plus its offset inside the clip. No speech recognition runs, nothing reaches the network, and no model is loaded.

A line placed on its own stretch is measured. When one stretch must carry several lines, the split inside it is a proportional count of effective characters, those cues carry `estimated_within_run`, each is named in `warnings`, and `speech_alignment` stays in `not_checked` rather than certifying the episode. Two defects block as `subtitle_line_coverage` failures: a shot that declares lines whose audio holds no speech, and a shot that speaks while the plan declares no line for it. The SRT is written either way so the operator can inspect what was measured.

Text is the shot script's; splitting it into delivery-length cues is the line plan's decision, so the tool assigns times and never edits words.

## Alternatives considered

**A new `tool-subtitle-timeline` package.** Rejected. The composer package established the pattern of a deterministic tool next to a model-backed one, but this pass reuses the renderer's manifest parsing, shot resolution, timeline layout, and FFmpeg process edge; a separate package would duplicate all four to own one method.

**Keep whole-episode transcription.** Rejected. It solves a global problem the pipeline does not have: the shot boundaries are already known and measured, so aligning the whole episode re-derives by search what the timeline states directly, and its only unique output — the words — is discarded on arrival.

**Recognition with word timestamps.** Rejected. It pays the same recognition cost and carries the same hallucination surface for times the silence profile already gives, and it adds nothing the shot-level placement lacks.

**CTC forced alignment for word-level splits.** Deferred. Word boundaries inside one stretch would remove the estimator, but it needs a Mandarin acoustic model the package does not carry, and an English phone model is not a substitute. The proportional split is reported rather than hidden until that selection happens.

**Silero VAD, or a Python runtime.** Rejected. The sibling composer already detects onsets with FFmpeg `silencedetect`, so the new pass adds no runtime dependency, no interpreter, and no download.

## Consequences

Cue times no longer depend on a Python environment, a downloaded model, or a model license. `faster_whisper` survives only as an optional spot-check that a line was read as written; it no longer participates in cue placement, and the delivery's timing evidence no longer depends on correcting its output.

The renderer now produces the artifact `prepare` consumes and `render` burns. The methods stay separate so the written SRT remains hand-editable between timing and burning.

The estimator stays visible: an episode whose cues all came from detected speech reports `speech_alignment` and drops it from `not_checked`; an episode with proportional splits keeps it in `not_checked` and names every affected shot in `warnings`. Material that was previously silent about the difference now states it.

Speech that is missing or undeclared is reported per shot instead of being discovered while reading a transcript. What the pass still cannot see is a line read wrongly but spoken — that remains a content-review question, and `speech_alignment` covers only the times it measured.

The [episode renderer decision](2026-09-19-drama-episode-render-tool.md) remains active and is extended rather than superseded: this note adds one method to the tool that decision introduced. The [BGM composition decision](2026-09-21-drama-bgm-compose-tool.md) is complementary — both keep a deterministic FFmpeg operation independent of a model-backed sibling.
