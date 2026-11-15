---
kind: upgrade-guide
description: "Active subtitle visuals now require measured single-line display width and the selected delivery font before rendering or verification can pass."
---

# Active subtitle visuals require passing display checks

English | [中文](guide.zh.md)

## Change

`drama_render` previously treated subtitle glyph measurements as advice even when `subtitle_visual` was active. `render` and `verify` now return failure-severity checks for forced line breaks, ordinary punctuation, overwidth, unavailable measurements or an unconfirmed selected font. Failed render preflight returns `ok: false` and an empty `output` before episode encoding, preserving existing deliveries. Deployments without an active visual profile retain their previous behavior; standalone `subtitle_layout` remains diagnostic.

## Migration

1. Enable `normalizeSubtitleText` for ordinary dialogue punctuation and physical or literal ASS `\N`/`\n` breaks. Read `render_preview.subtitle.path` and use that final display SRT for rendering and the editable draft. Original SRT files and cue times remain unchanged; meaningful numeric separators remain intact.
2. Keep the configured font installed and readable in `fontsDir`. For Muse direct output, retain the bundled Zhuque Fangsong font. Check `subtitle_display_font` and its saved libass logs rather than accepting a system fallback.
3. Resolve `subtitle_display_width` using actual source-bound word times. Without complete evidence, keep the text and timings pending review; do not shrink fonts, switch faces or divide time by character counts.
4. Render again and verify the existing MP4 against the exact display SRT claimed to be burned in. Verification never normalizes that input or rewrites the MP4. Confirm `ok: true` and passing `subtitle_display_*` checks, then review synchronization and the reopened editable draft separately.
