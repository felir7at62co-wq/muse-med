---
description: "Package map for the short-drama pipeline family: asset checks, shot planning, BGM composition, episode rendering, and settings mounted by a drama preset."
kind: "package-group"
---

# drama/ — the short-drama pipeline family

English | [中文](README.zh.md)

## Summary

The `drama/` group holds the short-drama pipeline's formats, operations, and settings. Its tools transcribe authorized media through the signed-in Muse account, reconcile remote assets, validate and compile shot scripts, turn explicit story segments into a measured BGM bed, and render medium-controlled episode delivery. `drama-settings` owns the durable directory, delivery-spec, BGM-library, image-standard, and per-series budget settings plus their Web editor. Creative shot and music choices remain in the drama skills and agent workflow.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | What it provides |
|---|---|
| [`character-asset-catalog/`](character-asset-catalog/README.md) | Source-scoped character metadata adaptation and image byte verification through a caller-owned reader, without approval or storage writes |
| [`screenplay-project/`](screenplay-project/README.md) | Source-backed writing, independent fact and episode review, generated source references, and resumable character knowledge |
| [`session-video/`](session-video/README.md) | Session-bound video inventory, authorized media access, and visual cut detection with source-version checks |
| [`tool-audio-transcribe/`](tool-audio-transcribe/README.md) | The model-facing `audio_transcribe` tool: account-bound cloud transcription of local media with durable job receipts and versioned transcripts |
| [`tool-drama-tos-upload/`](tool-drama-tos-upload/README.md) | The model-facing `drama_tos_upload` tool: stores one drama's source videos and transcription materials in dated Volcengine TOS folders without overwriting or deleting remote objects |
| [`tool-shot-script/`](tool-shot-script/README.md) | The model-facing `drama_shot` tool: strict script compilation by default, or advisory content checks, package suggestions and separate review drafts in Muse Short Drama |
| [`bgm-license-info/`](bgm-license-info/README.md) | Music-rights declarations, explicit unknown metadata and advisory intended-use conflicts shared by catalog and rendering consumers |
| [`tool-bgm-compose/`](tool-bgm-compose/README.md) | The model-facing `drama_bgm` tool: source analysis, deterministic crossfaded composition, no-clobber publication, and fixed WAV verification |
| [`tool-episode-render/`](tool-episode-render/README.md) | The model-facing `drama_render` tool: the render-input layout, project-canvas delivery with subtitle and audio style, medium-controlled ending and watermark, and the post-render checks |
| [`drama-settings/`](drama-settings/README.md) | The durable `drama` settings section every other row reads, plus its Web GUI surface: the Settings page and that page's read-only component list |
| [`character-library/`](character-library/README.md) | Bounded Host-owned browsing, preview and recommendation for character references |
| [`character-library-tos/`](character-library-tos/README.md) | Reviewed public character references read from fixed Volcengine TOS prefixes with bounded List, Head, and ranged Get operations |
| [`tool-character-reference/`](tool-character-reference/README.md) | The model-facing `drama_character_references`, `drama_character_reference_view` and `drama_character_reference_project` tools: bounded character-reference search and verified image inspection, without exposing storage locations or granting use permission |
| [`tool-drama-assets/`](tool-drama-assets/README.md) | The model-facing `drama_assets` tool: pre-spend reconciliation of the Jubian project's used assets against the manifest, the evidence the paid-call gate reads, and a recorded disposition per unregistered asset |
| [`skills/`](skills/README.md) | Portable skill resources that search historical drama assets, maintain project state, and assemble confirmed whole-drama deliveries |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tool subsystem the packages register into, then the generated schema the model receives.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the execution pipeline `drama_shot` and `drama_render` enter.
- [Settings subsystem reference](../../docs/subsystems/settings.md) — the namespace seam that owns the `drama` section, its resolution order, and the browser transport the page writes through.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-audio-transcribe) — the exact `audio_transcribe` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) — the exact `drama_shot` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-bgm-compose) — the exact `drama_bgm` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-render) — the exact `drama_render` schema and description a mounted row contributes.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
