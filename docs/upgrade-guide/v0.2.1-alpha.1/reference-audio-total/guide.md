---
kind: upgrade-guide
description: "Storyboard reference audio groups with known durations exceeding fifteen seconds now fail before binding or paid generation."
---

# Reference audio total duration

English | [中文](guide.zh.md)

## Change

Previously each audio reference was checked independently against a fifteen-second limit. Now the known durations of the whole reference audio group must sum to at most fifteen seconds. This affects callers of audio binding, preserved-image selection and native video preparation. Existing files are not rewritten. Unknown durations remain unverified; a missing value is not a zero-duration reference.

## Migration

1. Measure each selected reference and retain its actual `audioDuration`.
2. Extract about two seconds of the character's actual speech for each reference. Background sound may remain; do not upload an entire long mixed soundtrack as a voice sample.
3. Keep the total within fifteen seconds, reducing sample lengths or selecting the references needed for this package. Preserve the original storyboard and paid-operation IDs.
4. Run the existing audio preview and readback. An over-budget group must be rejected before a binding PUT or video submission. Missing measurements must not be described as a verified budget.
