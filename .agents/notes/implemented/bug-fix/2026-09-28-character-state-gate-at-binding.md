# Agent Note: the character state gate at asset binding

Status: implemented

English | [中文](2026-09-28-character-state-gate-at-binding.zh.md)

## Problem

The 2026-09-28 delivery review of 《山海自有相逢处》第25集 found that 沈知意 was bound to `沈知意（孕期职场装）` (asset 81685 / material 79293) for a script that reads 医生：孕八周, so 分镜3 and 分镜4 rendered a full-term belly. [The review's own note](2026-09-28-short-drama-delivery-defects.md) fixed three of its four defects in prompt text and defaults and left this one deferred: "the check would need the episode's body state in a machine-readable field and a rule mapping 孕八周 onto a board's silhouette."

Prompt text had already failed once here. [tweet-drama-shot-asset-match](../../../../packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md) told the run to write a per-character state card and compare it with the asset's board before binding; the run wrote the card, bound the wrong version anyway, and diagnosed itself at log L2507 (「是资产挂了错的那一版」). A card no tool reads cannot refuse a binding, and the shot script — the artifact the compiler actually consumes — carried no body state at all: `drama_shot` judged asset identity (official, ids, URL) and never the state those ids would render.

## Decision

**The shot script carries the state, per on-screen character, and `drama_shot` refuses a binding that disagrees with it.** Every subject of a `主体状态追踪` block declares one more per-subject field, written the way that block's other fields are:

```
主体状态追踪：
【沈知意】-位置：【场景图视角诊室中央偏右木椅靠近诊桌处】；
身体状态：【孕早期（孕八周）；孕期职场装；长发】；
```

That is the machine-readable field the review asked for, and it is the format owner's own block rather than a new artifact: [shot-script-creator-9-16](../../../../packages/drama/skills/skills/shot-script-creator-9-16/SKILL.md) now documents it beside 位置/动作状态/情绪状态, so the state card the asset skill already required lands somewhere a tool reads.

[`src/state.ts`](../../../../packages/drama/tool-shot-script/src/state.ts) normalizes both sides. Two dimensions have closed vocabularies because they decide the silhouette — pregnancy stage (`孕八周`/`怀孕8周`/`怀孕十三周` → 孕早期, `十四周` → 孕中期, `二十八周` → 孕晚期, `非孕期`, and 孕期待定 for a bare 孕期) and age band (a year, or 儿童/少年/青年/中年/老年). Everything else in the declaration — costume, hair, an injury — stays state text that the registration must contain. A declaration with two different stages is a conflict, and a conflict in any dimension refuses the shot instead of asking for an asset no version could satisfy.

The asset side reuses the fields the manifest already has: `state_or_costume` (together with the asset's own name, so a version named 孕晚期职场装 registers its stage even when the field is terse) and `episodes`. [`src/assets.ts`](../../../../packages/drama/tool-shot-script/src/assets.ts) judges four things against each bound character:

- a dimension the shot declares and the registration does not → `asset_state_unregistered`, naming the asset's ids and `state_or_costume`;
- a dimension both declare with different values, or state text the registration does not contain → `asset_state_mismatch`, naming the expected value, the registered value, and the asset id;
- a dimension the registration declares and the shot does not → `shot_body_state_unusable`: the two sides must state the same dimensions, because a registration that names a body state the shot never claims is exactly how the late-pregnancy board passed;
- a bound character with no `身体状态` at all → `shot_body_state_missing`.

**An asset's `episodes` registration is enforced at the same point.** A bound asset must declare `episodes` — episode numbers, or the all-episodes marker `all`/`全剧` — and a call that names an `episode` refuses a registration that does not cover it (`asset_episodes_unregistered`, `asset_episode_mismatch`). `validate` and `preview` now accept the `episode` argument `compile` already required, so the earliest decidable point can judge the same thing.

**A state no registration carries produces a restock request (`asset_state_missing`) instead of a binding.** The failure names the character, the stage, the costume and hair, the episodes the new asset serves, the versions already registered, and the path that produces it: reuse from the asset library, or generate and register a row, then `drama_assets reconcile`, then re-validate. `compile` writes nothing while any of these failures stands, so the restock demand also reaches `select_assets`: the material keys that call must carry come from a passing compile.

Registration口径: **the manifest is not rejected when these fields are missing — the row is degraded to 未标阶段/未标集 and the failure lands at binding.** The manifest is authored by the model and read by three tools; refusing the whole document at read time would turn one legacy row into a parse failure that hides every other finding, and it would judge rows nothing binds. Binding is where the harm happens and where the refusal can name the asset and the repair.

`jubian_organize` reads the same manifest, so it accepts the same all-episodes marker: an `episodes` entry of `all`, `*`, or the configured `seriesLabel` puts the row in the `series` bucket, which is what that bucket already means, instead of throwing `第 N 条资产的集号 all 不是数字`.

## Alternatives considered

**A `drama-gate` rule at `jubian_storyboard.select_assets`.** Rejected as the primary point: `select_assets` takes material keys and ids, carries no state, and cannot decide anything a passing `drama_shot compile` has not already decided — and `compile` refuses to write the keys a failing shot would submit. A gate rule restating the state comparison would be a second implementation of one rule in a package that does not own the manifest reader.

**A per-episode state card file, or a new top-level shot-script field.** Rejected: the per-character state already has a home inside `主体状态追踪`; a separate file would need the episode number at `validate` time and would keep the state out of the artifact the compiler consumes.

**Comparing the whole state string with set equality.** Rejected: costume and hair are free text, so equality would refuse correct bindings over wording (`米色风衣` versus `风衣（米色）`). Dimensions are closed vocabularies and compare exactly; state text is checked by containment of what the shot names.

**A closed vocabulary for an injury or illness (伤病).** Rejected: the format owner requires posture, held items, and injury state to stay out of fields of their own, and the reported defect is about body silhouette. An injury remains state text, so a shot that names 病弱 or 手部包扎 still requires the registration to say the same.

**Failing the `drama_assets` read or `jubian_organize` when a row omits `episodes` or a stage.** Rejected for the reason in the registration口径 above: the same row would fail a tool that never binds it, and one bad row would hide the rest of the manifest.

## Consequences

An official, correctly id'd asset of the wrong state can no longer compile. A project whose manifest predates these fields now fails binding on every character asset until each row states its stage and episodes, and the failure names the row — the enforcement is deliberately unavailable as a warning.

What the gate still does not decide: the asset's board image. A registration whose text is right and whose picture is not stays the model's review, which the drama skills require before submission; the alternative was image comparison this tool has no pixels for. A character named on screen whose state nobody declares and that matches no manifest row at all remains unreported, because nothing in the script then says which state to demand.

## Verification

`pnpm vitest run packages/drama/tool-shot-script` passes, 129 tests over seven spec files, with the new [`tests/state.spec.ts`](../../../../packages/drama/tool-shot-script/tests/state.spec.ts) driving the registered tool end to end: the accident's own ids (asset 81685 / material 79293) in the mismatch case, the restock request in the case with no matching version, `episodes: ['all']` covering an episode, and the unregistered-stage, missing-declaration, conflict, and undeclared-dimension boundaries. `--coverage.include` over `src/state.ts` and `src/assets.ts` reports both files fully covered, with two justified `v8 ignore` lines for capture groups and lookups the patterns make total.

`pnpm vitest run packages/jubian/tool-jubian/tests/organize.spec.ts` passes, including the new case that reads `episodes: ['all']` and `['全剧']` as series masters rather than refusing them.

The manifest reader now also accepts the array under `items`, the key the project's own manifest uses and `jubian_organize` already tolerated, so the gate is reachable on a real project instead of failing on the array key first.
