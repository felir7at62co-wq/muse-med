---
kind: reference
description: "Complete LocalMiniDrama episode assembly, verification and recovery for multiple production packages."
---

# Complete episode assembly

English | [中文](episode-merge.zh.md)

An episode contains an ordered collection of independently generated storyboard packages. A model's single-generation duration limit does not limit episode duration. `planEpisodeMerge` removes the fixed 100-clip ceiling; its local FFmpeg concat list accepts every selected package within configured resource limits.

## Completion and recovery

The merge requires every current storyboard exactly once, in storyboard order, with its adopted, locally saved video. Missing clips, different selected media, unreadable files and incompatible codec, picture, audio or timestamp parameters fail explicitly. This implementation does not silently normalize incompatible sources or substitute the first clip.

FFprobe measures source frames and duration. The output must contain the summed video frame count and measured duration within the configured tolerance, and FFmpeg must decode its complete video and audio. Task verification records every storyboard, source SHA256, frame count and duration, plus the output SHA256. Card duration fields are not treated as measured media. These checks establish complete technical assembly; visual continuity, dialogue and final delivery still require review.

Without post-processing options, video uses stream copy and selected embedded audio is aligned to the concat clock and encoded as AAC, rather than discarded; original files remain unchanged. Explicit dialogue/narration options use already adopted audio files; they never call a TTS supplier. Missing required audio, speech longer than its clip, absent requested narration text, invalid font resources or failed subtitle, watermark or audio processing leave the merge failed. Empty slots may be padded only when their corresponding speech text is empty; requesting dialogue for an episode with no adopted dialogue audio fails. Requested audio replaces the merged audio track; it is not an automatic background mix.

Only a fully verified output updates the episode. A changed storyboard inventory, adopted video or episode output during processing refuses stale publication. Failures preserve source generations and any verified raw candidate in the original task's `recoverable_candidate_url`; the candidate is not adopted as the final episode. Repair the source/options before requesting another free merge. Re-composition does not resubmit image, video or speech generation.

Each attempt uses a private temporary directory and UUID output names. Temporary files are removed after success or failure. Publication uses an exclusive hard link on the storage filesystem, so it cannot overwrite an existing output. Original and derived verified files remain available for inspection.

## Deployment limits

Set the following optional fields under the private companion configuration's `muse_merge` section. These constrain resources, rather than package count or model generation duration.

| Field | Default | Accepted values |
|---|---|---|
| `timeout_ms` | 900000 | Integer, 1000–3600000; total validation, assembly and post-processing deadline |
| `max_input_bytes` | 2147483648 | Integer, at least 1024; summed selected source bytes |
| `max_output_bytes` | 2147483648 | Integer, at least 1024; verified output ceiling |
| `duration_tolerance_ms` | 250 | Integer, 1–5000 |
| `max_process_bytes` | 2097152 | Integer, 1024–16777216; combined subprocess diagnostics |
| `font_file` | Automatic system font | Optional administrator-selected TrueType/OpenType font file for watermarks |

FFmpeg, FFprobe and storage hard-link support are required. Burning narration into video requires the FFmpeg subtitles filter, which reads the generated UTF-8 subtitles. Subprocesses run asynchronously, accept local file protocols only and are awaited through timeout termination. Disk ceilings are checked admission/output limits, rather than OS hard quotas. Heterogeneous sources need an explicit normalization step before this merge path.

## Verification

Run `node --test integrations/localminidrama/tests/episode-merge.test.mjs` with the pinned backend dependencies and FFmpeg/FFprobe installed. The fixture uses real SQLite, generated local video/audio and a 103-package episode; it decodes every ordered frame, verifies measured duration, tests missing/corrupt/incompatible sources, failed requested post-processing, concurrent adoption changes and distinct retained outputs. It makes no supplier or paid API call.
