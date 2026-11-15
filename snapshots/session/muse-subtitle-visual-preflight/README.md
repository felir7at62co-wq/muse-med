---
description: "Keyless Native tool coverage of subtitle preflight refusal, preserved delivery files and a corrected render."
kind: "reference"
---

# Subtitle visual preflight

English | [中文](README.zh.md)

This authored scenario loads the production `drama_render` tool through the ordinary Loader and shipped Headless profile. The Native executor first requests rendering with controlled external font-selection evidence that names a fallback. The actual preflight returns `ok: false` with `subtitle_display_font` before any body encoding command.

Assertions retain the previous MP4 and its valid source record byte for byte, with unchanged device and inode. A second call uses matching controlled font-selection evidence and a distinct output path; the production renderer publishes its output and a source record whose hash matches the actual written bytes. Both actual results reach subsequent model requests, and `workspace.expected/subtitle-preflight-proof.json` records the verified observations. The source SRT remains unchanged throughout.

The [PTC sibling](../muse-subtitle-visual-preflight-ptc/README.md) exercises the same assertions through programmatic tool calling. Media execution, glyph bounds and font-selection lines are controlled fixture inputs, not real decoding, glyph, encoding or visual-quality evidence. The separate episode-render owners use pinned bundled FFmpeg, Zhuque and Noto fonts for those technical checks. Private project files remain under the ignored `.dsh` workspace; the canonical Session and its prompt/schema sidecars belong to this scenario.
