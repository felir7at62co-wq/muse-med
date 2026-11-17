---
kind: upgrade-guide
description: Custom Session video compositions require the tool registry for binding and bounded review.
---

# Session video tools

English | [中文](guide.zh.md)

## Change

The Session video plugin requires `tools` and registers `muse_video` for inventory, version-bound production metadata and selected-interval review. Shipped Muse profiles already provide the tool registry. Authored shot intervals are optional; older videos remain playable without a binding.

## Migration

Custom compositions that mount `session-video` must also mount the tool registry and its system-prompt dependency. Keep the registration in the same Agent scope. Existing Session generations remain unchanged; private source checkpoints rebuild automatically. See the [package reference](../../../../packages/drama/session-video/README.md) for binding and review limits.
