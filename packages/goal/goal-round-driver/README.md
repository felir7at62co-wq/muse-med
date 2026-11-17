---
description: "The same-session continuation driver for users and maintainers choosing, composing, or debugging automatic goal rounds."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-round-driver

English | [中文](README.zh.md)

## Summary

`dsh-goal-round-driver` automatically continues an active goal in the same session while the agent is idle, continuation is armed, no wait is pending, and the configured round allowance remains. Each round gives the model another turn toward the objective; only goal rounds that reach model history consume the allowance, and exhaustion records a blocker. The driver's only configuration is the opt-in `transientErrorResume`; the goal defines the round limit, and `dsh-tool-goal` defines when repeated blocking stops continuation. Mount it with `dsh-goal` and `dsh-tool-goal` for unattended multi-round progress; omit it when each step requires human steering.

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

Mount `dsh-goal-round-driver` when an active goal should keep making progress without human intervention. It composes with the goal service and the goal tools: the service owns the state, the tools give the model control over it, and this package schedules the rounds.

An automatic round that finishes without tool calls yields instead of starting another round. A round containing only empty reads of running jobs waits for new output or settlement; the watcher observes output offsets without consuming the model cursor. Explicit tool waits can also name a deadline. New accepted user input releases a wait, and the next round starts after the human turn settles. Timer and job callbacks never rearm a disarmed or paused goal. Waiting is not completion or blocking, and the round cap still takes priority.

### Compose it

Mount the driver beside the goal service and the goal tools; its only option, `transientErrorResume`, is off unless configured.

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'
  config:
    # Optional; omit to keep every turn error a stop.
    transientErrorResume: { maxAttempts: 3, delayMs: 120000 }
