---
kind: upgrade-guide
description: "Muse Desktop applies the Jubian DeepSeek V4 Flash default once per profile after confirming the model is available."
---

# Muse Desktop chat default uses Jubian

English | [中文](guide.zh.md)

## Change

Muse Desktop previously kept an available saved default and initialized fresh profiles from the account catalog. On upgrade, the Desktop profile applies one replacement after sign-in confirms that the catalog offers `jubian/deepseek-v4-flash`. New conversations then start with **Muse · 剧变 → DeepSeek V4 Flash**. When you open a conversation with a saved model, Muse reads that conversation's choice.

If the account catalog does not offer the model, Muse uses its ordinary default selection while waiting for a refresh that offers it.

## Migration

1. Update Muse Desktop and open **Settings → MUSE Account** to refresh the shared model catalog. Sign in if prompted.
2. Start a new conversation and check for **DeepSeek V4 Flash** under **Muse · 剧变** in the chat model menu. If the group lacks that model, ask the gateway administrator to check `jubian/deepseek-v4-flash` in the account catalog and refresh the catalog.
3. After the switch, choose another model in the chat model menu if you want a different default for subsequent new conversations.
