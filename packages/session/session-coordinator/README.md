---
description: "Route Muse Main Session tasks to existing or fresh ordinary execution Sessions, with durable receipts and owner-only status controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-coordinator

English | [中文](README.zh.md)

## Summary

Compose this optional Host plugin with a routing-only preset. The Main Session searches the local profile owner's ordinary conversations, reads relevant history, and chooses an idle existing Session or a fresh worker. Workers keep their ordinary tools, history and presets. The separate task ledger tracks dispatch and execution revisions; receipt delivery does not imply completion or human acceptance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount the default export on the Host and `/worker` alongside ordinary tools. Compose `/main` only inside the configured Main preset. Muse offers `main-session` and retains `short-drama` as its default. The optional [Main Session navigation plugin](../../client/ui-session-coordinator/README.md) provides the retained Main entry and startup navigation. Worker Sessions keep their native sidebar rows; results return through Main chat messages. Removing the Host plugin retains ledger files and ordinary Session history.

`mainPreset` and `workerPreset` select distinct roles; `searchLimit` bounds search rows and `readChars` bounds each raw history page, allowing one oversized event intact. Search and read are local profile-owner capabilities across working directories. They never open remote accounts or grant access to another user's profile. The Remote methods require global owner access; scoped guest grants do not authorize the task directory.

Main's positive capability list admits coordination tools, `ask_user_question`, `show_view` and `visualize`. The fixed `coordinator_display_skill` loader reads only the model-invocable `visualize` Skill through the native registry; general `skill`, file and shell tools remain unavailable. An execution guard also rejects other tools, including late registrations and the PTC transport. Workers are created through the ordinary Session controller, outside Main's restrictive scope. Main owns goal clarification, task planning, routing decisions, exception handling and review coordination. Specialist research, writing, file changes, downloads, generation and professional review remain worker tasks.

Main's system prompt prioritizes readable chat presentation: concise conclusions, grouped information and proactive task-report cards for dispatch, key progress, delivery and exceptions. It guides the model to use structured cards for comparisons, lists, choices and forms, while keeping short answers as text. This is model guidance; task notifications do not create cards without a display-tool call.

Routing instructions are tagged relay context. Only Host-verified original human messages retain their original user attribution and unchanged content; coordinator-authored instructions never become human authorization. Dispatch includes the exact original human message and attachments, all earlier revision requirements, routing instructions and the saved video-model key when present. A fresh worker receives Main's dialogue-model selection; reusing a worker preserves its dialogue model. A saved video selection is applied through the worker's native selection service before input delivery. Missing or unavailable selection support rejects delivery instead of silently defaulting.

An existing worker must be idle, have no pending input or live owned jobs, and have no unsettled coordination task. Archived Sessions and subagents are reference-only. The agent chooses another worker when reuse is unavailable. A dispatch revision requires the expected revision and settlement or an explicit stop of its predecessor; it cannot silently steer over an in-flight assignment. Direct human input in a reserved worker invalidates its previous report and notifies Main without cancelling the new user work.

`coordinator_show_report` captures owner-verified task IDs, current revisions, worker Sessions, status and native file declarations in versioned tool-result metadata. Omitted or empty IDs select recent tasks; `searchLimit` also bounds reports, with explicit total and truncation fields. The combined serialized model result and metadata are bounded by `readChars`; only complete task receipts are retained, and an oversized first task fails instead of cutting its summary or files. Unknown, foreign, duplicate or excessive IDs fail. The model cannot provide completion flags, percentages or artifact paths. The Client renders inline cards and can follow the same captured revision through the existing task watch; later revisions never replace an earlier receipt. Main reports key progress, deliveries and exceptions rather than every execution step.

The Muse spider entry below New Session opens one retained Main Session per profile in Muse's existing default Workspace. Creation goes through the native Workspace and Session controllers; repeated clicks and plugin restarts reuse its stable identity. Workers keep their selected project directories.

`coordinator_reconcile` requests verification of an idle retained worker after Main inspects its complete latest log. It checks the expected task revision and worker event position, retains a new assignment revision, and sends only coordination context. It neither replays human business commands nor changes the worker's model or directory. While that revision's brief and human input remain current, an execution guard allows only `read`, `read_image`, `glob`, `grep`, `present` and `coordinator_report`. Shell, downloads, generation, writing, delegation and tool transports are denied. A new direct human input restores ordinary capabilities as soon as it is consumed. The worker verifies existing work and reports against the new revision; further coordinated execution requires a separate authorized assignment. Busy input, live descendants or jobs, stale inspection, foreign ownership and conflicting request keys reject the operation. Exact retries reuse the recorded intent and receipt.

