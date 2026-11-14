---
description: "Configure and diagnose the guard that discards a tool-less agent reply whose provider-reported prompt is far below the request it was sent, so the route's retry policy resends the request."
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-usage

English | [中文](README.zh.md)

## Summary

Discard a tool-less agent reply when the provider reports a prompt below both the request's tool definitions and its working-context estimate. Such a reply was produced from an incomplete request: a relay lane that dropped the tool definitions and tool history answers from the system prompt alone. The guard replaces the reply's terminal `stop` with a `PROMPT_USAGE_SHORTFALL` failure before the loop commits it, so the discarded text never becomes model-visible; the route's retry policy resends the same request when its `retryableCodes` list the code. Only listed provider/model routes are judged, and a reply without reported usage always passes.

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

Choose it for a route whose provider sometimes answers a request it received only in part and reports usage for what it received. Muse lists `muse-cloud-yunying`/`gemini-3.1-pro`: on 2026-11-13 and 2026-11-14 that relay answered about 7–9% of large requests from a lane that dropped the tool definitions and tool history, and the model then claimed it was not running in the client. Replies that lose content but keep calling tools, and failures without usage, are outside this guard.

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
  backoff: { initialDelayMs: 2000, maxDelayMs: 60000 }
```

Muse sets this on the `muse-account` row and also adds the code to `goal-round-driver` `transientErrorResume.codes`, so an unattended goal resumes after the step's retries are spent. The guard itself never retries and has no budget of its own; `always` mode therefore retries without bound.

### Choosing thresholds

Derive a route's thresholds from its logs. The reported prompt is the attempt's or message's usage `inputTokens + cacheReadTokens + cacheWriteTokens`. The tool-schema estimate is the heuristic price of the non-deferred tools in `request/header`. The working estimate is `request/context.workingContextTokens` where the working budget is mounted; each discarded reply's failure message also states all three numbers. Muse's values rest on 124 local sessions: the eight inferred bad replies reported 0.19–0.73 of the tool-schema estimate and 0.09–0.25 of the working estimate, while no healthy reply of any model reported less than 1.53 of its tool-schema estimate, and the lowest Gemini reply not labelled bad reported 0.56 of its working estimate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `llm/stream` listener, registered with `prepend`, judges only requests that the agent loop marked, that carry no auxiliary `purpose`, that name a live Session, and whose provider/model pair is listed. When the stream starts, before the adapter is pulled, it measures the tool-schema estimate of the request's non-deferred tools and the token meter's working estimate of the Session; both describe exactly the dispatched request. Every chunk is forwarded live. At the terminal finish it judges a `stop` reply that carried no tool-call chunk and reported a positive prompt. Below both thresholds it leaves its loop, which closes the inner stream so inner listeners never observe a completed `stop`, and yields an error finish instead. Below only one threshold it keeps the reply and logs one content-free warning, the evidence channel for partial drops.

The loop records the discarded reply as a log-only `assistant/attempt`, then the route's retry policy records `llm/retry` and resends the same logged context. A discarded reply's usage never becomes a token-meter anchor, so later estimates stay calibrated. After disposal no reply is judged; a stream already running forwards its original finish.

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

None, as the guard adds no prompt, tool or message; a discarded reply is resent from the same logged context and costs another model generation.

#### KV Cache effect

No request prefix changes; the discarded reply is a log-only attempt, so the resent request reuses the same prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The guard recognizes one narrow failure class from usage alone.

- A lane that reports no usage, or zero usage, is not caught, and neither is a bad reply that ends in `max-tokens` or calls a tool.
- A lane that keeps the tool definitions, or keeps more content than they amount to, passes; small tool sets lower the guard's sensitivity.
- A false positive repeats on every retry of the same request, because the request and its estimates do not change; with Muse's policy it costs nine requests and then a goal resume.
- The discarded text streams live before it is retired, the context meter briefly shows the small prompt, and a chat turn that exhausts retries shows no continue button.
- The failure message is English host text, like the other Muse model failures.
- Muse's thresholds rest on eight inferred bad replies and 171 Gemini replies with a logged estimate; the gateway journal could not confirm each label.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
