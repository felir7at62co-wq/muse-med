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

`max_submit_seconds` is the explicit per-package submission ceiling chosen within the project's selected model capability, including at least one second of natural hold. Seedance 2.0 permits 4–15 total seconds and Seedance 2.5 permits 4–30 for verified model revisions. Set each storyboard's actual duration to its package's returned `submit_seconds`; do not copy this ceiling to every storyboard. The compiler does not fetch provider capabilities.

### Character state and the asset's own registration

Every on-screen human subject of a `主体状态追踪` block declares its body state as one more per-subject field: `身体状态：【孕早期（孕八周）；孕期职场装；长发】；`, written bare inside that subject's section or with the subject's name in front of it. Two items carry a dimension each — the pregnancy stage and the age band, the two that decide the silhouette — and everything else is state text an appearance registration must contain, costume and hair and an injury or illness alike. A character with no body change writes `非孕期`. `孕八周`, `怀孕8周` and `怀孕十三周` all read as `孕早期`; `十四周` starts `孕中期` and `二十八周` starts `孕晚期`; a bare `孕期` with no week or stage reads as `孕期待定`; two different stages in one declaration read as a contradiction.

The asset that character binds must register the same pregnancy and age dimensions in `state_or_costume`, together with its own name. An appearance registration must also contain every other state item the shot names. A dimension stated on one side and not the other is `未标阶段`, which fails binding because the version is unresolved. The registration must declare `episodes` — a list of episode numbers, or the all-episodes marker `all`/`全剧` — and a call that names an episode refuses an asset whose list does not cover it.

When no registered version of a named character states the required dimensions, the failure is a restock request rather than a binding: it names the character, the stage, the costume, the episodes the new asset serves, the versions already registered, and the path that produces it (reuse from the asset library, or generate and register, then `drama_assets reconcile`, then re-validate).

Read the manifest's asset array under `assets` or under `items`: the project's own manifest spells it `items` and the older shot-script copies spell it `assets`.

An explicit `出镜人物` list determines which humans bind by exact canonical or registered alternate names; a name contained in another person's name does not qualify. Without it, the binder reads visual directions and excludes dialogue, speaker metadata, `核心场景` and `关键道具` fields. Registered location and prop names or aliases in camera and position descriptions do not establish a visible person: `李军家` and `李军的碗` do not bind 李军. Independent character actions and subject tracking remain eligible, and a shorter prop name does not erase a containing character name such as 老算盘. Canonical names and declared aliases (a delimited string or name array) resolve to registered assets; longer names suppress contained short names. An unqualified character name can select one costume version only when episode coverage and declared body state make it unique. Multiple eligible versions return `asset_binding_ambiguous` with candidate identities and a repair; name the intended full asset or correct its registration. Unknown names in an explicit on-screen list return `unregistered_character`. Body-part and pose descriptions remain usable with the same subject's registered state. `关键道具：无` suppresses prop inference.

`character_name` can declare the stable story identity shared by versions whose provider labels differ. Different people must not share this identity.

A character portrait explicitly registered with `reference_scope: "identity"` supplies identity rather than clothing: shot-authored costume, makeup, pose and expression remain in the prompt. Body stage and age still have to agree. A compatible appearance-specific version takes priority over this fallback. Omission or `"appearance"` retains strict registered costume matching. Do not label a costume-specific board as an identity portrait to bypass a mismatch.

Register recurring animal subjects as `type: "动物"` / `"animal"`, or keep `type: "角色"` / `"character"` with `subject_kind: "animal"`. Their canonical names and aliases also bind from visual directions when a human roster is present; dialogue-only mentions do not. Animals appear in the package's material names and keys and retain official confirmation, IDs, URL and episode checks. Bound animal classification is retained through repeated packaging and never contributes to human headcounts, even with a body-state declaration. They do not require a human pregnancy, age or costume declaration. A role row with no `subject_kind` keeps human state checks; the binder does not guess species from a name. Distinguish multiple animal versions with full names or non-overlapping episode coverage.

