# Jubian Live Video Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make storyboard-native generation validate and preserve the live Jubian storyboard's exact Seedance model settings, including Seedance 2.5 at 9:16/480p with up to 30 seconds of content, then produce and deliver episode 11.

**Architecture:** Replace the hard-coded Seedance 2.0/720p selector with an exact catalogue resolver driven by the live storyboard configuration. Centralize duration capability validation so preview construction and validation agree, while retaining identity, reconciliation, fingerprint, and one-PUT protections. After verification, use the existing episode package outputs to create six remote storyboards and run the normal production pipeline.

**Tech Stack:** TypeScript, Vitest, pnpm, DSH Jubian tools, Python project scripts, FFmpeg/drama_render.

---

## File Map

- Modify `packages/jubian/jubian-api/src/native.ts`: exact live-model catalogue resolution and shared storyboard-native duration capability.
- Modify `packages/jubian/jubian-api/src/storyboard.ts`: accept supported live storyboard configurations instead of fixed 720p while preserving direct-generate limits.
- Modify `packages/jubian/jubian-api/tests/native.spec.ts`: Seedance 2.5/480p/30-second resolver and preview tests.
- Modify `packages/jubian/jubian-api/tests/storyboard.spec.ts`: non-720p storyboard reading regression test.
- Modify `packages/jubian/tool-jubian/src/index.ts`: accurate tool descriptions.
- Modify `packages/jubian/tool-jubian/tests/native.spec.ts` and `tests/methods.spec.ts`: tool-layer prepare behavior.
- Update generated tool documentation only through the repository's existing generator if focused verification requires it.
- Create project audit/request files under `E:/aa-manju/short-drama/山海自有相逢处/_probe/` and `video_tasks/` during production.

### Task 1: Add failing API tests for live Seedance settings

**Files:**
- Modify: `packages/jubian/jubian-api/tests/native.spec.ts`
- Modify: `packages/jubian/jubian-api/tests/storyboard.spec.ts`

- [ ] **Step 1: Add a Seedance 2.5 catalogue fixture**

Add a FANG_ZHOU row whose modelId is `doubao-seedance-2-5-260628`, standardId is `61`, genType 3 has id `71`, and 9:16/480p has videoStandardId `338`.

- [ ] **Step 2: Add failing exact-resolution tests**

Test that a live config with platformId FANG_ZHOU, that exact modelId, genType 3, ratio 9:16, resolution 480p, and genNum 1 resolves to `{ standardId: 61, modelGenerationTypeId: 71, videoStandardId: 338 }`; also test that platform or resolution mismatch throws without fallback.

- [ ] **Step 3: Add failing duration tests**

Build previews with provider durations 31 and 32 (30- and 31-second content respectively). Assert 31 passes for Seedance 2.5 and 32 throws. Assert Seedance 2.0 still rejects content above 14 seconds.

- [ ] **Step 4: Add failing storyboard-read test**

Assert `readStoryboard` accepts an otherwise valid 9:16/480p Seedance config and derives content duration from `duration - 1`.

- [ ] **Step 5: Verify RED**

Run:

```powershell
pnpm vitest run packages/jubian/jubian-api/tests/native.spec.ts packages/jubian/jubian-api/tests/storyboard.spec.ts
```

Expected: the new tests fail because the implementation selects only Seedance 2.0/720p and `readStoryboard` rejects 480p.

- [ ] **Step 6: Commit the failing tests**

```powershell
git add packages/jubian/jubian-api/tests/native.spec.ts packages/jubian/jubian-api/tests/storyboard.spec.ts
git commit -m "test(jubian): cover live storyboard video settings"
```

### Task 2: Implement exact catalogue resolution and duration capability

**Files:**
- Modify: `packages/jubian/jubian-api/src/native.ts`
- Modify: `packages/jubian/jubian-api/src/storyboard.ts`

- [ ] **Step 1: Replace the hard-coded selector contract**

Change the selector to accept the live config:

```ts
export function selectSeedanceVideoModel(
  catalogue: unknown,
  requested: Record<string, unknown>,
): SeedanceVideoModel
```

Require exact normalized equality for `platformId`, `modelId`, `genType`, `ratio`, and `resolution`, require `genNum === 1`, and refresh only catalogue-owned IDs. Reject zero or multiple matching rows.

- [ ] **Step 2: Add one shared duration capability function**

