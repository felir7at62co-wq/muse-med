---
description: "The model-facing skill catalog and loader tool for users and maintainers understanding what agents see, or configuring the session skill catalog."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

## Summary

Agents can discover and load skills during a session. A durable catalog advertises names and capped routing summaries before the first request when model-invocable skills exist and the `skill` tool is visible. The catalog is complete by default; optional source limits select summaries without restricting invocation permissions. Users can invoke user-invocable skills with `/name`, which injects full instructions into that step. Changed entries or exposure mode append a replacement catalog; an empty catalog retires old names.

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

Mount the plugin alongside the skill registry to give agents a session skill catalog and the `skill` loader tool. It requires `ctx.agents`, `ctx.tools`, and `ctx.skills`.

### When to choose it

Use it when agents should discover and load skills during a session. Skip it when skill loading is handled by another consumer or not needed at all — without it, providers and the registry still work, but nothing renders a catalog or a tool for the model.

### Mount and configure

Load the plugin together with the skill registry and at least one provider. Configure the catalog summary length, optional source limits, and scoped-loader catalog ownership below.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | Maximum length of a normalized routing summary in the session catalog; minimum 3 |
| `scopedCatalogOwner` | `false` | Let this scoped loader own its catalog across other tool-skill instances and recheck its visibility after discovery |
| `catalogSourceLimits` | `{}` | Optional positive integer limits on advertised summaries per exact skill source; omitted sources remain unbounded |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-skill) is the exhaustive source for every accepted field.

A skill with a distinct, nonblank `whenToUse` publishes `When to use: <whenToUse> Description: <description>` as its routing summary. Whitespace is normalized; a blank hint or one identical to the normalized description keeps the description alone. `catalogDescriptionMaxLength` caps the complete summary, so a long trigger can consume the budget and omit the description. Durable catalog entries record that same summary in their existing `description` field.

Source limits are opt-in. The [Muse Desktop composition](../../../apps/desktop-host/config/desktop.cordis.patch.yml) sets `catalogSourceLimits: { muse-market: 3 }`, so it advertises at most three market summaries while preserving every eligible summary from other sources. This limits model-facing catalog exposure, not permission: the tool can still load an unlisted model-invocable skill by its exact name. The human-facing [`skills/list` catalog](../../api/session-controller/README.md) remains complete for the session's user-invocable skills and does not apply these limits. Zero, negative, and fractional limits fail configuration validation.

### What the model gets

- **A session catalog.** When model-invocable skills exist and the `skill` tool is visible, the agent receives a durable user-role message before its first request, listing selected skill names and capped routing summaries; the message tells the model to load a skill with the tool before acting on it, and never to infer instructions from the summary alone. When every eligible summary fits, the catalog lists them all.
- **A loader tool.** The model calls `skill` with the exact skill name and receives the full instruction body plus resource guidance in a canonical `<skill_content>` block; the result is retained as ordinary tool history.
- **Explicit user invocation.** While this exact `skill` tool is visible, a `/name` token in direct user input that names a user-invocable skill injects that skill's instructions into the step, without the model having to load it.
- **Live catalog updates.** Later membership, routing summary, visibility, task selection, or exposure-mode changes append a replacement catalog; removing every skill appends an empty catalog that retires older names. Catalogs that omit eligible summaries identify their entries as a selection.

### Observable success and failures

Loading a listed skill returns its full instructions; the model sees one canonical shape whether the load came from the tool or from a user's explicit invocation. An invalid name reports `Error: invalid skill name "<name>"`, an unknown name reports the skill is unknown or no longer available, and a skill disabled for model invocation reports it is not available for model invocation. The catalog is omitted entirely when no catalog was ever published and either no model-invocable skills exist or the `skill` tool is hidden or shadowed; after a catalog has been published, either visibility loss — the `skill` tool hidden or shadowed by a same-name scoped tool — or removal of every skill instead appends an empty catalog that retires older names.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the catalog and the invocation boundary are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The catalog is a durable projection whose digest covers the published entries and bounded exposure mode, not the rendered prose. Consumers read its recorded entries instead of parsing `<available_skills>`. One canonical rendering serves both the tool result and user-explicit injection through `renderSkillContent` shared from `dsh-skill`, so both load paths produce the same `<skill_content>` instructions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, catalog and gesture pre-step listeners, rendering and digest |
| [`src/catalog-selection.ts`](src/catalog-selection.ts) | Source-bounded summary selection and the shared explicit-gesture parser |

### Catalog lifecycle

At each eligible `agent/pre-step`, the plugin snapshots the calling session's skills, checks exact `skill` tool visibility, filters to model-invocable skills, and applies configured source limits. It compares the entries and exposure mode against the newest visible `skill-catalog` message in the session log. A changed digest contributes a durable replacement to the `enter` decision; an empty replacement explicitly retires earlier names. An incomplete provider snapshot retains an existing visible last-good catalog. Without one, preparation fails before dispatching a model request; the next user retry attempts discovery again.

The visibility check compares the exact registered tool definition, so an unrelated scoped same-name shadow removes both the schema and its guidance. A visible active loader with `scopedCatalogOwner: true` owns its registry's catalog and rechecks visibility after discovery; other instances leave that catalog intact. Without this opt-in, an ancestor treats a nested loader as a same-name shadow. The plugin works globally or inside one agent's composition.

When a source limit omits eligible summaries, the durable source carries optional `bounded: true`. Its absence identifies a complete catalog and preserves compatibility with earlier records. Other persisted values do not describe a usable catalog. A transition between complete and selected summaries republishes the catalog even when the entries are unchanged. The [persistence acknowledgement](../../../docs/persistence-changes/2026-11-02-bounded-skill-catalog.md) records the optional-field compatibility.

