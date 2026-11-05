---
kind: upgrade-guide
description: Editable draft watermarks default to UI size 7 and inherit an omitted watermark from a nonempty timeline style.
---

# Editable draft watermark selection

English | [中文](guide.zh.md)

## Change

New photorealistic and legacy editable drafts use watermark UI size 7 instead of 6 when no size is selected. An explicit size such as 6 or 8 stays unchanged. Animation continues to omit the watermark.

A nonempty `timeline.delivery.draft_style` that omits `watermark` now inherits the project's `project_bible.delivery.draft_style.watermark`. For example, a project watermark of 8 and a subtitle-only timeline style now select watermark 8. Subtitle fields still follow their existing snapshot selection and product enforcement policy. An explicit whole-section `draft_style: {}` resets all draft styles; `watermark: {}` resets only the watermark to the new default.

Windows native readback adds `verification.watermark_font_size` with requested/saved UI values and `matched`, `mismatch` or `unverified` status. Missing, nonfinite or different saved sizes add review warnings while retaining the candidate. Existing source, content and timing checks still apply. Saved-file verification does not establish native-editor appearance.

## Migration

1. Keep existing drafts, timeline files and source media. No automatic rewrite is required or performed.
2. Review subtitle-only timeline styles alongside the project's watermark section. To retain UI size 6, explicitly select `"watermark": {"font_size_ui": 6}` in the chosen draft-style section. Use `"watermark": {}` for the default 7; use `"draft_style": {}` only when you intend to reset the entire section.
3. For a requested new candidate, choose a unique `name_prefix`. Read the saved draft and `muse-review.json`; on Windows native output, inspect watermark size status and warnings without treating a size warning as a failed save. Preview the result in Jianying before accepting its appearance.
