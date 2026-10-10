---
kind: upgrade-guide
description: Slash skill invocation no longer loads instructions through a hidden or shadowed skill consumer.
---

# Scoped skill invocation

English | [中文](guide.zh.md)

## Change

A hidden or shadowed `skill` tool no longer handles explicit `/<skill-name>` messages. Previously that consumer could inject its own global instructions even when the session used another scoped loader or an isolated skill registry. Only the exact visible consumer handles the gesture, preserving its skill availability and invocation permissions.

## Migration

1. Review profiles or presets that restrict or shadow `skill` while relying on its explicit invocation handler.
2. Restore a visible `@deepseek-ai/dsh-tool-skill` row in the intended scope and register its permitted skill provider there. For an isolated registry, mount the provider and tool in the same `skills` realm.
3. Start a session and invoke a permitted user-invocable skill. Confirm that only the selected scope's instructions enter the conversation; unknown or unavailable names remain ordinary text.
