---
kind: upgrade-guide
description: Muse retires bundled manuscript writing skills and changes revision protection to advisory comparison.
---

# Muse manuscript guidance

English | [中文](guide.zh.md)

## Change

Muse provides concise screenplay notation and returned-file guidance in its system prompt. The bundled editing, adaptation, polishing, episode-design, review and screenplay-format skill entries are retired. Default writing presets no longer mount `screenplay_project` or the optional source-review save reminder. `manuscript_revision` reports differences without refusing writes, export or delivery; existing local revision records remain readable.

## Migration

1. Remove custom instructions that require the retired writing skills; describe the task and desired format directly.
2. Use `manuscript_revision` with the real previous and returned files when a comparison is needed. Without a previous version, use the latest file and report that historical edits cannot be identified.
3. Use `office-docx` and `screenplay_export_docx` for Word delivery. Transcription, media, accounting and video-production capabilities retain their own tool requirements.
