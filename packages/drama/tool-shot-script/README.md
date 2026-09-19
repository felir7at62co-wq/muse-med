---
description: "The short-drama pipeline's shot-script gate and episode compiler as one model-facing tool: validate a director-format script, preview the 14-second package budget, and compile the matched JSON and episode package, for users and maintainers running the Jubian drama pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shot-script

English | [中文](README.zh.md)

## Summary

Use this package when a short-drama session must compile a director-format shot script without trusting prose to enforce the format. One tool, `drama_shot`, judges and compiles the script where the artifact is produced: `validate` reports each shot's derived facts with hard failures and warnings separated, `preview` adds the package budget without writing, and `compile` writes the matched JSON and the episode package only after the script passes. A rule lives here exactly when the script text, the asset manifest, and the package budget settle it; how a shot should read stays in the drama skills.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin as one row of a short-drama preset; it needs only the tool registry:

```yaml
- id: tool-shot-script
  name: '@deepseek-ai/dsh-tool-shot-script'
  config:
    actionShotSeconds: 2   # silent shot without 动作复杂度; 1–4, default 2
```

| Field | Default | Meaning |
|---|---|---|
| `actionShotSeconds` | `2` | Packing seconds for a silent shot that declares no `动作复杂度`, 1–4. Load-time validation rejects anything outside that range. |

### The three methods

| Method | Reads | Writes | Use it for |
|---|---|---|---|
| `validate` | The script, and the manifest when `assets` is given | Nothing | Reading every per-shot fact and every rule violation before touching the project |
| `preview` | The script and the manifest | Nothing | Seeing the exact package budget — content seconds, the submitted duration, and the material-key order — before submitting |
| `compile` | The script and the manifest | The matched JSON, the compiled prompt, and the episode package | Producing the artifacts the pipeline submits |

| Parameter | Required | Meaning |
|---|---|---|
| `method` | always | `validate`, `preview`, or `compile` |
| `script` | always | Path of the shot script, absolute or relative to the working directory |
| `assets` | `preview`, `compile` | Path of `assets_manifest.json`; `validate` judges binding only when it is given |
| `project` | `compile` | Project root holding `episodes/`, `prompts/`, `matches/`, and `episode_packages/` |
| `episode` | `compile` | Episode number, a positive integer padded to two digits on write |

A method missing one of its own arguments fails before any file is opened, and a script with a hard failure writes nothing at all — the result carries the failures instead of an error, so one call tells the model everything it must repair.

### What decides the verdict

The script is one `【镜头N】` block per shot, each preceded by the style line `真人短剧写实风格`; that line plus the block is the shot's prompt text. A duration never appears in the script or in the prompt, and the compiler derives it:

| Rule | Verdict |
|---|---|
| Speaking shot: `ceil(effective characters / 9)` seconds, 1–4 | Derived; more than 15 effective characters warns, more than 36 fails |
| Silent shot: `发声类型：action` plus `动作复杂度：简单/一般/较复杂/复杂` | 1/2/3/4 seconds; an unlabelled silent shot takes `actionShotSeconds` |
| Shot length outside 1–4 whole seconds | Failure |
| `台词：无`, an empty dialogue line, or a line with no effective character | Failure — a silent shot omits the dialogue line entirely |
| `出镜人物：无` (also the older `出镜人物【无】`) | Failure — a shot with no character omits the field |
| 旁白/解说/心声/画外声/叙述/OS | Failure — this format has no narration track |
| `台词：角色名（画外音）：原文` or a bare `画外音` label | Allowed: same-scene off-screen continuation, still subtitled and still counted |
| Any `数字秒` left in the shot body | Failure — the prompt must not carry a duration |
| A bound asset that is not `official: true`, or lacks `jubian_asset_id`, `jubian_material_id`, or a URL | Failure |
| A `核心场景` name the manifest does not declare | Failure |
| A shot that binds no scene | Warning |
| Packaging | Continuous shots of one scene, at most 14 content seconds per package, plus 1 second of natural hold that adds no dialogue |

Effective characters are Han characters, Latin letters, and digits: punctuation and spaces never count. A legacy `时长：N秒` line is still read on an old script, checked against the derived seconds, and stripped from the prompt.

