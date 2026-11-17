---
description: "Browse recorded conversation videos, play local or verified Jubian media, and detect visual cut intervals without generating or replacing media."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-video

English | [中文](README.zh.md)

## Summary

Browse videos recorded in a conversation and detect chronological shot intervals in an existing video. Local workspace references, presented files, uploaded video attachments, supported generation results, and successful Jubian media results retain their original conversation coordinates. Cut detection downloads verified Jubian media when necessary and runs local FFmpeg; it makes no model or generation request. Results refer to ranges in the original video and preserve its bytes.

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

A Host composition mounts this plugin alongside Session queries and projections, the tool registry, filesystem and attachment providers, subprocess execution, sandbox policy, and the authenticated Client connection. The Client consumes the generated `sessionVideo` Remote service.

### Recorded sources and detection

`list` returns recorded video identities, event coordinates, file or provider versions, playback addresses, and availability diagnostics. The inventory accepts explicit user file references and uploaded video attachments, presented videos, supported local generation outputs, and successful Jubian tool results. Assistant prose and arbitrary Client URLs do not introduce video sources. A bounded inventory reports incomplete coverage rather than presenting an omitted suffix as complete.

Sources may include `production` coordinates reconstructed from successful recorded Jubian and `muse_production` results: remote project, episode, storyboard, task and subtask IDs, display episode number, video-package index, and authored shot numbers. Direct calls and committed PTC dispatches share this extraction. Unknown or conflicting associations remain absent; filenames never establish episode membership. Authored shot numbers do not identify FFmpeg-detected visual cuts. Metadata limits report incomplete coverage and omit production grouping without removing playable sources. These additions preserve source identities and rebuild incompatible private projection checkpoints; they neither query a provider nor authorize generation.

`detect` takes a Session identity and the source identity and version returned by `list`. Detection refuses stale versions, probes duration and dimensions, then detects visual changes with FFmpeg. When detection first downloads a provider source, the ready result carries the downloaded content's version; refresh `list` before pairing the result with playback. A ready result covers the entire original video with ordered, nonempty intervals; a continuous video has one interval. A failed result has no shot intervals and includes a diagnostic. Caller cancellation rejects after the owned subprocess has settled.

Local playback uses a Session-bound authenticated byte-range route. Verified public Jubian URLs can play directly; detection obtains their bytes through the existing restricted Jubian downloader and saves them in the attachment store. Downloads omit credentials, refuse redirects, and obey configured byte and timeout limits. No method accepts an arbitrary source path or URL from the Client.

`muse_video list` exposes the inventory to the Agent. `bind` records explicit production coordinates and optional observed `shotRanges` for an already recorded source version after checking its SHA-256, video duration and existing evidence-file identities. Evidence semantics remain the caller's responsibility: planned durations and cut order do not establish authored-shot timing. Bindings survive Session replay, including retained tool metadata, and disappear from the inventory when the video version changes. Present and bind an edited preview separately to retain both versions in the same episode.

`muse_video review` returns sampled images from a bounded source-local interval without starting a complete-episode task. The latest user selection restricts its source, version and interval; runtime context does not replace that selection. The Review action records a read-only intent that permits only video listing/review and tool-discovery operations; shell scripts, other images and media mutations are rejected. Complete-review and contact-sheet tools remain outside selected-interval inspection. A new user message without that intent restores ordinary tool access; its video references define the next interval scope. A message without video references clears that scope. Samples support advice about visible frames, not continuous viewing or audio judgments. Seeks with no frame before the exclusive end are reported in `unavailable_seconds`; an interval with no decodable frame fails visibly. Original media remains unchanged; extracted images use the attachment store.

### Configuration

The plugin accepts no required configuration fields. The owning Host composition supplies its injected services; executable paths and processing limits are deployment configuration.

