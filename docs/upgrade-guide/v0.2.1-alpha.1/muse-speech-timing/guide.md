---
kind: upgrade-guide
description: Muse estimates undeclared speaking-shot durations at five effective characters per second and includes declared action complexity.
---

# Muse speech timing

English | [中文](guide.zh.md)

## Change

Muse's Short Drama and Creation presets set `tool-shot-script.config.speechCharsPerSecond` to 5 instead of the plugin default of 8. Both `drama_shot` and `muse_production` use this rate. A speaking shot also reserves at least its declared action-complexity estimate; an unknown complexity is invalid in strict review. Explicit positive whole-second durations retain precedence. Saved plans and cards are not rewritten automatically.

## Migration

1. Re-preview affected unfinished episodes before preparing generation; do not infer package durations from older estimates.
2. If a deployment needs another estimate, set `speechCharsPerSecond` to a number at least 1 in its compiler configuration. Preserve explicitly reviewed shot durations and check sequential actions and reactions separately.
3. Confirm returned shot and package durations fit the selected model. Use the skill's source-speech preflight and then review actual video and audio; a duration estimate does not establish performance or delivery acceptance.
4. Coverage audit and speech preflight share ordinary performance-annotation parsing for source-listed characters; ambiguous identity or voice notes remain pending. Map existing `shots/EP13-9x16.md` files directly. For one in-scope episode, use `accept 13 --episode-only`, then `gate 13 --episode-only` after its mapping review. This preserves project scope and that episode's checks without requiring prior coverage records. Follow the [migration rules](../../../../packages/drama/skills/skills/tweet-drama-core/references/io-contract.md#existing-project-migration); default whole-project checks remain unchanged and missing coverage evidence does not require regenerating historical videos.
