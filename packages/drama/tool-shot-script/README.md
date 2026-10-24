---
description: "Check shot scripts, suggest packages, and save review drafts or compile asset-bound episodes according to the configured review mode."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

English | [中文](README.zh.md)

## Summary

Use `drama_shot` to check director-format scripts and preview package timing. The default `strict` mode compiles matched JSON and episode files only when content checks pass. Muse Short Drama uses `advisory` and the current session's video-model duration limit: content issues become warnings, and compilation saves a separate review draft. Input, configuration and filesystem errors still fail. The tool preserves spoken text and speaker identity, submits no generation requests, and does not establish generated quality.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside the tool registry in the drama preset. `actionShotSeconds` defaults to 2 and accepts whole seconds from 1–4; it estimates silent shots without explicit duration or complexity, not a maximum shot length. `speechCharsPerSecond` accepts numbers at least 1 and defaults to 8; Muse's Short Drama and Creation presets select 5 for both compiler and production packaging. `reviewMode` accepts `strict` and `advisory`, defaulting to `strict`. `sessionVideoSelection` defaults to `false`; enabling it uses the calling Agent's Jubian video-selection service instead of a caller-supplied package ceiling. `selectionReviewMaxChars` limits the complete appended selection-review text, defaults to 2000 characters and accepts at least 400; counts remain visible and omitted details are identified. Muse's Short Drama preset selects `advisory` and enables session selection. These are deployment settings, not model-selectable tool arguments.

<a id="muse-batch-production"></a>

### Muse batch production

`productionPackaging: true` additionally registers `muse_production`; Muse's director presets enable it. `production` configures the native transport, shared storyboard ledger and inventory bounds. The tool requires credentials and session video selection. `preview` reads the existing `project_dir`, complete episode `script`, display `episode`, project `ratio` and supported `gen_type`. It queries complete remote inventories, returns per-shot appearance candidates and saves a local plan below `.muse/production/`. Requirements specify costumes, scene conditions and voice periods; local aliases supplement matching live URLs. Candidates do not establish visual or acoustic identity.

`read` pages through `matches`, `packages`, `warnings` or complete `assets`, retaining counts and truncation. `update` refreshes source, inventory and model while merging individual choices and requirements. Choices belong to a shot, kind and story name. `targets` selects existing card IDs when names are ambiguous. Packages show current bindings and proposed image/voice IDs. Unknown model ceilings retain complete single-shot draft packages without claiming supported durations. Content warnings do not prevent publishing drafts or require user approval.

`apply` uses native free creation, edit, image-selection and audio-preview/apply operations with generation disabled. Original keys and partial receipts permit resuming without repeated creation; each package returns actual readback. Changed source, model or live card content requests refresh rather than overwriting user work. Independent packages report separate outcomes. The provider has no atomic cross-client compare-and-swap, so another client can race the final read/write. Empty image selections clear old images only when no image references remain; audio uses its dedicated replacement path. The tool never deletes or submits paid generation.

Voices use explicit character and life-period identities. Adopted reference IDs, URLs, hashes and measured duration metadata supplement live voices without claiming fresh listening or measurement. Missing identity or duration prompts inspection of existing samples first. Under existing production/spending authorization, the agent can generate the first clear speaking package, inspect and extract the sample, re-query shared audio, then register/reuse through the existing workflow. Costume changes do not create voice periods or replace adopted defaults. Compact package reviews survive pruning and model switches through logged review projections; these are advisory and do not change the system prompt.

<a id="review-modes"></a>
### Review modes

In `strict` mode, failure-severity content issues prevent packaging and compilation. The asset, state and timing rules below describe this default mode. Existing consumers keep this behavior unless their deployment explicitly changes `reviewMode`.

In `advisory` mode, all content issues are returned as `warnings`, with an empty `failures` list. `ok: true` means the check completed, not that the script is ready for generation or that its quality passed review. Package timing is a suggestion; over-budget shots and original dialogue are not truncated. The tool does not generate missing assets or bind materials on the platform. `compile` saves only `shot_reviews/<episode>/shot_script.txt` and `review.json`, retaining the original script and leaving formal `prompts`, `matches` and `episode_packages` outputs untouched. Required arguments, unreadable files, invalid asset-manifest JSON, invalid plugin configuration and write errors still fail.

