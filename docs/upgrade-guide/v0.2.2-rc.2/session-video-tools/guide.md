---
kind: upgrade-guide
description: Custom Session video and Chat compositions require tool, navigation and conversation services.
---

# Session video workspace composition

English | [中文](guide.zh.md)

## Change

The Session video plugin requires `tools` and registers `muse_video` for inventory, version-bound production metadata and selected-interval review. Authored shot intervals are optional; older videos remain playable without a binding.

The video interface uses a native right-Sidebar workspace instead of the previous in-flow history player. Custom clients must provide its navigation, resource, Session and composer services. Chat also requires `conversation` to report application-resource navigation failures through the owning input. Shipped Muse profiles already provide these services.

## Migration

1. For `session-video`, mount the tool registry and its system-prompt dependency in the same Agent scope. See the [media service reference](../../../../packages/drama/session-video/README.md) for binding and review limits.
2. For `ui-session-video`, keep the canonical entry id and provide the services declared by its [Client entry](../../../../packages/client/ui-session-video/src/client/index.ts). Follow the [video workspace composition](../../../../packages/client/ui-session-video/README.md#use-this-package) for its media and Client rows.
3. For `ui-chat`, mount the `ui-conversation` plugin that provides `conversation`, alongside the existing conversation assembly service. See the [Chat reference](../../../../packages/client/ui-chat/README.md).
4. Confirm the Client entries activate without missing-service warnings, open the video workspace from the Session header, and submit a selected-range review through the existing input.

Existing Session generations remain unchanged; private source checkpoints rebuild automatically.
