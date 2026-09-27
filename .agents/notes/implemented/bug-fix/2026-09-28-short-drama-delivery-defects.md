# Agent Note: the 2026-09-28 delivery review's four short-drama defects

Status: implemented

English | [中文](2026-09-28-short-drama-delivery-defects.zh.md)

## Problem

An operator review of 《山海自有相逢处》第25集 on 2026-09-28 returned four defects — a pregnant belly that contradicts the script, characters reacting with surprise to nothing, subtitles that read too thick, and a duplicated watermark. The session log (`dsh-session-session-8771b5c0-a535-4240-8af1-6d61427b1e44`) shows all four originate in this pipeline, not in the provider's generated footage.

**Character state.** The episode's script reads 医生：孕八周. The run bound 沈知意 to `沈知意（孕期职场装）` (asset 81685 / material 79293), whose board is a late-pregnancy body, so the model rendered a full-term belly in 分镜3 (1032840, 25-2 地下停车场) and 分镜4 (1033048, 25-3 车内) while 分镜2 (1032828, 25-1 诊室) stayed correct. The session diagnosed itself at log L2507: 「是资产挂了错的那一版…那张设定板本身就是孕晚期身形」. No step in the run compared the asset's body against the script's week, and the 分镜 spec the run invented (`_inbox/boss-spec.md`) governed dialogue, camera movement, framing and character names but said nothing about body state — its only age rule was 「第47集起…年龄状态必须随之变化」.

**Reactions.** The compiled shot script gave 沈知意 the state `【眉毛抬高，嘴唇张开，眉间收了一下】` for the flat question 「干什么？」 and `【眉毛抬高，唇角平，肩线放松】` for 「谁说怀孕就不能开车？」; the delivered car shot shows a startled open-mouthed face with no trigger in the script. The episode's only scripted surprise is 林晚's 「捂住嘴，眼睛瞪圆」. The existing rule forbade abstract emotion words and required observable signs; requiring observable signs is what makes an invented raised-eyebrow state render as a real expression.

**Subtitle outline.** Every delivery path set the ASS outline to 7 in the 1080x1920 design coordinates (`delivery.ts`, the skill's `render_episode.py`, and the hand-written ASS the run actually burned). Burned at the 1440x2560 delivery, 7 measures an 8-10px black band, as thick as the strokes of a 68px CJK glyph.

**Watermark.** The delivered frame carries two 「内容由AI生成」 marks in the bottom-right corner. The run bypassed `drama_render render` and composed its own ffmpeg chain: its ASS carried a `Mark` event (log L2131) and the filter chain added `drawtext` as well (log L2143), which the session confirmed as 「我写了两遍」 at L2522-L2530.

## Decision

The outline is 3 in the 1080x1920 design coordinates, in both renderers: [`buildAssHeader`](../../../../packages/drama/tool-episode-render/src/delivery.ts) and `write_ass` in [`tweet-drama-background-render/scripts/render_episode.py`](../../../../packages/drama/skills/skills/tweet-drama-background-render/scripts/render_episode.py). At the delivery size that is a near-4px band — the CJK hardsub norm of roughly 4-5% of the font size, and the value the skill text and the tool description now both state. The tool description also states where the mark comes from: the ASS the renderer writes carries it once, so an added `drawtext` or `overlay` duplicates it, and `subtitles.spec.ts` pins exactly one occurrence of the mark in the built document.

The watermark, the subtitle style and the ending bytes are all enforced by `drama_render`, so the skill now sends renders through `subtitles` → `prepare` → `render` and names hand-written ffmpeg as the path that inherits none of those checks; a hand-built render remains allowed only where the tool lacks a capability, and then the fixed style and the bottom-right visual check apply the same way.

[tweet-drama-shot-asset-match](../../../../packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md) owns character state at binding time: a per-character, per-episode state card (body state including pregnancy week or age band, costume version, hair, time of day) drawn from the script or a confirmed outline, checked line by line against the asset's own board before binding. An asset whose board disagrees with the script's state is the wrong version even when its name matches; `state_or_costume` in `assets_manifest.json` holds costume only, so body state is recorded beside it. The check runs before each `select_assets`/`compile`.

[shot-script-creator-9-16](../../../../packages/drama/skills/skills/shot-script-creator-9-16/SKILL.md) owns reactions: a reaction expression (惊讶, 震惊, 瞪眼, 挑眉, 后退, 捂嘴) requires a trigger written in the same or the preceding shot and taken from the episode's own dialogue or ▲ action lines. A shot whose source line is an ordinary question may not carry raised eyebrows or widened eyes, and one expression word may not be reused across unrelated shots.

## Alternatives considered

**Make the outline a plugin `Config` field.** Rejected: the outline is part of the delivery specification, exactly like the frame size and bitrate the same header fixes, and a deployment-varying field would let one project silently ship a different look.

**Let `drama_shot validate` reject a state-mismatched asset.** The manifest carries `state_or_costume` as costume text, so the check would need the episode's body state in a machine-readable field and a rule mapping 孕八周 onto a board's silhouette. That is a real seam, and the prompt-level check plus the review the tool already requires covers the defect that was reported.

**Forbid the surprise vocabulary outright.** The vocabulary is legitimate where the script has a surprise; banning it would break 林晚's 捂嘴瞪圆 beat. The trigger requirement keeps the legitimate use and blocks the invented one.

## Consequences

Three of the four fixes are prompt and default values, not enforcement: `drama_shot` still validates asset identity, not body state, so an official asset of the wrong state still compiles. The state card and the trigger rule reach the model through the skills, which is where the 2026-09-28 run's ad-hoc 分镜 spec was derived from.

Regenerating `docs/tool-catalog.md` also brought two lines current that were stale at HEAD — the `drama_shot` placeholder rules (`ff5437838d`) and the workflow `agent()` reporting contract (`95c98cc31b`) changed their tool descriptions without the catalog being regenerated, so `verify-tool-catalog` was failing before this change.

## Verification

`pnpm vitest run packages/drama/tool-episode-render` passes, including the new exact-count assertion on the mark and the pinned outline in the ASS header.

`pnpm run verify-tool-catalog` and `pnpm run verify-doc-budgets` pass. `pnpm run verify-translation-pairing` reports three unpaired documents under `docs/superpowers/` and none of the pairs this change touches; `pnpm run verify-md-links` reports ten dead targets in other notes and none in this one.

The outline value is measured rather than asserted: `ffmpeg -f lavfi -i color=white:s=1440x2560 -vf ass=<probe>.ass` with SimHei 68 at PlayRes 1080x1920, then the black band width across the raster — 10px at Outline 7 with `ScaledBorderAndShadow: yes` (8px in the shipped header, which omits the key), 4px at Outline 3.

`python -B -m unittest discover` over `packages/drama/skills/tests` covers the Python renderer, whose ASS header keeps its own font and outline expectations.
