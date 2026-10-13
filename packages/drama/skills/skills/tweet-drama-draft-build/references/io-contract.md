# Draft build I/O contract

Input:

- The validated `path` returned by `drama_draft_dir`, passed as `drafts_dir`. Read Settings before draft creation; ask for the installed editor root only when missing or invalid, save through the tool, and use its readback. Existing draft names refuse replacement; choose a unique prefix for a new candidate.
- Ordered reviewed Jubian videos with subtitle_cleanup=clean or not_required; pending requires explicit draft=True and an unfinished-preview label.
- Shot/task source mapping, original spoken text, speech_type and speaker identity: dialogue, vo, os, 心声, 旁白 and 解说 are retained when actually voiced. Actions and unvoiced descriptions are not subtitles.
- Complete actual_speech_start/end audio evidence for every final spoken cue. Only explicit drafts may use marked 9-effective-characters-per-second estimates.
- Project root and an approved per-episode BGM mix containing at least two emotion-matched tracks; keep the segment selection and listening record with the project.
- One timeline per episode at `05_timeline/<episode>.timeline.json`, with `clips: [{shot: 1, start_us: 0, duration_us: 10080000}]` and optional `body_end` in seconds, matching the document written by `drama_render prepare`. Clips must cover a continuous body timeline and match the measured main audio within 0.2 s. Missing or invalid clips fail; there is no deliverable based on default shot durations. Optional `canvas: {width: 2560, height: 1440}` selects a landscape canvas; the default is 1440×2560.
- A two-second ending is appended by default. If the last input clip already contains the ending, retain the original `body_end`: it must be exactly two seconds before the last clip's end. The draft replaces those two seconds with an editable image clip without lengthening the programme or adding ending sound again. Do not identify an existing ending by filename, audio length, or a static scene alone.
- Optional selected ending files, shared with the final render, at `06_ending/ending_audio.mp3` and `06_ending/ending_effect.mp4`, or supplied as `ending_audio` and `ending_effect` to `prepare_materials`. They occupy separate tracks from `body_end`, at normal speed, trimmed to two seconds. `06_ending` is excluded from all BGM directory detection and fallback scans; its audio must not also start at zero as BGM. The effect uses screen blending. No ending audio is added when the input's full-length main audio already covers an explicitly included ending.
- A subtitle file with separately aligned cues that follow the shared text rules (one line, at most 14 effective characters). The draft path removes punctuation and writes `<draft>/<episode>.normalized.srt` without changing cue times. An unsplit long cue fails before draft creation; split the line plan and rerun recognition alignment instead of distributing time by character count. The burned delivery follows the same text rules.

Output:

- Editable draft with body video clips, a separate two-second tail-frame image clip, and an independent lower-right white text track reading exactly `内容由AI生成` for the entire programme including the ending. No top-right notice is added; the AI notice is not a speech subtitle and does not enter the SRT.
- `Resources/last_video_tail_frame.png` and `ending-evidence.json` record the selected source interval, source/image SHA-256, last decoded RGB frame MD5, body end, total duration, and whether an input ending was already included. The image must match the last decoded frame of the interval actually placed in the draft; a same-numbered storyboard PNG cannot substitute for it.
- Ordered media manifest, SRT, preview MP4 and warnings.
- Subtitle cues only for actual spoken content, preserving original text and speaker.
- No additional transitions or effects beyond an explicitly selected ending effect.

Generation duration and resolution follow the current selected model and project, not fixed historical shot limits. Export dimensions are separate from source resolution and paid enhancement. See the two skills' SKILL.md files for review requirements and delivery styling.
