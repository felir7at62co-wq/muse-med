---
description: "Session status lines as the session list shows them, and status digests of watched Sessions, for maintainers composing a parent Session that dispatches work to other Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-activity

English | [中文](README.zh.md)

## Summary

This package lets a parent Session see other Sessions the way a person sees the session list: running, idle, waiting for an answer or an approval, or failed, with the latest tool and the jobs and subagents still running. A consumer such as the Muse coordinator reads one Session's line on demand, or registers a watch so that status changes reach the parent as one bounded digest in its inbox. Waiting for input, a failed turn and a stall wake an idle parent; other changes wait for the parent's next step.

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

Mount the plugin in the Host beside the Session store, the projection registry and the Agent registry. It provides `ctx.sessionActivity`; consumers read it through `ctx.get('sessionActivity')` and treat it as optional. Pending questions and approvals come from the Typert gateway when the Host mounts one; running jobs, subagents and schedules come from the `workspace/session-activity` providers. The Muse desktop Host mounts the plugin before the session coordinator.

```yaml
- name: '@deepseek-ai/dsh-session-activity'
  config:
    maxLines: 8
    maxChars: 1200
    stallMs: 600000
    coalesceMs: 1000
    subagents: true
```

| Field | Meaning |
|---|---|
| `maxLines` | Watched Sessions listed per digest; further changed Sessions are counted |
| `maxChars` | Characters of the complete digest text |
| `stallMs` | Running time without a new event after which the watched Session wakes its parent once; `0` disables |
| `coalesceMs` | Delay that merges a burst of events into one evaluation |
| `subagents` | Watch every running subagent for the Session that started it, from `subagent/start` until `subagent/end` |

### Status lines

`describe(sessionId)` returns one line such as `running for 12 min · last tool video_inspect · job: ffmpeg cut, asr · subagent: ep001-writer`. The state is, in order of precedence:

| State | Source |
|---|---|
| `waiting for an answer in its own chat` | a pending `user-questions/request` for the Session |
| `waiting for an approval in its own chat` | a pending `approval/request` for the Session |
| `running` | the live Agent is running |
| `not open` | no live Agent |
| `last turn failed` | the latest turn ended with an error; the line adds its error text |
| `idle` | otherwise |

The duration counts from the open turn's start for running and waiting states and from the latest turn end otherwise. Job and subagent labels are cut to 40 characters, three per family.

### Watches and digests

With `subagents` on, a Session that starts a subagent receives that subagent's line in the same digests, labelled `name: task` from its own subagent catalog, until the subagent settles; the subagent's closing notice still arrives separately. `watch(parent, child, label)` returns a disposer. Watching the same pair again adds a reference and replaces the label; the watch ends when every reference is released, after one last evaluation delivers a change the coalescing delay has not reached yet.

- A digest lists each watched Session whose state, running work or failure changed; the duration and the latest tool are shown but change nothing on their own, so a busy Session does not produce a digest per step. Sessions that are not open are left out; a subagent's closing notice reports its end.
- A digest that reports no state needing the parent is injected: it waits in the parent's inbox until the parent's next step and never opens a turn by itself.
- While a digest is still pending, a newer digest replaces it in place.
- Entering a waiting or failed state, or a stall, adds a `Needs your attention` section and wakes an idle parent. Each state wakes the parent once until it changes.
- When the parent logs the digest, its lines become the baseline for the next digest.

### Failures and recovery

Without a live parent Agent the plugin skips delivery and keeps the baseline. A failing status read is logged and skipped; later evaluations continue. Baselines, pending digest ids and stall timers are process-local: after a restart the first digest lists every watched Session again, and no stall wakes the parent until the watched Session commits another event. Unloading the plugin clears every watch and timer; a digest already in an inbox stays there.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionActivityDigests` service: status reads, watches, coalescing, delivery |
| [`src/projection.ts`](src/projection.ts) | Host-only `sessionActivity` unit and its state schema |
| [`src/digest.ts`](src/digest.ts) | Pure status lines, digests and wake decisions |
| [`src/types.ts`](src/types.ts) | Service key, `session-activity` message source and public status types |

### Data model

The unit folds `turn/start`, `turn/end`, `tool/call` and `subagent/catalog` into the open turn and its start time, the latest tool call with its bounded arguments, the latest turn end with its error text, and the `name: task` labels of the Session's direct subagents. Everything else in a status line is read live when the line is rendered.

### Delivery state

Per parent the service keeps the watched children with their reference count, label, logged status key, last sent state and stall timer, the id and keys of the digest still pending, and a promise chain that serializes evaluations and releases. A `user/message` with the pending id in the parent's log commits the captured keys as baselines. A digest that should wake removes the pending digest and queues itself as a follow-up.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session coordinator](../session-coordinator/README.md) — the Muse consumer that watches executing workers and adds status lines to its Session search.
- [Session projection registry](../session-projection/README.md) — the registry that folds the host-only unit.
- [Background job tools](../../jobs/tool-jobs/README.md) — the completion notices this package's delivery rules follow.

-----

<a id="model-experience"></a>
## Model Experience

### Status digests

#### What the model sees

The parent model receives a user message with source `session-activity` and form `notice`. Its text starts with `Status of the Sessions you dispatched, as the session list shows it (read a Session for details):`, followed by one line per changed Session, for example `- episode 1 [session-…] running for 12 min · last tool video_inspect · job: ffmpeg cut`. When a Session needs the parent, a `Needs your attention:` section names the waiting state with the latest tool call, the failed turn's error, or the stall time. The plugin registers no tools and no system-prompt section; consumers render `describe` lines in their own tool results.

#### Token effect

Each logged digest adds at most `maxChars` characters, about 600 tokens at the default. Replacement keeps at most one pending digest per parent, and digests without a waiting, failed or stalled Session never start a model request. A wake starts one parent request.

#### KV Cache effect

Digests are appended as ordinary logged user messages; earlier messages, the system prompt and tool schemas do not change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process-local baselines** — after a restart the first digest repeats every watched line, and stall detection waits for the next watched event.
- **Waiting states need the gateway** — without a Typert gateway a Session waiting for an answer reads as idle or running.
- **Sessions that are not open** show no latest tool or turn end; `describe` says `not open` and digests leave them out.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Design discussion and the phased plan (P0 coordinator workers, P2 subagents, P1 read-only harness tools) live outside the repository in the Muse design notes of 2026-11-15.

</details>
