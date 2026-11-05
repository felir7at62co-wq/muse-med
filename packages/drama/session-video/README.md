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

A Host composition mounts this plugin alongside Session queries and projections, filesystem and attachment providers, subprocess execution, sandbox policy, and the authenticated Client connection. The Client consumes the generated `sessionVideo` Remote service.

### Recorded sources and detection

`list` returns recorded video identities, event coordinates, file or provider versions, playback addresses, and availability diagnostics. The inventory accepts explicit user file references and uploaded video attachments, presented videos, supported local generation outputs, and successful Jubian tool results. Assistant prose and arbitrary Client URLs do not introduce video sources. A bounded inventory reports incomplete coverage rather than presenting an omitted suffix as complete.

`detect` takes a Session identity and the source identity and version returned by `list`. Detection refuses stale versions, probes duration and dimensions, then detects visual changes with FFmpeg. A ready result covers the entire original video with ordered, nonempty intervals; a continuous video has one interval. A failed result has no shot intervals and includes a diagnostic. Caller cancellation rejects after the owned subprocess has settled.

Local playback uses a Session-bound authenticated byte-range route. Verified public Jubian URLs can play directly; detection obtains their bytes through the existing restricted Jubian downloader and saves them in the attachment store. Downloads omit credentials, refuse redirects, and obey configured byte and timeout limits. No method accepts an arbitrary source path or URL from the Client.

### Configuration

The plugin accepts no required configuration fields. The owning Host composition supplies its injected services; executable paths and processing limits are deployment configuration.

| Fields | Defaults | Meaning |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | Executables resolved in the configured execution world |
| `sceneThreshold`, `analysisWidth`, `minShotSeconds` | `0.3`, `320`, `0.08` | Visual-change threshold, analysis width, and minimum retained interval separation |
| `maxSources`, `maxResultBytes` | `500`, `4194304` | Inventory and structured tool-result parsing bounds |
| `maxSourceBytes`, `maxDurationSeconds`, `maxSourcePixels` | `536870912`, `3600`, `33177600` | Maximum input bytes, duration, and video-track pixel count |
| `maxShots`, `maxConcurrent`, `maxCachedAnalyses` | `500`, `2`, `128` | Complete interval count, simultaneous detections, and process-local cached results |
| `commandTimeoutMs`, `downloadTimeoutMs`, `graceMs` | `180000`, `60000`, `1000` | Subprocess deadline, download deadline, and process termination grace |
| `maxOutputBytes`, `playbackChunkBytes`, `maxPlaybackStreams` | `8388608`, `262144`, `8` | Captured command output, playback read size, and active playback limit |

The validated schema in [`src/index.ts`](src/index.ts) owns accepted ranges. Raising a source-processing limit does not widen the fixed Jubian download origin allowlist.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A private Session projection retains bounded source coordinates and supported unsettled tool calls. Filesystem hydration supplies current availability and versions without changing Session history. Source identities bind the Session to an exact recorded coordinate; shot identities also bind the source version and interval endpoints. Successful analyses are reused only while the current file version matches the cached version.

The service obtains execution paths through the filesystem provider and uses the Session sandbox policy for subprocesses. It checks file versions again after detection and around playback reads. Plugin disposal cancels operations and streams, joins subprocesses and pending reads, and removes the playback route. The processing helpers return complete results or explicit errors; they do not truncate successful shot lists.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote methods, source resolution, bounded downloads, playback and lifecycle |
| [`src/sources.ts`](src/sources.ts) | Private source projection and recorded-result parsing |
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

The `sessionVideo` service adds no tools, prompts, model requests, or Session messages. Inventory and cut ranges remain Client inspection data. A consumer that submits a user-authored modification draft owns that later model input.

#### Token effect

Zero direct request tokens. Listing, playback, downloads, and FFmpeg detection do not build model input.

#### KV Cache effect

Inspection preserves the existing request prefix. This package neither changes model history nor owns provider cache availability.

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
