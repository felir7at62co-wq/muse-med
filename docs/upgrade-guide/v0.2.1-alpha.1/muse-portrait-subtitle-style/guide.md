---
kind: upgrade-guide
description: Packaged Muse portrait rendering replaces legacy subtitle style overrides with the product visual configuration.
---

# Muse portrait outputs use the product subtitle style

English | [中文](guide.zh.md)

## Change

Packaged Muse uses its bundled Zhuque Fangsong font and product visual configuration for portrait short-drama output. Existing project and timeline `subtitle`, `subtitle_visual`, and `draft_style.subtitle` overrides no longer select the output style in this path. Editable Jianying drafts use independently calibrated editor defaults rather than copying FFmpeg font-size units. Existing source files and project configuration are preserved. Landscape and square layouts retain their style resolution rules; integrations without `enforceSubtitleVisual` retain existing override behavior.

The display candidate removes ordinary dialogue punctuation and line breaks, retaining meaningful numeric separators and word-internal apostrophes or hyphens. Punctuation-only cues are omitted with review information. Long cues are split only when usable measured width and matching word times are available; otherwise they remain for review. An entirely empty derived SRT still requires the draft importer to receive valid subtitle input. This policy does not remove captions already burned into source video or apply to arbitrary shell FFmpeg commands.

## Migration

1. Generate a new preview through Muse's standard `drama_render` workflow. Use the returned display subtitle candidate for the editable draft; preserve the original SRT.
2. Compare the actual MP4 and a reopened Jianying draft, including a long line. Confirm font selection, position, size, timing and editable text rather than relying on saved configuration values.
3. Apply a separately requested custom subtitle appearance in the editable Jianying draft. Existing finished videos require a new render to adopt the product style; upgrading does not rewrite them.
