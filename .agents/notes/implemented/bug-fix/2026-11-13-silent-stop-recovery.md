# Agent Note: Silent-stop recovery in output continuation

Status: implemented

English | [中文](2026-11-13-silent-stop-recovery.zh.md)

## Problem

A provider can end a response with a normal `stop` whose content is hidden reasoning alone. The agent loop ends a turn when a response carries no tool call, so the turn completed with nothing shown to the user. In one Muse short-drama session on gemini-3.1-pro through an OpenAI-compatible gateway, seven of about twenty-two turns ended this way after the model had already edited files, and the user asked for the file six times. The adapters classify only a `stop` with zero content blocks as `EMPTY_RESPONSE`; [an earlier decision](../../archived/bug-fix/2026-07-24-empty-model-response-is-retryable.md) declined to extend that classification to reasoning-only responses because a retry repeats the same request.

## Decision

`agent-output-continuation` treats a settled response as a silent stop when its stream reports `stop` and its content holds no tool call and no text other than whitespace. At `agent/turn-stopping` it injects one user-role instruction with the existing `output-continuation` source and keeps the turn open. `maxSilentStopRecoveries` bounds these requests per turn, separately from `maxContinuations`: the default is one, zero disables the recovery, and Muse Desktop sets two. A human message restores the budget. The instruction states that nothing reached the user, that only tools read or change files or run code, and that a final reply may claim only what tool results show.

The recovery uses the continuation's admission filter, human-input priority, and withdrawal on cancellation, idle and disposal, because the injected message has the same source kind.

## Alternatives considered

**Classifying a reasoning-only stop as `EMPTY_RESPONSE` in the adapters** would retry the identical request up to the retry policy's limit, with no new instruction and with the failed attempt absent from model history. An adapter test pins the current classification.

**A sibling plugin with its own source kind** would need a declared persistence type, an acknowledgement record and client handling. With the same source kind instead, the existing plugin's stale-input filter would drop the sibling's queued input.

**A discriminating field on the `output-continuation` source** would change the persisted digest of every event that carries a message source. The preceding assistant response already distinguishes the two triggers: it finished with `stop` or with `max-tokens`.

**Treating a missing finish reason as a stop** would infer intent from a provider that reports none. The plugin already declines that inference for output limits.

## Consequences

A silent stop costs at most `maxSilentStopRecoveries` additional requests per turn and then completes as before, so a provider that keeps returning nothing cannot loop. Subagents and Main Session turns receive the same recovery. Where another `agent/turn-stopping` listener handles a narrower case, such as a missing submission from the Muse continuity reviewer, the listener that registers first injects its instruction for that stop; the narrower policy's request cap still applies.

A text-only response that announces work without doing it, or prints code as text, is visible and still ends the turn. The plugin does not judge it.
