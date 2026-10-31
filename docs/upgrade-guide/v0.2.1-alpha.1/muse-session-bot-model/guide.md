---
kind: upgrade-guide
description: "Automatically listed Muse Session Bots share native model selection instead of a saved Bot override."
---

# Use one model selection for automatic Session Bots

English | [中文](guide.zh.md)

## Change

Automatically listed Muse Session Bots use their native Session's current model and reasoning level. Older entries with `autoSessionBot: true` are normalized to `modelSource: session` when the Bot store loads. Saved model preferences, parts, history and independent Bot settings remain in place. The old saved Bot model no longer overrides the native selection for side answers, memory review or new parts. Memory review retains its existing lowest-supported-effort policy.

Choosing a model in the Bot settings changes the same native Session selection without changing the profile default. Independently created Bots and explicitly managed, manually adopted Bots retain their own model settings.

## Migration

1. Install the updated Muse Desktop and open the affected conversation or its automatically listed Bot. Do not edit `muse-bot/state.json` manually.
2. Select the required model and reasoning level in either interface. Confirm that the other interface shows the same choice and that the next request uses that provider and model.
3. If a Bot must keep an independent model, create an independent Bot instead of using the automatic entry for an existing Session. Existing independent Bot settings require no migration.
