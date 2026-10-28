---
description: "Configure and diagnose a local stop for streamed tool arguments that repeat one JSON object member, with bounded optional response recovery and no tool replay."
kind: "package-reference"
---

# @deepseek-ai/dsh-argument-loop

English | [中文](README.zh.md)

## Summary

Stop a model response when one JSON object repeats the same member name at an explicitly configured count. Completed earlier work stays intact; no tool from the failing response executes, even a complete call preceding the looping call in that response. The existing raw attempt and structured `TOOL_ARGUMENT_LOOP` turn failure explain the stop. Optional `recoveryAttempts` resamples the unsettled request within a per-turn limit; it never replays completed tools. It does not repair model reasoning or detect every kind of loop.

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

Mount this plugin through a Cordis configuration row; it is not an installable profile bundle.

### When to choose it

Choose it to stop repeated member names inside a single streamed tool-argument object before the output budget is exhausted. Use [repeat-tool-reminder](../repeat-tool-reminder/README.md) for advisory reminders about already executed identical calls instead. Ordinary prose, string values, auxiliary model requests, and repeated keys in separate array objects are not this guard's target.

### Minimal configuration

```yaml
- id: tool-argument-loop
  name: '@deepseek-ai/dsh-argument-loop'
  config:
    repeatedPropertyLimit: 64
    recoveryAttempts: 1
```

| Field | Default | Meaning |
|---|---|---|
| `repeatedPropertyLimit` | required | Safe integer ≥ 2: occurrences of one decoded member name in the same object that stop a response |
| `recoveryAttempts` | `0` | Non-negative safe integer: maximum fresh responses after local argument-loop failures within one turn |

The package has no implicit threshold. Muse explicitly selects 64: the reported incident repeated `page_num` about 18,000 times, while 64 occurrences of one member in one object cannot advance that ordinary tool call. Muse also explicitly permits one response recovery per turn. This conservative stop is not a universal guarantee. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-argument-loop) is the exhaustive accepted-field reference.

### After a stop

With recovery enabled, the guard closes the failed stream before the loop retains its raw `assistant/attempt` and requests a fresh response from the same current request. Earlier completed tool results stay in history, while partial calls and complete calls from the failed response never enter tool execution. The budget covers the whole turn and does not replenish after successful intervening steps. Cancellation and host pause stop recovery; unloading cancels and awaits any pending recovery. No instruction, model setting, goal revision, or content-safety policy is changed.

When recovery is disabled or exhausted, the guard throws a local `LlmError` outside provider retry semantics, so even `retryPolicy: always` cannot restart it. Other provider errors, including content-safety failures, retain their existing policy. Inspect raw attempts, completed results, remote task IDs, writes, and cost records before a later human-authorized restart; a failed turn does not make earlier successful or uncertain paid operations safe to repeat.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `llm/stream` listener only wraps requests marked by the agent loop. Incremental lexical state counts decoded keys independently for each nested object and tool-call index, without retaining value strings. It follows the assembler's first-block-end contract and checks authoritative full arguments separately rather than appending them to deltas twice. The exact triggering chunk is retained before either the bounded recovery finish or terminal exception. The loop cannot dispatch tools from an unsettled response. Only an internally witnessed local failure bound to the current turn signal can use `agent/request-error` recovery; provider-supplied copies of the failure code do not qualify. Iterator return awaits upstream cleanup. Disposal drains pending recovery before removing listeners.

| File | Purpose |
|---|---|
| [`src/index.ts`](src/index.ts) | Explicit policy, request selection, local failure and stream ownership |
| [`src/detector.ts`](src/detector.ts) | Bounded incremental JSON-prefix scanner |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Real app/Loader, always-retry provider and Goal Round with local side-effect counters |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM subsystem](../../../docs/subsystems/llm-streaming.md) — the stream middleware and provider boundary.
- [Output continuation](../../core/agent-output-continuation/README.md) — normal output-limit recovery remains unchanged.
- [Guard group](../README.md) — adjacent policies and advisory reminders.

<a id="model-experience"></a>
## Model Experience

None, as no prompts or tool definitions are added; optional recovery resends retained history and consumes another model generation with its normal token usage.

#### KV Cache effect

No request prefix is rewritten; the raw failed attempt is diagnostic evidence, not a new injected model message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The guard deliberately recognizes a narrow failure class.

- It validates only the received JSON prefix through the repeated key's colon, not future bytes or all argument semantics; malformed or ambiguous prefixes disable scanning rather than inventing a format error.
- Scanning stops without a loop verdict beyond its defensive state budgets: 128 nesting levels, 4,096 distinct retained keys, 65,536 retained key characters, or 1,024 characters in one key. Values are not stored. These are scanner capacities, not additional model-quality thresholds.
- Repeated prose, different keys, loops spread across requests, and duplicate counts below the explicit limit remain possible. No model repair or automatic paid-operation recovery is provided.
- The synthetic 18,000-member regression models the reported failure class; it is not an exact replay of the original EP23 private log or proof that every provider exposes identical chunks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