| Fields | Defaults | Meaning |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | Executables resolved in the configured execution world |
| `sceneThreshold`, `analysisWidth`, `minShotSeconds` | `0.3`, `320`, `0.08` | Visual-change threshold, analysis width, and minimum retained interval separation |
| `maxSources`, `maxResultBytes` | `500`, `4194304` | Inventory and structured tool-result parsing bounds |
| `maxSourceBytes`, `maxDurationSeconds`, `maxSourcePixels` | `536870912`, `3600`, `33177600` | Maximum input bytes, duration, and video-track pixel count |
| `maxShots`, `maxConcurrent`, `maxCachedAnalyses` | `500`, `2`, `128` | Complete interval count, simultaneous media operations, and process-local cached results |
| `commandTimeoutMs`, `downloadTimeoutMs`, `graceMs` | `180000`, `60000`, `1000` | Subprocess deadline, download deadline, and process termination grace |
| `maxOutputBytes`, `playbackChunkBytes`, `maxPlaybackStreams` | `8388608`, `262144`, `8` | Captured command output, playback read size, and active playback limit |
| `reviewFrames`, `maxReviewSeconds`, `reviewFrameDimension` | `6`, `60`, `960` | Sample count, interval duration limit and largest review-frame dimension |

The validated schema in [`src/index.ts`](src/index.ts) owns accepted ranges. Raising a source-processing limit does not widen the fixed Jubian download origin allowlist.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A private Session projection retains bounded source coordinates and supported unsettled tool calls. Display labels come from the recorded local path, attachment name, or provider URL without its query. Filesystem hydration supplies current availability and versions without changing Session history. Source identities bind the Session to an exact recorded coordinate; shot identities also bind the source version and interval endpoints. Successful analyses are reused only while the current file version matches the cached version. Analysis and download caches evict their oldest inserted entries when they exceed the configured limit.

The service obtains execution paths through the filesystem provider. Probe and scene-analysis subprocesses read video bytes and write only to stdout or null; a confined Session's policy is narrowed to read-only, while `danger-full-access` remains unchanged. Analysis acquires no workspace write grants and creates no media. It checks file versions again after detection and around playback reads. Plugin disposal cancels operations and streams, joins subprocesses and pending reads, and removes the playback route. The processing helpers return complete results or explicit errors; they do not truncate successful shot lists.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote methods, source resolution, bounded downloads, playback and lifecycle |
| [`src/sources.ts`](src/sources.ts) | Private source projection and recorded-result parsing |
| [`src/production.ts`](src/production.ts) | Recorded production associations and unambiguous source grouping |
| [`src/media.ts`](src/media.ts) | Subprocess ownership, validated video facts and complete cut ranges |
| [`src/types.ts`](src/types.ts) | Client-visible inventory, source and interval types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The related packages own source storage, execution, and provider-download rules.

- [Session projections](../../session/session-projection/README.md) — derived Session state.
- [Attachments](../../attachment/attachment/README.md) — binary source storage.
- [Jubian API](../../jubian/jubian-api/README.md) — restricted media downloads.
- [Subprocess execution](../../subprocess/subprocess/README.md) — cancellation and process settlement.

-----

<a id="model-experience"></a>
## Model Experience

### Video inspection in the Client

#### What the model sees

The `muse_video` tool exposes list, binding and bounded review operations. Results retain source versions, explicit production coordinates and sampled images in ordinary tool history. Inventory, playback and cut detection remain Client inspection data; they do not request a model turn.

#### Token effect

Tool schemas and results consume request tokens; review images consume image input tokens. Client listing, playback, downloads and FFmpeg detection do not build model input.

#### KV Cache effect

Tool calls append normal history; review images can increase the request suffix. Client-only inspection preserves the request prefix. Provider cache availability remains provider-owned.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to video discovery and cut interpretation.

- **Visual cuts only** — detected intervals do not identify story scenes, characters, dialogue, or dramatic continuity; fades and gradual transitions can remain within one interval.
- **Original-video ranges** — detection creates no separate clip files, thumbnails, edits, or replacement generations. The Client can capture preview frames from the playback source.
- **Supported recorded sources only** — arbitrary assistant links and unrecognized tool results are omitted. Missing or inaccessible recorded files remain visible with diagnostics; unsupported Jubian origins cannot be downloaded.
- **Process-local analysis cache** — a Host restart discards analysis and downloaded-source lookup entries. Saved content-addressed attachment bytes follow the attachment store's lifecycle.
- **Executable and codec availability** — FFmpeg, FFprobe, filesystem access, and compatible decoders must exist in the configured execution world. Limits, unsupported inputs, and confinement failures return diagnostics without invented shots.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
