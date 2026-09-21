# Jubian Live Video Model Settings Design

## Goal

Make storyboard-native video preparation follow the model, ratio, resolution, generation type, generation count, and duration already saved on the live Jubian storyboard, while validating that exact combination against the current account model catalogue before any paid submission.

The immediate acceptance case is Seedance 2.5 (`doubao-seedance-2-5-260628`) with FANG_ZHOU, 9:16, 480p, genType 3, genNum 1, and packages up to 30 seconds for episode 11 of project 2708.

## Scope

- Replace the hard-coded Seedance 2.0 / 720p resolver in the storyboard-native preparation path.
- Keep the live storyboard as the caller's configuration intent.
- Resolve its exact model combination against the live taskType=1 catalogue.
- Allow Seedance 2.5 content duration up to 30 seconds.
- Keep existing limits for models without a verified extended-duration capability.
- Update storyboard readers, preview validation, submission validation, schemas, descriptions, and focused tests.
- Preserve all existing identity, material order, project binding, snapshot reconciliation, idempotency, and one-PUT billing protections.

Out of scope: changing image generation, adding another provider, bypassing storyboard-native submission, weakening asset identity checks, or redesigning the editing pipeline.

## Configuration Resolution

`prepare_video` reads the live storyboard modelConfig and extracts:

- platformId
- modelId
- standardId
- genType
- modelGenerationTypeId
- videoStandardId
- ratio
- resolution
- genNum
- duration

The live taskType=1 catalogue is queried on every preparation. Resolution requires one catalogue model row matching both platformId and modelId, one generation type matching genType, and one video standard matching ratio and resolution. The resolver refreshes standardId, modelGenerationTypeId, and videoStandardId from that live catalogue row. It never silently changes model, platform, ratio, resolution, or genType.

No match or more than one semantically valid match fails before any paid request and reports the unsupported combination.

## Duration Capability

Duration remains a whole positive number in the provider modelConfig. The generated content duration is `duration - 1` seconds because the final second is the existing natural hold.

- Seedance 2.5 (`doubao-seedance-2-5-260628`): content duration 1–30 seconds.
- Other currently supported Seedance models: content duration 1–14 seconds unless a verified capability is added later.
- The existing direct `generate` path retains its current 4–14 second contract; this change applies to the storyboard-native prepare/submit path used for subject video.

The capability rule lives in one shared function used by preview construction and preview validation, avoiding inconsistent limits across layers.

## Safety and Data Flow

1. A storyboard is created or saved with `isGenerate=0`.
2. Model settings may be changed through `jubian_model preview/apply`, which preserves prompts and assets.
3. `prepare_video` reads the live storyboard, live subject assets, and live model catalogue.
4. It validates exact model support, duration capability, material identity, prompt key order, scriptId, and project binding.
5. It writes an immutable preview containing the exact paid PUT payload and fingerprint.
6. `submit_video` validates the preview, re-reads live state, runs task double-snapshot reconciliation, and performs at most one paid PUT.
7. Result identity and task cost are read back as before.

## Episode 11 Production Plan

After the plugin change is verified:

1. Use the already compiled six episode-11 packages as source material.
2. Create six remote storyboards with correct scriptName, episodeCount=11, and episodeId=46744, without generation.
3. Use `jubian_model preview/apply` to set all six to Seedance 2.5, 9:16, 480p, genType 3, genNum 1. Existing package durations remain unchanged unless a later repack is separately validated.
4. Select and verify ordered official assets for every package.
5. Prepare six storyboard-native previews and submit them with their fingerprints.
6. Read back task IDs, identity fields, result URLs, and realCost.
7. Review videos, perform subtitle cleanup when needed, upscale results below delivery resolution when required, build subtitles from actual audio timing, assemble the episode, and render the fixed delivery format.
8. Verify the final file at 1440×2560, 60 fps, H.264, with measured total bitrate at least 4.6 Mbps.

The first production pass retains six existing packages because they already passed the director-shot and asset gates. Thirty-second support is enabled by the infrastructure change but does not justify merging already validated packages across scene/time boundaries.

## Error Handling

- Unsupported model/standard combination: stop before preview creation.
- Stale or ambiguous catalogue match: stop; never substitute another model.
- Duration above model capability: stop before preview creation.
- Remote write timeout or unknown result: reconcile with the same idempotency key; never issue a second PUT.
- Missing asset identity or changed material order: terminal `subject_identity_lost`; return to selection.
- Failed or incomplete video task: read parent and child status before considering the guarded retry path.

## Tests

Add focused tests proving:

- Seedance 2.5 / FANG_ZHOU / 9:16 / 480p resolves to live catalogue IDs.
- A 30-second content package passes for Seedance 2.5.
- A 31-second content package fails.
- An unavailable resolution fails without fallback.
- A platform mismatch fails without fallback.
- Seedance 2.0 retains its existing duration limit.
- Existing asset identity, prompt order, preview fingerprint, tamper detection, and one-PUT submission tests remain green.
- Tool descriptions no longer claim that prepare_video is fixed to Seedance 2.0 / 720p.

## Done Condition

The change is complete when the focused Jubian API and tool tests pass, episode 11 can be configured as Seedance 2.5 / 480p through the supported model configuration path, all six previews prepare without bypasses, paid submissions produce identity-preserving task IDs, and the verified final episode is presented to the user.