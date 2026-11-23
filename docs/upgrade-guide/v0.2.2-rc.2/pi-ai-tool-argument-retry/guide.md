---
kind: upgrade-guide
description: "pi-ai reports invalid completed tool arguments as retryable `INVALID_TOOL_ARGUMENTS` and a Chat Completions body cut inside an event as `TRANSPORT`."
---

# pi-ai tool-argument and truncated-stream failure codes

English | [中文](guide.zh.md)

## Change

Before this release, a pi-ai reply whose completed tool arguments were not a valid JSON object failed with `MALFORMED_RESPONSE`, which the default normal retry policy excludes. A Chat Completions body that ended inside an SSE event, before any finish reason, failed with `PI_AI_ERROR`. Muse account routes reported both as `UNKNOWN`, so neither was retried.

The first failure now uses `INVALID_TOOL_ARGUMENTS`, which the default normal retry policy repeats with a fresh request; no tool from the failed reply runs. The second failure now uses `TRANSPORT`, like a body that ends between events without a finish reason. Muse account routes keep `INVALID_TOOL_ARGUMENTS` and `MALFORMED_RESPONSE` with fixed messages, and the Desktop `muse-account` policy allows at most two consecutive `INVALID_TOOL_ARGUMENTS` retries. Session logs written after the upgrade record the new codes in `assistant/attempt`, `llm/retry`, and `turn/end`; earlier logs keep their codes.

Readers who supply a pi-ai `retryPolicy.retryableCodes` or a `muse-account` `modelRetryPolicy.retryableCodes` list, or who match these codes in logs or automation, are affected.

## Migration

1. In each supplied `retryableCodes` list for a pi-ai or `muse-account` route, list `INVALID_TOOL_ARGUMENTS` wherever `MALFORMED_RESPONSE` was listed to retry invalid tool arguments; a supplied list replaces the defaults. To bound repeats, add `consecutiveRetryLimits: { INVALID_TOOL_ARGUMENTS: 2 }` with the limit you need.
2. Update log queries and automation that matched `MALFORMED_RESPONSE` for invalid tool arguments, or `PI_AI_ERROR` for truncated Chat Completions streams, to match `INVALID_TOOL_ARGUMENTS` and `TRANSPORT` as well.
3. Confirm the change: after a reply with invalid tool arguments, the Session log contains an `llm/retry` event whose `failure.code` is `INVALID_TOOL_ARGUMENTS`, and no `tool/call` event for that reply.
