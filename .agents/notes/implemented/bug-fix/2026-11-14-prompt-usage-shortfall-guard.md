# Agent Note: Discarding replies to incomplete requests

Status: implemented

English | [中文](2026-11-14-prompt-usage-shortfall-guard.zh.md)

## Problem

The Yunying relay serves gemini-3.1-pro through several upstream lanes. On 2026-11-13 and 2026-11-14 some large requests were answered by a lane that dropped the tool definitions and the tool-call history: the reply was HTTP 200, finished with `stop`, called no tool, and reported a prompt of a few thousand tokens for a request of about fifty thousand. In a Muse whole-series transcription goal the model, seeing no tools, said it was not running in the client and invented content; the loop committed the reply as an ordinary answer and the goal paused. The gateway journal measured the failure on about 7–9% of large gemini-3.1-pro requests from all callers, and on no gpt-6.1-sol request through the same relay.

## Decision

[`prompt-usage-guard`](../../../../packages/guard/prompt-usage/README.md) is an `llm/stream` listener for explicitly listed provider/model routes. It measures two references when the stream starts: the heuristic size of the request's non-deferred tool schemas (T) and the token meter's working estimate (E). It judges only a `stop` reply without tool calls and with a positive reported prompt P = input + cache-read + cache-write tokens. When P < `minToolSchemaRatio` × T and P < `minEstimateRatio` × E, it withholds the `stop` and yields a `PROMPT_USAGE_SHORTFALL` failure; when only one holds, it keeps the reply and logs a warning. Muse lists `muse-cloud-yunying`/`gemini-3.1-pro` with 1.0 and 0.5, adds the code to the `muse-account` retry policy and the goal transient-resume codes, and keeps the code local to the plugin.

The thresholds come from 124 local sessions with 17,663 usage-bearing replies. Eight replies were labelled bad: tool-less `stop`, 21–46 reported tokens per KB of request text against a healthy minimum of 224. They reported 0.19–0.73 of T and 0.09–0.25 of E. No healthy reply of any model reported less than 1.53 × T, and the lowest Gemini reply not labelled bad reported 0.56 × E. Requiring both references flags all eight with no false positive, and it tolerates the known inflation of E: the meter scales by anchor usage that includes output tokens, so a previous reply with long hidden reasoning raises E.

## Alternatives considered

**The previous reply's prompt as the reference** caught two of the eight, because six bad replies were the first request of a turn or session, and it flagged a legitimate shrink after a system-prompt replacement.

**Request bytes as the reference** fail in both directions: base64 images make healthy requests look large, and repetitive text could make them look small.

**The working estimate alone** depends on calibration that a committed bad reply had already lowered: after the incident's first bad reply the next estimate fell from about 53k to 41k although the context had grown.

**A guard-owned retry cap** would duplicate llm-retry's per-step budget with a second exhaustion path; the route policy owns the bound, as it does for `EMPTY_RESPONSE`.

**Adding the code to `LLM_FAILURE_CODES`** would claim a provider failure and publish a settings choice; `retryableCodes` already accepts any non-empty code.

**Placing the check in the Muse account adapter** would have its error sanitizer rewrite the unknown code to `UNKNOWN`.

**Buffering the reply until the finish** would remove live streaming on the main creative route and lose interrupted text on cancellation.

## Consequences

A discarded reply is a log-only `assistant/attempt`, so its text never becomes model-visible and its usage never becomes a calibration anchor. The retry resends the same logged context. With Muse's policy a persistent failure costs nine requests over about four minutes, then ends the turn, and an unattended goal resumes up to three times; a false positive would cost the same, because an identical request reports identical numbers. The discarded text streams live before it is retired. A lane that reports no usage, keeps the tool definitions, or ends in `max-tokens` is not caught. The gateway's per-model lane pinning remains the primary fix; this guard also covers routes and transports that the gateway does not.