| Method | Required inputs | Result |
|---|---|---|
| `validate` | `script`; optional `assets`, `project`, `episode` | Read-only shot facts, failures and warnings |
| `preview` | `script`, `assets`; `max_submit_seconds` when session selection is disabled; optional `project`, `episode` | Read-only packaging plan |
| `compile` | Preview inputs plus `project`, `episode` | Strict: matched JSON and episode files; advisory: separate review draft |

An `episode` given to any method is kept, so `validate` alone can refuse an asset whose registration does not cover the episode being compiled.

With `sessionVideoSelection: false`, `max_submit_seconds` remains the required explicit whole-second per-package submission ceiling of at least four seconds for `preview` and `compile`, including at least one second of natural hold. Existing standalone strict workflows keep this behavior. The caller must verify the budget against the generation model; the compiler does not fetch provider capabilities. Set each storyboard's actual duration from its reviewed package's `submit_seconds`, rather than copying the ceiling to every storyboard.

<a id="session-video-settings"></a>
### Session video settings

With `sessionVideoSelection: true`, the current session's selected model and verified duration ceiling control package suggestions. Project defaults do not override them. A passed `max_submit_seconds` is ignored; a conflicting value produces a warning. The report's `duration_budget` identifies `source` (`session` or `argument`), the applied `max_submit_seconds` or `null`, and `selection` or `null`. A selection contains `model_id`, `model_name`, `platform_id`, `standard_id`, `resolution`, `max_duration_seconds` and `revision`. An unavailable choice or unknown duration produces warnings and no package suggestions, retaining the original script; the tool never borrows another model's 15- or 30-second limit.

When the selection changes, a synchronous reviewer compares the latest actual advisory `preview` or `compile` package `submit_seconds` with the new limit. It identifies over-limit packages and shots in the existing logged selection-context message, without changing the system prompt or issuing another model request. The host-only `dramaShotReview` projection recovers that latest check from logged tool results across reload and context compaction. A result that completes after its model revision became stale also adds a warning context. This comparison does not reread edited source, inspect pictures, repack, write files or alter cards; rerun `preview` to calculate a layout for the new selection. Finding no over-limit package does not establish creative quality.

| Warning code | Meaning and next action |
|---|---|
| `session_video_budget_ignored` | A conflicting `max_submit_seconds` was ignored; read the session-derived `duration_budget` |
| `session_video_unavailable` | No usable session choice could be obtained; verify the conversation's selection and preview again |
| `session_video_duration_unknown` | The chosen model has no verified duration ceiling; verify its capability before packaging |
| `session_video_selection_changed` | The choice changed during this check; use the appended context and preview under the latest revision |

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

Every method reads its project's own requirements: the `project` argument when the call names one, otherwise the nearest `project_config.json` at or above the script, up to four directories — the same ancestor lookup the pipeline's own scripts use. Today the one requirement read is `delivery.max_effective_chars_per_shot`, the project's per-shot ceiling in effective characters. In strict mode, it outranks this tool's built-in numbers: speech above it is a failure, and the repair text names both honest ways out — split the line along the original semantics, or change that project's requirement. Advisory mode reports the same conflict as a warning. A project config that declares no such key, or none that parses, leaves the built-in numbers as advice. A key that is present but not a positive integer fails the call instead of being ignored.

### Script and timing

Complex physical actions use the [first-pass production workflow](../skills/skills/tweet-drama-core/references/first-pass-production.md). Optional `动作起点`, `接触与支撑` and `动作落点` fields are retained in submitted prompts; once used, each must occur once with substantive content. Malformed declarations fail strict compilation. Complex actions missing stages or relying on complexity estimates produce advisory findings rather than changing their duration or deleting action.

An explicit ordered sequence in `动作状态`, such as `先…再…` or `先…最后…`, receives the same missing-stage and estimated-timing review even without a complexity label. Speech and camera directions alone do not trigger this check. It recognizes these written sequence markers, not every action phrasing; it does not establish who should execute a spoken instruction, whether its prerequisite occurred, or whether hands, object uses and destinations agree. Verify those facts against the source and actual prepared prompt before generation. A substantive stage declaration and reviewed duration clear the corresponding preparation finding without rewriting action or speech.

