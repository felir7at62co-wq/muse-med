---
description: "Source-backed screenplay projects with independent episode review and recoverable character knowledge."
kind: "package-reference"
---

# @deepseek-ai/dsh-screenplay-project

English | [中文](README.zh.md)

## Summary

`screenplay_project` imports immutable novel text or timed speech, assigns source-unit identities, and renders structured episodes from reviewed facts. The writing session cannot approve its own facts or candidates. Acceptance advances one episode at a time; subsequent work reads the accepted state rather than a model-written progress summary.

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

### When to choose it

Use this tool for source-backed novel, video, or trope adaptation projects that need independently reviewed episodes and recovery after interruption. Freeform writing without episode acceptance can use the existing writing skills directly.

### Minimal configuration

In a `dsh` profile composition that already mounts `fs`, `tools`, `attachments`, and `llm`, add:

```yaml
- id: screenplay-project
  name: '@deepseek-ai/dsh-screenplay-project'
  config: {}
```

| Field | Default | Meaning |
|---|---|---|
| `maxSourceBytes` | `16777216` | Maximum original file bytes |
| `maxProjectBytes` | `33554432` | Maximum project artifact bytes |
| `maxReadUnits` | `100` | Maximum source units, facts, or drafted scene files in one operation |
| `maxReadBytes` | `65536` | Maximum encoded source-window or individual scene-file bytes |
| `maxFactBatch` | `20` | Maximum facts proposed or independently reviewed in one atomic mutation |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-screenplay-project) owns accepted configuration fields. These budgets do not fix the number of episodes or chapters.

### Project operations

`propose_facts` submits a bounded list of individually attributed facts; `review_facts` carries an independent decision and reason for every fact. Either operation publishes once and advances the revision once. An empty, over-budget, invalid or duplicate-review batch publishes nothing. Read and classify all source context before reviewing; batching does not waive semantic review. Single-fact operations remain available.


Mount this plugin with `fs`, `tools`, `attachments`, and `llm`; a sandboxing filesystem also requires `sandboxPolicy`. Mutations use the initiating session's standing policy. `project` names one JSON artifact, not a directory. `init` records the user's direction and faithful or adaptation mode. `import_source` accepts UTF-8 text, native `audio_transcribe` segment arrays, account responses containing `segments`, or actual `video_inspect` sampled-frame manifests. Exact original bytes determine the source SHA-256. Unit numbering starts at one and retains original line or segment order; available speech times and speaker IDs survive import.

Facts distinguish actions, speech, character thoughts, and author analysis. Exact quoted substrings must occur in their referenced units. Adaptation facts require the project's adaptation mode and an explicit reason. Frame reads return the original verified image attachments beside timecodes, require an image-capable route, and reject a changed video original. A different session reviews their meaning, attribution, and narrative layer. `stage` accepts complete scenes with typed action, dialogue, OS, or VO beats referring to approved facts. OS requires the same character's thought; author analysis is unassigned commentary. Continuous scenes retain place, time and layer. Entering a flashback and returning from it require explicit transitions; `return_present` also marks a return from a dream or imagined scene.

Character knowledge derives from accepted beats. Declared witnesses can see an action or hear dialogue; private OS and VO have no on-scene witnesses. Present, flashback, dream, and imagined knowledge remain separate. These records describe acquired information and make no universal claim that every character is unaware of unspecified information. Cross-layer recollection or an altered event needs a separately reviewed fact in the destination layer.

`list_facts` restores fact identities and reviews in bounded original order after an interrupted writer. `read_candidate` returns the exact structured version, rendered script, and referenced facts for review. Review binds the application-issued candidate identity and SHA-256. Only independently approved next episodes can be committed. `status` returns the next episode and accepted versions for recovery. `export` generates the accepted Markdown and source map, including renderer-assigned line numbers and host-assigned timestamps. Repeating export preserves identical outputs and rejects edited files; an interrupted two-file export can be completed by repeating the same command.

-----

`stage_files` assembles an episode from ordered JSON files containing one complete structured scene each. It verifies every file exists, parses its fields, and checks file versions again before publishing. File count uses `maxReadUnits`; each file uses `maxReadBytes`. The resulting candidate contains an immutable copy of the scenes and follows the same attribution and independent-review rules as `stage`. Writers can save scenes in separate bounded requests and resume those files after output truncation without regenerating one large tool argument. Dialogue facts retain individual conversational turns; combining answers across another character's question requires reviewer rejection.

`fork_project` starts a revision in a new destination file before a chosen accepted episode, or before the next episode. It retains the original direction, verified sources, fact history and accepted ancestors; it records the exact parent file digest and revision. Later episodes must be rewritten and independently reviewed in order. The original project and exports remain unchanged, and an existing destination is refused.

Rendering uses the accepted episode number and scene order, source-verified interior/exterior settings, and explicit Chinese narrative-layer labels. Omitted settings display as unresolved; the program does not infer them from a place name. A writer may mark one source-backed suspense beat in the final scene with `hook`; semantic review checks its evidence. Source-index line numbers include these headings and the marker. This projection leaves earlier exported files unchanged.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each mutation replaces one validated project file atomically through the mounted filesystem with a file-version guard and the caller's expected revision. A cancelled or stale mutation cannot advance the persisted project. Imported originals are rehashed before operations; changed source files or inconsistent source indexes fail. Candidate content digests are checked when loading the artifact. Rejected and superseded candidates remain available, and existing accepted versions are never overwritten. Project format version 1 is independent of released Session generations; commands and canonical results use the existing logged tool events.

Oversized reads fail and require a smaller window instead of silently truncating text.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — Guarded reads and atomic writes.
- [Tools subsystem](../../../docs/subsystems/tools.md) — Canonical logged command results.
- [Speech transcription](../tool-audio-transcribe/README.md) — Timed source artifacts and durable jobs.

<a id="model-experience"></a>
## Model Experience

### The `screenplay_project` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-screenplay-project) owns the operation schemas and description. Canonical results contain bounded source windows, application-issued identities and revisions, candidate text, reviews, accepted state, or exported paths. They are recorded as normal tool results and use the generic persisted tool card.

#### Token effect

The mounted schema adds a fixed request cost. Source windows are bounded by configuration; candidate reads include complete episode content and its referenced facts. Calls add results without inserting the complete source into every request.

#### KV Cache effect

Results append to conversation history. Changing the schema or description changes the reusable request prefix; project mutations do not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Mechanical checks still need semantic review and appropriate allocation budgets.

- **Semantic review** — exact quote binding and attribution types do not establish that a paraphrase preserves meaning. A separate reviewer must inspect originals, the complete candidate, and approved adaptation direction. Speaker separation IDs alone do not establish a character's name.
- **Artifact authority** — the validated project is the continuation record for this tool. Direct external edits are not independent reviews; general filesystem access remains available to the agent, and the tool cannot make arbitrary files immutable against that access.
- **Storage scale** — originals and episode versions share one guarded JSON artifact. Very large projects require an explicitly increased allocation budget; this provider does not yet shard its history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
