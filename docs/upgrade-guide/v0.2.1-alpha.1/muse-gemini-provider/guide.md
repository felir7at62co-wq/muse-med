---
kind: upgrade-guide
description: "Muse Desktop hides the standalone Gemini account provider while retaining Yunying Gemini."
---

# Select Yunying Gemini for saved standalone Gemini conversations

English | [中文](guide.zh.md)

## Change

Muse Desktop excludes the standalone account provider `aa`, registered locally as `muse-cloud-aa`, from its model directory. Saved conversations using that provider must select an available model before continuing. The selector offers `muse-cloud-yunying/gemini-3.1-pro` when the gateway supplies it; other Yunying models remain hidden from new selections. Their registered routes remain available to saved Sessions. Existing conversation logs remain readable; their model selections and Session format are not rewritten.

## Migration

1. Install the updated Muse Desktop and sign in, then open an affected conversation's model picker.
2. Select **Muse · 云映 → gemini-3.1-pro** or another available model, and continue. Confirm that the next logged request uses the chosen provider and model.
3. Custom deployments can set `excludedProviderIds` in their `@deepseek-ai/dsh-muse-account` row to exact gateway provider IDs. Its plugin default is `[]`; the Desktop product patch sets `['aa']`. It hides `yunying` through `hiddenProviderIds` and permits `yunying/gemini-3.1-pro` through `visibleModels`. Do not replace the `aa` exclusion with a `gemini` model-prefix filter, which would also remove Yunying Gemini.