### Issue codes

Every failure and warning carries a stable code. `validate` prints them; a repair loop keys on them.

| Code | Severity | Meaning |
|---|---|---|
| `no_shots` | failure | The script declares no `【镜头N】` block |
| `shot_numbering` | failure | Shot numbers are not 1..N without gaps or repeats |
| `missing_style_line` | failure | A shot block is not preceded by `真人短剧写实风格` |
| `seconds_in_shot_body` | failure | A `数字秒` expression appears outside the legacy duration field |
| `legacy_duration_invalid` | failure | A legacy `时长` value is not a whole 1–4 seconds |
| `legacy_duration_mismatch` | failure | A legacy `时长` disagrees with the derived seconds |
| `missing_negative_prompt` | failure | A director-format shot omits `无噪点，无跳帧，五官稳定不变形` |
| `narration_marker` | failure | A narration, inner-monologue, or stage-narration marker |
| `multiple_speech_lines` | failure | More than one speech line in one shot |
| `empty_dialogue_line` | failure | A speech line with no effective character |
| `placeholder_dialogue` | failure | A speech line whose text is `无` |
| `missing_voice_type` | failure | A shot without speech does not declare `发声类型：action` |
| `action_voice_with_dialogue` | failure | One shot declares both `action` and a speech line |
| `speech_too_long` | failure | More than 36 effective characters in one shot |
| `speech_above_writing_threshold` | warning | More than 15 effective characters; split the sentence at its own semantics |
| `unknown_action_complexity` | failure | `动作复杂度` is not one of the four labels |
| `action_complexity_on_speaking_shot` | failure | `动作复杂度` on a shot whose duration already comes from its words |
| `characters_placeholder` | failure | `出镜人物` carries the `无` placeholder |
| `unregistered_scene` | failure | `核心场景` names an asset the manifest does not declare |
| `no_scene_bound` | warning | The shot binds no scene asset |
| `unconfirmed_asset` | failure | A bound asset is not `official: true` |
| `incomplete_asset` | failure | A bound asset lacks a Jubian asset id, material id, or URL |

### What compile writes

`compile` writes the project's own layout, and returns every path it wrote:

| Path | Contents |
|---|---|
| `prompts/<集号>.txt` | The script as the submitted prompt, copied when the source is another file |
| `matches/<集号>.matched.json` | The matched payload: one row per shot with its timeline position, bound assets, and one video task per package |
| `episode_packages/<集号>/package.json` | The same payload, so the package is self-contained |
| `episode_packages/<集号>/shot_script.txt` | The compiled prompt |
| `episode_packages/<集号>/matched.json` | The same payload |
| `episode_packages/<集号>/episode.txt` | The episode text from `episodes/<集号>.txt` |
| `episode_packages/<集号>/assets/<类型>/<文件名>` | Every locally stored bound asset, once per asset |

The result also reports each package's `content_seconds`, `content_duration_ms` (the value `jubian_storyboard` `generate` takes), `submit_seconds` (content plus the one-second hold), `material_keys` in the prompt's own `@[名称](key)` order, and `material_names`. A local asset image or the episode text that does not exist fails the call before the first byte is written.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one call is judged and where the code lives; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on four commitments:

