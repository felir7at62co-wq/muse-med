---
kind: upgrade-guide
description: Offline BGM preparation names copied package origin in its runtime inventory.
---

# BGM runtime package source

English | [中文](guide.zh.md)

## Change

The optional Windows offline BGM preparation tool records the copied distribution origin in `runtime-manifest.json` under `packageSource`. Executable and asset hashes remain unchanged in format.

## Migration

Update inventory readers to use `packageSource`. Existing inventories still pass byte verification; regenerate an inventory from the same validated inputs when the new field is required. Never replace measured hashes with assumed values.
