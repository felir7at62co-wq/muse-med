---
kind: upgrade-guide
description: "The selected Muse shared catalog withdraws other managed models and supplies provider credentials through account login."
---

# Select an available Muse shared model

English | [中文](guide.zh.md)

## Change

The deployed selected catalog contains two official DeepSeek models and six Yunying models. Other managed models are withdrawn. Existing conversations that select a withdrawn model must select an available model before continuing. Personal providers, credentials and conversation history remain unchanged. Fresh profiles select official DeepSeek Flash after Muse sign-in; supplier API keys remain on the gateway. Model-specific default thinking levels now enter the prepared and logged request, while explicit supported choices remain selected.

## Migration

1. Operators prepare the private directory with the [selected-model configuration tool](../../../../services/muse-accounts/README.md), retaining the exact source backup. Deploy the candidate and matching gateway release together; client code alone does not activate shared credentials.
2. Sign in to Muse or refresh MUSE Account settings. Confirm that the shared model picker contains the selected official DeepSeek and Yunying catalog.
3. For a conversation using a withdrawn model, select an available Muse model in the conversation model picker, then continue. Keep personal provider defaults when using your own credentials.
4. Verify a real model response and a tool continuation through the deployed gateway. Restore the retained private source backup and restart the gateway if deployment verification fails.