## Understand the implementation

The validated `muse_coordination` storage domain writes each task intent before creating its worker or sending input. Each request key is unique within its Main Session; exact retries return its existing task, while conflicting reuse is rejected. Every attempt retains its stable worker and message identities, source event and previous receipts. The current domain writes version 2 and reads compatible version 1 records; follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.2/muse-coordination-reconciliation/guide.md) before opening an existing profile or rolling back.

Native inbox splices and admitted user messages establish delivery. Recovery checks those records before retrying a dispatch intent. A receipt without confirmed settlement becomes interrupted; generation is never automatically resubmitted. Opening Main preserves its task directory, so the router can inspect the worker and explicitly stop or revise the task. Plugin unload drains its owned mutations and closes observers without cancelling ordinary execution Sessions.

The private `museCoordinationInput` Session projection retains only the latest consumed human identity and assignment brief identity for the reconciliation guard. It has no Client or wire view; the Session log and task ledger remain authoritative. Plugin unload releases the guard and projection registration together.

Worker settlement uses native Agent maintenance to retain newly queued input until the report write and notification finish. Input already consumed before settlement invalidates the earlier report; input arriving during settlement remains in the durable inbox for the next turn.

`coordinator_report` accepts only a consumed current assignment brief and its verified human input from the assigned worker. A reconciliation retains the existing human input identity and inspected log position; later direct input requires another inspection and revision. Subsequent dispatch to another worker includes the verified human additions retained by earlier reconciliations. It captures successful native `present` declarations after that assignment's input and checkpoints the worker log. Its outcome is published only after the worker, its runtime descendants and their jobs settle, including pending creation and external execution cleanup. The runtime manager supplies tree ownership and nonblocking work checks; tree waits run outside the coordinator command queue so Stop remains available. A delegated failure after the report requires inspection and a new report. Idle without a report becomes `needs-report`; text claiming completion alone does not complete the task. File declarations retain their source paths and are not copied or treated as content snapshots.

Stop persists `stopping`, removes unconsumed assigned input, cancels the assigned activity and its owned runtime descendants and jobs, and publishes `stopped` only after quiescence. Tree interruption includes pending startup and caller-delivered external execution, preserves child inboxes, and permits later task revisions to create new descendants. If the worker is processing another input, it is retained for inspection rather than cancelled. Structured receipts wake Main through durable, identified native messages. UI status watches storage changes without model polling.

## Model Experience

### Routing and report tools

#### What the model sees

Main receives routing instructions plus `coordinator_sessions`, `coordinator_read`, `coordinator_dispatch`, `coordinator_reconcile`, `coordinator_tasks`, `coordinator_stop`, `coordinator_show_report` and `coordinator_display_skill`. Where installed, `show_view` and `visualize` remain resident and excluded from Tool Search. Workers receive a logged `muse-coordination` assignment followed by the unchanged verified human messages, and use `coordinator_report` for an explicit outcome. Read pages include an explicit continuation cursor. Reports distinguish preparing reconciliation, delivered, running, finishing, interrupted, stopped and worker-reported completion.

#### Token effect

History enters only when requested. Dispatch repeats the original task material and revision requirements in the chosen worker; terminal receipts add one bounded account to Main. Reconciliation adds a coordination-only verification request to the retained worker without duplicating its human messages. Report cards append the selected bounded receipt as ordinary logged tool output. The task watch does not call a model.

#### KV Cache effect

Stable policies and prior messages remain unchanged; new dispatches, reads and receipts append normal logged input or tool results.

## Known Limitations and Deferred Work

- A worker report is evidence of its account and native file declarations, not independent creative or human acceptance. Paid-generation authorization remains with the execution workflow.
- Coordination is process-local within one owner's profile. Cross-device workers and multi-owner shared task directories are not supported.
- Ambiguous restart settlements require inspection and an explicit continuation. No automatic paid retry is inferred from a missing report.

### Dev Note

Run the native-loop regressions under `tests/coordinator.spec.ts` and the keyless recorded-session scenario before changing dispatch identities, role guards, or cancellation semantics.
