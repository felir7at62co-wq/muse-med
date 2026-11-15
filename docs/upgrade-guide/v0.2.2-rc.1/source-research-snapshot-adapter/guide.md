---
kind: upgrade-guide
description: "New Muse source-research snapshots use adapter version 1.0.1, which older plugin readers reject."
---
# Muse source-research snapshot adapter 1.0.1

English | [中文](guide.zh.md)

## Change

New `muse-source-research` snapshots keep `schemaVersion:1` and use `adapterVersion:1.0.1` to preserve Hongguo observation-level missing-metric reasons. Older plugin readers accept only `adapterVersion:1.0.0` and reject these new snapshots. The updated reader validates both versions using their respective normalization rules. Existing snapshot bytes, IDs and historical reasons remain unchanged. Reports and mappings retain `adapterVersion:1.0.0`.

## Migration

1. Update every `muse-source-research` installation that reads a shared project before collecting new evidence there. Do not relabel or rewrite files under `.muse/source-research/snapshots/v1/`.
2. To obtain corrected missing-metric reasons, collect a new Hongguo snapshot with `source_snapshot` and `action:collect`. Read it with `action:read` and its returned `snapshotId`; confirm `adapterVersion:1.0.1` and the original observation's reason. Existing snapshots remain readable with their original hashes and reasons.
