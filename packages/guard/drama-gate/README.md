---
description: "Drama-pipeline gate plugin that intercepts tool dispatch for a short-drama session and refuses the calls a prompt cannot be trusted to prevent, for users and maintainers running or debugging the Jubian drama pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-guard-drama

English | [中文](README.zh.md)

## Summary

Use this package when a short-drama pipeline must follow its hard rules without trusting a prompt to enforce them. Mounted as one preset row, it intercepts tool dispatch and refuses the calls that are provably wrong: a paid Jubian method with no idempotency key, a write that would land an invalid shot script or matched JSON, and a paid storyboard submission with no official asset record. Every refusal is a Chinese instruction naming the repair. It reads files and never writes; it registers no tool, prompt section, or event.

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

Mount the plugin as one row of the drama preset. There is nothing to wire by hand: with the defaults it judges every tool call that session makes, and stays silent until a call breaks one of the rules.

### When to choose it

Choose it when a session runs the live-action pipeline and a wrong call costs money or corrupts a compiled artifact — a regenerated storyboard that bills twice, a shot script that quietly reintroduces narration, a paid submission that references an asset nobody confirmed. Avoid expecting it to judge quality: it never looks at an image, a prompt's wording, or a cut's rhythm, so the visual and editorial review stays in the shot-script and video-review skills. Avoid it, too, on sessions that have nothing to do with the pipeline; the row is a preset member precisely so that no other conversation pays for the checks.

### Mounting it in a preset

Add the row to the drama preset's `agent.cordis.yml`, or override it from a profile patch by id:

```yaml
- id: drama-gate
  name: '@deepseek-ai/dsh-guard-drama'
  config:
    workspaceRoot: E:\aa-manju        # fallback root when the session states no cwd
    workshopDir: short-drama          # the workshop directory below that root
    projectRoot: ''                   # explicit project root; empty means derive it
    idempotencyKey: true              # refuse a Jubian write method with no key
    shotScript: true                  # check the text a write or edit would commit
    officialAssets: true              # require an official asset before paid work
    museToolNames: true               # explain a retired MUSE tool name
```

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | `''` | Absolute fallback root, used only when the session states no working directory |
| `workshopDir` | `short-drama` | Directory name below the workspace root that holds the drama projects |
| `projectRoot` | `''` | Absolute project root that overrides the workshop-root derivation |
| `idempotencyKey` | `true` | Refuse a Jubian write/paid method that carries no `idempotency_key` |
| `shotScript` | `true` | Refuse a write/edit that would land an invalid shot script or matched JSON |
| `officialAssets` | `true` | Refuse a paid storyboard submission while no `official=true` asset is recorded |
| `museToolNames` | `true` | Answer a retired MUSE tool name with the replacement surface |

A `workshopDir` that is absolute or contains a separator, and a `workspaceRoot` or `projectRoot` that is relative, fail at load with a clear error rather than silently judging the wrong directory.

### What you get

With the defaults, a session that calls `jubian_storyboard` with `method: generate` and no `idempotency_key` gets its call refused before the network is touched, and the model reads a sentence telling it to add the key and, if the previous outcome is unknown, to repeat that same call with the same key instead of minting a new one. A `write` of a shot script that reintroduces a narration marker is refused with the line number, the marker, and the repair:

```text
短剧门禁拦下这次 write（…/short-drama/demo/prompts/01.txt）：第 4 行出现旁白/心声标记「旁白」。本格式没有旁白：把该台词落成画面内台词（角色在画面中当场说出，文字逐字不改）后重写；落不进画面内的段落回报失败，不要静默丢弃、不要改写成叙述字幕。
```

A refused call never reaches the tool body, so nothing is charged, no file is written, and the refusal is the tool result the model reads next — exactly where a tool error would have been.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one pending call is judged, which rules exist, and where the code lives; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The gate is built on four commitments:

- **Only decidable rules.** A rule earns its place only when the tool name, the parsed arguments, and a file read settle it. Anything needing pixels, taste, or a judgement about the story stays in the skills, because a refusing gate that guessed would block correct work.
- **Judge the file that would exist.** A `write` is judged on its full new text; an `edit` is judged on the file with the replacement applied, using the edit tool's own literal `split`/`join` semantics, so the gate sees exactly what the tool would commit and never a fragment.
- **Refuse in the model's own language.** Every reason is Chinese, names the offending value, and states the repair in the terms the pipeline already uses — the counting rule, the asset gate, the retired tool names. A refusal the model cannot act on is a refusal that cost a turn.
- **Read, never write.** The plugin opens files and answers a decision. It repairs nothing, rewrites no arguments (they are already logged and presented), and adds no tool, prompt section, session event, or service.

### The four rules

