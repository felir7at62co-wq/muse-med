---
kind: upgrade-guide
description: Subtitle generation rejects invalid speech intervals and Jianying import requires separately aligned short cues.
---

# Subtitle speech boundaries

English | [中文](guide.zh.md)

## Change

`align_subtitles.py` and `drama_render subtitles` retain measured speech intervals instead of extending short cues or moving later lines. Negative, overlapping, non-positive, or out-of-shot intervals fail validation. Jianying draft import retains each cue's interval and rejects text requiring multiple subtitle lines instead of allocating speech time by character count.

## Migration

1. Review failed alignment documents against the same source media; regenerate invalid intervals with `align_subtitles.py`. Do not shrink or shift timestamps to pass validation.
2. Split long subtitle text in the line plan into cues of at most 14 characters and align each cue separately before importing the SRT into Jianying.
3. Confirm `drama_render subtitles` reports `ok: true`, compare SRT and draft text ranges with measured speech, and listen to the delivered video. Existing reading-speed, source, and delivery checks still apply.
