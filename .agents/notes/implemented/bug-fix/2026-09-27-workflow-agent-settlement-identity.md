# Agent Note: Attribute a workflow fan-out failure and keep a completed child's return contract

Status: implemented

English | [中文](2026-09-27-workflow-agent-settlement-identity.zh.md)

## Problem

A recorded 31-child production fan-out lost two children to one cause the harness never reported. The parent script called `agent(prompt, { schema })` per episode and told each child in the same prompt to `只返回一行 JSON`; the child's own request carried the matching `structured_output` tool, its schema, and the trailing system-prompt section `When you have your final answer, you MUST report it by calling the structured_output tool…`. The child answered in prose and one line of JSON, as its task text asked, and the run recorded that child as failed.

Three separate defects produced that outcome.

A child that finished its turn cleanly without committing the requested structured value was flattened to `stopReason: 'error'` by the in-process driver, so the workflow engine could not tell "the child failed" from "the child skipped its return channel" and the script received a bare `null`. The engine's own reason — the missing structured result — reached no durable record and no observer.

The durable `tool-workflow/agent-end` record carried only `runId`, `seq`, and `outcome`. In that session `label` and `childId` appeared on 2 of 31 member settlements, and only because the operator found those members by hand; nothing in the record said which child failed or why.

`outcome: 'completed'` meant only that the child's turn completed. Three of the completed episodes were rejected afterward for unusable content, so a consumer reading `completed` could not tell a usable artifact from a finished turn.

## Decision

**A skipped return channel is its own stop reason.** `SubagentStopReasonMap` gains `structured-output-missing`, which the in-process driver reports when a turn settles `completed` while the requested `outputSchema` was never captured, together with the existing diagnostic that names the tool call the child never made. A turn that failed on its own terms keeps its own stop reason. `run-settlement.ts` maps the new variant through its merge-extensible default, so the one-shot background path reports a failure rather than a completion.

**Every failed settlement names its cause.** `WorkflowAgentEndInfo` carries `reason: WorkflowAgentFailureReason`, a closed union of `child-failed`, `missing-structured-output`, `invalid-structured-output` (with the artifact detail), `infrastructure-fault`, and `cancelled`. The PTC host validates the reason a guest reports and the JSON bridge carries it to the engine's observers. The script still receives `null`, which its contract promises, but the failure is no longer indistinguishable from every other one.

**`completed` now requires the artifact the call declared.** The PTC host holds the schema each child request declared and checks the captured value before the runtime sees it: the value must be a JSON object and every property in the schema's top-level `required` list must be present. Only a passing check produces `completed`; a failing one reports `invalid-structured-output` with the missing property named. The check is structural by design — a schema can require a `dialogue` array but cannot require it to be non-empty, so semantic acceptance stays with the caller.

**The durable member settlement repeats the member's identity.** `tool-workflow/agent-end` writes the `label` and `childId` its start record established, plus the reason when the member failed, so one settlement record attributes a fan-out failure and locates the failing child Session without joining back by sequence number. Both identity members are optional in the payload: logs written before this change stay readable and keep their meaning.

**A schema call prepends its return contract to the task text.** `STRUCTURED_RETURN_NOTICE` precedes the script's prompt for every `agent(prompt, { schema })` call and states that the child finishes by calling `structured_output`, that only that call carries its result, and that an answer in plain text is discarded. A task body that describes its own return format describes the payload the schema already declares, not a competing instruction. The `workflow` tool description states the same rule where the script author reads it.

## Alternatives considered

**Accept a schema-valid JSON object found in the child's final text.** The two lost children did emit exactly the object their schema described, so recovering it from the text would have completed both. It also removes the only mechanical reason for the child to call `structured_output` at all, and the terminal guard that call installs — a later tool call cannot reopen a captured run. The return channel is what makes a child's result machine-checkable, so this keeps the channel required and fixes the statement of it instead.

**Keep the settlement shape and let an operator join starts to ends.** The start record already carried the identity, so a reader could recover it by `(runId, seq)`. That join is exactly what the reviewed session could not perform: `agent-end` arrived 29 times with nothing to attribute it to, and the two failed members were found by searching child Sessions by hand.

**Gate fan-out success inside the workflow script.** The script can validate anything it wants about a returned value, and the recorded parent script did log its own per-episode failures. A gate the script owns cannot make `completed` mean a usable artifact for any other consumer — the UI, an operator reading the Session log, or a later replay.

**Make the repeated identity required.** A required member would make every log written before this change unreadable by a payload validator that requires it, including the reviewed session that motivated the change.

## Consequences

A fan-out failure is now attributable from the durable record alone: `tool-workflow/agent-end` names the member, its child Session, and the reason. A consumer that reads `completed` as "the child delivered the value the call declared" is correct for the structural part of that claim and still needs its own content validation for the rest.

The prompt prefix adds about 90 tokens to every schema-bearing `agent()` call. A plain `agent()` call is unchanged: no schema, no prefix, and the child's final text remains the result.

A provider that honors `outputSchema` but keeps reporting a capture-less clean turn as `completed` is still handled by the engine's own check; the new stop reason makes the provider's report exact rather than load-bearing.

The [persistence record](../../../../docs/persistence-changes/2026-09-27-workflow-agent-settlement-identity.md) also acknowledges an optional `config.responseFormat` member that concurrent work in the same tree added to `event:request/header`. That entry is not part of this decision, and the record states which root belongs to which change.

## Testing

`packages/workflow/workflow-ptc/tests/integration.spec.ts` drives the real in-process stack: a schema child that answers in prose resolves the script's `agent()` to `null` and emits exactly one `workflow/agent-end` whose `childId` equals the one `workflow/agent-start` recorded, whose `label` is non-empty, and whose reason is `missing-structured-output`. `packages/workflow/workflow-ptc/tests/guest.spec.ts` pins the reason for a failed child, for a missing structured value, and for a captured value rejected by the artifact check with its detail text. `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts` pins the recorded payload of a completed member. `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` pins the new stop reason and its diagnostic. These suites and `packages/session/session-format-v0-to-v1/tests/` pass 217 tests across nine files.

The [Session log versioning decision](../architecture/2026-08-10-session-log-version-mechanism.md) owns why three optional payload members need no version bump; [its persistence record](../../../../docs/persistence-changes/2026-09-27-workflow-agent-settlement-identity.md) is the acknowledgement. Neither is superseded.
