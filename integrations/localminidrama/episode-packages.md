---
description: "Ordered per-episode production packages, additive AI continuation and verified duration totals."
kind: "reference"
---

# Muse episode production packages

English | [中文](episode-packages.zh.md)

## Summary

**Episode packages** organizes one native card per independent video prompt. Each episode can contain multiple ordered packages, and a package can describe several sub-shots within the selected model's clip duration. Users can append packages, edit one package, reorder the episode and continue with AI while preserving existing packages and their adopted resources.

## Contents

- [Editing and ordering](#editing-and-ordering)
- [AI continuation](#ai-continuation)
- [Actual duration](#actual-duration)
- [Integration and verification](#integration-and-verification)

## Editing and ordering

Open **Episode packages** from the production page. A classic package uses `video_prompt`; a universal package uses `universal_segment_text`. Packages retain their native storyboard IDs, asset associations and generation history. The organization view does not create a second shot entity. The native card still owns image/video/voice version adoption and detailed editing.

Manual append and content edits do not dispatch supplier calls. Each save compares the observed database identity and episode-input snapshot in one SQLite transaction. Reordering requires every active native card ID exactly once and assigns consecutive `storyboard_number` values. Native lists, batch production and episode merging use this same order. A changed snapshot or a foreign card fails without overwriting current data.

Stable free-operation receipts prevent a lost acknowledgement from repeating the same operation ID. Replaying a receipt does not overwrite later edits. The browser retains only input fingerprints and UUIDs in its operation cache. Refreshing asks before discarding unsaved package fields; saving one package retains other unsaved fields. Save outstanding edits before reordering or AI continuation. Adopted resource fields are never changed by content saves or ordering.

## AI continuation

**AI continuation** uses the existing paid `POST /api/v1/episodes/:id/storyboards` with `mode: append`, `expected_package_snapshot`, `expected_package_database_id`, `append_brief` and `storyboard_count`. It shares the [generation admission](admission.md) reservation and stable header; it does not create a second paid endpoint. The user explicitly confirms the text-model call. This creates package prompts, not generated video clips.

The request includes existing package continuity information and the explicit continuation brief. It freezes the native episode, cards, referenced business assets and generation records used by the source snapshot. If those inputs change while the model runs, the completed response is rejected for storage and existing edits remain. Supplier failure, incomplete output or a failed insertion cannot partially append. The task and original receipt remain available for inspection; a failed task does not imply a free supplier call.

Successful append sorts the model's local shot numbers and allocates consecutive global package numbers from the current active maximum inside the same transaction. It never soft-deletes existing cards or replaces their prompts, associations or adopted versions. Automatic whole-episode polishing and parameter completion do not run over the older packages after continuation. The original AI rebuild remains an explicit replacement action with a warning; it is separate from continuation.

## Actual duration

Package target duration is a planning value. The organization view probes adopted local video files using FFprobe; it does not use requested generation duration as actual duration. Missing files, external-only URLs, invalid media, probe failures or a changing file produce `null`. Local resolution remains inside the configured storage directory.

The full episode duration is known only when every active package has a readable adopted video duration. Otherwise the view displays **Unknown**, the number of unknown packages and the known partial total separately. Appending packages can extend an episode; it does not extend a supplier's single-clip limit. Episode merging still requires an adopted video for every package and retains the existing local merge constraints.

## Integration and verification

`planMuseEpisodePackages(root, readSource)` runs after `planMuseAdmission`, retaining staged audio, revisions and postproduction changes. It uses precise pinned-source replacements and rejects drift or repeated application. Owned operation receipts use monotonic `muse_package_schema` version 1; native business content and media remain in their existing tables. Back up the database and storage together.

`GET /api/v1/muse/packages/episodes/:id` returns the database ID, frozen snapshot, ordered cards and duration observations. `POST` to the same path accepts `{database_id,expected_snapshot,operation_id,kind,...}`. `kind` is `create`, `update` or `reorder`; create/update take title, prompt, creation mode and target duration, while reorder takes the full `ids` permutation. An update also names `package_id`.

Validated `muse_packages` settings are `max_prompt_chars` (65,536; range 256–262,144), `max_new_packages` (100; range 1–1,000), `probe_timeout_ms` (30,000; range 1,000–300,000) and `probe_concurrency` (2; range 1–8). Single-package video limits still come from the selected supplier/model rather than these organization limits.

Run `node --test integrations/localminidrama/tests/muse-episode-packages.test.mjs`. Fixtures execute real native generation/storage services with local model barriers, private SQLite databases, original HTTP handlers, real FFmpeg/FFprobe and a full Vite build. They verify append preservation, concurrent edits, rollback, stable acknowledgements, ordering and unknown duration. No supplier keys or paid calls are used. The [package expectation](tests/expected/muse-episode-packages.json) is owner-local.

## Dev note

None.