### Summary selection

Each limited source is selected independently. The latest accepted direct user message supplies lexical intent. Explicit `/name` gestures in that message take priority, then deterministic matches against names and descriptions choose the remaining summaries. A tool-only continuation retains still-eligible names from the most recent durable catalog and fills vacated slots in registry order, even if compaction hides the original user message. Without a prior catalog, visible direct user history supplies the fallback. Matching normalizes case and character width and includes adjacent Han character pairs; ties and the final catalog preserve registry order. Host injections and assistant text never supply ranking intent. Selection does not load bodies, perform semantic search, or use process-local state, so restoring the same history and registry produces the same selection.

### Invocation boundary

The `/name` gesture listener scans every claimed direct user message while this plugin's exact `skill` definition is visible: a whitespace-bounded token naming a user-invocable skill in the workspace catalog injects the same `<skill_content>` rendering as a `user`-role instructions context appended after every other injection. Source limits do not cap the number of explicitly invoked bodies. The listener rechecks tool visibility after loading, so a hidden or shadowed consumer cannot inject stale instructions. Unknown names and user-disabled skills stay ordinary prose. This is the only entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry vocabulary behind the catalog to the exact tool schema and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider vocabulary behind the catalog.
- [skill package](../skill/README.md) — the registry and the shared `renderSkillContent` rendering.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill) — the exact `skill` schema the model receives.
- [Bounded catalog persistence acknowledgement](../../../docs/persistence-changes/2026-11-02-bounded-skill-catalog.md) — optional exposure-mode metadata and earlier-record compatibility.
- [User-explicit skill invocation Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md) — the `/name` gesture design.

-----

<a id="model-experience"></a>
## Model Experience

### Session catalog

#### What the model sees

If model-invocable skills exist and this exact `skill` tool is visible, the agent receives a durable user-role catalog before the first request. The default template below includes every eligible summary. When a source limit omits eligible summaries, the bounded templates list the selected summaries. Changes append replacements; an empty replacement explicitly retires older names. Every template tells the model to follow a user-invoked `<skill_content>` block instead of loading that skill again.

##### Skill catalog template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-routing-summary>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### Bounded initial catalog template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following is a selected set of skill summaries for this task, not the complete directory of permitted skills:

<available_skills>
- `<name>`: <normalized-and-capped-routing-summary>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
Other permitted skills may be loaded by an exact name supplied by the user. Do not invent skill names; ask the user to choose another skill if these summaries do not match the task.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### Bounded replacement catalog template

```markdown
<system-reminder>
The selected skill summaries changed. This selection replaces earlier recommended summaries; it is not the complete directory of permitted skills:

<available_skills>
- `<name>`: <normalized-and-capped-routing-summary>
</available_skills>

These are selected summaries, not all permitted skills. Use a listed skill when it matches the task; another permitted skill may be loaded by an exact name supplied by the user. Do not invent skill names.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

##### Empty replacement catalog template

```markdown
<system-reminder>
The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:

<available_skills>
</available_skills>

No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.
A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.
</system-reminder>
```

#### Token effect

Repeated input cost scales with the advertised summary count and `catalogDescriptionMaxLength`; source limits cap only their own summaries, not other sources or loaded bodies. No initial catalog tokens are sent when the list is empty or the tool is hidden or shadowed. Each changed selection or exposure mode adds one retained replacement message.

#### KV Cache effect

The initial durable catalog follows the existing reusable prefix. Changed entries or bounded mode append history, preserving earlier reusable tokens and forming a new suffix. Unchanged tool continuations and restored histories do not republish the same catalog. A changed digest may affect cache reuse from the newly appended catalog position.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill). The selected catalog explains when to use an exact skill name supplied by the user.

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### User-explicit invocation injection

#### What the model sees

A whitespace-bounded `/name` token anywhere in a claimed user message, naming a user-invocable skill in the workspace catalog, injects that skill's full `<skill_content>` rendering (the exact result-template shape above) as a `user`-role instructions context appended after every other injection of that step — background first, the material to act on last. This plugin's exact `skill` tool must remain visible through loading; a hidden or same-name shadowed tool contributes no invocation instructions. Only direct user input is scanned, the check runs on the loaded definition, and unknown or user-disabled names stay ordinary prose. This is the sole entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose; the catalog's closing sentence tells the model to follow the injected block instead of re-loading it.

#### Token effect

Each gesture adds one rendered skill body to that turn as injected context — the same size as the tool result for the same skill, paid deterministically at the user's request instead of at the model's discretion. Repeated gestures for one skill within one step inject once. Catalog source limits do not limit these bodies.

#### KV Cache effect

Append-only; the injection lands after the reusable request prefix inside the step's message batch and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the catalog or the loader is a poor fit. They are current package constraints, not a task backlog.

- **The catalog omits source and provider metadata** — names and capped routing summaries do not identify the provider or resource location.
- **Bounded selection is lexical, not semantic retrieval** — synonyms or indirect task descriptions can omit a relevant summary. The tool has no directory-search operation; a user can choose a skill from the complete human-facing catalog or supply its exact name. Exposure limits are not invocation authorization.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog routing summaries are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
- **Catalog replacement is whole-list** — a changed selection, routing summary, or bounded mode appends every currently advertised summary; token cost remains proportional to that catalog.
- **Bodies are not versioned** — body-only edits do not change the catalog digest or notify the model; a later tool call reads the current provider content while earlier tool results remain historical facts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
