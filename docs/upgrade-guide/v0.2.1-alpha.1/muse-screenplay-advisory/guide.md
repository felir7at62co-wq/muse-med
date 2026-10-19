---
kind: upgrade-guide
description: Muse screenplay projects use advisory review without fixed approval or episode sequencing.
---

# Muse autonomous screenplay review

English | [中文](guide.zh.md)

## Change

Muse's `short-drama` and `creation` compositions set `screenplay_project` to `reviewMode: advisory`. The Agent chooses whether and when to review, including within the writing Session. New and existing projects can draft a selected episode, save several episodes before adoption and adopt them out of order. Adopting another candidate for an episode replaces its current selection while retaining historical candidates, commit times and reviews. Export can deliver an actual draft or historical candidate without automatically adopting it. Adoption does not mean that review passed.

Results preserve real pending and rejected states through `review_advisory`. Optional reviews retain their actual actor, time, decision and reason with `kind: advisory`, without fabricated independent reviewers or A/B/C evidence. Story inventories, `story_notes` and C semantic reports are optional; supplied records still require valid sources, locations and digests. `rendered.continuity_advisory` reports missing foreknowledge outside the screenplay body rather than inventing prior events. `base_episode` retains its creation-time count; `next_episode` suggests the first unadopted episode, without restricting work.

Existing projects receive `review_policy: advisory` in memory when read and persist it on the next successful mutation. Historical `review_mode`, review-context digests and identities remain unchanged. Once persisted, the policy remains effective under later `independent` or `self-check` configuration; configuration does not convert that project back to strict review. Strict defaults still apply to projects without advisory policy. Source integrity, real episode IDs, current revisions, candidate hashes, real user authorization and returned-manuscript protection remain active. Muse's system prompt is unchanged.

Preserved history does not provide downgrade compatibility: use a pre-upgrade project backup when returning to Muse 1.1.6, whose reader does not recognize advisory records.

## Migration

1. Continue using the existing project file in Muse; no manual JSON or Session-log conversion is required. Custom compositions select `config.reviewMode: advisory` on the `@deepseek-ai/dsh-screenplay-project` row. Choose strict `independent` or `self-check` only for new or non-advisory projects that need mandatory review.
2. Call `status` and use actual source IDs, candidate digests and `expected_revision`. Read `candidate_states` for each version's actual adoption/review status and `continuity_advisory` for adopted-episode risks; suggested `next_episode` is not an execution requirement.
3. Save the requested episode versions. Adopt a candidate with `commit` only when intended, or `export` a specified real candidate directly. Check `export.adoption` and continuity advice instead of inventing an approval or adopting missing earlier episodes merely to unlock work. Keep normal story continuity and the user's intended order.
4. Word export and delivery use the actual readable document, not an approval receipt. Word conversion pins inputs and compares generated paragraphs; user-return protection remains active. Confirm the intended files and actual review scope. See the [package reference](../../../../packages/drama/screenplay-project/README.md) for strict-policy rules and remaining integrity checks.
