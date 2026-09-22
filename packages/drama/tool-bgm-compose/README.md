---
description: "Preview, assemble, and verify short-drama BGM beds from explicit story segments without coupling the composer to emotion-matching models."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bgm-compose

English | [中文](README.zh.md)

## Summary

Turn an agent-approved episode music plan into one measured WAV bed without hand-written FFmpeg commands. `drama_bgm` validates complete story coverage, measures source starts and volume, crossfades the selected tracks, and verifies the fixed output format. It does not choose music or judge whether music fits a scene. Use `bgm_match` separately when emotion-ranked candidates are useful; its m-a-p/MERT-v1-95M backbone is CC-BY-NC-4.0 and restricted to non-commercial use, while the composer does not depend on that model.

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

Mount the plugin after the tool registry and a subprocess provider. The provider resolves and owns every `ffmpeg` and `ffprobe` process.

```yaml
- id: tool-bgm-compose
  name: '@deepseek-ai/dsh-tool-bgm-compose'
```

| Field | Default | Meaning |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | FFmpeg executable or provider-resolvable command |
| `ffprobePath` | `ffprobe` | ffprobe executable or provider-resolvable command |
| `commandTimeoutMs` | `300000` | Maximum duration of one media command |
| `terminationGraceMs` | `5000` | Provider termination grace |
| `outputMaxBytes` | `1048576` | Maximum collected bytes for each process stream |
| `minTracksPerEpisode` | `2` | Distinct tracks every episode must use |
| `maxEpisodesPerTrack` | `2` | Episodes one track may appear in across a batch |
| `freshTracksPerEpisode` | `1` | Tracks each episode must use that no other episode in the batch uses |
| `boundaryToleranceSeconds` | `0.05` | Seconds a cut may sit away from a package boundary |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-bgm-compose) is the exhaustive source for accepted fields.

### Plan and methods

The plan uses `episodes[].segments[]`. Each selected episode declares `body_duration_seconds`, optional `crossfade_seconds`, and contiguous segments with `track`, `source`, `start_seconds`, `end_seconds`, and `reason`. A segment may freeze `source_start_seconds` and `source_sha256`; `valence` and `arousal` preserve optional candidate measurements without invoking `bgm_match`.

| Method | Writes | Result |
|---|---|---|
| `preview` | Nothing permanent | Resolved source hashes, source starts, measured mean volume, applied gains, and the batch episodes the reuse rules were checked against |
| `compose` | A 48 kHz stereo `pcm_s16le` WAV and adjacent `.generation.json` | The preview facts plus probed media facts and output SHA-256 |
| `verify` | Nothing | Probed container and audio facts for an existing WAV; original source tracks are not read and `segments` is empty |

All three methods run the batch gate before anything is opened or written, so a plan that breaks the reuse rules fails without producing a file. The batch is every JSON in the plan's own directory that carries an `episodes` array — how the pipeline lays episodes out (`episodes/segments/<集>.json`) — and `batch_episodes` reports what was checked. A file in that directory that cannot be parsed at all is a failure, because a batch quietly missing one member would let a track exceed its limit unnoticed; a parseable file without an `episodes` array is simply not a plan. The rules are: at least `minTracksPerEpisode` distinct tracks per episode, no track twice inside one episode, no track in more than `maxEpisodesPerTrack` episodes of the batch, at least `freshTracksPerEpisode` tracks that no other batch episode uses, every cut within `boundaryToleranceSeconds` of a package boundary from the timeline, and a non-empty `reason` on every segment. A track is identified by its resolved `source` path; the `track` label is a display name and is never compared, because production plans have carried two labels for one file and one label for two files. The gate cannot run without package boundaries, so a timeline that carries no `clips` is a failure rather than a silently skipped check.

`compose` targets mean volume `-17.5 dB`, caps automatic boost at `+9 dB`, centers each crossfade on the story boundary, fades in for 1.5 seconds, and fades out over the last 2.5 seconds. It stages and probes both artifacts before no-clobber publication; a failed command or validation removes staged files and leaves an existing destination untouched. Pass the returned `output` to `drama_render.bgm` and the same plan to `drama_render.bgm_plan`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plan module owns timing validation and filter-graph algebra. The composer resolves project-owned control and output paths, hashes each selected source, uses an explicit source offset or detects the first audible onset in the 1–5 second window, measures the consumed source window, and compiles one FFmpeg graph. The media module sends argv through `ctx.subprocess`, parses bounded collected output, probes the staged WAV, and publishes the WAV and JSON sidecar as one no-clobber batch.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration and the `drama_bgm` schema |
| [`src/plan.ts`](src/plan.ts) | Segment coverage, overlap durations, gains, and FFmpeg graph construction |
| [`src/compose.ts`](src/compose.ts) | Plan loading, source analysis, method dispatch, staging, and media validation |
| [`src/media.ts`](src/media.ts) | Subprocess adaptation, ffmpeg/ffprobe parsing, and no-clobber publication |
| [`src/types.ts`](src/types.ts) | Type declarations only |
| — | No runtime invariant companion is published because the package retains no state between calls. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bgm-compose) — the exact `drama_bgm` schema and description.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — tool registration and canonical results.
- [Subprocess subsystem reference](../../../docs/subsystems/subprocess.md) — provider-owned command execution and cancellation.
- [Drama package map](../README.md) — adjacent short-drama tools.

-----

<a id="model-experience"></a>
## Model Experience

### The `drama_bgm` tool schema

#### What the model sees

A mounted row contributes `drama_bgm`; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-bgm-compose) owns the complete parameter, result, and description text. The description separates candidate matching, agent selection, deterministic composition, and later `drama_render` use.

#### Token effect

The request gains one fixed tool schema. `preview` and `compose` results grow linearly with the selected episode's segment count because every analyzed segment returns its source identity, timing, measured volume, gain, and selection reason; `verify` returns no segment analysis.

#### KV Cache effect

Append-only. A stable mount keeps the request prefix reusable; changing this package's tool description or schema invalidates that prefix. Each call adds its own tool result and does not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The composer does not listen for story fit** — it executes selected tracks and reasons but cannot certify mood, musical continuity, or creative approval.
- **Onset detection is not beat-grid analysis** — an omitted source offset uses the end of initial silence in the 1–5 second window, starts at one second when that window is already audible, and fails when the entire window stays silent; plans that need a specific downbeat must provide `source_start_seconds`.
- **Sources do not loop** — every source must contain the full consumed window after its selected offset, including crossfade overlap.
- **Volume normalization is window mean, not integrated LUFS** — FFmpeg `volumedetect` supplies the value used for gain; the final limiter remains the episode renderer's responsibility.
- **One episode and local files per call** — control files and outputs must stay inside the project, while selected read-only source tracks may live elsewhere.
- **Published files are immutable to this tool** — an existing WAV or sidecar causes `compose` to fail instead of overwriting it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
