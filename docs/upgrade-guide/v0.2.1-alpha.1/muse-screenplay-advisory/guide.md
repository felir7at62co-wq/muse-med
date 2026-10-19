---
kind: upgrade-guide
description: Muse managed screenplay projects use advisory review instead of mandatory creative approval.
---

# Muse autonomous screenplay review

English | [中文](guide.zh.md)

## Change

Muse's `short-drama` and `creation` compositions set `screenplay_project` to `reviewMode: advisory`. New and existing projects can stage unreviewed or rejected facts and commit a current candidate without a separate reviewer or A/B/C sequence. Review is the Agent's decision; adoption does not mean that review passed. Other deployments retain the package's `independent` default and may explicitly select strict `self-check` for projects without an advisory policy.

Advisory results include `review_policy: advisory` and `review_advisory` counts for pending/rejected facts and candidates, plus guidance. A recorded review uses `kind: advisory` with the actual actor, time, decision and reason; the tool invents neither independent reviewers nor sequential evidence. Story inventories, `story_notes` and C semantic reports are optional; supplied records still require valid source references, locations and digests.

The policy does not change historical `review_mode`, review-context digests or review identities. Existing projects receive the policy in memory when read and persist it on the next successful mutation. Reading alone does not rewrite the file. Once persisted, the advisory policy stays effective if configuration later changes to `independent` or `self-check`; configuration does not convert that project back to strict review. Source integrity, current revisions, episode order, candidate hashes, real user authorization and returned-manuscript protection remain active. Muse's system prompt is unchanged.

Preserved history does not provide downgrade compatibility: use a pre-upgrade project backup when returning to Muse 1.1.6, whose reader does not recognize advisory records.

## Migration

1. Continue using the existing project file in Muse; no manual JSON or Session-log conversion is required. Custom compositions that want autonomous review must set the `@deepseek-ai/dsh-screenplay-project` row's `config.reviewMode` to `advisory`. For new projects or projects without an advisory policy, select `independent` or `self-check` explicitly when mandatory review is intended.
2. Call `status` and use its actual source IDs, candidate digest and current revision. Confirm `review_policy: advisory`; inspect `review_advisory` rather than treating adoption as approval. Do not rewrite historical review records or add a fabricated review to unlock work.
3. Stage the intended next episode and commit the current candidate when it is ready to adopt. Review calls remain available when useful; report their real decisions and unresolved findings. Use the adopted candidate for `export`, Word conversion and presentation. Those operations still reject stale, altered or unauthorized data.
4. Confirm that the same project reopens, preserves its history and exports the intended adopted text. A source, reference, version or permission error needs correction; changing the review policy does not waive it. See the [package reference](../../../../packages/drama/screenplay-project/README.md) for the remaining strict-policy requirements.
