---
kind: upgrade-guide
description: "Desktop workspace writes move to an exclusively owned successor store; older builds no longer update that workspace registry."
---

# Desktop workspace successor storage

English | [中文](guide.zh.md)

## Change

Desktop routes the workspace domain to `muse-workspace-owned`. Its first open copies a complete snapshot from the previously selected live JSON backend into the configured successor `root`, preserving Workspace IDs, Session IDs, order, archive and pin state. The source JSON remains unchanged; the successor lease does not lock an older process writing that source. A migration receipt records its canonical path and SHA-256. Membership epochs and the authority ID are stored atomically with subsequent workspace changes.

One process holds the successor's kernel ownership lease for the complete domain lifetime. Another owner fails immediately; process termination releases ownership. Removing a bound membership, deleting its workspace or archiving its Session revokes the active video continuation before the ownership change is committed. Model and working-directory selections have separate scoped guards.

Before first publication, bounded local process snapshots reject another supported Desktop Host, including a prior Host still draining after its parent exits. An incomplete query rejects migration; no process is terminated. This check covers same-user Desktop processes, and on Windows the same interactive session. Manual non-Desktop writers and cross-user or cross-session sharing of a product home are unsupported.

The successor is authoritative after publication. Changes made by an older build to the retained source are not imported, and downgrading does not carry successor workspace edits back. Unsupported source backends, incomplete source mutations and a successor without its receipt fail instead of starting an empty replacement. Existing tasks without recorded original binding remain pending.

## Migration

1. Close the old Desktop normally before the first updated start. Keep the original workspace JSON and Session directories. The Desktop composition derives `sourceBackend` from the prior workspace route and retains that backend's configured root; do not substitute a default home for a custom source.
2. Start the updated Desktop once. Migration writes `state.json` and `migration.json` inside `storages/workspace-owned-v1/` under the active Harness home; Session log generations and the original JSON are not rewritten.
3. Verify the same Workspace and Session IDs appear, and inspect the receipt's source path and SHA-256 if migration reports a mismatch. A source containing an unfinished create/delete must be recovered by its original owner before migration.
4. Use the updated Desktop for subsequent workspace changes. Deleting, moving or archiving bound work cancels its automatic continuation. To inspect an older build, use an isolated home; do not expect old-source writes to synchronize into the successor.
