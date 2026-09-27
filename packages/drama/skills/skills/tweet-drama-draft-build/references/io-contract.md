# Draft build I/O contract

Input:

- Ordered reviewed Jubian videos with subtitle_cleanup=clean or not_required; pending requires explicit draft=True and an unfinished-preview label.
- Shot/task source mapping, original spoken text, speech_type and speaker identity: dialogue, vo, os, 心声, 旁白 and 解说 are retained when actually voiced. Actions and unvoiced descriptions are not subtitles.
- Complete actual_speech_start/end audio evidence for every final spoken cue. Only explicit drafts may use marked 9-effective-characters-per-second estimates.
- Project root and an approved per-episode BGM mix containing at least two emotion-matched tracks; keep the segment selection and listening record with the project.
- One timeline per episode at `05_timeline/<episode>.timeline.json`, shaped `{"clips": [{"shot": 1, "start_us": 0, "duration_us": 10080000}]}` — the same document `drama_render prepare` writes to `editing/<episode>-timeline.json`. Shot durations must add up to that episode's measured audio duration within 0.2 s. `jianying_draft.py` refuses a missing `clips`, a non-integer clip, a shot the media pack does not cover, or a total that disagrees with the audio; it never falls back to a per-shot default duration. The 5 s default stays only for an episode with no timeline file at all, warns, and fails the pre-delivery check.
- A subtitle file whose text follows the shared text rules (punctuation removed, split by semantic group, one line, at most 14 effective characters). The draft path normalizes it into `<draft>/<episode>.normalized.srt`; the burned delivery follows the same rules.

Output:

- Editable draft, ordered media manifest, SRT, preview MP4 and warnings.
- Subtitle cues only for actual spoken content, preserving original text and speaker.
- No transitions or effects unless the project style explicitly requires them.

Generation duration and resolution follow the current selected model and project, not fixed historical shot limits. Export dimensions are separate from source resolution and paid enhancement. See the two skills' SKILL.md files for review requirements and delivery styling.
