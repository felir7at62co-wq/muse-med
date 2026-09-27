---
description: "Validate shot scripts, report creative guidance, and compile asset-bound episode packages within an explicit storyboard duration budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

English | [中文](README.zh.md)

## Summary

Use `drama_shot` to validate director-format scripts, preview package timing, or compile matched JSON and episode files. Long shots, slow delivery, narration and inner monologue are allowed with advisory warnings. Malformed fields, incomplete or unconfirmed bound assets, a character state that disagrees with the asset's own registration, speech above a ceiling the project declares for itself, and packages exceeding the caller's explicit duration budget still prevent compilation. The tool preserves spoken text and speaker identity and makes no provider calls.

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
| `validate` | `script`; optional `assets`, `project`, `episode` | Read-only shot facts, failures and warnings |
| `preview` | `script`, `assets`, `max_submit_seconds`; optional `project`, `episode` | Read-only packaging plan |
| `compile` | Preview inputs plus `project`, `episode` | Matched JSON and episode files; no writes on validation failure |

An `episode` given to any method is kept, so `validate` alone can refuse an asset whose registration does not cover the episode being compiled.

`max_submit_seconds` is the target storyboard's actual requested total duration, including the one-second natural hold. It must already be within the selected model's verified capability. A board configured for 8 seconds requires 8, even if its model supports 30. Existing 15-second boards pass 15 explicitly; a configured 30-second board may pass 30. The compiler does not fetch provider capabilities or silently assume a 14-second content ceiling.

### Character state and the asset's own registration

Every on-screen subject of a `主体状态追踪` block declares its body state as one more per-subject field: `身体状态：【孕早期（孕八周）；孕期职场装；长发】；`, written bare inside that subject's section or with the subject's name in front of it. Two items carry a dimension each — the pregnancy stage and the age band, the two that decide the silhouette — and everything else is state text the registration must contain, costume and hair and an injury or illness alike. A character with no body change writes `非孕期`. `孕八周`, `怀孕8周` and `怀孕十三周` all read as `孕早期`; `十四周` starts `孕中期` and `二十八周` starts `孕晚期`; a bare `孕期` with no week or stage reads as `孕期待定`; two different stages in one declaration read as a contradiction.

The asset that character binds must register the same thing in `state_or_costume`, together with its own name: each dimension must match value for value, and every other item the shot names must appear in the registration. A dimension stated on one side and not the other is `未标阶段`, which fails binding, because nothing then proves which version the shot renders. The registration must also declare `episodes` — a list of episode numbers, or the all-episodes marker `all`/`全剧` — and a call that names an episode refuses an asset whose list does not cover it. This is the gate that the 2026-09-28 《山海自有相逢处》第25集 run lacked: the script read 孕八周 and the bound board was a late-pregnancy body.

When no registered version of a named character states the required dimensions, the failure is a restock request rather than a binding: it names the character, the stage, the costume, the episodes the new asset serves, the versions already registered, and the path that produces it (reuse from the asset library, or generate and register, then `drama_assets reconcile`, then re-validate).

Read the manifest's asset array under `assets` or under `items`: the project's own manifest spells it `items` and the older shot-script copies spell it `assets`.

### Project requirements

Every method reads its project's own requirements: the `project` argument when the call names one, otherwise the nearest `project_config.json` at or above the script, up to four directories — the same ancestor lookup the pipeline's own scripts use. Today the one requirement read is `delivery.max_effective_chars_per_shot`, the project's per-shot ceiling in effective characters. It outranks this tool's built-in numbers: speech above it is a failure rather than a warning, because a project's stated requirement is not advice, and the repair text names both honest ways out — split the line along the original semantics, or change that project's requirement. A project config that declares no such key, or none that parses, leaves the built-in numbers as advice. A key that is present but not a positive integer fails the call instead of being ignored.

### Script and timing

Shots use consecutive `【镜头N】` blocks. An optional `时长：N秒` declares a positive safe integer duration and takes precedence over estimates. Without it, speech uses `max(1, ceil(effective characters / 9))`; silent shots use `动作复杂度：简单/一般/较复杂/复杂` (1/2/3/4 seconds), then the configured fallback. Han characters, Latin letters and digits count; punctuation and spaces do not. Explicit duration lines are excluded from each matched shot's visual prompt.

The result separates `failures` from `warnings`; only failures prevent a packaging plan and writes.

| Check | Outcome |
|---|---|
| More than 15 or 36 effective characters; declared timing differs from estimate | Warning: review pacing and actual speech, without forced splitting |
| More than `delivery.max_effective_chars_per_shot` declared in the project's `project_config.json` | Failure (`speech_exceeds_project_limit`): split along the original semantics, or change that project requirement |
| Narration/inner-monologue declarations | Warning; preserve the complete payload, including colons, as `vo`; use `说话人` to identify its speaker |
| Missing suggested realistic style or fixed negative phrase | Warning; neither phrase is automatically inserted |
| Seconds expressions in shot prose or dialogue | Warning; preserve text, and do not infer duration from prose |
| Missing shot blocks, nonconsecutive numbering, malformed explicit duration | Failure |
| Empty/placeholder dialogue, multiple speech lines, action plus dialogue | Failure; ambiguous speech is not silently discarded |
| Unknown silent-shot complexity or character placeholder | Failure |
| Action complexity alongside speech | Warning: explicit timing wins; otherwise review speech-based timing |
| Unregistered explicit scene, unconfirmed or incomplete bound asset | Failure |
| A manifest row whose `type` is none of the spellings the binder matches | Failure (`asset_type_unusable`): the row binds nothing and no other rule would notice, so the message names the row, the asset, the value read, the accepted spellings and the repair, while the readable rows still take part in the same run |
| A bound character with no `身体状态`, or one that states no dimension | Failure (`shot_body_state_missing`, `shot_body_state_unusable`): declare the state inside that subject's `主体状态追踪` section |
| A registration whose dimensions disagree, whose state carries none, or that omits costume or hair the shot requires | Failure (`asset_state_mismatch`, `asset_state_unregistered`): fix the registration or bind the version that states it |
| A registration that declares no episode, an unreadable one, or one not covering the episode being compiled | Failure (`asset_episodes_unregistered`, `asset_episode_mismatch`) |
| No registered version of a named character states the required dimensions | Failure (`asset_state_missing`) carrying the restock request |
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

The parser collects structural failures and creative warnings; asset binding checks the manifest; the state gate in [`src/state.ts`](src/state.ts) normalizes both sides' declarations and [`src/assets.ts`](src/assets.ts) judges them; the packer enforces an explicit content budget. The registered tool returns these issues through the same canonical JSON report used by validation and compilation. See [`src/script.ts`](src/script.ts), [`src/episode.ts`](src/episode.ts), and [`src/index.ts`](src/index.ts). No runtime invariant companion is published: this package owns no independently changing observation between calls.

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
- Asset matching uses manifest names in fields and prose. A character named on screen whose state nobody declares, and that matches no manifest row at all, is still not rejected; this tool does not verify remote project ownership.
- The state gate compares the declared dimensions and the costume text a shot names. It does not compare the asset's own board image: an asset whose registered text is right and whose picture is not stays the model's review, which the drama skills require before submission.
- Scene is the continuity key; time/costume changes require an explicit package break.
- Writes are prechecked but not transactional across concurrent processes.

<a id="dev-note"></a>
### Dev Note

None.
