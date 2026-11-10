---
kind: upgrade-guide
description: Muse requires current visual, listening and requested-font evidence before short-drama delivery.
---

# Muse content and font acceptance

English | [中文](guide.zh.md)

## Change

Short-drama delivery no longer treats technical render checks, matching ASR text or caller-written approval as complete content review. Projects requiring source review also require current source and output observations covering physical logic and continuity, plus the current output's verified listening answer. Generic working renders remain available; missing evidence keeps delivery pending without automatically opening a user question.

Requested draft fonts no longer silently fall back to the editor's system font. The draft backend retains the requested identity and verifies saved font references. Missing resources or unsupported bindings preserve a repair candidate but do not report successful requested-font delivery. Product `fontsDir` and `subtitleFontFamily` carry bundled fonts without requiring system installation.

## Migration

1. Reload the current draft and rendering skills when continuing an older production session. Keep existing media and paid task identities; these changes do not require video regeneration.
2. Regenerate affected editable drafts with the current native tool and the selected font. Inspect the returned candidate and font state; do not turn a saved repair candidate into delivery by editing its status.
3. Follow the [content review requirements](../../../../packages/drama/tool-episode-render/README.md) for actual source and output observations. Review generated internal cuts as well as joins between packages. Preserve unresolved physical, spoken-content and continuity findings.
4. Reuse a listening answer only for its exact output digest and complete duration. ASR matches and model-written listening declarations do not replace it. Until the configured workflow can establish actual listening, keep the episode pending and continue independent work.
5. Run `stage_delivery` again after a media repair and review. Changed media, subtitles, font resources or reviews invalidate the corresponding prior evidence. Staging retains a digest-bound original native draft for font verification. Later edits in the editor do not invalidate the unchanged reviewed MP4; the edited draft has `modified_unverified` status and is not certified by the original font evidence. Native editor compatibility and creative quality remain separate from file creation.
