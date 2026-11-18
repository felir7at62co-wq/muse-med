---
kind: reference
description: "Atomic native editing and version-checked project history."
---

# Editing and project history

English | [中文](edit-migration.zh.md)

The companion protects ordinary native project, episode, character, scene, prop, storyboard, media and reusable-library edits with atomic version comparisons. The independent workbench does not connect to a supplier project or migrate its data.

## Editing and conflicts

Native GET replies retain their original fields and add `muse_edit` to each editable row: database identity, entity kind, native ID and snapshot SHA256. Updates, deletions and storyboard relation saves require that original token and a stable `x-muse-operation-id`; native tool calls supply `expected_database_id`, `expected_snapshot` and `operation_id`. Comparisons, native writes and immutable receipts share one SQLite transaction. Related-row changes invalidate bulk replacements and storyboard relation edits. A rejected native response or receipt failure rolls back the write.

HTTP 409 means the original edit version is stale. The browser retains its initial version across background reads, preserves unsaved input, and displays current and local fields for an explicit merge. Cancel keeps the local patch; a confirmed merge uses the newly inspected version and a new operation identity. Repeating the original operation returns its original receipt without overwriting later edits. An unknown network outcome does not justify changing the operation identity.

The declared native routes are protected; arbitrary SQL, filesystem modifications and unregistered extension routes are not. Revision restore remains a separate operation with its own content-field limits. Private `muse_edit` configuration bounds snapshot bytes, related rows and receipt bytes; defaults are 8388608, 10000 and 8388608. Invalid limits fail before writes.

## Project archives

Export and restore native projects through the workbench. An archive holds project content and its retained media. Keep the database, media, and operation receipts together for deployment backups. Reopening a historical version does not rewrite current prompts or call a generator.
