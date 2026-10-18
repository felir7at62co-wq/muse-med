---
kind: upgrade-guide
description: "Muse Short Drama uses session video limits for advisory drama_shot review and saves review drafts separately from formal episode packages."
---

# Muse shot-script review mode

English | [中文](guide.zh.md)

## Change

Muse Short Drama exposes `drama_shot` with `reviewMode: advisory`. Content problems are warnings, including script format, asset declarations and duration conflicts. `ok: true` means the check completed; it does not certify that the script can be generated or that its quality is acceptable. `preview` returns package suggestions without truncating dialogue or over-budget shots.

Advisory `compile` writes only `shot_reviews/<episode>/shot_script.txt` and `review.json`. It preserves the source script and leaves formal `prompts`, `matches` and `episode_packages` files untouched. These review drafts are not generation-ready episode packages. Missing required arguments, invalid plugin configuration, unreadable input, invalid asset-manifest JSON and write failures still report errors.

Muse also enables `sessionVideoSelection: true`: package suggestions use the current session's selected video model and known duration ceiling, not project defaults or a passed `max_submit_seconds`. A conflicting argument produces a warning. `duration_budget` returns the actual source, ceiling and selected model revision. An unavailable selection or unknown duration returns warnings and no packages; another model's 15- or 30-second limit is never substituted.

Switching the selected model appends a comparison of the latest actual preview/compile package submission lengths to the existing logged selection context. It names over-limit packages and shots without rewriting the system prompt, starting another model request, changing files or modifying cards. It does not reread edited source or inspect images; rerun `preview` for a new layout. Late results checked under an older selection revision also produce warning context.

The plugin defaults remain `reviewMode: strict` and `sessionVideoSelection: false`, preserving strict compilation and required explicit budgets for standalone workflows. Results return the mode as `review_mode`; deployment settings are not model-selectable tool arguments. The existing shot-writing skills remain unchanged.

## Migration

1. Finish running work and restart Muse to load the current Short Drama preset. Confirm `review_mode: advisory` and `duration_budget.source: session` in `drama_shot` results; verify the returned selection matches the conversation's video-model menu.
2. Read the returned warnings and decide the creative corrections from the source script and actual project. After switching models, rerun `preview` to refresh package suggestions. Do not treat an empty `failures` list, `ok: true` or a duration-only recheck as quality approval.
3. Find advisory drafts under `shot_reviews/<episode>/`. Continue previewing, saving and reading back actual video cards through the platform tools; do not submit a review draft as a formal compiled episode package.
4. If an existing external workflow needs matched JSON and formal episode packages, keep or explicitly set `reviewMode: strict` and `sessionVideoSelection: false`; continue supplying a verified `max_submit_seconds` for preview/compile. See the [review modes](../../../../packages/drama/tool-shot-script/README.md#review-modes) for output paths and [session video settings](../../../../packages/drama/tool-shot-script/README.md#session-video-settings) for model selection.