- **Enforce a decision where the artifact is made.** The rules that decide whether a script may compile are checked inside the call that writes the artifacts, not restated as advice in a skill. A model that skips the skill still cannot compile a narration subtitle or a 40-character shot.
- **Decidable only.** A rule lives here when the script text, the manifest, and the budget settle it. Wording, framing, performance, and cut rhythm are not decidable, so they stay in the skills that teach them.
- **Report, don't throw, for script problems.** A malformed script is a domain outcome: the parser collects every issue with its line and shot number and returns them, so one call is one repair list. Only environment problems — a missing file, a manifest that is not JSON — throw.
- **Write nothing on failure.** Packages are planned before anything is written, and every input is verified before the first byte, so a refused compile leaves the project exactly as it was.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, argument resolution, the method dispatch, and the `drama_shot` schema and description |
| [`src/script.ts`](src/script.ts) | The parser and every script rule: block splitting, effective characters, speech and narration decisions, derived durations |
| [`src/assets.ts`](src/assets.ts) | Manifest reading and shot-to-asset binding, including the official-and-complete asset gate |
| [`src/episode.ts`](src/episode.ts) | Package packing, the matched payload, material-key order, and the episode write |
| [`src/report.ts`](src/report.ts) | The canonical result: one row per shot and per package, failures and warnings separated |
| [`src/types.ts`](src/types.ts) | Types only: the parsed shot, the bound asset, the packed task, and the model-facing result |
| — | No runtime invariant companion is published: the package holds no state between calls, exposes no snapshot, and every answer is a pure function of the files it reads. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script) — the exact `drama_shot` schema and description the model receives.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the parameter DSL, the canonical output value, and the pipeline every call enters.
- [drama group map](../README.md) — the sibling packages of the short-drama pipeline.

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_shot` tool schema

#### What the model sees

One tool named `drama_shot` in the request's tool list: this package's `description`, its five parameters, and the JSON schema of its result, all reproduced in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shot-script). The description states the three methods, the derivation and the 1–4 second rule, the 15/36 effective-character thresholds, the mandatory `发声类型：action` on a silent shot with its `动作复杂度` labels, the refusals (`台词：无`, an empty dialogue line, `出镜人物：无`, narration markers), the same-scene off-screen continuation that stays legal, the ban on durations in the script and the prompt, the official-and-complete asset gate, and the ≤14 second package budget with its one-second hold. The result schema declares `method`, `ok`, `script`, `assets_manifest`, `assets_checked`, `shots`, `packages`, `failures`, `warnings`, `written`, and `summary`; the rendered content is the same value as pretty-printed JSON.

#### Token effect

Conditional and bounded by the script: the schema is fixed, while the result grows with the shot count and the issue list — every parsed shot contributes one `shots` row and every package one `packages` row. Failures and warnings carry a Chinese message each, and a hard failure yields no packaging plan, so a refused call returns the shortest useful answer.

#### KV Cache effect

Append-only. The tool registration carries a stable name, description, and schema, so a mounted row keeps the request prefix reusable; only a change to this package's description or schema invalidates it. A call's result is appended as that call's own tool result and rewrites no earlier message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this package is and is not. They are current constraints, not a task backlog.

- **Purely local compilation** — `compile` writes the matched JSON and the episode package; it never submits anything to Jubian. The paid submission stays with `jubian_storyboard`, which is why the result reports `content_duration_ms` and the material-key order instead of performing the submission itself.
- **Package count is not a submission budget** — with `actionShotSeconds: 2` a shot may be charged less than the provider renders, so a package can hold more than 14 rendered seconds; the number of packages is therefore a lower bound, not a promise about the bill.
- **Scene is the only continuity key** — a package breaks when the resolved scene changes or a shot declares `子任务边界：是`. Two shots of one scene but different times or costumes stay in one package unless the script marks the boundary itself.
- **A character named only by a non-matching string binds nothing** — binding is substring matching against manifest names, so `出镜人物：苏晚` binds only a manifest asset whose name occurs in that field or in the prompt text; a name with no such asset is not reported as an error.
- **A missing scene is a warning, not a failure** — a shot whose `核心场景` is omitted and whose prompt names no registered scene compiles with an empty scene.
- **No prompt rewriting** — the compiled prompt is the script's own text: the style line, the marker line, and the shot body, with any legacy duration line removed. This package normalizes no wording, ordering, or spacing.
- **The legacy `segments` verification is not ported** — the older compiler's optional cross-check of pre-split narration segments has no consumer in the current pipeline and is not part of any method.
- **A compile is not transactional across processes** — the write is pre-verified and ordered, but two concurrent compiles of one episode can still interleave their files.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked documents.

The rule set is a port of the pipeline's Python compiler (`tweet-drama-early-shot-script/scripts/compile_director_shots.py`), with four deliberate differences: 15 effective characters is the writing threshold and 36 the hard ceiling, `台词：无` and empty dialogue lines fail, `出镜人物：无` fails, and `动作复杂度` gives each silent shot its own budget instead of one global value. The Python compiler stays the reference for the byte layout of the matched payload.

The remaining duplication is deliberate: the same rules are being removed from the skill text as sessions move to this tool, so for a transition period both exist.
</details>
