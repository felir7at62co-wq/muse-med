# Agent Note: the draft build's timeline, gain and subtitle-text contracts

Status: implemented

English | [中文](2026-09-27-draft-timeline-and-subtitle-contracts.zh.md)

## Problem

The Jianying draft for 《山海自有相逢处》第25集 came out with fifteen seconds of picture against 50.208 seconds of audio: three video segments, each `source={start:0,duration:5000000}`, at `target` 0/5 s/10 s. [`jianying_draft.py`](../../../../packages/drama/skills/skills/tweet-drama-draft-build/scripts/jianying_draft.py) read `payload["clips"]`, while the upstream `25.timeline.json` carried `shots` with `start`/`end`. `clips` came back empty, every shot fell back to the file's own `CLIP_DURATION = 5 s`, and no step compared the result with the audio — the same silent default also hid a mismatch between the media pack and the episode. Two further defects rode along. The master audio was written at `audio_segment.volume = 15`, a leftover of the pre-loudnorm workflow, on an input already normalized to a measured −0.6 dBFS peak; a 15× gain clips it. The draft imported `editing/25.srt` verbatim, so its subtitles kept the punctuation and the over-length lines that the burned delivery's own rule forbids, and the draft carried no font field at all.

## Decision

**One timeline shape.** `{"clips": [{"shot": 1, "start_us": 0, "duration_us": 10080000}]}` is the only accepted document — the same one `drama_render prepare` writes to `editing/<集>-timeline.json`, whose `body_end` (50.208 for 第25集) equals the sum of its clips and the measured audio duration. `load_edit_timeline` requires `clips` to be a non-empty list whose entries carry integer `shot`/`start_us`/`duration_us` with `shot > 0`, `start_us >= 0`, `duration_us > 0`, and unique shots; a file carrying `shots` with `start`/`end` is refused by name rather than read. `assert_timeline_matches_audio` requires the sum to match the measured audio within `TIMELINE_TOLERANCE_US` (0.2 s, a few container frames). `DEFAULT_SHOT_DURATION_US` (5 s) survives only for an episode with **no** timeline file: that path warns, and it fails the delivery gate below.

**Unit gain.** `VOICE_VOLUME = 1.0` replaces the hardcoded `15`. The 01_audio master is already loudnorm'd, so the draft applies no gain; `BGM_VOLUME` keeps `pyJianYingDraft`'s own `1.0`.

**One text rule, two renderers.** `normalize_subtitle_text` removes punctuation, splits at semantic groups, packs each line to at most 14 effective characters (a space counts as half) and splits a cue's time range by character weight; `normalize_srt` writes `<草稿目录>/<集>.normalized.srt`, and that file is what the draft imports. Font, size, letter spacing and outline stay the two paths' separate contracts, and both skill documents now carry the same paragraph saying so.

**Delivery gate.** `verify_draft_delivery` reads the JSON `ScriptFile.dumps()` is about to write and refuses to deliver unless the video total equals the audio total, the segment count equals the shot count, no segment uses the default duration, the subtitle count equals the normalized line count, and every subtitle carries the draft style contract's values and already-normalized text. A refusal removes the draft directory this run just created, so a re-run is not blocked by a half-written draft. The same gate refuses an episode with no timeline.

## Alternatives considered

**Accept both shapes (`clips`, else `shots`).** Rejected: the two producers would keep disagreeing, and the reader would keep guessing which one a file is. The generator now names the shape it needs and the producer's own document (`drama_render prepare`) already writes it.

**Derive the draft gain from the input's measured loudness.** Rejected: the input is normalized by construction, so the derivation lands on unit gain; measuring it again in the draft path would import an audio-analysis dependency to reach the value `1.0` and could only ever add gain.

**Normalize `editing/<集>.srt` itself.** Rejected: that file is the render path's input and belongs to the tool that writes it. The draft writes its own normalized copy and the shared rule now names one text contract both paths follow.

**Delete the 5 s default outright.** Rejected: an episode with no timeline still needs a previewable draft. The default is now an explicitly warned, non-deliverable state instead of a silent one.

**Read the written `draft_content.json` back for the gate.** Rejected as redundant: the object checked is the exact JSON `save()` writes (both go through `dumps()`), so a second read would only re-parse the same bytes before they exist.

## Consequences

Runtime drafts no longer carry an implicit assumption about shot length: an episode whose timeline is missing, misnamed or shorter than its audio now fails loudly and leaves no draft behind, which is the point — the previous behavior shipped a 15 s draft that looked successful.

The gate is a hard pre-delivery requirement, so a legitimate future variant (a per-shot default an operator really wants) has to become an explicit input, not a fallback.

Container rounding is unchanged and still visible: `VideoMaterial.duration` reports 10.042 s where ffprobe measures 10.08 s for shot 1 of 第25集, so each shot is clamped to the container and the episode's picture runs 82 ms short of its audio — inside `TIMELINE_TOLERANCE_US`, and now reported by the numbers the gate compares.

## Verification

`npm test` in `packages/drama/skills` passes (91 + 24 + 55 tests, exit 0), including the new `tests/render/test_draft_delivery_contract.py` (8 tests, exit 0): a `shots`/`start`/`end` timeline is refused with no draft directory, each shot takes its own duration from the correct timeline, the audio segment is written at `volume: 1.0`, punctuated input becomes single-line punctuation-free cues whose count matches the draft, and the gate rejects a broken video total, a missing timeline and a missing style field.

Against the real materials of 第25集 (audio/25.wav, media/25/p{1,2,3}.mp4, editing/25.srt, editing/25-timeline.json) the generator wrote video segments at 10.042/20.042/20.042 s against the 50.208 s audio track at `volume 1.0`, twenty-three normalized cues, and passed its own gate. Re-run on the same episode with the timeline's field names swapped to `shots`/`start`/`end`, the pre-fix generator produced three 5.000 s segments (`target` 0/5/10 s, 15.000 s of picture) and an audio segment at `volume 15`, importing the raw 21-cue SRT; the fixed generator refuses that file by name and leaves no draft behind.

[The 2026-09-28 delivery review](2026-09-28-short-drama-delivery-defects.md) owns the outline, watermark and character-state decisions from the same review; this note owns the draft build's inputs.
