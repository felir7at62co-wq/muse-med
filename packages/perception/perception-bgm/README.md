---
description: "Rank local or public music by emotion and download selected tracks, with optional non-commercial analysis."
kind: "package-bundle"
---

# @deepseek-ai/dsh-perception-bgm

English | [中文](README.zh.md)

## Summary

Find BGM candidates near a requested mood on a 1–9 valence/arousal scale. `match` reads a local index or a configured public catalogue without Python or model weights. Select a remote candidate explicitly with `download` to obtain a verified local file for composition. `index` and `inspect` require a separately prepared Python runtime and models; the MERT backbone is restricted to non-commercial use.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The bundle's [patch](cordis.patch.yml) contributes one `perception-bgm` row to a profile with the tools registry. The package does not automatically install or activate itself in a running profile. Desktop assembly and profile-install verification remain release-owner tasks.

Without `catalogUrl`, `match` reads `indexPath` and preserves the local candidate `path` result. A missing or empty local index asks for indexing. With `catalogUrl`, `match` reads only that public catalogue and returns `track_id`, original `name`, public `url` and measurements, never a nonexistent local path. It downloads no audio automatically. Call `download` with the selected `track_id`; its verified `path` can be supplied directly as a `drama_bgm` track source. Cached reuse verifies SHA-256 again and still requires the live catalogue. `index` and `inspect` remain local, optional analysis methods; Python dependency errors occur only when their worker starts.

The published catalogue at `https://muse.tos-cn-beijing.volces.com/bgm/catalog.json` was exercised through `match` and one verified download without credentials or Python. It is not enabled by default; profile configuration chooses it. Public audio rights and the non-commercial analysis-model license are separate obligations.

Candidates, downloads and published tracks include `license_info` (`status`, `license`, `commercial_use`, `source`, `attribution`, `scope`) and `license_warnings`. These fields carry the supplied rights declaration, never a verified grant. Missing fields remain `unknown`; commercial permission without a license, source and scope becomes unknown. Optional `intended_use` on `match` and `download` is `commercial`, `non_commercial` or `unknown` (default); it changes risk warnings, never permissions or tool availability. A non-commercial declaration used commercially reports a warning without blocking. Download hashes identify audio bytes, not usage rights. Unsupported approval statuses or malformed field types reject the declaration; warnings are recomputed for the current use rather than copied from stored metadata.

Before selection, pass an absolute `project` and explicit story `context_tags` to `match`. Each call rereads user-confirmed `project_bible.bgm_feedback` from `project_config.json`, written through `drama_project`'s preview/revision workflow. Stable track IDs or content hashes survive renaming. A rejection applies only when every feedback tag occurs in the current scene; other-context feedback remains visible, not a global blacklist. The latest appended applicable user decision can reverse an earlier rejection without erasing history. Matching retains the original emotion distance, moves applicable rejections to auditable `withheld_candidates`, and does not prevent downloads. Acceptances are annotated, not assigned an invented emotional score. If every candidate is rejected, no added music is an ordinary recommendation. Missing legacy feedback preserves matching; malformed feedback is reported instead of silently discarded. Omitting `project` does not read project preferences; the optional `story` parameter controls intent-based ranking.

For story scoring, pass optional `story` with a nonempty `intent` (up to 600 characters), 1–8 `desired_tags`, optional 0–8 `avoid_tags`, and `dialogue_density` (`none`, `sparse`, `dense`, or default `unknown`). Use the musical-intention enum in the current tool schema; desired and avoided tags must not overlap. The agent derives these intentions from the actual script, audience knowledge and adopted timeline; the matcher does not interpret the intent prose. Explicit title conflicts move to auditable `review_candidates`; remaining tracks compare available sampled-audio label matches in descending `desired_tags` priority, then title matches, mood matches and unchanged emotion distance. Audio/mood-label conflicts are advisory. `story_fit` separates audio/title/mood evidence, missing tags and unknown audio properties; `supported` means candidate evidence exists, never that a cue was heard or approved. Applicable user rejections remain withheld even when a title fits. All three candidate lists are limited independently. Unsupported libraries recommend considering no added music; uncertain and conflicting candidates remain available for audition and download. Omitting `story` preserves emotion-only ranking; catalogues without audio profiles preserve legacy result fields.

