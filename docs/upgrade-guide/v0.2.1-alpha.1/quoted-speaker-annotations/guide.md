---
kind: upgrade-guide
description: "Source coverage retains unresolved quoted speaker annotations and marked directions instead of discarding possible speech."
---

# Review quoted speaker annotations

English | [中文](guide.zh.md)

## Change

The drama Core `episode_coverage.py` commands leave quoted text inside speaker annotations pending. Previously, a recognized performance word could cause the annotation to be removed during speaker comparison even when it contained additional speech. Existing acceptance records cannot override the current source check.

Established identities use balanced performance notation across genres without requiring action keywords; nested groups and several cast labels are supported. Without a roster, plain dialogue prefixes can establish identities, while an annotated line cannot declare its own identity. Separate explicit OS/VO markers retain their meaning. Exact editorial markers retain heading rows. Source and shot text remain unchanged. Diagnostics distinguish unsupported syntax or metadata from identity, period, voice, quotation and adjacent-speaker ambiguity; a terminal delivery cue requires the next dialogue to belong to the same declared actor.

Marked directions also check single, double and corner quotes consistently. Previously, some quoted content or colon clauses could be treated as action or as part of a speaker name. A paired, supported object sound with an explicit sound suffix or physical impact context can remain action; remaining speech cues, quotations or colon clauses require review. This exception does not apply to quoted speaker annotations or human vocalizations. Explicit action-line speech cannot invent an identity from descriptive text when a roster exists. Contradictory shot voice labels fail; generic offscreen notation remains unresolved. See the [source classification rules](../../../../packages/drama/skills/skills/tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage).

## Migration

1. Preserve the original text. Run `episode_coverage.py <project> source-scan` for the declared assignment, then `source-lines <ID>` and `preflight <ID> --script <shot-script>` from the loaded Core directory.
2. For pending annotations or directions, inspect the complete line and its speech, identity and voice meaning. Retain all quoted content. Unsupported layouts require parser support and renewed checks; do not delete annotations to fit the parser, treat manual notes as acceptance or offer a gate bypass.
3. After classification, mapping and speech checks pass, renew acceptance and run the gate. An authorized single-episode continuation uses `accept <ID> --episode-only`, then `gate <ID> --episode-only`. Confirm `status: passed` before the existing authorized paid workflow proceeds; these checks do not submit a video.
