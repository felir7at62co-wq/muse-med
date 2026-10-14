---
kind: upgrade-guide
description: "Incomplete initial skill discovery now stops preparation instead of sending a model request without a skill catalog."
---

# Skill preparation deadlines

English | [中文](guide.zh.md)

## Change

An incomplete initial skill catalog now fails before the model request. Previously, the request could proceed without its catalog. A visible last-good catalog remains usable during a later discovery failure. Filesystem discovery is cancellable and bounded by `discoveryTimeoutMs` (30000 ms); watcher startup is bounded by `watchReadyTimeoutMs` (10000 ms).

Cancelled skill-registry discovery and loading now preserve the signal's original rejection reason instead of converting non-Error reasons to Error objects.

## Migration

1. Retry after fixing unreadable skill folders or failed filesystem watchers. No session-data migration is needed.
2. For deliberately slow filesystems, set `discoveryTimeoutMs` and `watchReadyTimeoutMs` on the `@deepseek-ai/dsh-skill-filesystem` row in your profile patch. Both accept positive integers up to 2147483647 ms.
3. Confirm that a new turn either loads the complete catalog or reports preparation failure before contacting the model. Cancelling a waiting turn must return promptly.
4. Consumers catching cancelled `ctx.skills.list()`, `snapshot()`, or `get()` calls must handle the configured signal reason without assuming it is an Error.
