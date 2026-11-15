---
kind: upgrade-guide
description: "Rendering with active subtitle_visual now rejects invalid display text, unmeasured or excessive width, and an unconfirmed requested font before body encoding."
---

# Subtitle visual checks can stop delivery

English | [中文](guide.zh.md)

## Change

Rendering with an active `subtitle_visual` previously did not enforce the layout diagnostic. It now returns failed checks for invalid display text, unmeasured or excessive width, or an unconfirmed requested font before encoding the episode body. The existing MP4 and its source record are retained on this failure. Renders without an active visual target keep their legacy behavior. The resolved deployment policy decides whether a target is active; Muse's enforced portrait policy still applies.

Standalone `subtitle_layout` remains diagnostic. With an active visual target, `verify` remeasures the exact supplied SRT and writes separate layout evidence without display normalization or fitting. It does not rewrite the video or SRT or establish which text was burned into the video.

## Migration

1. Keep the original SRT and measured word-time evidence. Without `subtitle_plan`, use `prepare`'s `render_preview.subtitle.path` as the final display candidate. With an audited overlay plan, keep the original SRT and its hash-bound `subtitle_plan` for `render`; use `subtitle_overlay.resolved_srt` for independent `verify` or editable drafts.
2. Inspect `subtitle_layout` with that timeline, final display SRT and delivery configuration. Make the report's `requested_font` available through configured `fontsDir`, and inspect each entry's `fontselect_trace`; do not rely on a substituted font.
3. Use the intended renderer `config.normalizeSubtitleText` and review the resulting display SRT. Enable it when ordinary punctuation or ASS line-break markers must become spaces, then rerun `prepare`. For an overwide line, supply complete same-source `speech_transcripts` so `prepare` can split at measured word starts. Do not invent word times or overwrite the original SRT.
4. Rerun `render` and inspect its checks. For a later `verify`, supply the exact SRT you claim was burned in; a passing report measures that claim, not the video's text pixels. See the [renderer reference](../../../../packages/drama/tool-episode-render/README.md#use-this-package).
