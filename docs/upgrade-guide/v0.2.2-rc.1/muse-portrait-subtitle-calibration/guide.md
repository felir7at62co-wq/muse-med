---
kind: upgrade-guide
description: Muse portrait direct-render subtitles use a smaller default font and thinner outline.
---

# Muse portrait subtitle calibration

English | [中文](guide.zh.md)

## Change

Muse packaged Desktop and its `creation` and `short-drama` presets change the direct-render portrait subtitle default from 48px font size with a 2px black outline to 46px with a 1.25px outline on the 480×854 reference canvas. Output typography scales with delivery height. The bundled Zhuque font, centre position and usable width remain unchanged.

The existing portrait enforcement policy still ignores persisted project or timeline subtitle overrides. Landscape and square deliveries retain their existing style selection. This calibration does not change Jianying UI font-size or outline units, word timing, text normalization or ending-fit behavior. Existing exports are not rewritten.

## Migration

1. Keep existing project, timeline, subtitle, Session and exported files; no stored-data rewrite is required.
2. When a new portrait export is requested, render to a new output path with the updated Muse build. Use `drama_render` method `subtitle_layout` to inspect actual font selection and width evidence, then check a frame from the resulting export.
3. If you maintain a separate deployment composition, review its `tool-episode-render` configuration's `defaultSubtitleVisual.font_size_px` and `outline_px`. The shipped defaults are in `apps/desktop-host/presets/creation/agent.cordis.yml` and `apps/desktop-host/presets/short-drama/agent.cordis.yml`; packaged Desktop supplies the same values through `MUSE_DEFAULT_SUBTITLE_VISUAL`. Keep your intended enforcement policy explicit.
