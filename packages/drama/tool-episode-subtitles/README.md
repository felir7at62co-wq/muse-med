---
description: "Build per-episode subtitles from measured speech, corrected toward the locked script by the rules shared with Jingliu, without the model writing any text or time."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-episode-subtitles

English | [中文](README.zh.md)

## Summary

`episode_subtitles` turns the approved shots of one or more episodes into an SRT, a version 2 clock receipt and a review list. Text comes from what cloud transcription heard, corrected toward the script with Jingliu's `subtitle_cues` rules; times are always measured word times. The model never writes lines, alignments, receipts or offsets. Calling again with the same arguments resumes the work and redoes only the shots whose audio, script or decisions changed.

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

Desktop mounts the plugin inside its Office composition with the bundled runtime directory and the media executables it gives `jianying_draft`. It needs the tool registry, the Muse account service and a subprocess provider; Jingliu projects also need the optional `jingliuConnection` with local media.

```yaml
- id: tool-episode-subtitles
  name: '@deepseek-ai/dsh-tool-episode-subtitles'
  config:
    pythonPath: /path/to/python-with-pypinyin
```

| Field | Default | Meaning |
|---|---|---|
| `source` | — | Bundled primary runtime directory; Windows uses `media/python/python.exe` beside it |
| `pythonPath` | — | Interpreter with `pypinyin==0.55.0`; overrides `source`. One of the two is required |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | Media executables |
| `packSeconds` | `600` | Longest packed upload, silence included; equal to the transcription chunk so a pack is never split |
| `gapSeconds` | `0.8` | Digital silence after each shot in a pack |
| `maxChars` / `spaceWidth` | `14` / `0.5` | Effective characters per cue; a space counts as `spaceWidth` |
| `jingliuMaxChars` | `20` | Cue width of a Jingliu project's preview, equal to the width Jingliu stores |
| `jingliuJobWaitMs` | `60000` | Longest wait for one Jingliu subtitle job inside a call |
| `maxEpisodes` / `reviewPageSize` | `100` / `20` | Episodes per call and review items per page |
| `rulesTimeoutMs` | `300000` | Deadline of the rules process |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-episode-subtitles) lists every accepted field, including the transcription limits shared with `audio_transcribe`.

### Methods and files

`build` resolves the locked package plan `episode_packages/NN/package.json` and the approved selections `reviews/epNN-pMM.json`, writes the shot manifest `editing/NN-shots.json` that `prepare` and drafts read, and measures durations with the renderer's picture clock. A package without approval, a plan changed after approval, or media changed after approval blocks the episode and names the packages.

Shots without a cached transcript (`transcript/shots/<audio_sha256>.json`) are packed into content-named WAV files under `transcript/packs/` and transcribed through the `audio_transcribe` runner with purpose `subtitles`. A pending pack is only queried or resumed under its receipt; a pack that failed or became uncertain blocks its shots and is never packed again. Words go back to the shot whose range contains their midpoint, and words in a gap or across a boundary become `boundary` review items.

Correction and layout run once per call through the vendored `subtitle_rules/run.py`. Each shot's result is cached in `subtitles/NN.state.json` under a key of its transcript, lines, names, rules digest and its own decisions. The clock is laid out again on every call: a cue past a trimmed shot is clipped or dropped with a `cut_by_trim` item, and a cue faster than the renderer's reading limit becomes `too_fast`. The SRT and its version 2 receipt are published at `editing/NN.srt` only when every shot is terminal; an episode with recognition pending or blocked keeps its previous files.

`review` pages the items in `subtitles/NN.review.json`. With `decisions` it writes `subtitles/NN.decisions.json` and rebuilds the affected episodes without new recognition. Decisions are keyed by item ID, so they survive edits to other shots and stop applying when their own shot changes.

Draft builders read an episode's current approved selection and measured clock with `localEpisodeSelection` from `@deepseek-ai/dsh-tool-episode-subtitles/selection`, which applies the same checks and rewrites the same manifest.

### Jingliu projects

With `source: "jingliu"`, `project` is the Jingliu project ID and every file lives under `<workspace>/jingliu/<project>`. `build` first reads `POST /projects/{pid}/edit-plan` for the enabled shots, their trim windows, speed, spoken lines, names and stored subtitle status; a server without that route answers 404 and every episode is `jingliu_outdated`, so no subtitle job ever reaches a server that would run its own recognition. Each shot's video is downloaded once into the project folder and is also its sound; an episode with an ungenerated shot is `video_missing`, and an unreadable file is `media_unavailable`. Recognition is packed exactly as for a local project.

