---
description: "Package map for the short-drama pipeline family: the shot-script gate and episode compiler a drama preset mounts, for users and maintainers running or composing the Jubian drama pipeline."
kind: "package-group"
---

# drama/ — the short-drama pipeline family

English | [中文](README.zh.md)

## Summary

The `drama/` group holds the short-drama pipeline's own formats and the operations over them. `tool-shot-script` registers `drama_shot`, which judges a director-format shot script against this format's rules, previews the 14-second package budget, and compiles the matched JSON and the single-episode package. `tool-episode-render` registers `drama_render`, which lays out the render inputs, encodes the episode to the operator-approved 1440x2560 delivery, and checks the delivered file. The group stays narrow: what a shot should look like is teaching and belongs to the drama skills, while what makes a script uncompilable, and what a delivered file must measure, are decisions this pipeline settles.

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
| [`tool-episode-render/`](tool-episode-render/README.md) | The model-facing `drama_render` tool: the render-input layout, the fixed 1440x2560 delivery with its subtitle and audio style, the proved two-second ending, and the post-render checks |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tool subsystem the packages register into, then the generated schema the model receives.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the execution pipeline `drama_shot` and `drama_render` enter.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) — the exact `drama_shot` schema and description a mounted row contributes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-render) — the exact `drama_render` schema and description a mounted row contributes.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
