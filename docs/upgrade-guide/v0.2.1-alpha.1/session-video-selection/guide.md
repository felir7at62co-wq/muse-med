---
kind: upgrade-guide
description: "Sessions with explicit video-model selections require a build that recognizes the new selection event."
---

# Conversation video-model selections

English | [中文](guide.zh.md)

## Change

Muse records a configured initial or explicitly selected video-model and resolution choice in the required `jubian/video-selection` Session event. Older builds that do not recognize this event refuse these logs. Existing sessions without the event remain readable. The choice is independent of the dialogue model and Jubian project defaults; the changing model context is appended to the conversation.

## Migration

1. Keep a build that supports this event when opening sessions in which a video model was selected. Do not remove the event to open them in an older build.
2. In deployments enabling `sessionVideoSelection`, the optional `defaultVideoModel` initializes sessions without a saved choice after live catalogue validation; Muse uses Seedance 2.5 at 480p. Otherwise choose in the composer or answer `jubian_video_model` before generation. Reading a project does not select its model.
3. After switching, prepare fresh previews for new submissions. Reconcile already recorded operations with their original keys and previews. Confirm that restoring the session restores the chosen model and resolution.

The [persistence acknowledgement](../../../persistence-changes/2026-10-17-session-video-selection.md) records the compatibility classification.