Corrected words are stored on Jingliu by one `auto_subtitles` segments job per episode, sent through the once-only submission receipts in `subtitles/jobs/` and carrying each shot's audio digest, words, decisions and flags. Jingliu corrects and lays them out with the same rules at its own cue width, replaces only those shots' automatic subtitles, and returns the review items. Their IDs equal the local rules' IDs for the same audio digest and words, so decisions round-trip. A shot is sent again only when its words, lines, decisions or video changed or Jingliu no longer reports it `fresh`; a shot with only hand-added subtitles is never sent. A job that refuses a shot because its video changed leaves the episode `waiting`, and the next build downloads the new video. The preview SRT and receipt (`subtitles/epNN.srt`) place the same rules' cues through the trim window and speed; clipped or fast cues are not review items there, because Jingliu places the stored cues itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration, interpreter resolution and the `episode_subtitles` schema |
| [`src/tool.ts`](src/tool.ts) | Argument checks, the per-root build lock, review paging, decisions and compact results |
| [`src/source.ts`](src/source.ts) | The Jingliu provider: edit plan, media, segments job and review items, and the provider used without a connection |
| [`src/shots.ts`](src/shots.ts) | Local package plan, approved selections, shot manifest, durations, lines and names |
| [`src/hash-cache.ts`](src/hash-cache.ts) | Stat-keyed digests and digest-keyed probe memo in `<root>/.muse-hash-cache.json` |
| [`src/asr-pack.ts`](src/asr-pack.ts) | Pure pack planning, punctuation attachment and midpoint splitting |
| [`src/asr.ts`](src/asr.ts) | Pack manifests, WAV assembly and the runner calls |
| [`src/rules.ts`](src/rules.ts) | The rules digest and the managed Python process |
| [`src/clock.ts`](src/clock.ts) | Window and speed mapping onto the episode clock |
| [`src/build.ts`](src/build.ts) | Per-shot cache keys, clock layout, review items and publication |
| [`src/types.ts`](src/types.ts) | Type declarations only |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-subtitles) — the exact `episode_subtitles` schema and description.
- [`tool-audio-transcribe`](../tool-audio-transcribe/README.md) — receipts, pacing and recovery of every upload.
- [`tool-episode-render`](../tool-episode-render/README.md) — the picture clock, `prepare` and the clock receipt.
- [Drama package map](../README.md) — adjacent short-drama tools.

-----

<a id="model-experience"></a>
## Model Experience

### The `episode_subtitles` tool schema

#### What the model sees

A mounted row contributes `episode_subtitles`; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-episode-subtitles) owns the complete parameter and description text. It takes `method`, `source`, `project`, `episodes`, `wait_seconds`, `decisions` and `offset`. A build result groups episodes by status (`ready`, `waiting`, `needs_review`, `blocked`), lists at most ten shots per entry, reports recognition progress and names the next call. A review page carries at most `reviewPageSize` items with the heard and script text and episode-clock times.

#### Token effect

The request gains one fixed schema. A build result is about 30 bytes per episode and stays under 3 KB for 100 episodes; a review page grows with its items, bounded by the page size.

#### KV Cache effect

Append-only. A stable mount keeps the request prefix reusable; changing the description or schema invalidates it. Each call adds its own result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Packed recognition can carry context across shots** — the silence between shots does not reset the recognizer; how often this changes text has not been measured on real episodes.
- **No re-transcription option** — a shot whose pack failed or became uncertain stays blocked; re-transcribing one shot alone is not offered.
- **Segments without word times keep one cue per segment** — such cues are listed as `long_cue` instead of being split by estimate.
- **An interrupted Jingliu submission stays blocked** — when a segments job was sent but its answer was lost, the episode reports `subtitle_job_unknown` for that payload; it clears only when the words, decisions or video change.
- **Jingliu names come from the edit plan** — the preview uses the names of all requested episodes, while Jingliu corrects with the names of the shots in each job; the review list is always Jingliu's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The rule modules are byte copies of `services/jingliu/backend/app/subtitle_align.py` and `subtitle_cues.py`; `pnpm run verify-subtitle-rules-copy` rejects any difference, and `rules.ts` computes the same digest as `run.py`.

</details>