- **Paid and write methods need an idempotency key.** For `jubian_storyboard` `create`/`save`/`generate`/`erase_subtitle`, `jubian_video` `image_generate`/`upscale`, and `jubian_asset` `confirm_casting`/`remove`, a missing or blank `idempotency_key` refuses the call and repeats the pipeline rule: add the key, and after an unknown outcome repeat the same key rather than sending a new one.
- **Shot scripts and matched JSON must satisfy the pipeline's own contract.** Inside the workshop's `prompts/`, `matches/`, and `episode_packages/` directories, a `write`/`edit` is refused when the text contains a narration marker (`画外音`, `画外声`, `心声`, `旁白`, or the whole tokens `VO`/`OS`); when a `【镜头N】` block declares no `时长`, a fractional duration, or one outside 1–4 seconds; when a shot's on-screen dialogue exceeds 36 effective characters; or when the declared duration disagrees with `max(1, ceil(chars / 9))`. Effective characters are Han characters, Latin letters, and digits only — punctuation and spaces do not count. A matched JSON is checked field by field instead: every `script_duration` (or legacy `duration`) must be an integer of 1–4, and each shot's `text` is held to the same character and duration rule.
- **A paid storyboard submission needs an official asset.** `jubian_storyboard` `generate` is refused unless some project under the workshop records an `official=true` asset — an entry in `assets_manifest.json`, or a completed `official_assets` stage in `pipeline_state.json` when no manifest exists. Asset generation itself is deliberately not gated, because it is the step that runs before any asset is official.
- **A retired MUSE tool name gets an answer, not a shrug.** A call to `drama`, `asset`, `shot`, `project`, `timeline`, or `delivery` that the registry does not resolve is refused with the names of the tools that replaced it, instead of the bare `UNKNOWN_TOOL` a model reads as a broken deployment.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud path validation, the host filesystem reader, and the `tools/pre-execute` interceptor |
| [`src/rules.ts`](src/rules.ts) | The pure evaluator: the rule order, the write-method and paid-submission tables, workshop path classification, and the official-asset evidence reader |
| [`src/shot-script.ts`](src/shot-script.ts) | The content rules: the `【镜头N】` parser, the matched-JSON reader, effective-character counting, and every refusal message |
| — | No runtime invariant companion is published; the gate owns no independently changing observation. It holds no state between calls, exposes no snapshot, and its whole contract is a pure function of the call and the files it reads. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the dispatch waterfall the gate sits in through the pipeline's own rules to the guard group it belongs to.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/pre-execute` waterfall and the `PreToolDecision` a refusal returns.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — where pre-execute sits between argument materialization and the tool body.
- [guard group map](../README.md) — the sibling guard packages and what each one watches.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tool schema, no prompt section, and no session event: its whole contribution is refusing a pending call inside `tools/pre-execute`, and the model only ever reads the refusal text through the tool result that a denied call already produces.

#### KV Cache effect

A refusal becomes that call's own error tool result, appended where the result would have gone, and no earlier message is rewritten — so a reusable request prefix stays reusable. An allowed call adds nothing at all beyond what the intercepted tool already produces.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this gate is and is not. They are current package constraints, not a task backlog.

- **Only the tool-visible surface is gated** — the paid storyboard path the drama preset actually uses also runs through skill scripts (`select-storyboard-assets`, `prepare-storyboard-video`, `submit-storyboard-video`), which are launched from a shell and never pass through a tool dispatch, so this gate cannot see them.
- **A shell write bypasses the content rules entirely** — only the `write` and `edit` tools are inspected. A script produced or copied by a shell command is judged by the compiler instead.
- **A write outside the workshop is not inspected** — the content rules apply below `<workspaceRoot>/<workshopDir>`, and only in the `prompts/`, `matches/`, and `episode_packages/` directories the pipeline writes, so the archived source script and every unrelated file stay untouched.
- **No workspace root means no file rules** — a session that states no working directory and a deployment that configures no fallback leave the file-based rules unable to judge, and they allow rather than refuse; the idempotency rule and the retired-name rule still apply.
- **Official-asset evidence is per workshop, not per shot** — the gate proves that some project under the workshop has an official asset, not that the shots being submitted reference those assets. In a workshop holding several projects the check is weaker than it reads.
- **Only the `official` flag itself is verified** — the refusal also states that an asset needs a Jubian asset/material id and a URL, but the check reads the flag alone, so a manifest whose `official: true` record carries a stale or missing id still passes.
- **Unparseable matched JSON is only scanned for narration** — when the document does not parse, the numeric rules cannot be evaluated field by field, so only the raw-text narration scan runs.
- **Video packaging is not gated** — the 14-second content ceiling with a one-second hold, the task-break rules, and dialogue/speaker continuity are the compiler's job, not this gate's; they are not decidable from a single file write.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked documents.

The workshop layout this gate reads (`short-drama/<project>/` holding `prompts/`, `matches/`, `episode_packages/`, `assets_manifest.json`, `pipeline_state.json`) is the pipeline's own, established by the workspace-local drama skills rather than by this repository. If the preset moves to a different root name, the row's `workshopDir` is the one field to change.

The interceptor reads files synchronously on every matching call. That is deliberate — the files are small, the read happens only for `write`, `edit`, and the paid Jubian methods, and a gate that awaited an async filesystem service would have to declare a dependency it does not otherwise need. Revisit if a workshop ever holds a matched JSON large enough to matter.

The gate refuses; it cannot repair. A future revision could carry the corrected duration back to the model as structured feedback instead of a sentence, but argument rewriting is excluded by `PreToolDecision`, and a second source of truth about a shot's duration would be worse than a refusal.

The row ships in this package's `cordis.patch.yml` and lands in the drama preset as one `insert`; until that preset is mounted, the package contributes nothing to any session.

</details>