Deployments can enable `requireStoryEvidence` (generic default false; Muse creative presets enable it). Story calls then require `story.evidence` references for both `script` and `visual_review`, with optional `transcript`; each has `kind`, project-owned UTF-8 `file`, and 1–8 exact `quotes` of at most 800 characters. Up to eight reference files of at most 2 MiB each are read anew. Whitespace is ignored when matching quotes. Visual review is JSON containing `video`, `video_sha256` and `observations` from actual inspection; the tool compares quotes against observations and streams the project-owned video to verify its hash. A video change requires a new inspection. Missing evidence returns `needs_source_evidence`; unmatched quotes or a changed video return `needs_source_correction`, empty candidates and concrete source checks before any library request. Ordinary browsing remains `reference_only`. `evidence_matched` proves quoted text and video identity, never the accuracy of observations, interpretation or musical suitability. Existing generic deployments remain compatible; see the [production migration](../../../docs/upgrade-guide/v0.2.1-alpha.1/bgm-story-evidence/guide.md).

Story calls include actual audition checks, with dialogue masking emphasized for dense speech. Filenames and tags cannot verify vocals, instruments, era, excerpt development or musical cuts. Follow the drama skill's [story selection workflow](../../drama/skills/skills/tweet-drama-background-render/references/story-bgm-selection.md) for scene-specific queries, source offsets, reveal-sensitive timing and the render tool's audible comparison; this matcher does not generate a complete cue plan or guarantee creative acceptance.

For a contiguous next cue, pass `previous_track_id` with the actual preceding catalogue ID or local SHA-256. The same library supplies its measurements and tags; an absent identity returns `missing_from_library` without inventing reference values. Candidates report `continuity_fit`: measured V/A Manhattan distance, normalized tag-set Jaccard overlap and shared tags. Ranking first preserves evidence for the current primary story tag, then favors transitions within configured limits before existing ranking. Missing labels remain `insufficient_tags`; findings are advisory, and real plot turns may justify a larger change. Review the complete sequence and both sides of each actual cut; these metadata checks cannot verify tempo, timbre, loudness or dialogue interpretation.

To prefer variety across adjacent episodes, pass `adjacent_episode_track_ids` from the current project's actual N−1 and already-produced N+1 music records. This differs from the preceding cue within the same episode. After primary intent, continuity, conflicting labels and sampled-audio evidence, matching adds `adjacentEpisodeRepeatPenalty` to the ranking distance of listed tracks; original measured distance remains unchanged. Candidates disclose that penalty and remain selectable. Hash identities normalize case and the optional SHA prefix; missing local identities remain `unknown_identity`. The matcher does not discover neighbor plans or certify that the supplied list is complete. A genuine cross-episode scene or theme may retain the same cue with a recorded reason.

Catalogue rows may carry optional `audio_profile` version 1, linked to the exact track SHA-256 and a recipe digest. Results retain its pinned model identity, raw cosine tag scores, inferred instruments/vocals, duration, estimated tempo, RMS/peak dBFS and sampled time windows. `human_reviewed` must be false for this machine-inference format; similarities are not confidence percentages, and sampled coverage is not whole-song semantic analysis. Invalid source identity, sample bounds/coverage, measurements, tag scores or review claims reject the profile instead of silently attaching unrelated evidence. Lookup requires no model or Python. Missing profiles remain valid.

| Configuration | Resolution |
|---|---|
| `pythonExecutable` | Existing absolute executable; otherwise `DSH_PERCEPTION_PYTHON`; an unusable path prevents analysis only |
| `weightsPath` | Existing absolute emotion-head checkpoint; otherwise `DSH_PERCEPTION_BGM_WEIGHTS`, then `<DSH_HOME>/perception/bgm/J_all.ckpt` |
| `dataDir` | Defaults to package `python/data`; analysis deployments must supply an external directory with **all** packaged static data plus `btc_model_large_voca.pt` |
| `indexPath` | Defaults to `<DSH_HOME>/perception/bgm/bgm-index.json`; keep it writable and outside the installation |
| `env` | Explicit worker environment; use `HF_HOME` for the prepared cache and `HF_HUB_OFFLINE=1` to forbid downloads |
| `callTimeoutMs` | Defaults to 300000 milliseconds per analysis |
| `catalogUrl` | Omitted: local index; configured: canonical HTTPS catalogue URL without credentials, query or fragment |
| `cacheDir` | Defaults to `<DSH_HOME>/perception/bgm/cache`; absolute directory for verified downloads |
| `networkTimeoutMs` | Defaults to 60000 milliseconds for the complete match/download operation |
| `maxCatalogBytes` | Defaults to 2097152 decoded bytes |
| `maxTrackBytes` | Defaults to 134217728 bytes per catalogue track |
| `maxTransitionEmotionDistance` | Defaults to 3; advisory adjacent V/A Manhattan-distance limit, 0–16 |
| `minTransitionTagOverlap` | Defaults to 0.2; advisory normalized tag-set Jaccard minimum, 0–1 |
| `adjacentEpisodeRepeatPenalty` | Defaults to 2; ranking-distance penalty for supplied neighboring-episode track IDs, 0–16; zero disables the preference |
| `requireStoryEvidence` | Defaults to false; require current script and video-bound visual-review quotations for story recommendations |

