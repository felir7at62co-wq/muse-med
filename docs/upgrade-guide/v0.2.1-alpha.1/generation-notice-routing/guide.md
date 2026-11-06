---
kind: upgrade-guide
description: "Group generation notices require a saved assignment before automatic result routing."
---

# Group generation result routing

English | [中文](guide.zh.md)

## Change

Older builds could route a generation result from the `jubian-generation-watch` message's `groupOrigin` alone when the team handoff record was missing. The team now routes only from its independently saved handoff. Creating that record requires the original `bot` / `room` assignment in the worker's Session history. A receipt cannot change its original participants.

Ordinary notices remain readable, including their metadata. Existing handoffs still resume after restart and reach the same requester. A notice without verifiable assignment evidence stays in the worker's Session and reports that automatic group delivery needs review.

## Migration

1. Keep both the active Muse home's Session directory and `muse-bot/state.json` when moving an installation. Do not edit notice metadata to recreate a handoff or redirect a result.
2. Resume the existing Host generation watcher. It can rebuild a missing handoff when the worker's original persisted assignment and current group Sessions match.
3. If the original assignment is unavailable, read the result in the worker's Session and review its project and requester before handing it back. Do not resubmit a paid generation merely to restore a notification.
4. Confirm that the original requester receives one continuation, or that the missing-evidence warning remains explicit. No Session-format conversion is required; the [persistence acknowledgement](../../../persistence-changes/2026-11-06-generation-watch-attribution.md) records the same-version addition.
