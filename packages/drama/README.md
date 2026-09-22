---
description: "Package map for the short-drama pipeline family: asset checks, shot planning, BGM composition, episode rendering, and settings mounted by a drama preset."
kind: "package-group"
---

# drama/ — the short-drama pipeline family

English | [中文](README.zh.md)

## Summary

The `drama/` group holds the short-drama pipeline's formats, operations, and settings. Its tools reconcile remote assets, validate and compile shot scripts, turn explicit story segments into a measured BGM bed, and render the fixed episode delivery. `drama-settings` owns the durable tier, directory, delivery, and BGM-library settings plus their Web editor. Creative shot and music choices remain in the drama skills and agent workflow.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | What it provides |
|---|---|
| [`tool-shot-script/`](tool-shot-script/README.md) | The model-facing `drama_shot` tool: script validation with hard failures and warnings separated, the package budget preview, and the matched JSON and episode package compile |
| [`tool-bgm-compose/`](tool-bgm-compose/README.md) | The model-facing `drama_bgm` tool: source analysis, deterministic crossfaded composition, no-clobber publication, and fixed WAV verification |
| [`tool-episode-render/`](tool-episode-render/README.md) | The model-facing `drama_render` tool: the render-input layout, the fixed 1440x2560 delivery with its subtitle and audio style, the proved two-second ending, and the post-render checks |
| [`drama-settings/`](drama-settings/README.md) | The durable `drama` settings section every other row reads, plus its Web GUI surface: the Settings page and that page's read-only component list |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tool subsystem the packages register into, then the generated schema the model receives.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the execution pipeline `drama_shot` and `drama_render` enter.
- [Settings subsystem reference](../../docs/subsystems/settings.md) — the namespace seam that owns the `drama` section, its resolution order, and the browser transport the page writes through.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) — the exact `drama_shot` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-bgm-compose) — the exact `drama_bgm` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-render) — the exact `drama_render` schema and description a mounted row contributes.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
