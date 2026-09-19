# Agent Note: Jubian storyboard isGenerate is not a gate

Status: implemented

English | [中文](2026-09-19-jubian-storyboard-isgenerate-not-a-gate.zh.md)

## Problem

Three Jubian call sites read the storyboard field `isGenerate` as "this storyboard has already been generated": `withGenerationEnabled()` refused to build the paid PUT unless the snapshot read 0, `select_assets` threw `CONTRACT_CHANGED` unless its read-back read 0, and `buildSubjectSelection()` reported `already_applied` only when it read 0. The provider stores 1 on every storyboard it holds — ones that already produced videos, ones that never generated, and empty placeholders alike — so `jubian_storyboard generate` failed before sending anything and the storyboard-native subject-video channel failed at its first step, while `already_applied` was unreachable and every selection call sent a PUT it did not need.

## Decision

No reader or transformation gates on `isGenerate`: the provider acts on the `isGenerate` a caller writes into a request body, not on the stored value, so the paid path's only precondition is that the saved `modelConfig.duration` equals the requested content duration plus one second. `select_assets` keeps its read-back and its billing-safety audit, where a selection-only save that produced a video task still reports `billing_safety_violation`; the `already_applied` no-op now depends only on the saved materials matching the plan. `readStoryboard()` still rejects a value that is neither 0 nor 1 and still reports `is_generate`, so a caller can see what the provider said.

Test fixtures in `jubian-api` and `tool-jubian` carry `isGenerate: 1`, the value the provider really returns, and the tool test's fake provider keeps storing 1 whatever a PUT body carried.

## Alternatives considered

**Treat a stored 1 as "already generating" and surface it as an error.** The field then refuses every request this provider can answer, which is the defect rather than a fix.

**Compare the value against a snapshot taken before the call.** A transition test needs a stored 0 to start from and the provider never stores one, so the comparison has no failing case left to detect.

**Detect a previous generation from the project's video task list.** Those records carry no storyboard id, and matching on the derived task name would guess at a relationship the provider does not publish; the ledger's idempotency key already stops a second dispatch of one submission.

## Consequences

`generate` sends its single PUT, which is what makes the paid path usable against this provider version. The removed check never fired, so no protection that was in effect is given up: what still stands is the duration precondition, the ledger key, and `submit_video`'s double task snapshot with identity matching. Should the stored value ever become a real signal, the check belongs back in one place.

`packages/jubian/jubian-api/tests/storyboard.spec.ts` pins that either stored value produces the same paid body, `packages/jubian/jubian-api/tests/selection.spec.ts` pins the no-op against the provider's own value, and `packages/jubian/tool-jubian/tests/native.spec.ts` pins a selection save whose read-back still reads 1.
