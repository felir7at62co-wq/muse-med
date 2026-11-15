---
description: "Compact activity digests of watched Sessions for maintainers composing a parent Session that dispatches work to other Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-activity

English | [中文](README.zh.md)

## Summary

This package lets a parent Session follow the progress of Sessions it dispatched without polling them. A consumer such as the Muse coordinator registers a watch; the plugin folds each watched Session's tool calls, failures, image inputs, declared deliverables, owned jobs and token use, and puts one bounded digest into the parent's inbox. Questions, failed turns and stalls wake an idle parent; other progress waits for the parent's next step.

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

Mount the plugin in the Host beside the Session store, the projection registry and the Agent registry. It provides `ctx.sessionActivity`; consumers read it through `ctx.get('sessionActivity')` and treat it as optional. The Muse desktop Host mounts it before the session coordinator, which watches the worker of every executing assignment for that assignment's Main Session.

```yaml
- name: '@deepseek-ai/dsh-session-activity'
  config:
    wakeTools: [ask_user_question]
    maxLines: 8
    maxChars: 1200
    stallMs: 600000
    coalesceMs: 1000
```

| Field | Meaning |
|---|---|
| `wakeTools` | Tool names whose new calls in a watched Session wake the parent; the call's arguments are quoted, cut to 160 characters |
| `maxLines` | Watched Sessions listed per digest; further changed Sessions are counted |
| `maxChars` | Characters of the complete digest text |
| `stallMs` | Running time without a new event after which the watched Session wakes its parent once; `0` disables |
| `coalesceMs` | Delay that merges a burst of events into one evaluation |

`watch(parent, child, label)` returns a disposer. Watching the same pair again adds a reference and replaces the label; the watch ends when every reference is released, after one last evaluation delivers changes the coalescing delay has not reached yet. A newly watched Session appears once it commits a counted event.

### Delivery

- A digest lists each changed watched Session on one line: running or idle, the four most-called tools, image count, the four latest deliverable file names, job counts, failures with the latest failure text, latest context size and summed input tokens.
- A digest that only reports progress is injected: it waits in the parent's inbox until the parent's next step and never opens a turn by itself.
- While a digest is still pending, a newer digest replaces it in place, so the parent receives one digest with the latest totals.
- A new call to a `wakeTools` tool, a turn that ended with an error, or a stall adds a `Needs your attention` section and wakes an idle parent.
- When the parent logs the digest, its totals become the baseline; only Sessions that changed afterwards appear in the next digest.

### Failures and recovery

Without a live parent Agent the plugin skips delivery and keeps the baseline. Baselines, pending digest ids and stall timers are process-local: after a restart the first digest lists every watched Session that changes, and no stall wakes the parent until the watched Session commits another event. Unloading the plugin clears every watch and timer; a digest already in an inbox stays there.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionActivityDigests` service: projection registration, watches, coalescing, delivery |
| [`src/projection.ts`](src/projection.ts) | Host-only `sessionActivity` unit and its state schema |
| [`src/digest.ts`](src/digest.ts) | Pure digest rendering and wake decisions |
| [`src/types.ts`](src/types.ts) | Service key, `session-activity` message source and public state types |

### Data model

The unit folds `turn/start`, `turn/end`, `tool/call`, `tool/result`, `user/message`, `assistant/message`, `deliverables/presented`, `job/registered` and `job/settled`. Per-tool tallies keep calls, failures, the latest call sequence and its bounded arguments. Image blocks count when they reach the model as images; offloaded placeholders do not count. Calls without a result are dropped at `turn/end`. Record lookups use own keys, so provider-minted ids such as `constructor` never resolve to inherited members. State size grows with distinct tool names and declared deliverable paths.

### Delivery state

The service keeps, per parent, the watched children with their reference count, label, delivered baseline and stall timer, plus the id and captured totals of the digest still pending. A `user/message` with the pending id in the parent's log commits the captured totals as baselines. A digest that should wake removes the pending digest and queues itself as a follow-up. Wake reasons are judged against the totals last sent, logged or pending, so one question or stall wakes the parent once.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session coordinator](../session-coordinator/README.md) — the Muse consumer that watches executing workers.
- [Session projection registry](../session-projection/README.md) — the registry that folds the host-only unit.
- [Background job tools](../../jobs/tool-jobs/README.md) — the completion notices this package's delivery rules follow.

-----

<a id="model-experience"></a>
## Model Experience

### Activity digests

#### What the model sees

The parent model receives a user message with source `session-activity` and form `notice`. Its text starts with `Activity of the Sessions you dispatched (running totals; read a Session for details):`, followed by one line per changed Session, for example `- episode 1 [session-…] running turn 3 · tools bash 35, video_inspect 2 · images 8 · delivered ep001.md · jobs 2 running/12 done/1 failed · errors 1 (last: …) · context 21k tokens, input total 2.1M`. When something needs the parent, a `Needs your attention:` section quotes the question tool's arguments, the failed turn's error, or the stall time. The plugin registers no tools and no system-prompt section.

#### Token effect

Each logged digest adds at most `maxChars` characters, about 600 tokens at the default. Replacement keeps at most one pending digest per parent, and progress-only digests never start a model request. A wake starts one parent request.

#### KV Cache effect

Digests are appended as ordinary logged user messages; earlier messages, the system prompt and tool schemas do not change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process-local baselines** — after a restart the first digest repeats unchanged totals, and stall detection waits for the next watched event.
- **Deliverables, not every written file** — files appear only when a watched Session declares them through `present`; files written by shell commands are counted only as tool calls.
- **No cost in money** — token totals are shown; prices per model are not known to this package.
- **Subagents are not watched yet** — the coordinator watches its worker Sessions; delivering subagent and job activity to their parent Agent is planned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Design discussion and the phased plan (P0 coordinator workers, P2 subagents, P1 read-only harness tools) live outside the repository in the Muse design notes of 2026-11-15.

</details>
