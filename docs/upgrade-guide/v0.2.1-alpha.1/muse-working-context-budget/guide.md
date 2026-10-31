---
kind: upgrade-guide
description: Muse enables adaptive working-context budgets for all desktop models.
---

# Muse estimated working-context budgets

English | [中文](guide.zh.md)

## Change

Muse Desktop Host defaults and the `standard`, `ptc`, Cordis, `short-drama`, `creation` and `bot-coordinator` presets apply one adaptive policy to all models. The policy uses a 475,000-token estimated working limit, a `0.45` pressure ratio, 16,384 tokens of headroom and summary output, and a requested 65,536-token recent tail. Smaller model windows reduce headroom, retained tail, summary output and final request admission. Physical model windows, ordinary output caps and routes do not change. The estimate does not guarantee agreement with the provider tokenizer. `minimal` does not mount automatic compaction.

A local working-budget rejection preserves current-step input and tool updates, compacts balanced history, and retries only after durable replacement. The request stops if it cannot fit or the flush fails.

## Migration

1. Upgrade the compaction runtime together with the [Host defaults](../../../../apps/desktop-host/config/defaults.cordis.patch.yml) and each affected preset. Earlier runtimes reject `adaptiveBudget`.
2. Personal profile patches can set `adaptiveBudget: false` and configure their own `modelPolicies`, threshold, working budget, headroom, retained tail and summary cap using the [compaction reference](../../../../packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts). A physically invalid output reservation still fails explicitly.
3. Keep automatic compaction enabled and provide a persistence listener for `ctx.sessions.flush()`; missing or failed acknowledgement stops recovery. `maxOverflowRetries` bounds retries; `auto: false` disables the check.
4. Run the [keyless admission tests](../../../../packages/compaction/compaction-basic/tests/working-context-limit.spec.ts) and verify the selected adapter's model capacity. A server catalog update alone does not install this behavior. Do not rewrite Session logs or restore old databases: committed summaries and tool receipts remain valid.
