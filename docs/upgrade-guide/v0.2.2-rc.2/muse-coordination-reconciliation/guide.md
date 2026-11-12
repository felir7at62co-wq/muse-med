---
kind: upgrade-guide
description: "Muse coordination storage writes version 2 records that older coordinator builds cannot resume."
---

# Muse coordination reconciliation

English | [中文](guide.zh.md)

## Change

The optional Muse coordinator writes version 2 records in the `muse_coordination` storage domain. The current reader also accepts version 1 records. Reconciliation adds a `reconciling` state and retains the inspected worker input positions in each new assignment revision. Session logs and previous assignment revisions remain intact.

Older builds do not support these records. The JSON per-record backend treats an unsupported version as absent, so opening an upgraded profile with an older coordinator can hide tasks; it is not a supported downgrade. Report metadata also admits the new state; older Clients may display the raw tool result instead of the report card.

Report and worker-selection failures now expose `ToolArgsError` with `INVALID_ARGS`; missing reconciliation context exposes `ToolContextUnavailableError` with `TOOL_CONTEXT_UNAVAILABLE`. Callers must use these fields rather than match the previous untyped error text.

## Migration

1. Stop the profile's writer and back up its complete Harness home, including Session history and the `muse_coordination` storage domain. Keep parallel test instances in separate homes.
2. Upgrade the Host coordinator and its Client together. Custom compositions must provide `@deepseek-ai/dsh-session-projection` before the coordinator; shipped profiles already include it. Existing version 1 records are read without clearing task history; rewritten records receive version 2.
3. Open Main and confirm that earlier tasks and their original worker Sessions remain visible. After inspecting an idle worker with changed input, use `coordinator_reconcile` to request a new verification report. This operation sends coordination context without replaying the original human business commands.
4. Keep the upgraded profile on a compatible build. To roll back, stop its writer and restore the complete pre-upgrade backup into a separate home; do not mix old task records with newer Session history or run both writers against one home.
