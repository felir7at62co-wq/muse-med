---
description: "Stable native generation submissions, durable receipts and explicit new-version permission."
kind: "reference"
---

# Muse generation admission

English | [中文](admission.zh.md)

## Summary

Native production requests retain one submission identity across retries, page refreshes and logins. **Generation submissions** reads original receipts and task references without generating again. A failed HTTP response does not establish that the supplier charged nothing. Another version requires a separate, explicit permission against a preceding terminal operation.

## Contents

- [Submission and reconciliation](#submission-and-reconciliation)
- [Coverage and supplier usage](#coverage-and-supplier-usage)
- [Integration and persistence](#integration-and-persistence)
- [Verification](#verification)

## Submission and reconciliation

Every protected native request requires `x-muse-operation-id`. The server commits a reservation before the original handler executes. The fingerprint contains the normalized method/path, canonical input and uploaded-file SHA; it excludes operation IDs and credential keys. The ledger stores the fingerprint, route and result receipt, not the original request body. Image/video receipts retain original record pointers without copying prompts or temporary media addresses.

An identical ID and input reads the original receipt. A changed input with that ID fails. A fresh UUID with the same fingerprint also fails when any original operation exists, including pending or unknown outcomes; clearing browser storage or logging in again cannot bypass this check. The browser reconciles the server fingerprint before choosing an ID. Cache persistence failure stops dispatch.

JSON success receipts commit before returning success. Stream deltas can appear while generation runs; `done` is held until the whole receipt commits. Oversized or unsaved receipts produce an unknown outcome, never a truncated success. Disconnects retain the original active handler so its eventual result can still be recorded. Restarted, unfinished reservations become unknown and are not automatically dispatched again.

Read the original operation before retrying. The UI can permit another version only after the original native operation is terminal. This permission reserves an authorized ID but does not invoke the supplier; the user returns to the original generation button to submit. Failed native tasks may already have incurred charges. Unknown results cannot receive this permission. Missing or deleted native task records remain unconfirmed.

## Coverage and supplier usage

The exported [native route catalog](compatibility/muse-admission.mjs) covers images, videos, character/scene/prop generation and description extraction, stories, episode storyboards, frame prompts, prompt polishing and novel AI rewriting. The novel rule-only import remains free of generation admission. The legacy paid `GET /storyboards/episode/:id/generate` returns 405; callers use the protected `POST /episodes/:id/storyboards` instead. Local editing, local image resizing, polling, downloads and adoption are separate from paid submission.

Independent TTS and Fal postproduction retain their own durable operation services and are not wrapped twice. This admission service does not cover supplier requests outside the native production route catalog, including configuration probes or material-service registration. It does not change the upstream clients' internal supplier retry policies or guarantee that a supplier itself deduplicates a request.

The native text client's real JSON/SSE usage reports are retained per supplier call. Later usage chunks replace that call's earlier snapshot instead of adding cumulative chunks together. Missing token fields stay `null`; reported zero remains zero. Multiple batch calls remain separate, and partial reports are not presented as complete billing. Other protocols without this observation stay unreported. Costs are never estimated. Usage-write failures show a degraded observation warning; they do not fabricate zero usage.

`recordResourceUsage(db, kind, id, payload, providerTaskId)` records an actual image/video poll report against its original native resource owner even after restart or manual polling without request context. A resource retains one cumulative snapshot; later operations that merely reference it do not receive another copy of its usage. Only nonnegative safe integer token values are accepted. Recording failures mark degraded usage and return `false` without throwing away the paid media result.

## Integration and persistence

`planMuseAdmission(root, readSource)` runs after prefix, audio, revision and postproduction planners. It reads staged source, installs the guard before native handlers, and refuses repeated or changed source anchors. Native generation resources are linked through SQLite triggers and the request's asynchronous context, including batch descendants that do not return resource IDs immediately. Every writing connection must register this service's SQLite function.

Owned tables use monotonic `muse_admission_schema` version 1 and complete SQL. The upstream migration files remain unchanged. `muse_admission.max_receipt_bytes` defaults to 2,097,152 and accepts integer values from 1,024 to 16,777,216. The worker uses `getActiveOperationCount(db)` to retain an original request after its HTTP connection closes; historical unknown rows do not keep an idle worker alive forever. Back up the database and media storage together.

HTTP paths begin `/api/v1/muse/admission`: `GET /capabilities` exposes database identity and the catalog; `GET /lookup?request_sha256=…` finds an original operation; `GET /` lists recent operations; `GET /:id` reads the original receipt; and `POST /:id/next-version` accepts a stable new `{operation_id}`. The grant references the preceding ID, rejects unknown/active operations and rejects concurrent competing grants. This service does not store supplier credentials in the browser.

## Verification

Run `node --test integrations/localminidrama/tests/muse-admission.test.mjs`. Fixtures use private real SQLite databases, native video route code, loopback suppliers, actual JSON/SSE parsers, HTTP disconnects and the actual browser cache helper. The suite checks reservations, cross-UUID deduplication, batch resource linkage, explicit grants, failed storage, receipt limits, stream completion and reported usage. No supplier key, paid generation or supplier permission check is included. [Expected failure output](tests/expected/muse-admission.json) remains owner-local.

## Dev note

None.