```ts
export function nativeContentDurationLimit(modelId: string): number {
  return modelId.toLowerCase() === 'doubao-seedance-2-5-260628' ? 30 : 14
}

export function requireNativeDuration(config: Record<string, unknown>): number {
  const duration = integer(config.duration)
  const content = duration - 1
  if (content < 1 || content > nativeContentDurationLimit(text(config.modelId))) invalid()
  return content
}
```

Use it in preview construction and preview validation. Keep direct `withGenerationEnabled` at 4000–14000ms.

- [ ] **Step 3: Remove fixed resolution from storyboard reading**

In `configOf`, require 9:16, genNum 1, a non-empty modelId/platformId/resolution, and an integer duration, but do not require `resolution === '720p'`.

- [ ] **Step 4: Preserve the live configuration as intent**

Pass the parsed live config into the catalogue resolver. Refresh `standardId`, `modelGenerationTypeId`, and `videoStandardId` plus normalized catalogue values, but never change the requested model, platform, ratio, resolution, or genType to a different semantic value.

- [ ] **Step 5: Verify GREEN**

Run the same two focused Vitest files. Expected: all tests pass.

- [ ] **Step 6: Run the package API test set**

```powershell
pnpm vitest run packages/jubian/jubian-api/tests
```

Expected: all Jubian API tests pass.

- [ ] **Step 7: Commit implementation**

```powershell
git add packages/jubian/jubian-api/src/native.ts packages/jubian/jubian-api/src/storyboard.ts
git commit -m "fix(jubian): follow live storyboard video settings"
```

### Task 3: Update the tool layer and descriptions

**Files:**
- Modify: `packages/jubian/tool-jubian/src/index.ts`
- Modify: `packages/jubian/tool-jubian/tests/native.spec.ts`
- Modify: `packages/jubian/tool-jubian/tests/methods.spec.ts`

- [ ] **Step 1: Add failing tool tests**

Add a prepare-video fixture whose live storyboard is Seedance 2.5/480p with duration 31 and whose live catalogue contains the exact matching row. Assert the persisted preview keeps 480p, resolves IDs 61/71/338, and reports `content_duration_ms: 30000`.

- [ ] **Step 2: Verify RED**

```powershell
pnpm vitest run packages/jubian/tool-jubian/tests/native.spec.ts packages/jubian/tool-jubian/tests/methods.spec.ts
```

Expected: new tests fail under the old fixed-setting behavior.

- [ ] **Step 3: Update descriptions only**

Describe `prepare_video` as validating the storyboard's saved Seedance model, ratio, resolution, generation type, count, and model-specific duration against the live catalogue. Remove claims that it always resolves non-Mini Seedance 2.0/720p.

- [ ] **Step 4: Verify GREEN and package tests**

```powershell
pnpm vitest run packages/jubian/tool-jubian/tests
pnpm --filter @deepseek-ai/dsh-tool-jubian typecheck
```

Expected: all tests and typecheck pass without warnings.

- [ ] **Step 5: Commit tool changes**

```powershell
git add packages/jubian/tool-jubian/src/index.ts packages/jubian/tool-jubian/tests/native.spec.ts packages/jubian/tool-jubian/tests/methods.spec.ts
git commit -m "docs(jubian): expose live video setting validation"
```

### Task 4: Verify integration and rebuild the active tool package

**Files:**
- Inspect/modify only repository-defined generated catalog files if the generator changes them.

- [ ] **Step 1: Run focused integration tests**

```powershell
pnpm vitest run packages/jubian/jubian-api/tests packages/jubian/tool-jubian/tests
```

Expected: all pass.

- [ ] **Step 2: Run package builds**

```powershell
pnpm --filter @deepseek-ai/dsh-jubian-api build
pnpm --filter @deepseek-ai/dsh-tool-jubian build
```

Expected: both builds succeed.

- [ ] **Step 3: Inspect the final diff**

Confirm no unrelated pre-existing workspace changes are staged and that the diff preserves identity checks, double-snapshot reconciliation, fingerprint validation, and one-PUT semantics.

### Task 5: Create and configure episode 11 storyboards

**Files:**
- Create: `E:/aa-manju/short-drama/山海自有相逢处/_probe/ep11-p1-create-body.json` through `ep11-p6-create-body.json`
- Create: model preview under the project directory as returned by `jubian_model preview`

- [ ] **Step 1: Sync pipeline state**

Run the canonical `pipeline_state.py <project> sync` and record the current projection.

- [ ] **Step 2: Re-verify the compiled package**

