---
description: "Validate shot scripts, report creative guidance, and compile asset-bound episode packages within an explicit storyboard duration budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

English | [中文](README.zh.md)

## Summary

Use `drama_shot` to validate director-format scripts, preview package timing, or compile matched JSON and episode files. Long shots, slow delivery, narration and inner monologue are allowed with advisory warnings. Malformed fields, incomplete or unconfirmed bound assets, and packages exceeding the caller's explicit duration budget still prevent compilation. The tool preserves spoken text and speaker identity and makes no provider calls.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside the tool registry in the drama preset. `actionShotSeconds` defaults to 2 and accepts whole seconds from 1–4; it estimates silent shots without explicit duration or complexity, not a maximum shot length.

| Method | Required inputs | Result |
|---|---|---|
| `validate` | `script`; optional `assets` | Read-only shot facts, failures and warnings |
| `preview` | `script`, `assets`, `max_submit_seconds` | Read-only packaging plan |
| `compile` | Preview inputs plus `project`, `episode` | Matched JSON and episode files; no writes on validation failure |

`max_submit_seconds` is the target storyboard's actual requested total duration, including the one-second natural hold. It must already be within the selected model's verified capability. A board configured for 8 seconds requires 8, even if its model supports 30. Existing 15-second boards pass 15 explicitly; a configured 30-second board may pass 30. The compiler does not fetch provider capabilities or silently assume a 14-second content ceiling.

### Script and timing

Shots use consecutive `【镜头N】` blocks. An optional `时长：N秒` declares a positive safe integer duration and takes precedence over estimates. Without it, speech uses `max(1, ceil(effective characters / 9))`; silent shots use `动作复杂度：简单/一般/较复杂/复杂` (1/2/3/4 seconds), then the configured fallback. Han characters, Latin letters and digits count; punctuation and spaces do not. Explicit duration lines are excluded from each matched shot's visual prompt.

The result separates `failures` from `warnings`; only failures prevent a packaging plan and writes.

| Check | Outcome |
|---|---|
| More than 15 or 36 effective characters; declared timing differs from estimate | Warning: review pacing and actual speech, without forced splitting |
| Narration/inner-monologue declarations | Warning; preserve the complete payload, including colons, as `vo`; use `说话人` to identify its speaker |
| Missing suggested realistic style or fixed negative phrase | Warning; neither phrase is automatically inserted |
| Seconds expressions in shot prose or dialogue | Warning; preserve text, and do not infer duration from prose |
| Missing shot blocks, nonconsecutive numbering, malformed explicit duration | Failure |
| Empty/placeholder dialogue, multiple speech lines, action plus dialogue | Failure; ambiguous speech is not silently discarded |
| Unknown silent-shot complexity or character placeholder | Failure |
| Action complexity alongside speech | Warning: explicit timing wins; otherwise review speech-based timing |
| Unregistered explicit scene, unconfirmed or incomplete bound asset | Failure |
| No scene binding | Warning |
| One indivisible shot longer than `max_submit_seconds - 1` | Failure (`shot_exceeds_package_budget`), never truncate a shot |

Packing preserves complete continuous shots, splits on scene changes or `子任务边界：是`, and ensures content plus one-second hold fits the explicit budget. Review `submit_seconds` against the actual storyboard before submission; compilation does not change its stored duration.

### Files

Compilation writes `prompts/<episode>.txt`, `matches/<episode>.matched.json`, and `episode_packages/<episode>/` containing `package.json`, `shot_script.txt`, `matched.json`, `episode.txt`, and local bound assets. Episode numbers are padded to two digits. The prompt file is a source copy; matched shot visuals omit duration fields. Missing episode text or local asset files fails before writes begin. Results include every written path, per-shot timing, package durations and ordered material keys.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The parser collects structural failures and creative warnings; asset binding checks the manifest; the packer enforces an explicit content budget. The registered tool returns these issues through the same canonical JSON report used by validation and compilation. See [`src/script.ts`](src/script.ts), [`src/assets.ts`](src/assets.ts), [`src/episode.ts`](src/episode.ts), and [`src/index.ts`](src/index.ts). No runtime invariant companion is published: this package owns no independently changing observation between calls.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_shot` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) records the method schema. Results expose `shots`, `packages`, `failures`, `warnings`, `written` and summary counts. Warnings carry an actionable message and never require deleting or rewriting spoken text. `duration_source: declared` identifies explicit timing.

#### Token effect

The schema is fixed; results grow with shots, packages and issues. Failures suppress packaging and writes but retain diagnostic rows.

#### KV Cache effect

Tool results append without rewriting previous messages. Changes to the tool description or schema change the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compilation is local. The caller supplies the verified storyboard budget; paid submission must independently validate actual model settings and subject identity.
- Estimates are not measured audio timing. Review recorded speech before final editing and delivery.
- Asset matching uses manifest names in fields and prose. Unmatched character names are not rejected; this tool does not verify remote project ownership.
- Scene is the continuity key; time/costume changes require an explicit package break.
- Writes are prechecked but not transactional across concurrent processes.

<a id="dev-note"></a>
### Dev Note

None.