```

`maxGoalRounds` belongs to the goal definition, while the model-facing blocked threshold belongs to `dsh-tool-goal`; duplicating either value in the driver could produce divergent policy.

`transientErrorResume` lets an unattended goal survive an upstream model outage that outlasts one request's provider retries. It applies only to an admitted goal round that ends with a listed `LlmFailure.code` (`codes`, default `SERVER`, `TIMEOUT`, `TRANSPORT`, and `STREAM_CLOSED`). Such a round does not disarm continuation: the driver records a `timer` wait whose message names the code and the attempt as `n/maxAttempts`, and the next round starts after `delayMs`; accepted user input releases the wait early. A wait the model recorded during the failed round is kept instead and still consumes one attempt. A completed goal round, or a human edit or resume, resets the count. After `maxAttempts` consecutive resumes the driver disarms continuation and, when the failed round left no wait of its own, records an `input` wait whose message gives the stop reason; the Web goal bar shows that message as its tooltip. Misconfigured values, including duplicate codes, fail the plugin load.

### What each round does

With an exact live agent idle, an active armed goal, and remaining capacity, the driver queues one goal-round prompt. It names the JSON-quoted objective, round number, and cap, and tells the model to use current workspace, tool results, and durable state as authority. An accepted round starts a distinct request series, so Chat renders its self-contained request header before the goal message. The round enters history as a goal-sourced user message; only an entered goal message consumes the cap, while human messages and stale reservations do not. Goal lifecycle mutations still require the independent authority checks in `dsh-tool-goal`.

### When continuation stops

A round starts only at whole-agent idle and, when the subagent service is loaded, only after the agent's progressing descendants settle; completion, pause, and blocking suppress continuation; a host-initiated pause also aborts the turn already running, while a model-initiated pause inside its own turn finishes normally. An edit only invalidates an in-flight round through the revision fence, and the driver continues the new revision. The driver also stops on its own when a turn ends on max tokens or with an error outside the opt-in transient resume, a durability write fails, the agent is cancelled, the plugin unloads, or the round cap is exhausted — at the cap it records a blocker with the stable code `round-limit`. Cancellation never auto-restarts a round: a goal whose round was under way is paused at the next idle point, and a cancellation unrelated to a goal attempt only disarms continuation. Agent disposal, such as a graceful process shutdown or a reload of the plugin that owns the Agent, aborts the round with the `disposed` cause and only disarms continuation, so the goal stays active, as on plugin unload; user, parent, and hook cancellations still pause it. A round prompt still queued when the agent reaches idle is removed from the inbox, so later human input does not wait behind it; when the cancelled turn belonged to other work, continuation is disarmed rather than paused.

### After resume, fork, or unload

Mounting the driver over an existing agent never arms a goal, and after session resume or fork an active goal stays disarmed until an explicit human-authorized resume — the driver never revives work on its own. Unloading the plugin cancels any in-flight round and ensures no later round starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the driver schedules rounds without races; the observable behavior is covered in [Use this package](#use-this-package).

### Design

- **Reservation, then admission.** At idle the driver reserves `roundsStarted + 1` for the current `{ goalId, revision }`, queues one `<goal_round>` prompt with a goal message source, and only an entered `user/message` increments `roundsStarted`. A reservation rejected as stale does not consume the round number.
- **Race fences.** The `agent/pre-step` listener verifies the complete claimed record against the current goal both before and after downstream listeners, so a stale, cancelled, or competing prompt is rejected before its step enters. Human work that arrives before a reservation makes automatic work yield until the agent is idle again.
- **Durability checkpoint.** `goal/changed` creates a durability obligation: before queuing work the driver awaits `ctx.sessions.flush()` and rechecks the goal revision and competing input after the await. A flush failure arriving through `agent/error` disarms continuation before another round can start.
- **Transient classification.** With `transientErrorResume` set, the `agent/error` listener marks the admitted, uncompleted round with the `LlmError` code instead of disarming; `turn/end` records the same code. The next idle pass settles the mark: it records the timer wait, keeps a model-recorded wait, or disarms on exhaustion, on a stale revision, or at the round cap. Any other error report for the agent, including a second report for the same turn, still disarms. The attempt count lives in process memory, keyed by goal id and revision.
- **Fail-closed teardown.** Teardown closes admission, disarms every live goal, cancels active work with the `parent` cause, and awaits the driver plus agent quiescence while its event fence remains installed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: driver state machine, race fences, teardown |
| [`src/prompt.ts`](src/prompt.ts) | The retained `<goal_round>` continuation prompt |

### The round prompt

The retained prompt is one text block: the JSON-quoted objective and `round/maxGoalRounds` on the first lines, then the working instructions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The driver consumes the goal state and defers policy to the goal tools; read these pages for the surrounding contract and the design rationale.

- [Goal service](../goal/README.md) — the goal state and lifecycle this driver continues.
- [Goal tools](../tool-goal/README.md) — the model-facing tools and their execution-time authority checks.

-----

<a id="model-experience"></a>
## Model Experience

### Goal-round prompt

#### What the model sees

Each admitted round is one retained user-role `<goal_round>` block naming the full objective and positive round number. Earlier human messages, goal-state snapshots, assistant output, and tool records remain in the same session history. A round resumed after a transient model error uses the same prompt; the cool-down and stop messages are durable `goal/wait` records that reach the model only through `get_goal` and `update_goal` results.

#### Token effect

One fixed instruction block plus the objective is added per admitted round. Later requests resend retained rounds until compaction shadows them; no fresh agent or copied conversation prefix is created.

#### KV Cache effect

Append-only within an epoch: each admitted round extends the existing conversation after its reusable prefix. Compaction may replace the derived-history suffix and move the reusable boundary.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the driver is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **No independent evaluator** — the model-facing goal policy decides when evidence is sufficient for completion and whether a blocker is semantically unchanged; evaluator-backed certification remains deferred.
- **Same-session execution only** — this package deliberately does not spawn a fresh agent, fork a session prefix, or implement Ralph-style independent attempts; that workflow belongs to its own plugin layer.
- **Accepted-queue unload race** — Cordis plugin unload is asynchronous. A goal prompt already accepted by the agent inbox can begin and consume its round before unload starts; teardown then cancels the request, disarms the goal, and awaits quiescence. No later round starts.
- **Round cap, not resource budget** — token, currency, time, and provider quota policies remain independent. Their session events are not attributed to the goal message or mapped into goal blocker codes.
- **Bounded transient resume only** — without `transientErrorResume`, every turn error needs a human-authorized resume. With it, at most `maxAttempts` consecutive resumes run per goal revision, and each resumed round consumes a goal round. A process restart during a cool-down leaves the goal disarmed until a human resume; headless one-shot runs exit at the first idle and do not benefit. A transient failure before the goal message enters history, such as a failed compaction request in the round's first step, and persistence failures still disarm ([decision](../../../.agents/notes/implemented/architecture/2026-11-13-goal-transient-error-resume.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided direction: evaluator-backed round certification, which stays outside this package by design.

</details>
