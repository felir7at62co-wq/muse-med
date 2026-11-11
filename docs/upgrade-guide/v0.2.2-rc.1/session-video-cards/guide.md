---
kind: upgrade-guide
description: "Muse replaces its floating video bubble with chat video cards and a conversation menu."
---

# Use chat video cards and the conversation menu

English | [中文](guide.zh.md)

## Change

The Muse floating video bubble and its overlay player are removed. Chat video cards retain video selection, playback, shot timelines, zoom and modification drafts. The normal conversation header now provides a Conversation videos menu; selecting a recorded source opens the same video card at the top of Chat, including when its original message is not loaded. The General setting is labeled Video cards and timeline. Its existing `ui-session-video.enabled` value is retained.

## Migration

1. Use the controls directly on a delivered or generated video card.
2. To find a recorded video, open Conversation videos in the header and select its name. Close the historical card when finished.
3. Use Settings → General → Video cards and timeline to enable or disable the enhanced presentation. Confirm that disabling restores native delivered-video playback and re-enabling restores the cards and menu without a floating bubble. No Session, draft, media file or configuration-key migration is needed.
