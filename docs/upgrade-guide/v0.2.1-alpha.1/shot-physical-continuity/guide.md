---
kind: upgrade-guide
description: Director scripts using physical-stage or continuity labels now validate those declarations in strict compilation.
---

# Physical-stage and continuity declarations

English | [中文](guide.zh.md)

## Change

`drama_shot` recognizes optional `动作起点`, `接触与支撑`, `动作落点`, `连续性场次`, `连续性状态` and `连续性变化` lines. These labels previously remained unchecked prose. Malformed declarations now fail strict compilation and remain warnings in advisory mode. Legacy scripts without these fields remain accepted; complex actions can receive preparation suggestions without a timing rewrite. Authored state changes without an explanation produce advisory findings, not automatic video rejection.

## Migration

Explicit continuity periods and existing source-scene headings also separate packages at the same physical location. A shot omitting the period inherits that scene's previous declaration. Review package boundaries around scripted time jumps; do not remove source headings merely to retain the old package count.

Optional `场景时段` and `时段变化依据` declarations follow the same strict/advisory validation. Scene time inherits across shots and completed packages; a changed label separates packages. Native prepared director prompts without a resolvable scene time now report `scene_time_missing` under `first_pass_review`. Original package shot numbers remain unchanged, including packages starting after shot 1. These findings do not establish actual lighting or change paid-submit permissions.

Explicit ordered steps in `动作状态` also receive missing-stage and estimated-timing findings without requiring `动作复杂度`. Spoken instructions alone do not trigger this check. Review the actual executor, prerequisites, hand occupancy and object destinations against the source; declaring stages does not prove those facts.

1. If an existing director script uses these labels, follow the [field rules](../../../../packages/drama/skills/skills/tweet-drama-core/references/first-pass-production.md). Action stages occur once each. Continuity rows identify a specific object's post-shot location, state and nonnegative integer count; changes include their source-backed reason.
2. Run the project's existing `drama_shot validate` or `muse_production preview` flow, inspect findings and preserve the original actions, dialogue and approved assets. Do not rewrite source text to clear advisory messages.
3. Review actual prepared prompts before generating. Supply source-backed scene time in every independent package, retain legitimate montage transitions, and inspect selected scene images for compatible lighting. When the source leaves time unresolved, retain that uncertainty rather than inventing a label to clear warnings. Native preparation findings do not modify the persisted preview, fingerprint or payment authorization. Existing media still requires visual and audio review.
