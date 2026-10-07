---
kind: upgrade-guide
description: "Automatic pressure compaction may reduce requested retention to accommodate fixed request content."
---

# Compaction pressure budgets

English | [中文](guide.zh.md)

## Change

Automatic pressure compaction treats `retainRatio` and `retainTokens` as requested recent-history budgets. It may retain less when tools, the system prompt, or a provider usage correction would prevent a checkpoint from fitting below the trigger. A fixed request prefix or indivisible tool unit that leaves no useful replacement space produces a warning without calling the summary model. Unchanged failed selections and a successfully summarized lone checkpoint are not summarized repeatedly; relevant content, route, or policy changes permit another attempt. Manual compaction and provider-confirmed context overflow retain their existing recovery behavior.

The [Muse Host defaults](../../../../apps/desktop-host/README.md#compaction-defaults) apply smaller headroom and summary budgets to three cloud models configured with a 128,000-token window. Normal conversation output limits are unchanged.

## Migration

1. Update the application and resume the conversation. Existing Session files and content remain readable; the fix does not rewrite historical logs.
2. Review custom `retainRatio` or `retainTokens` settings if your workflow requires specific messages verbatim. Requested retention can now be reduced by automatic pressure compaction; store indispensable source material in workspace files.
3. For personal compositions using small model windows, review `headroomTokens`, summary `maxTokens`, and exact `modelPolicies` against the [compaction configuration](../../../../packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts). Muse's bundled presets already contain their product policies.
4. Confirm that ordinary requests continue without repeated summaries of the same checkpoint and that genuine input growth can still trigger useful compaction.
