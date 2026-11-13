---
description: "Route Muse Main Session tasks to existing or fresh ordinary execution Sessions, with durable receipts and owner-only status controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-coordinator

English | [中文](README.zh.md)

## Summary

Compose this optional Host plugin with a routing-only preset. The Main Session searches the local profile owner's ordinary conversations, checks candidate summaries, and chooses an idle existing Session or a fresh worker. Workers keep their ordinary tools, history and presets. The separate task ledger tracks dispatch and execution revisions; receipt delivery does not imply completion or human acceptance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount the default export on the Host and `/worker` alongside ordinary tools. Compose `/main` only inside the configured Main preset. Muse offers `main-session` and retains `short-drama` as its default. The optional [Main Session navigation plugin](../../client/ui-session-coordinator/README.md) provides the retained Main entry and startup navigation. Worker Sessions keep their native sidebar rows; results return through Main chat messages. Removing the Host plugin retains ledger files and ordinary Session history.

`mainPreset` and `workerPreset` select distinct roles; `searchLimit` bounds search rows and `readChars` bounds each raw history page, allowing one oversized event intact. `noteChars` bounds each routing note (`instructions`, `reason`) Main writes, and `summaryChars` bounds a worker report summary. Search and read are local profile-owner capabilities across working directories. They never open remote accounts or grant access to another user's profile. The Remote methods require global owner access; scoped guest grants do not authorize the task directory.

Main's positive capability list admits coordination tools, `ask_user_question`, `show_view` and `visualize`. The fixed `coordinator_display_skill` loader reads only the model-invocable `visualize` Skill through the native registry; general `skill`, file and shell tools remain unavailable. An execution guard also rejects other tools, including late registrations and the PTC transport. Workers are created through the ordinary Session controller, outside Main's restrictive scope. Main routes requests, relays receipts and worker questions, and handles stop requests; planning, research, writing, file changes, downloads, generation and review remain worker tasks. The worker brief and `coordinator_report` guide a worker to report `needs-input` with one question in its summary instead of asking in its own chat, and Main relays that question to the user. Workers keep `ask_user_question`, because short-drama content-listening acceptance and budget approval accept only an answer to a question asked in the same Session.

Main's system prompt limits it to routing: it does not restate or add requirements, does not read worker history before reconciliation, and ends its turn after dispatch instead of polling. It asks the user to restate in one message a request spread across earlier messages, relays a `needs-input` question as text rather than a card, dispatches the revision after the user's reply, and stops reconciling a task whose reconciliation ended without a report. It prioritizes readable chat presentation: concise conclusions, grouped information and task-report cards after dispatch and when a task ends. It guides the model to use structured cards for comparisons, lists, choices and forms, while keeping short answers as text. This is model guidance; task notifications do not create cards without a display-tool call.

Bounded routing notes are tagged relay context, and the worker brief labels them as notes, not requirements. Only Host-verified original human messages retain their original user attribution and unchanged content; coordinator-authored notes never become human authorization. Dispatch includes the latest Main human message and its attachments unchanged, the message recorded by each earlier revision, the routing notes and the saved video-model key when present. A fresh worker receives Main's dialogue-model selection; reusing a worker preserves its dialogue model. A saved video selection is applied through the worker's native selection service before input delivery. Missing or unavailable selection support rejects delivery instead of silently defaulting.

An existing worker must be idle, have no pending input or live owned jobs, and have no unsettled coordination task. Archived Sessions and subagents are reference-only. The agent chooses another worker when reuse is unavailable. A dispatch revision requires the expected revision and settlement or an explicit stop of its predecessor; it cannot silently steer over an in-flight assignment. Direct human input in a reserved worker invalidates its previous report and notifies Main without cancelling the new user work.

`coordinator_show_report` captures owner-verified task IDs, current revisions, worker Sessions, status and native file declarations in versioned tool-result metadata. Omitted or empty IDs select unsettled tasks first, then recent ones; `searchLimit` also bounds reports, with explicit total and truncation fields. `coordinator_tasks` returns routing rows in the same order without a card. Each row counts presented files instead of listing them; the serialized list is bounded by `readChars`, and a row that does not fit is omitted with `truncated` set. Dispatch, reconcile and stop return one routing row for the latest revision. For report cards, the combined serialized model result and metadata are bounded by `readChars`; only complete task receipts are retained, and an oversized first task fails instead of cutting its summary or files. Unknown, foreign, duplicate or excessive IDs fail. The model cannot provide completion flags, percentages or artifact paths. The Client renders inline cards and can follow the same captured revision through the existing task watch; later revisions never replace an earlier receipt.

The Muse spider entry below New Session opens one retained Main Session per profile in Muse's existing default Workspace. Creation goes through the native Workspace and Session controllers; repeated clicks and plugin restarts reuse its stable identity. Workers keep their selected project directories.

`coordinator_reconcile` requests verification of an idle retained worker without requiring Main to read its history. It checks the expected task revision, records the worker's current log position, and rejects an optional `expected_worker_seq` that differs from that position. It retains a new assignment revision and sends only coordination context. It neither replays human business commands nor changes the worker's model or directory. While that revision's brief and human input remain current, an execution guard allows only `read`, `read_image`, `glob`, `grep`, `present` and `coordinator_report`. Shell, downloads, generation, writing, delegation and tool transports are denied. A new direct human input restores ordinary capabilities as soon as it is consumed. The worker verifies existing work and reports against the new revision; further coordinated execution requires a separate authorized assignment. Busy input, live descendants or jobs, a mismatched `expected_worker_seq`, foreign ownership and conflicting request keys reject the operation; a busy rejection tells Main to wait for the next receipt instead of dispatching again. Exact retries reuse the recorded intent and receipt.

