---
kind: upgrade-guide
description: Coverage acceptance records use episode-local v2 hashes, and explicit drama assignments require work_scope-aware readers.
---

# Drama episode work scope

English | [中文](guide.zh.md)

## Change

New coverage records use `version: 2` and `episode_manifest_sha256`; older skill copies cannot validate these records. The updated reader keeps v1 records valid only while their original whole-manifest hash matches. Existing manifests without `work_scope` keep the full-story inventory and prefix-acceptance rules.

An explicit `work_scope.episode_ids` defines local assigned episodes independently from the whole-story `expected_episode_count`. Scoped state completion describes that assignment, not the whole story. Scoped splitting preserves other contributors' files and rows; malformed existing manifests now fail before writes. Delivery names retain complete canonical episode IDs from `01` through `9999`; zero and out-of-range IDs are rejected.

## Migration

1. Update the adjacent `tweet-drama-core`, `tweet-drama-script-split`, `tweet-drama-pipeline`, and `tweet-drama-delivery` skill directories together. Personal installed copies do not synchronize automatically.
2. Back up `episodes/manifest.json`. Confirm the authorized episode list, then add `work_scope.episode_ids` using the [scope schema](../../../../packages/drama/skills/skills/tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage). Keep the true whole-story total; never infer scope from current files.
3. Run `episode_coverage.py <project> audit`. Resolve missing sources, stale hashes and uncertain mappings. Run `accept <episode...>` only for reviewed episodes that pass; pending entries cannot be bulk-approved. Freshly accepted episodes receive v2 records.
4. Run `gate <episode...>` before an authorized submission and `pipeline_state.py <project> sync`. Verify `completion_scope=work_scope` and the exact `scope_episodes`. A nonzero gate result stops submission. These commands do not generate or submit paid media.