Every previewed or compiled package returns `prompt` with the complete shot directions, named character/scene/prop references and the natural hold instruction. Existing references normalize registered aliases to canonical names and reuse one key per asset; missing references use `asset_<jubian_asset_id>`. Authored references to another identity, a wrong parent key, or a key shared by different actors return `material_reference_mismatch`. `material_bindings` explicitly maps each first-seen key to its name, parent ID, material ID, URL and reference scope; use these rows for selections rather than zipping `material_keys` and `material_names`. Repeated mentions share one material. Identity explanations remain singular per asset within each shot when prompt completion is repeated, including when the packer has no original manifest. Matched output version 5 includes these rows. A separate `validate` call is optional; `preview` and `compile` perform the same checks.

Prompt completion states each shot's selected human identities and an upper headcount, allowing close framing and occlusion without forcing everyone into view. Recompilation replaces previous derived cast limits with the current selection. An empty cast remains empty; offscreen voices, source-scene rosters and other shots do not add people. Faces, clothing boards and multiple views of one asset describe one person, including across shots. Identity guidance preserves distinguishing facial features and age while respecting explicit changes and the selected official version. Prop guidance preserves the selected image's shape, structure, material and colour rather than replacing it from a generic name. These are generation instructions: the compiler does not inspect pixels, invent a beard or material, or guarantee the generated result.

### Project requirements

Every method reads its project's own requirements: the `project` argument when the call names one, otherwise the nearest `project_config.json` at or above the script, up to four directories — the same ancestor lookup the pipeline's own scripts use. Today the one requirement read is `delivery.max_effective_chars_per_shot`, the project's per-shot ceiling in effective characters. It outranks this tool's built-in numbers: speech above it is a failure rather than a warning, because a project's stated requirement is not advice, and the repair text names both honest ways out — split the line along the original semantics, or change that project's requirement. A project config that declares no such key, or none that parses, leaves the built-in numbers as advice. A key that is present but not a positive integer fails the call instead of being ignored.

### Script and timing

Shots use consecutive `【镜头N】` blocks. An optional `时长：N秒` declares a positive safe integer duration and takes precedence over estimates. Without it, speech uses `max(1, ceil(effective characters / 8))`; silent shots use `动作复杂度：简单/一般/较复杂/复杂` (1/2/3/4 seconds), then the configured fallback. Han characters, Latin letters and digits count; punctuation and spaces do not. Explicit duration lines are excluded from each matched shot's visual prompt.

A standalone `场次54-1：地点 时段 内/外` heading applies to subsequent shots until the next such heading; it never enters the previous shot. Each affected prompt retains the literal heading before any `｜` or `|` annotation as `来源场次（原文段落）` context, including an initial heading before the first shot. Cast-list annotations, scene-summary lines and mentions inside directions or dialogue do not supply this context. It preserves the source paragraph's time and location without selecting assets or overriding a shot's own interior/exterior insert: the shot's picture and `核心场景` still determine its view and registered scene. Source offsets and issue line numbers remain unchanged.

The result separates `failures` from `warnings`; only failures prevent a packaging plan and writes.

Style declarations preserve the project medium: `真人短剧写实风格` for live action or `写实3D CG渲染风格` for 3D CG. The compiler retains the declared line and never substitutes one medium for another. Matched `production_mode: "live_action"` is a legacy compilation-pipeline label, not a medium selector. Use each shot's explicit style and the project's confirmed visual references; an unmapped provider code such as `0` does not establish live action.


