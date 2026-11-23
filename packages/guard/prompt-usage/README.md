---
description: "Configure and diagnose the guard that discards a tool-less agent reply whose provider-reported prompt is far below the request it was sent, so the route's retry policy can resend the request."
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-usage

English | [中文](README.zh.md)

## Summary

The guard discards a tool-less `stop` reply when the provider reports prompt usage below both the tool-schema and working-context thresholds. It reports `PROMPT_USAGE_SHORTFALL` before the loop commits the reply. Low usage can reflect missing request content or inaccurate provider reporting. The route's retry policy determines whether to resend. The guard judges listed provider/model pairs with positive reported prompt usage.

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

Mount this plugin through a Cordis configuration row; it is not an installable profile bundle. It needs the `llm`, `sessions` and `tokenMeter` services.

### When to choose it

Use the guard on a route whose usage reports sometimes disagree with the dispatched context and whose tool-less replies may be unsafe to commit. Muse lists `muse-cloud-yunying`/`gemini-3.1-pro`. Its relay has returned both unusually small prompt usage and zero completion usage on replies with generated text. The guard treats the latter reports as unreliable and keeps those replies.

### Minimal configuration

```yaml
- id: prompt-usage-guard
  name: '@deepseek-ai/dsh-prompt-usage'
  config:
    routes:
      - { provider: muse-cloud-yunying, model: gemini-3.1-pro, minToolSchemaRatio: 1.0, minEstimateRatio: 0.5 }
```

| Field | Default | Meaning |
|---|---|---|
| `routes` | required | Non-empty list of guarded routes; a repeated provider/model pair or an unknown key fails at load |
| `routes[].provider` | required | Logical provider id exactly as the loop sends it |
| `routes[].model` | required | Logical model id exactly as the loop sends it |
| `routes[].minToolSchemaRatio` | required | Finite number above 0: the reported prompt must reach this multiple of the request's tool-schema estimate |
| `routes[].minEstimateRatio` | required | Finite number above 0 and below 1: the reported prompt must reach this fraction of the working-context estimate |

The package has no default route or threshold. A route qualifies only when its usage counts cached prompt tokens inside the prompt (`prompt_tokens` semantics); otherwise healthy cached replies look too small.

### Required retry wiring

Without retry wiring, the first discarded reply ends the turn with `PROMPT_USAGE_SHORTFALL`. List the code in the route's retry policy; a supplied `retryableCodes` replaces the defaults, so restate them:

```yaml
modelRetryPolicy:
  mode: normal
  maxRetries: 8
  retryableCodes: [EMPTY_RESPONSE, INVALID_TOOL_ARGUMENTS, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PROMPT_USAGE_SHORTFALL]
  consecutiveRetryLimits: { PROMPT_USAGE_SHORTFALL: 1 }
  backoff: { initialDelayMs: 2000, maxDelayMs: 60000 }
```

In normal mode, `consecutiveRetryLimits` caps retries for the same failure code within the step's total budget. This example permits one shortfall retry. A consecutive second shortfall ends the turn with the error. Muse uses this policy on `muse-account`. Goal auto-resume applies to the configured transient failures and leaves a shortfall stopped. The guard delegates retry decisions to the route policy. `always` mode ignores the consecutive limit.

### Choosing thresholds

Derive a route's thresholds from its logs. The reported prompt is the attempt's or message's usage `inputTokens + cacheReadTokens + cacheWriteTokens`. The tool-schema estimate is the heuristic price of the non-deferred tools in `request/header`. The working estimate is `request/context.workingContextTokens` where the working budget is mounted; each discarded reply's failure message also states all three numbers. Muse's values rest on 124 local sessions: the eight inferred bad replies reported 0.19–0.73 of the tool-schema estimate and 0.09–0.25 of the working estimate, while no healthy reply of any model reported less than 1.53 of its tool-schema estimate, and the lowest Gemini reply not labelled bad reported 0.56 of its working estimate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `llm/stream` listener, registered with `prepend`, judges only requests that the agent loop marked, that carry no auxiliary `purpose`, that name a live Session, and whose provider/model pair is listed. When the stream starts, before the adapter is pulled, it measures the tool-schema estimate of the request's non-deferred tools and the token meter's working estimate of the Session; both describe exactly the dispatched request. Every chunk is forwarded live. At the terminal finish it judges a `stop` reply that carried no tool-call chunk and reported a positive prompt. A reply that streamed non-empty text or reasoning but reports `outputTokens` of 0 contradicts its own usage, so the guard does not judge its prompt and keeps it; a reply with no generated content and 0 output tokens is still judged. Below both thresholds it leaves its loop, which closes the inner stream so inner listeners never observe a completed `stop`, and yields an error finish instead. Below only one threshold it keeps the reply and logs one warning with the measured usage and estimates.

The loop records the discarded reply as a log-only `assistant/attempt`. When the route policy permits a retry, it records `llm/retry` and resends from the same logged context. A discarded reply's usage never becomes a token-meter anchor, so later estimates stay calibrated. After disposal, a stream already running forwards its original finish.

| File | Purpose |
|---|---|
| [`src/index.ts`](src/index.ts) | Explicit routes, request selection, measurement timing and the error finish |
| [`src/assess.ts`](src/assess.ts) | Route validation and the pure two-threshold verdict |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Real app/Loader with the shipped Desktop rows and a synthetic dropping lane |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM subsystem](../../../docs/subsystems/llm-streaming.md) — the stream middleware and the retry policy that resends a discarded reply.
- [Token meter](../../llm/token-meter/README.md) — the working estimate and the shared tool-schema estimator.
- [Guard group](../README.md) — adjacent stream and tool guards.
- [Decision record](../../../.agents/notes/implemented/bug-fix/2026-11-14-prompt-usage-shortfall-guard.md) — evidence, thresholds and rejected alternatives.

<a id="model-experience"></a>
## Model Experience

None, as the guard checks reported usage and any policy-approved retry sends the same logged context in a new model invocation.

#### KV Cache effect

No request prefix changes; the discarded reply is a log-only attempt, so the resent request reuses the same prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The guard recognizes one narrow failure class from usage alone.

- A lane that reports no usage, or zero usage, is not caught, nor is one that reports zero output tokens for a reply with text (the prompt figure of such a report is unreliable), and neither is a bad reply that ends in `max-tokens` or calls a tool.
- Smaller tool sets lower the guard's sensitivity. Replies pass if the reported usage reaches either threshold.
- A false positive can repeat when the same request produces the same usage report. The measurements alone cannot establish whether the upstream service received the complete request.
- The discarded text streams live before it is retired, the context meter briefly shows the small prompt, and a chat turn that exhausts retries shows no continue button.
- The failure message is English host text, like the other Muse model failures.
- Muse's thresholds rest on eight inferred bad replies and 171 Gemini replies with a logged estimate; the gateway journal could not confirm each label.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