Run `_tools/check_shot_script.py --episode 11`, `_tools/build_ep_matches.py --episode 11`, `drama_shot compile`, and `_tools/verify_ep_package.py --episode 11`. Expected: 43 shots, six packages, zero problems.

- [ ] **Step 3: Freeze six creation bodies**

Build six `isGenerate=0` bodies with scriptId 2708, episodeId 46744, episodeCount 11, scriptName `山海自有相逢处`, correct package names, prompts, ordered materials, and existing durations. Save each body before any remote write.

- [ ] **Step 4: Create six storyboards without generation**

Call `jubian_storyboard create` once per body with a unique stable idempotency key. Record returned storyboard IDs. Do not retry with a new key.

- [ ] **Step 5: Preview and apply model settings**

Call `jubian_model preview` for the six exact storyboard IDs with modelId `doubao-seedance-2-5-260628`, platformId `FANG_ZHOU`, ratio `9:16`, resolution `480p`, genType 3, genNum 1. Review every before/after entry, then call apply with the preview fingerprint.

- [ ] **Step 6: Select and verify ordered assets**

For every storyboard call `select_assets` with package-order material keys and official parent asset IDs. Verify identity, URL, name, and order on readback.

### Task 6: Prepare, submit, and account for generation

**Files:**
- Create: six immutable preview files under `video_tasks/`
- Append: project billing ledger through existing accounting path

- [ ] **Step 1: Prepare all six packages**

Call `prepare_video` with each storyboard ID and project directory. Verify every preview says Seedance 2.5, 480p, correct duration, correct episode metadata, and exact ordered assets.

- [ ] **Step 2: Report pre-charge estimate**

Use the live rate and preview durations to report the six-package estimate before submission. This batch is a higher-priced model decision already explicitly approved by the user.

- [ ] **Step 3: Submit once per preview**

Call `submit_video` using each preview path and its exact fingerprint as idempotency key. Never issue a second PUT for an unknown result.

- [ ] **Step 4: Read back tasks and costs**

Use `jubian_video task/subtasks` to record task IDs, parent/child statuses, all identity fields, URLs, resolution, and `realCost`. Report actual total cost from readback only.

### Task 7: Review, clean, and assemble episode 11

**Files:**
- Create/update: project video manifests, downloaded videos, review evidence, subtitle status, draft files, timeline, SRT, and render inputs.

- [ ] **Step 1: Download successful results**

Use `jubian_media download` for each accepted child result and probe every file.

- [ ] **Step 2: Review visual and identity quality**

Extract representative frames, inspect identity, clothing, scene, props, actions, mouth movement, continuity, malformed anatomy, and embedded text. Record pass/fail evidence per package.

- [ ] **Step 3: Handle resolution and subtitles**

Because source output is 480p, call `jubian_video upscale` for accepted clips that report `needs_upscale=true` against 1080p delivery. Submit subtitle erasure only for clips with embedded subtitles; poll asynchronously and allow the documented pending fallback after five minutes.

- [ ] **Step 4: Build spoken subtitles and draft**

Load `tweet-drama-draft-build`, transcribe the assembled episode audio locally with faster_whisper, align cue times to actual speech, and correct names/homophones against the original script.

- [ ] **Step 5: Select BGM and prepare render inputs**

Use `bgm_match` based on the episode's emotional coordinates, choose the best candidate from measured valence/arousal, and run `drama_render prepare` with the accepted shot list and SRT.

### Task 8: Render, verify, and deliver

**Files:**
- Create: final episode 11 MP4, SRT, timeline, render log, and verification report under the project.

- [ ] **Step 1: Render fixed delivery output**

Load `tweet-drama-background-render`, then call `drama_render render` for 1440×2560 at 60fps, H.264 high@5.1, target 24Mbps, AAC 192kbps, BGM and ending assets.

- [ ] **Step 2: Verify the actual file**

Call `drama_render verify`. Require measured 1440×2560, 60fps, H.264, audio/video streams, acceptable duration, no blocking black/silent sections, in-range subtitles, and total bitrate at least 4.6Mbps.

- [ ] **Step 3: Sync final pipeline state**

Run canonical pipeline sync and verify episode 11 is represented in downstream artifacts without falsely marking the whole 50-episode stages complete.

- [ ] **Step 4: Present deliverables**

Use `present` for the final MP4, SRT, timeline, and verification report. Report actual generation/upscale/subtitle costs and final measured media properties.
