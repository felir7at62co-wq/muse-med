---
description: "The Web feedback surface: the Like/Dislike pair in the finalized assistant message's action row, the feedback dialog behind both ratings and `/feedback`, and its acknowledgement and failure toasts; for users and maintainers of the feedback experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-message-feedback

English | [中文](README.zh.md)

## Summary

Collect feedback on a completed answer or the current task through one dialog. Users can choose a category and add a description; failed submissions keep their draft. Muse Desktop sends both targets to the signed-in account's Muse inbox and offers optional, bounded conversation diagnostics. Other deployments use local Session feedback and their configured log delivery. Ratings and notes never enter model context.

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

Mount this plugin alongside `ui-conversation` and `ui-commands`; the Like/Dislike pair appears between copy and branch in each completed answer's action row. The composer Feedback action and, with `session-log-export`, the Session Header's Feedback action open the same dialog. Seven categories and a description are optional. A recorded rating stays visible without hover; clicking it retracts the local rating. A bare `/feedback` opens the Session dialog; `/feedback <text>` retains the separate Host command path.

On Muse Desktop, Submit sends the draft, category, and task or message identifiers to the Muse inbox. Diagnostics are unchecked by default; selecting the option adds bounded excerpts of the recent request and related answer. They exclude full logs, tool arguments and results, thinking, and attachments. A server-confirmed receipt raises “Submitted to the Muse inbox”; the local log keeps only that receipt marker and category. Retracting a local rating does not delete a submitted inbox record.

### Failures

A rating or list-load failure shows inline in the row; a submission failure shows a warning toast and keeps the draft. Muse requires its delivery provider and current account; it does not acknowledge a local record as inbox delivery. An uncertain send or account change directs the user to inspect the original account's inbox before deciding to retry. A confirmed cloud receipt stays successful if saving the local marker fails. Only finalized messages reach the message entry; an interrupted partial has no `messageId` or feedback controls.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package contributes the `feedback` entry (order 10) of `conversation.chat.assistant-actions`, declared by ui-conversation and rendered inside the finalized assistant message's IconActions row, and the `feedback-dialog` entry (order 2) of `conversation.input.overlay`, which renders the Modal and Toast primitives through body portals and centers the toast over the composer card it mounts inside. The `feedbackUi.openSession(sessionId)` Client service opens that same Session-scoped dialog without recording feedback; the Header menu and command decoration both use it. The `/feedback` decoration is an `action` registered through `ctx.commandUi.decorate`, so a menu pick or a bare Enter consumes the trigger token and opens the dialog while an argued line still reaches the Host command.

Per Session, one message controller loads ratings lazily and serializes local changes against observed versions. One dialog controller owns the draft and acknowledgement; a new draft resets diagnostic consent, a late completion leaves a newer draft intact, and disposal retires in-flight acknowledgements. The optional `feedbackDelivery` provider submits the selected target to the account inbox before a local receipt marker is recorded. Without that provider, other products use `messageFeedback.put` or `sessionFeedback.record`; Muse reports unavailable. The [Muse account provider](../../host/muse-account/README.md) owns authenticated delivery and diagnostic filtering.

The delivery service exposes Client-owned target and entry types. Its category keys share the dialog's presentation list and are checked against the durable feedback taxonomy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the feedback surface is not enough. They move from the browser strip to the Session-log backends and the conversation shell.

- [dsh-message-feedback](../../feedback/message-feedback/README.md) — the Session-log backend that owns per-item compare-and-set and persistence.
- [dsh-command-feedback](../../feedback/command-feedback/README.md) — the `/feedback` command, the `sessionFeedback` Remote, and the category taxonomy.
- [ui-commands](../ui-commands/README.md) — the command decoration contract the `/feedback` row goes through.
- [ui-conversation](../ui-conversation/README.md) — declares the assistant-actions strip and the composer overlay.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as ratings, categories, and notes are log-only events, not model input. Optional Session-log delivery uses request metadata rather than model context.

#### KV Cache effect

None; feedback mutations leave the model-visible history unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current feedback surface. They are current package constraints, not a general rating comparison or a task backlog.

- **Note size is a Host policy** — the deployment configures `maxNoteBytes` (8192 in the Web bundle) and the Host rejects an oversized note with `note-too-large`. The dialog does not pre-check the limit, so an oversized description for a message fails on submit rather than while typing; a Session remark has no bound.
- **No cross-tab push** — a second tab's rating becomes visible on reconnect or on the next conflict reply, not immediately; the controller does not consume feedback log events.
- **Chat view only** — the trajectory and waterfall views render no feedback controls even though their assistant nodes carry the same `messageId`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