Optional `连续性状态：object-id｜location｜state｜count` lines declare each specific object's post-shot state. Counts are nonnegative safe integers, not totals for every object of the same kind in the scene. A changed location, state or count without `连续性变化：object-id｜source-backed reason` produces an advisory finding. Omitted objects retain their preceding state. `连续性场次` or an existing source-scene heading separates scripted scene periods; camera cuts and package breaks do not reset state. Subsequent same-scene package prompts include previously declared states at their opening. These text comparisons do not establish physical feasibility or the truth of a supplied reason.

Optional `场景时段` labels inherit within the same scene and authored period; source headings can supply the initial label. Each completed shot receives that time and lighting directions, including later packages. A changed label separates packages and requires a substantive `时段变化依据` to avoid an unexplained-change warning. Each field occurs at most once; empty, placeholder or detached reasons fail strict compilation. Labels are compared literally, without verifying source truth or image lighting; reconcile synonyms before treating a warning as a contradiction. Camera cuts do not advance time, while source-backed montage transitions remain possible. Legacy scripts without time fields still parse.

When this plugin is mounted, native `jubian_storyboard.prepare_video` and preparation-only `generate` results receive `first_pass_review` for actual prepared director prompts, including directly authored cards. It checks speech declarations, action stages, continuity, missing scene time and total performance time against the actual card duration, including estimated shots and the natural hold. Prepared packages retain consecutive original shot numbers even when starting after 1; whole-episode scripts still start at 1. Estimates require natural reading and rehearsal. `needs_review` reports findings; `text_checks_passed` means only the supported text checks found none. Both retain `media_acceptance: false` and name source, asset and media checks they did not perform. The disposable listener follows the caller's compiler scope and preserves other post-execution decisions. It changes neither the persisted preview nor its fingerprint, authorization or paid submission, and does not force unmarked natural-language prompts into director format.

Package reports separate net content from ending holds: `content_duration_ms = content_seconds * 1000`, `submit_seconds = max(4, content_seconds + 1)`, and `natural_hold_seconds` is the difference. One second of content therefore reports 1000 milliseconds, a four-second submission and three seconds of hold. Normally omit the optional `content_duration_ms` input when preparing generation instead of forwarding this report field: native preparation cross-checks the saved card's total duration minus one second, which differs when a short package has extra hold.

Shots use consecutive `【镜头N】` blocks. An optional `时长：N秒` declares a positive safe integer duration and takes precedence over estimates. Without it or a complete performance budget, speech uses `max(1, ceil(effective characters / speechCharsPerSecond))` and takes at least the declared action-complexity estimate. Silent shots use `动作复杂度：简单/一般/较复杂/复杂` (1/2/3/4 seconds), then the configured fallback. These complexity estimates are not maximum action lengths. Unknown complexity is invalid on speaking and silent shots. Han characters, Latin letters and digits count; punctuation and spaces do not.

An optional performance budget declares `动作预算：N秒`, `发声预算：N秒`, `反应预算：N秒` and `表演顺序：同时|先动作后台词|先台词后动作` exactly once each. Budgets are nonnegative safe integers; speech requires at least one second, silent shots require zero speech seconds, and the total must be a positive safe integer. Concurrent work takes `max(action, speech) + reaction`; sequential work takes `action + speech + reaction`. Its duration source is `declared`. Missing, duplicate or invalid fields produce `timing_plan_invalid`; an explicit duration shorter than this authored total produces `timing_plan_exceeds_duration`. Both are failures in strict mode and warnings in advisory mode. This arithmetic does not verify actual performance speed. Explicit duration and performance-budget lines are excluded from matched visual prompts; write the meaningful action order in the visual directions as well.

Character and scene fields accept a plain name followed by its `@[name](key)` reference, or the reference alone. Repeated display labels do not create another identity. The original prompt remains available to reject wrong parent keys or references naming a different character. Style declarations also accept `风格：真人短剧写实风格。` and the corresponding 3D style without changing the selected medium.

A standalone `场次54-1：地点 时段 内/外` heading applies to subsequent shots until the next such heading; it never enters the previous shot. Each affected prompt retains the literal heading before any `｜` or `|` annotation as `来源场次（原文段落）` context, including an initial heading before the first shot. Cast-list annotations, scene-summary lines and mentions inside directions or dialogue do not supply this context. It preserves the source paragraph's time and location without selecting assets or overriding a shot's own interior/exterior insert: the shot's picture and `核心场景` still determine its view and registered scene. Source offsets and issue line numbers remain unchanged.

