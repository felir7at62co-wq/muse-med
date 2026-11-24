---
kind: upgrade-guide
description: "Hongguo tasks started with the 8.0 engine require that engine to resume."
---

# Hongguo download tasks across engine upgrades

English | [中文](guide.zh.md)

## Change

`muse-hongguo-download` 0.2.3 uses the 8.2 engine. A task started with the 8.0 engine records that engine's identity and can only resume under the same identity. Switching to 8.2 preserves the task and its files. Resuming it under 8.2 reports `task_source_changed`.

## Migration

1. In a CLI profile, use `dsh --profile hongguo jobs --json` to identify unfinished tasks. In Muse, inspect the task from the conversation where it started.
2. Finish the task on the original engine, or keep that plugin version available in the original profile for resumption. Keep the task's workspace, verified files and receipts.
3. Start new requests under 8.2. Confirm the new task reports the 8.2 source identity in the job receipt.
