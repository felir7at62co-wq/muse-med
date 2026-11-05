---
kind: upgrade-guide
description: "Muse uses native Session model selection while archived Bot model settings remain inactive."
---

# Select models in native Sessions

English | [中文](guide.zh.md)

## Change

Muse conversations use their native Session's current model and reasoning level. The product no longer loads the Bot store or runs Bot side answers, memory review or conversation-part creation. Saved Bot model preferences and histories remain in place without conversion; they do not override ordinary Sessions. See [ordinary Sessions](../muse-session-product/guide.md) for the retired interface and retained data.

Choose a model in the native conversation controls. The Session selection remains distinct from the profile default; changing it does not rewrite archived Bot settings.

## Migration

1. Install the updated Muse Desktop and open the underlying conversation from native history. Keep the archived Bot state unchanged.
2. Check the Session's saved model and reasoning level, or select the desired values in its native controls. Confirm that the next request uses that provider and model.
3. Keep independent Bot model settings in the archive. The ordinary product does not offer a Bot model editor or automatically import those overrides.
