# Agent Note: Opt-in goal resume after transient model errors

Status: implemented

English | [中文](2026-11-13-goal-transient-error-resume.zh.md)

## Problem

An unattended goal stopped on any turn error until a person resumed it. In a 2026-11-13 desktop transcription run, upstream `SERVER` (HTTP 502) errors outlasted one request's provider retries; each failed goal round disarmed continuation, and one stop lasted 10.5 minutes. Overnight desktop runs and a cloud worker have nobody to press resume.

## Decision

`dsh-goal-round-driver` takes an opt-in `transientErrorResume { maxAttempts, delayMs, codes }` option, off by default. The driver decides in its `agent/error` listener: an admitted, uncompleted goal round that fails with an `LlmError` whose code is in `codes` (default `SERVER`, `TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED`) is marked instead of disarmed. At the next idle point the driver records a `timer` goal wait whose message names the code and the attempt `n/maxAttempts`, so the session log explains the next round; a wait the model recorded during the failed round is kept instead. A completed goal round, or a goal edit or resume (each bumps the revision), resets the in-memory count. After `maxAttempts` consecutive resumes the driver disarms and records an `input` wait whose message gives the stop reason, which the Web goal bar shows as its tooltip. The provider retry policy stays the first defense within one request. User aborts, policy blocks, the round cap, no-tools and job waits, other codes, non-model errors, and failures outside an admitted goal round keep the human-authorized resume rule, as do session-start edges.

## Alternatives considered

**Record the automatic resume as a `goal/change` with operation `resume`.** `resume` is the human-authorized transition: it bumps the revision, which trips the attempt fences, and the log would show automatic resumes as human ones. A new reason field would also fail the strict `goal/change` reader for older readers on the same session format. The existing `goal/wait` timer and input waits carry the reason without a persisted type change.

**Add a new wait reason such as `transient-error`.** The wait reason is a closed enum, so older readers would reject the value on replay; `timer` with a message already has the needed meaning and UI.

**Decide at `turn/end`.** The loop writes the same `LlmError` failure code into `turn/end` that `agent/error` carries, and `agent/error` fires first, so deciding there needs no extra cross-listener state. A second, non-transient report for the same turn still disarms.

**A separate plugin that resumes after error turns.** It cannot see the driver's private attempt state and would run after the driver already disarmed, so it would have to use the human `resume` operation.

**Persist the attempt count.** Activation is process-local and a session-start edge disarms anyway, so a durable counter would add persistence without a consumer.

## Consequences

Each resumed round consumes a goal round, so `maxGoalRounds` still bounds the total. A deterministic error reported as `SERVER` is retried at most `maxAttempts` times per revision. Compositions without the option keep the documented behavior. Headless one-shot runs exit at the first idle and do not benefit; a long-lived server profile needs the same option row. A transient failure before the goal message enters history, such as a failed compaction request in the round's first step, still disarms. A process restart during a cool-down keeps the durable timer wait but leaves the goal disarmed until a human resume. The [driver README](../../../../packages/goal/goal-round-driver/README.md#compose-it) documents the option.