No model weights ship in npm. See [sources and licenses](SOURCES.md) before acquiring weights; the default package data directory alone is insufficient for analysis. Without offline mode, the first analysis can download the frozen MERT snapshot. Explicit `env` entries take precedence. Setting any of `HF_HOME`, `HF_HUB_CACHE`, `TRANSFORMERS_CACHE` or `HF_ENDPOINT` excludes all four ambient values; otherwise the worker inherits that allowlisted group. Read-only model deployments must provide writable `HF_MODULES_CACHE`, `NUMBA_CACHE_DIR` and application cache locations outside the installation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The public manifest is `{version:1,tracks:[{id,name,sha256,bytes,url,valence,arousal,moods,license_info,license_warnings}]}`. Each `id` equals its `sha256:<64 lowercase hex>` digest. Track URLs default to the catalogue's origin plus `/bgm/tracks/<hash>.<audio extension>`. A track may declare `object_key`, such as `bgm/tracks/1`, to use an existing numbered object; its URL must exactly match the same origin plus that key. Keys contain one ASCII alphanumeric-led filename with letters, digits, dots, underscores or hyphens under `bgm/tracks/`; duplicate URLs are rejected. IDs and download-cache paths remain content-addressed, and downloads still verify size and SHA-256. HTTPS transfers omit credentials and reject redirects, partial responses, oversize bodies, invalid measurements, duplicate IDs and unsafe filenames. Downloads stream into exclusive files in private temporary directories, verify size and SHA-256, then atomically rename into content-addressed cache paths; errors remove staging files. Caller cancellation and plugin unload abort network operations.

The maintainer-only `scripts/build_tag_index.py` reads verified local audio and a prepared, pinned CLAP model directory. It compares up to twelve distributed ten-second excerpts per track with recorded musical-intention prompts; the default is six. It writes an extended catalogue, standalone `tag-index.json`, CSV and a Chinese lookup table without uploading or changing audio. Coverage counts overlapping intervals once. Checkpoints resume only for matching audio and recipe digests; the recipe records prompts, model weights and library versions. Prepare Torch 2.6.0, Transformers 4.57.6, librosa 0.11.0 and soundfile 0.13.1 in a separate environment; obtain the pinned model from its official source in [SOURCES.md](SOURCES.md). Run `python scripts/build_tag_index.py --catalog <catalog.json> --audio-dir <numbered-audio-directory> --model-dir <prepared-model-directory> --output-dir <new-output-directory>`. Review outputs before publishing metadata; audio inference never constitutes human approval or changes music rights.

Local indexing checks SHA-256 before reusing measurements or declarations, even when size and modification time are unchanged. New or changed audio receives unknown rights; unchanged bytes retain normalized declarations. Local candidates include the indexed `source_sha256` when available so a plan can freeze the selected bytes. A failed re-analysis also clears the changed file's old declaration.

The TypeScript tool ranks cached or public measurements and lazily starts an isolated NDJSON Python worker only for analysis. The worker uses the maintained Music2Emotion inference adapter and vendored helpers; analysis-library print diagnostics go to stderr, while stdout carries only NDJSON responses. Non-response JSON and diagnostic lines are ignored; a response must carry a string request ID before it can settle a pending call. Caller cancellation and unloading stop local indexing with an explicit tool error, while ordinary per-track analysis failures remain recorded in the index result. Unloading removes the tool registration, aborts admitted operations, rejects worker requests and waits for process close and filesystem work. An already-started index write completes before cancellation is reported; completed track entries remain available for resuming, and no new worker or index write starts after unloading. Each chord/key operation owns a random OS temporary directory, removed on return or exception; no intermediate is written into package data. No invariant companion is published because the package has no independently maintained observations to reconcile.

From the repository root, the focused source build and offline checks are:

```sh
pnpm exec tsc -p packages/perception/perception-bgm/tsconfig.json
pnpm exec tsdown --config packages/perception/perception-bgm/tsdown.config.ts
pnpm exec vitest run packages/perception/perception-bgm/tests/match-loader.spec.ts packages/perception/perception-bgm/tests/tools.spec.ts packages/perception/perception-bgm/tests/bundle-patch.spec.ts packages/perception/perception-bgm/tests/remote-library.spec.ts
python -B packages/perception/perception-bgm/tests/test_runtime_resources.py
```

From this package directory, check the standard npm file list after building:

