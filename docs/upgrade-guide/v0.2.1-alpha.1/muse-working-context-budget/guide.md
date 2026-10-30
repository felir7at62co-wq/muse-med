---
kind: upgrade-guide
description: Muse Flash presets reject oversized estimated requests locally instead of continuing with over-budget history after compaction fails.
---

# Muse estimated working-context budgets

English | [中文](guide.zh.md)

## Change

Muse Desktop Host defaults and the `standard`, `ptc`, `cordis`, `short-drama`, `creation` and `bot-coordinator` presets enable `workingTokenLimit: 475000` for the current and historical official DeepSeek Flash IDs. Their physical model metadata stays at 1,000,000 tokens; provider routing, the default model and conversation output caps do not change. A `0.45` threshold starts proactive compaction at 450,000 estimated tokens, with a requested 65,536-token recent tail and a 16,384-token summary cap.

The existing compaction backend checks complete ordinary agent-loop requests before provider dispatch. Local recovery preserves newly committed current-step input, runtime context and tool-update text, compacts older balanced history, and retries only after pressure falls below the limit and persistence acknowledges the replacement. Failure stops the request instead of sending oversized history. This estimate is not a guarantee about the provider's exact tokenizer. Profiles without `workingTokenLimit` keep their previous behavior.

## Migration

1. Upgrade the compaction runtime together with its profile policy. Earlier runtimes reject the new configuration key. The [Host defaults](../../../../apps/desktop-host/config/defaults.cordis.patch.yml) and each affected preset's `agent.cordis.yml` contain exact policies for `muse-cloud-deepseek-official/deepseek-flash` and `muse-cloud-deepseek-official/deepseek-v4.1-flash-261017`; personal profiles opt in through their own `modelPolicies`.
2. Keep automatic compaction enabled and provide a persistence listener for `ctx.sessions.flush()`. Recovery requires a `true` result; a missing listener or failed flush stops the request. `maxOverflowRetries` bounds recovery attempts, including local working-budget recovery. `auto: false` disables the check; auxiliary requests with a declared `purpose` are excluded.
3. Validate with the [keyless working-budget tests](../../../../packages/compaction/compaction-basic/tests/working-context-limit.spec.ts): an oversized request must not reach the conversation adapter before a durable replacement, current-step input must remain intact, and flush failure must prevent retry. Confirm the adapter's model capacity remains 1M. A server catalog update alone does not install this client/Host behavior.
4. To disable final-request admission, remove `workingTokenLimit` from the active default and exact-target policies and reload the affected profile. Existing threshold and retention settings remain; restore their previous values separately if previous compaction timing is required. Do not restore a database or rewrite Session logs: already committed summaries and tool receipts remain valid. See the [compaction reference](../../../../packages/compaction/compaction-basic/README.md#tuning-when-condensation-starts) for configuration.