## Understand the implementation

The validated `muse_coordination` storage domain writes each task intent before creating its worker or sending input. Each request key is unique within its Main Session; exact retries return its existing task, while conflicting reuse is rejected. Every attempt retains its stable worker and message identities, source event and previous receipts. The current domain writes version 2 and reads compatible version 1 records; follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.2/muse-coordination-reconciliation/guide.md) before opening an existing profile or rolling back.

Native inbox splices and admitted user messages establish delivery. Recovery checks those records before retrying a dispatch intent. A receipt without confirmed settlement becomes interrupted; generation is never automatically resubmitted. Opening Main preserves its task directory, so Main can reconcile, stop or revise the task. Each task recovers independently; a failure is logged and leaves that task's stored status unchanged. Plugin unload drains its owned mutations and closes observers without cancelling ordinary execution Sessions.

The private `museCoordinationInput` Session projection retains only the latest consumed human identity and assignment brief identity for the reconciliation guard. It has no Client or wire view; the Session log and task ledger remain authoritative. Plugin unload releases the guard and projection registration together.

Worker settlement uses native Agent maintenance to retain newly queued input until the report write and notification finish. Input already consumed before settlement invalidates the earlier report; input arriving during settlement remains in the durable inbox for the next turn.

`coordinator_report` accepts only a consumed current assignment brief and its verified human input from the assigned worker. A reconciliation retains the existing human input identity and recorded log position; later direct input requires another reconciliation. Subsequent dispatch to another worker includes the verified human additions retained by earlier reconciliations. It captures successful native `present` declarations after that assignment's input and checkpoints the worker log. Its outcome is published only after the worker, its runtime descendants and their jobs settle, including pending creation and external execution cleanup. The runtime manager supplies tree ownership and nonblocking work checks; tree waits run outside the coordinator command queue so Stop remains available. A delegated failure after the report requires inspection and a new report. Idle without a report, while none of the assignment's brief or human inputs is still queued, becomes `needs-report`; after a reconciliation, its issue tells Main to inform the user instead of reconciling again. Text claiming completion alone does not complete the task. File declarations retain their source paths and are not copied or treated as content snapshots.

Stop persists `stopping`, removes unconsumed assigned input, cancels the assigned activity and its owned runtime descendants and jobs, and publishes `stopped` only after quiescence. Tree interruption includes pending startup and caller-delivered external execution, preserves child inboxes, and permits later task revisions to create new descendants. Only a busy worker that consumed a later human-authored message keeps running, and the task becomes interrupted; runtime continuations of the assignment, such as subagent settlement messages, are cancelled with it. A background producer that did not confirm resource release leaves the task interrupted until reconcile or Stop, and Stop then publishes `stopped` with that issue. This check covers only events after the current revision's input or recorded reconciliation position. Structured receipts wake Main through durable, identified native messages. UI status watches storage changes without model polling.

## Model Experience

### Routing and report tools

#### What the model sees

Main receives routing instructions plus `coordinator_sessions`, `coordinator_read`, `coordinator_dispatch`, `coordinator_reconcile`, `coordinator_tasks`, `coordinator_stop`, `coordinator_show_report` and `coordinator_display_skill`. Where installed, `show_view` and `visualize` remain resident and excluded from Tool Search. Workers receive a logged `muse-coordination` assignment followed by the unchanged verified human messages, and use `coordinator_report` for an explicit outcome. `coordinator_read` defaults to summary excerpts; its events view pages raw history with an explicit continuation cursor. Task lists and routing results are bounded task rows that count presented files, and receipt summaries are bounded by `summaryChars`. Reports distinguish preparing reconciliation, delivered, running, finishing, interrupted, stopped and worker-reported completion.

#### Token effect

History enters only when requested. Task lists and dispatch, reconcile and stop results add one row per task instead of every revision. Dispatch repeats the original task material and revision requirements in the chosen worker; terminal receipts add one bounded account to Main. Reconciliation adds a coordination-only verification request to the retained worker without duplicating its human messages. Report cards append the selected bounded receipt as ordinary logged tool output. The task watch does not call a model.

#### KV Cache effect

Stable policies and prior messages remain unchanged; new dispatches, reads and receipts append normal logged input or tool results.

## Known Limitations and Deferred Work

- A worker report is evidence of its account and native file declarations, not independent creative or human acceptance. Paid-generation authorization remains with the execution workflow.
- Coordination is process-local within one owner's profile. Cross-device workers and multi-owner shared task directories are not supported.
- Ambiguous restart settlements require inspection and an explicit continuation. No automatic paid retry is inferred from a missing report.
- No worker concurrency limit or queue exists. Adding one requires a queued status in the ledger and in the Client status maps.
- Fresh workers use Main's directory unless Main passes `cwd`, because short-drama episodes share one project folder; there is no per-task subdirectory.
- Routing worker questions to Main is guidance, not enforcement: content-listening acceptance and budget approval verify answers to `ask_user_question` in the worker Session, so those questions appear in the worker chat.
- Dispatch forwards only Main human messages, one per revision. Requirements spread across earlier Main messages and answers given through Main's question or form cards reach a worker only when the user sends them as a message; a revision without a new Main message forwards the previous message again.
- Receipt file lists are not bounded; only the summary is.

### Dev Note

Run the native-loop regressions under `tests/coordinator.spec.ts` and the keyless recorded-session scenario before changing dispatch identities, role guards, or cancellation semantics.