The result separates `failures` from `warnings`; in strict mode, failures prevent a packaging plan and writes. Advisory mode reports the same content issues as non-blocking warnings.

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

Packing preserves complete continuous shots, splits on scene changes or `子任务边界：是`, and ensures content plus at least one second of hold fits the resolved budget. Short packages extend natural hold to the four-second request floor without adding dialogue. Review `submit_seconds` against the actual storyboard before submission; compilation does not change its stored duration.

### Files

Strict compilation writes `prompts/<episode>.txt`, `matches/<episode>.matched.json`, and `episode_packages/<episode>/` containing `package.json`, `shot_script.txt`, `matched.json`, `episode.txt`, and local bound assets. Episode numbers are padded to two digits. The prompt file is an unchanged source copy; matched shot visuals omit duration fields and include completed material references. Each `video_tasks` row stores the complete package `prompt`, its ordered `material_keys` and corresponding `material_bindings`. Missing episode text or local asset files fails before writes begin. Results include every written path, per-shot timing, package durations and ordered material keys. Advisory compilation writes the separate review files described above and does not require or copy local asset images into a formal episode package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The parser collects structural failures and creative warnings; asset binding checks the manifest; [`src/state.ts`](src/state.ts) normalizes both sides' declarations and [`src/assets.ts`](src/assets.ts) compares them. Strict packing enforces a content budget and rejects unconfirmed assets or missing parent IDs, material IDs or URLs, including calls directly to its source helper. It refuses inconsistent prompt references rather than emitting an incomplete material map. Advisory review reports content issues without promoting a draft to these formal outputs. The registered tool returns issues through the same canonical JSON report used by validation and compilation. Session-aware review registers a host-only result projection and a disposable selection-context reviewer. Native tool results retain compact package facts in `presentationMeta`, so output spilling or pruning does not remove the recheck basis. An unreadable latest PTC packaging result marks that basis unavailable instead of reusing an older plan; `validate` does not replace the latest packaging check. Reports keep absolute source paths, while selection context displays paths relative to the Agent's working directory. See [`src/script.ts`](src/script.ts), [`src/episode.ts`](src/episode.ts), and [`src/index.ts`](src/index.ts).

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_shot` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) records the method schema. Results expose `review_mode`, `duration_budget`, `shots`, `packages`, `failures`, `warnings`, `written` and summary counts. In advisory mode, `ok: true` reports a completed check while `warnings` retains content problems for the Agent to consider; it is not a generation or quality approval. Advisory `material_bindings` lists only unambiguous explicit references with complete confirmed identities; unresolved references stay in the original text with warnings. Warnings carry an actionable message and never require deleting or rewriting spoken text. `duration_source: declared` identifies explicit timing. In strict mode, same-named character, scene and prop registrations retain the selected remote IDs. Scene and prop versions require unique episode coverage; multiple eligible registrations report `asset_binding_ambiguous`.

#### Token effect

Results grow with shots, package suggestions and issues. Strict failures suppress packaging and writes but retain diagnostic rows. Advisory warnings remain model-visible and do not prevent writing the separate review draft. A session-model change can add a check of the last recorded packages to the ordinary selection context; it does not start another model step.

#### KV Cache effect

Tool results and selection-review context append without rewriting previous messages or the system prompt. Changes to the deployment's tool description or schema change the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compilation is local. Standalone calls supply a verified storyboard budget; session-aware calls use the selected model's known ceiling. Paid submission must independently validate actual model settings and subject identity.
- Estimates are not measured audio timing. Review recorded speech before final editing and delivery.
- Asset matching uses local manifest names, aliases, episode coverage and declared state. It does not verify remote project ownership or infer an unregistered character from free visual prose.
- State checks compare declared dimensions and costume text rather than the asset image. Conflicts block strict compilation and remain warnings in advisory mode; an asset whose registered text is right and whose picture is wrong still needs the model's visual review before submission.
- Scene and authored source period determine package boundaries; an omitted period retains that scene's preceding period. Costume changes within one period still require an explicit package break when they need separate generation.
- Writes are prechecked but not transactional across concurrent processes.

Strict packing respects whole-shot boundaries even when they require more packages than the arithmetic minimum. Every emitted strict package is checked against the content ceiling; one indivisible overlong shot fails with its shot number. Advisory suggestions may exceed the ceiling and must be reviewed against the actual selected generation model before use.

<a id="dev-note"></a>
### Dev Note

None.