| Check | Outcome |
|---|---|
| More than 15 or 36 effective characters; declared timing differs from estimate | Warning: review pacing and actual speech, without forced splitting |
| More than `delivery.max_effective_chars_per_shot` declared in the project's `project_config.json` | Failure (`speech_exceeds_project_limit`): split along the original semantics, or change that project requirement |
| Narration/inner-monologue declarations | Warning; preserve the complete payload, including colons, as `vo`; use `说话人` to identify its speaker |
| Missing suggested realistic style or fixed negative phrase | Warning; neither phrase is automatically inserted |
| Seconds expressions in shot prose or dialogue | Warning; preserve text, and do not infer duration from prose |
| Missing shot blocks, nonconsecutive numbering, malformed explicit duration | Failure |
| Empty/placeholder dialogue, multiple speech lines, action plus dialogue | Failure; ambiguous speech is not silently discarded |
| Director-format dialogue without a named speaker; explicit speaker conflicts with the dialogue prefix | Failure (`missing_speaker` / `speaker_mismatch`); keep the declared identity and resolve the conflict against the source before compilation |
| Unknown silent-shot complexity or character placeholder | Failure |
| Action complexity alongside speech | Warning: explicit timing wins; otherwise review speech-based timing |
| Unregistered explicit scene, unconfirmed or incomplete bound asset | Failure |
| A manifest row whose `type` is none of the spellings the binder matches | Failure (`asset_type_unusable`): the row binds nothing and no other rule would notice, so the message names the row, the asset, the value read, the accepted spellings and the repair, while the readable rows still take part in the same run |
| A bound character with no `身体状态`, or one that states no dimension | Failure (`shot_body_state_missing`, `shot_body_state_unusable`): declare the state inside that subject's `主体状态追踪` section |
| A registration whose dimensions disagree, whose state carries none, or that omits costume or hair the shot requires | Failure (`asset_state_mismatch`, `asset_state_unregistered`): fix the registration or bind the version that states it |
| A registration that declares no episode, an unreadable one, or one not covering the episode being compiled | Failure (`asset_episodes_unregistered`, `asset_episode_mismatch`) |
| No registered version of a named character states the required dimensions | Failure (`asset_state_missing`) carrying the restock request |
| Several eligible character versions, or an unknown character in an explicit on-screen list | Failure (`asset_binding_ambiguous`, `unregistered_character`); resolve the version or register the character before compilation |
| No scene binding | Warning |
| One indivisible shot longer than `max_submit_seconds - 1` | Failure (`shot_exceeds_package_budget`), never truncate a shot |

Packing preserves complete continuous shots, splits on scene changes or `子任务边界：是`, and ensures content plus at least one second of hold fits the explicit budget. Short packages extend natural hold to the four-second request floor without adding dialogue. Review `submit_seconds` against the actual storyboard before submission; compilation does not change its stored duration.

### Files

Compilation writes `prompts/<episode>.txt`, `matches/<episode>.matched.json`, and `episode_packages/<episode>/` containing `package.json`, `shot_script.txt`, `matched.json`, `episode.txt`, and local bound assets. Episode numbers are padded to two digits. The prompt file is an unchanged source copy; matched shot visuals omit duration fields and include completed material references. Each `video_tasks` row stores the complete package `prompt`, its ordered `material_keys` and corresponding `material_bindings`. Missing episode text or local asset files fails before writes begin. Results include every written path, per-shot timing, package durations and ordered material keys.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The parser collects structural failures and creative warnings; asset binding checks the manifest; [`src/state.ts`](src/state.ts) normalizes both sides' declarations and [`src/assets.ts`](src/assets.ts) compares them. The packer enforces an explicit content budget and rejects unconfirmed assets or missing parent IDs, material IDs or URLs, including calls directly to its source helper. It refuses inconsistent prompt references rather than emitting an incomplete material map. The registered tool returns issues through the same canonical JSON report used by validation and compilation. See [`src/script.ts`](src/script.ts), [`src/episode.ts`](src/episode.ts), and [`src/index.ts`](src/index.ts). No runtime invariant companion is published: this package owns no independently changing observation between calls.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_shot` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) records the method schema. Results expose `shots`, `packages`, `failures`, `warnings`, `written` and summary counts. Warnings carry an actionable message and never require deleting or rewriting spoken text. `duration_source: declared` identifies explicit timing. Same-named character, scene and prop registrations retain the selected remote IDs. Scene and prop versions require unique episode coverage; multiple eligible registrations report `asset_binding_ambiguous`.

#### Token effect

The schema is fixed; results grow with shots, complete package prompts and issues. Failures suppress packaging and writes but retain diagnostic rows.

#### KV Cache effect

Tool results append without rewriting previous messages. Changes to the tool description or schema change the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compilation is local. The caller supplies the verified storyboard budget; paid submission must independently validate actual model settings and subject identity.
- Estimates are not measured audio timing. Review recorded speech before final editing and delivery.
- Asset matching uses local manifest names, aliases, episode coverage and declared state. It does not verify remote project ownership or infer an unregistered character from free visual prose.
- The state gate compares the declared dimensions and the costume text a shot names. It does not compare the asset's own board image: an asset whose registered text is right and whose picture is not stays the model's review, which the drama skills require before submission.
- Scene is the continuity key; time/costume changes require an explicit package break.
- Writes are prechecked but not transactional across concurrent processes.

Packing respects whole-shot boundaries even when they require more packages than the arithmetic minimum. Every emitted package is checked against the content ceiling; one indivisible overlong shot fails with its shot number.

<a id="dev-note"></a>
### Dev Note

None.
