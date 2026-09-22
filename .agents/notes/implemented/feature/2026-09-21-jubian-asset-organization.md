# Agent Note: Episode-and-category asset organization for the Jubian tools

Status: implemented

English | [中文](2026-09-21-jubian-asset-organization.zh.md)

## Problem

A Jubian production's assets were addressable but not organized. The plugin could create, read and delete a subject-setting asset, and every asset it created went into the console's library under whatever name the caller passed and whatever category the caller sent. The tool schema offered one category field, `asset_type`, whose only evidenced value was `1`, so the short-drama pipeline sent `1` for everything: its 77 scenes and 21 props were created as characters and the console filed them under 角色. Nothing in the plugin could tell a caller which episode used which asset, which names had drifted from any convention, or which assets sat in the wrong category. A person opening the console could see the damage and had no tool that reported it.

## Decision

The package gains a naming convention, three asset-library writes, and one read-only organization view.

`src/naming.ts` owns the convention. An asset name reads `EP{nn}｜{类别}｜{名称}`, or `全剧｜{类别}｜{名称}` for a cross-episode master, and a processing task name carries an `EP05-P3-` prefix. `episode`, `asset_category` and `package_number` are new optional arguments on `image_generate`, `erase_subtitle`, `upscale` and `rename`; passing no `episode` leaves `asset_name` and `task_name` byte for byte what they were, so every call written before this feature keeps its meaning. The separator and the series label are `Config` fields (`nameSeparator`, `seriesLabel`) because a deployment may want `|` or a different master label; a blank value fails the mount rather than composing a name nobody can split.

`asset_category` fixes the category defect at its root. The three categories are the provider's own numbering — 角色 `1`, 场景 `2`, 道具 `3` — and `ASSET_CATEGORY_TYPES` is that external contract. `image_generate` derives `assetType` from the category, so a scene or a prop can no longer be created as a character. `asset_type` stays accepted for callers that predate the category, and the two must agree: a name that says 场景 with a type that says 角色 fails while the request body is compiled.

`src/folders.ts` adds `create_folder`, `move` and `rename` to `jubian_asset`, reproducing the console's own three calls: `POST /aigc/assetFolder/add`, `PUT /aigc/material/move` and `PUT /aigc/material/reName`. Each runs under the existing two-phase ledger and requires a caller-supplied `idempotency_key`; each consults the ledger for a replay *before* its precondition read, so a repeated key returns the recorded outcome rather than re-diagnosing a world its own first call changed. Two refusals are decided locally and before anything is sent, because the provider reports both as one envelope code: a sibling folder that already carries the name reports `folder_exists` with that folder's id, and a `target_folder_id` the library does not hold reports `target_folder_missing`. A successful create reads the tree back and returns the new `folder_id`, which is the id `move` needs.

`src/organize.ts` adds a sixth tool, `jubian_organize`, with one read-only method `index`. It reads the project's paged asset list, its used subject materials, its video tasks and each category's personal-library folder tree, and joins them with the project's own `assets_manifest.json` — the only episode map that exists, since no remote field carries one. The result carries four things, and the same content is written to `<project_dir>/<assetIndexPath>` (default `_probe/asset-index.md`, a `Config` field): `episodes` grouped by episode and then by category, `series` for the masters declared with no episode, `naming_violations` for every remote name that does not read as the convention, and `category_mismatches` for every asset whose `assetType` disagrees with what its manifest row or its own name declares. The index reports; it renames and moves nothing.

## Alternatives considered

**Keep the naming convention in the skill text instead of the plugin.** The pipeline's skills could tell a model to name things `EP05｜道具｜红包`. That is a rule a model has to remember, and nothing checks it: the three defects above were all produced by skill-following sessions. A tool argument carries the convention into the transcript, fails on a missing category, and lets the plugin derive the provider number a model cannot be trusted to send.

**Send the folder id without reading the tree first.** `create_folder` could POST and return whatever the provider says. It would then have no folder id to hand `move`, and a duplicate name would come back as the same envelope code as a permission problem, because the transport deliberately never echoes provider text into a result. The free tree read turns both into decidable answers.

**Enforce the convention on every existing name.** The 77 scenes and 21 props the pipeline created under `assetType` 1 could be renamed and moved in bulk. They are names and positions a person is already reading, and a rename does not change an `assetType`, so a batch would produce a correctly named asset sitting in the wrong library. The index reports the mismatch; acting on it is a user's decision, and the tool description says so.

**Put the organization view in `jubian_catalog` as another read method.** `jubian_catalog` reads account-level catalogues; this reads one project's assets and a local file, and it is the one call a model should reach for when it wants to understand a project rather than to fetch one field. A separate tool name is also what makes "this one changes nothing" sayable in the model's own reading language.

## Consequences

Every existing call keeps its meaning, and a caller that wants the convention opts in per call. The package's model-facing surface grew from five tools to six and from one tool's method enum to ten, which is a fixed token cost on every request while the row is mounted.

Three limits are recorded in the README. A category cannot be corrected without regenerating the asset, so the 98 mis-filed assets stay mis-filed until someone regenerates them; the two library writes take a material id rather than a parent asset id, so a parent id reaches the provider as an unknown row and comes back as a generic stable failure code; and the organization view reads the personal library's folders only, because the tree read runs with the `assetScopeType` the console opens on.

The three writes change what a person reads in the console. The plugin has no budget check and no confirmation step, so its only guard is the sentence in the `jubian_asset` description telling a model to obtain the user's explicit consent before a batch rename or move.

## Testing

`packages/jubian/jubian-api/tests/folder.spec.ts` covers the tree reader, the by-name and by-id lookups and every rejection. `packages/jubian/tool-jubian/tests/` adds `naming.spec.ts`, `folders.spec.ts` and `organize.spec.ts`, covering name composition, the audits, all three library writes including their two local refusals, the replay path, the ledger's unsettled-intent case, and an index built over a manifest and provider payload carrying the ragged rows real projects contain. `tools.spec.ts` asserts the six-tool registry, both schemas, and that each organization write reaches its own writer before the network. `npx vitest run packages/jubian` runs 288 tests; the four new or changed source modules — `src/naming.ts`, `src/folders.ts`, `src/organize.ts` and `jubian-api/src/folder.ts` — report per-file 100% statements, branches, functions and lines under the same v8 configuration the coverage gate uses.
