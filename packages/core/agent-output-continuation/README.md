---
description: "Continue an output-limited answer, or a stop that produced nothing visible, in the same agent turn, with cancellation and repeat detection."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-output-continuation

English | [中文](README.zh.md)

## Summary

Continue an answer automatically when the provider reports `max-tokens`. Every continuation uses normal agent input, request preparation and compaction. A later normal stop completes the turn; the original truncated attempts remain in the session log. The plugin also asks the model again, a bounded number of times per turn, when a response stops normally with no visible text and no tool call.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount this function plugin beside the agent registry and loop. Muse Desktop mounts it by default; other profiles opt in through a patch.

```yaml
- insert:
    - id: agent-output-continuation
      name: '@deepseek-ai/dsh-agent-output-continuation'
      config:
        maxContinuations: null
        maxNoProgressResponses: 2
        repeatWindowChars: 16384
        maxSilentStopRecoveries: 1
```

`maxContinuations` is a positive integer or `null`; the default `null` imposes no count cap on progressing output. `maxNoProgressResponses` stops after consecutive empty or repeated truncated responses; its default is two. Repeat detection compares the full response hash and containment within the latest `repeatWindowChars` answer characters, whose default is 16384. `continuationTailChars` bounds the exact response suffix repeated in the continuation instruction; its default is 1024 characters, retaining trailing whitespace. `{responseEndJSON}` is that suffix encoded as a JSON string. These fields reject zero, negative, fractional and unsafe integer values at activation. `maxSilentStopRecoveries` bounds, per turn, the additional responses requested after a normal `stop` whose content holds no tool call and no text other than whitespace, such as hidden reasoning alone; its default is one, zero disables this recovery, and negative, fractional and unsafe integer values are rejected. It is counted separately from `maxContinuations`, and a new human message restores it. A response whose stream reports no finish reason is never treated as a silent stop. To disable this behavior, patch the plugin row with `disabled: true`.

Continuation is reserved only after a settled output-limited response or silent stop and only for its live turn. Queued human input takes priority. Cancellation, plugin disposal, a new live agent or idle transition withdraws queued continuation. Admission rejects stale reservations and preserves other pre-step policies. Restarting a session does not authorize automatic resumption of old truncated output.

The plugin reports recovery through `agent/output-limit-recovered` only after its continuation was admitted and a later response stopped normally. An error, cancellation or policy rejection remains that outcome. Truncated tool calls are discarded by the existing assembler; a complete reissued call executes through the normal tool pipeline, and its result still requires another model step. Request output limits remain unchanged and apply independently to every segment.

## Model Experience

### Continuation after a settled output-limited response

#### What the model sees

The previous committed answer prefix and a new user-role input with logged source `output-continuation` attributing it to this plugin; adjacent step events identify its turn and preceding response. Its text is:

##### Verbatim continuation instruction

```markdown
Your previous response was cut off before it finished. Continue exactly from where it stopped. Do not repeat the previous text or restart the answer. Complete the original request. If the response ended mid-sentence or mid-line, write only its missing suffix first; do not skip the unfinished item. If a tool call was cut off, issue the complete call again before claiming its action happened. Stop normally when the answer or required work is complete.

Exact end of the interrupted response (JSON string): {responseEndJSON}
```

#### Token effect

Each continuation adds the instruction and its assistant response to history. It creates a separate model request at the same configured output cap; normal request compaction may summarize earlier history. Repeated or empty responses consume requests until the configured progress guard stops them.

#### KV Cache effect

The instruction appends after the existing history and preserves its reusable prefix until another plugin compacts or rewrites that history. Provider cache availability remains provider-owned.

### Recovery after a stop with no visible reply

#### What the model sees

Its previous response, which holds no tool call and no visible text, and a new user-role input with the same logged source `output-continuation`; the preceding assistant response, which finished with `stop`, distinguishes this input from an output-limit continuation. Its text is:

##### Verbatim silent-stop instruction

```markdown
Your previous response ended without any visible reply and without a tool call, so the user received nothing; your reasoning is not shown to the user. Do not stop silently. If the requested work is not finished, continue it now by calling the provided tools; only those tools can read or change files or run code, and code written in a reply is not executed. If the work is finished, give the user a brief final reply that states only what tool results show was actually done. Stop normally when the answer or required work is complete.
```

#### Token effect

Each recovery adds the instruction and one assistant response to history and creates one additional model request. At most `maxSilentStopRecoveries` such requests occur per turn; a turn that spends them completes without a visible reply.

#### KV Cache effect

The instruction appends after the existing history and preserves its reusable prefix until another plugin compacts or rewrites that history. Provider cache availability remains provider-owned.

## Known Limitations and Deferred Work

- A provider's normal `stop` cannot establish that every requested item was written. This plugin responds to a reported output limit and to a stop that carried nothing visible; it does not judge whether a visible answer is complete or accurate.
- A response that only announces work, or prints code as text instead of calling a tool, counts as visible and ends the turn. Silent-stop recovery cannot make a provider answer: once its budget is spent the turn completes without a reply.
- Provider quota, request errors, cancellations and repeat detection can still end an answer before completion. Continuation cannot exceed the provider's per-request capacity or repair a provider that omits its finish reason.
- Only text is used for progress detection; two empty truncated responses stop even when the provider spent those responses on hidden reasoning. Output caps should leave room for visible answers.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