```sh
npm pack --dry-run --json --ignore-scripts --cache .test-npm-cache | node tests/check-pack.mjs
```

The manifest includes `lib/index.js`, `lib/config.js`, `lib/worker.js`, declarations, worker scripts, vendored Python, static data, and source/license records. Its explicit allowlist excludes TypeScript sources, checkpoints, and caches. Python regression tests stub heavy libraries and do not analyze audio or access the network.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sources, revisions and licensing](SOURCES.md)
- [Harness profile architecture](../../../docs/architecture.md)
- [Tool implementation](src/index.ts)

-----

<a id="model-experience"></a>
## Model Experience

### The `bgm_match` tool schema

#### What the model sees

The [generated `bgm_match` schema](../../../docs/tool-catalog.md#deepseek-aidsh-perception-bgm) exposes `match`, `download`, `index`, and `inspect`. Its description states “返回的是候选排序，不是决定” and identifies MERT as “仅限非商业用途”. Public candidates contain stable IDs rather than local paths; only an explicit download returns a verified local `path`. Results include measured valence/arousal, mood tags, candidate distance, declared license information and usage-risk warnings; the agent chooses the track.

#### Token effect

The mount adds one fixed tool schema. Match results contain at most 20 recommended, 20 withheld and 20 story-conflicting review candidates, with up to eight recent identity-feedback excerpts per candidate; text and history-display budgets have explicit truncation flags, while `history_count` and `config_path` locate the complete unchanged history. Matching uses full records, not their display excerpts. Index failure lists grow with failed files. Python analysis does not call a language model.

#### KV Cache effect

Append-only. Stable schema text preserves the request prefix; calls add tool results without rewriting earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Python runtime, interpreter, model weights and caches are optional local data prepared outside the package by `scripts/runtime.py`; nothing it writes is packed, no upstream wheel hashes are recorded, and clean-machine or redistributable-payload verification remains undone. MERT cannot be treated as commercially licensed by this package's MIT metadata.
- The worker directly owns a local subprocess; subprocess-service integration remains separate lifecycle work. Forced termination can bypass Python temporary-directory cleanup.
- The public catalogue must remain reachable even for cached downloads. The cache has no automatic eviction; no upload credential is accepted or needed.
- Concurrent writers to one index are not coordinated. Use one index writer at a time; malformed JSON or unreadable indexes are currently treated as empty; malformed rights declarations reject matching.
- Feedback context tags remain explicit: the agent maps similar story contexts after reading user feedback. Audio-profile labels are precomputed hypotheses from sampled audio, not plot understanding, verified instrumentation or calibrated suitability. A better distance, model score or accepted track cannot establish dramatic fit, clear rights or dialogue audibility; use the render tool's audible music/no-added-music comparison. Match and download load no analysis model.
- Workspace gates require this package to remain private and omit `publishConfig`. A Desktop packer must resolve workspace dependency ranges and include its runtime dependency closure; public npm publication is disabled.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`scripts/runtime.py` is maintainer tooling and is not packed. `prepare` (Windows x64 only) reads a standalone CPython 3.11.16 base, an already validated CPU environment, the frozen Hugging Face cache, two checkpoints and two hash-pinned wheels, and writes one self-contained tree: the copied interpreter, `Lib/site-packages`, the `Library/bin` DLLs that the MKL and Intel OpenMP distributions record outside site-packages, `models/J_all.ckpt`, `models/data` and `models/hf-cache`. It copies only RECORD-listed resources, takes nothing from the base's own `site-packages` or `Scripts`, refuses venv launchers, bytecode, startup modules and external `.pth` paths, drops the reviewed setuptools `distutils-precedence.pth`, and records that decision plus a SHA-256 for every installed file in `runtime-manifest.json`. The inventory uses `packageSource` for the copied distribution origin.

`verify` re-hashes that inventory before and after a run, probes with `-I -B -X utf8` and requires `sys.prefix`, `sys.base_prefix` and every `sys.path` entry to resolve inside the tree, repeats the probe after renaming the tree, and analyses one real track offline through `worker_main.py`. Because the base interpreter is copied in, no uv-managed installation under `%APPDATA%` is consulted at run time and the source environment is disposable.

Point `pythonExecutable`, `weightsPath` and `dataDir` at the tree's `python\python.exe`, `models\J_all.ckpt` and `models\data`, and set `env.HF_HOME` to `models\hf-cache`. The worker launch allowlist forwards `HF_HOME` and ambient system variables but never `OMP_NUM_THREADS`, `MKL_NUM_THREADS` or `OPENBLAS_NUM_THREADS`, so a deployment that wants pinned BLAS threading must set them in `env`; the validated analysis run used `1` for each.

</details>
