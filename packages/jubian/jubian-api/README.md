---
description: "Typed Jubian payload readers and request builders for callers that read catalog, asset, video, storyboard, image, subtitle, or upscale data and submit the matching body."
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian-api

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jubian-api` turns Jubian response payloads into validated, typed values and turns caller input into the exact request bodies Jubian accepts. A single import covers catalog and episode reads, asset and material reads, video task and subtask reads, storyboard snapshots, image generation, subtitle erasure, upscaling, and bounded media downloads. It sends no Jubian request itself: `@deepseek-ai/dsh-jubian` owns transport and credentials, and `@deepseek-ai/dsh-tool-jubian` calls these functions. Readers accept the envelope `data` field as `unknown`, and any payload that does not match throws `JubianError` with code `CONTRACT_CHANGED` instead of returning a half-read value.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import the library from any package that already holds a Jubian response envelope. The common path is two calls: send the request once, then hand the envelope's `data` to the reader for that endpoint.

### When to choose it

Choose this library when you read or submit Jubian business data and you do not want to re-derive the provider's wire shape. It is a dependency, not a composition row: it registers no Cordis service, tool, prompt section, or session event, so nothing mounts it and no `cordis.yml` entry exists for it. Reach for it from a plugin or a test that owns the transport itself. Reach for `@deepseek-ai/dsh-tool-jubian` instead when a model should call Jubian through tools.

Every reader takes one argument: the `data` field of a Jubian response envelope, through `JubianResponse.data`. The transport returns that field untouched, and this library is what gives it a type.

### Smallest working call

Read one video generation task behind a transport call:

```ts
import { JubianClient, JubianError } from '@deepseek-ai/dsh-jubian'
import { readTaskPage } from '@deepseek-ai/dsh-jubian-api'

const client = new JubianClient({ credential: resolveToken })
const response = await client.request({ method: 'GET', path: '/admin/aigc/video/task/428322' })

try {
  const task = readTaskPage(response.data)
  console.log(task.task_id, task.status, task.real_cost)
} catch (error) {
  if (error instanceof JubianError && error.code === 'CONTRACT_CHANGED') {
    console.error('Jubian changed the payload shape this reader expects')
  }
}
```

Success is a fully typed value: `task.task_id` is a number, and `task.real_cost` is the provider's own string or `null`. Failure is one `JubianError` whose code is `CONTRACT_CHANGED`, which means the payload did not carry a field the reader requires. The reader never returns a partial value and never substitutes a zero for a missing number. `JubianError` itself belongs to `@deepseek-ai/dsh-jubian`, which owns every failure code.

### Reading a list of results

Page readers return `{ total, rows }`. Read every child result of a generation task and ask whether each one is deliverable at the target resolution:

```ts
import { needsUpscale, readSubtaskPage } from '@deepseek-ai/dsh-jubian-api'

const response = await client.request({ method: 'POST', path: '/admin/aigc/video/task/sub/list',
  body: { aigcVideoTaskId: 428322 } })
const page = readSubtaskPage(response.data)

for (const row of page.rows) {
  console.log(row.subtask_id, row.video_url, row.last_stage, needsUpscale(row, '1080p'))
}
```

`needsUpscale()` compares the row's recorded resolution against the delivery target. It returns `true` below the target, `false` at or above it, and `null` when either label is unrecognised, so you never read a guess as a verdict. Use `row.video_url` as the file to use: after an upscale the provider keeps the generation output in `row.base_video_url` and reports the newest file in `video_url`.

### Building a request body

Builders accept caller input and the live catalogue, and return the body to submit. Build a subtitle erasure:

```ts
import { buildSubtitleEraseRequest } from '@deepseek-ai/dsh-jubian-api'

const body = buildSubtitleEraseRequest('quzimuToB', {
  scriptId: 2708, episodeId: 46734, episodeCount: 1,
  taskName: 'episode-1-erase',
  firstResultId: 979766, parentResultId: 979766,
  videoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/media/v.mp4',
  duration: 13, videoWidth: 720, videoHeight: 1280,
})
```

A builder returns a plain object and sends nothing. Submit it with `client.request()`, and read the task identity back out of the response with `readSubtitleTaskId()`. `buildSubtitleEraseRequest` pins the standard identifiers per model: `26` for `quzimuToB` and `67` for `ark-erase-video-subtitle-pro`, which is the automatic route and takes no rectangle. When a caller omits `subtitleBox`, the regional route derives the rectangle from the frame size instead.

### Downloading media

`downloadMedia()` is the one function in this package that opens a socket. It fetches one bounded payload from a fixed allowlist of media origins and returns the bytes with their digest:

```ts
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'

const media = await downloadMedia(row.video_url!, { kind: 'video', timeoutMs: 60000 })
console.log(media.media_type, media.kind, media.sha256, media.bytes.byteLength)
```

The call rejects a URL outside `MEDIA_ALLOWED_ORIGINS`, a response larger than the ceiling for its kind, a redirect, and a body whose own header bytes do not match the requested `kind`. The bytes come back to you; writing the file is your step.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The library is eight small modules with one shape each: they read a payload the transport already accepted, or they compose a body from values a caller already owns. Nothing here holds state between calls, and nothing here mutates its input.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The public surface: every reader, builder, and constant exported here |
| [`src/catalog.ts`](src/catalog.ts) | Model catalogue rows, screenplay identity, and episode pages |
| [`src/asset.ts`](src/asset.ts) | Asset pages and details, subject materials, one generated image |
| [`src/video.ts`](src/video.ts) | Video tasks, child results, the stage names, the upscale verdict |
| [`src/storyboard.ts`](src/storyboard.ts) | Storyboard snapshots and the two one-field PUT transformations |
| [`src/image.ts`](src/image.ts) | Catalogue selector resolution, the image body, the display price |
| [`src/subtitle.ts`](src/subtitle.ts) | Erasure models and standards, the derived box, the erasure body |
| [`src/upscale.ts`](src/upscale.ts) | The SeedVR2 upscale body and the submitted task identity |
| [`src/download.ts`](src/download.ts) | Bounded media transfer from the allowed origins, header-typed |
| — | No runtime invariant companion is published; pure readers hold no live state, so unit tests pin their algebra. |

### How validation stays compatible

Each reader validates the fields it promises and ignores everything else. A field the provider adds is therefore not an error, and a field the reader needs but the payload omits is. Some readers also accept two observed spellings of the same fact: the asset id arrives as `id` or `assetId`, a result identity arrives as a number or as a numeric string, and a scenario may arrive as one object or as a nested result. `readGeneratedImage()` goes one step further and accepts both forms the same endpoint has answered with: the list the provider sends today, whose rows carry the material as `id` and the file as `assetUrl`, and the single object earlier captures showed, whose fields were `materialId` and `url` or `materialUrl`. An empty list is a failure, not an empty reference.

Where a field is optional in the provider's own data, the reader carries that optionality forward as `null` rather than inventing a default. A cost the provider did not send stays `null`; it never becomes `0`.

### The video stage vocabulary

The provider records each result's stage as a number. `VIDEO_TASK_TYPES` maps `1` to `generate`, `10` to `erase_subtitle`, and `20` to `upscale`, and `20` is the upscale stage. A result also carries the whole recorded history in `versions`, which this library maps to the same stage names. `subtitle_erased` and `upscaled` read that stage and the recorded upscale count, so a caller can tell a raw generation from a processed one without opening the file.

`RESOLUTION_ORDER` lists this provider's ladder from `480p` to `4K`. `resolutionRank()` returns a label's index or `-1` when the label is unrecognised, and `needsUpscale()` returns `null` in that case. A delivery target is a comparison, not a constant, because a generation model can top out below it.

### Where the wire shapes come from

The builder bodies are captured from the product workbench and reproduced field for field: the erasure body with `taskType` 10 and its per-model standard, and the upscale body with `taskType` 20, the SeedVR2 model id, and its two standard identifiers. The image body is different in kind: it resolves `standardId`, `platformId`, and `videoStandardId` from the live catalogue instead of accepting them, because those values are account state and a stale pair produces a request the provider rejects after the caller already believes it succeeded. One model id can be listed once per platform at its own price, so `resolveImageModel()`, `buildImageRequest()` and `readImageDisplayPrice()` all take an `ImageModelSelection` (`platformId`, `standardId`, or both) and fail with every candidate named when that selection does not leave exactly one row.

### What the download module adds

`downloadMedia()` treats the media URL as untrusted input. It parses the URL, rejects a credential or a fragment, and requires the origin to appear in the allowlist it was given. It sends no `Authorization` header, follows no redirect, and aborts after a timeout. The response is read in bounded chunks against the ceiling for the requested kind, and the media type is then decoded from the payload's own header bytes, so a saved file's extension is never a guess.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the transport under these readers or the tool that calls them.

- [Jubian transport source](../jubian/src/index.ts) — the client, the five stable failure codes, credential repair, and the write-path ledger that these readers and builders sit above.
- [Jubian tools package](../tool-jubian/README.md) — the model-facing tools that call these readers and builders.
- [Module graph](../../../docs/module-graph.md) — where these packages sit in the repository dependency order.
- [Adding a package](../../../docs/cookbook/adding-a-package.md#4-write-the-package-readme) — the package contract this README follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or session event; `dsh-tool-jubian` owns every rendered use of these readers and builders.

#### KV Cache effect

No direct invalidation; the tool layer that renders their output owns any request-prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints are current package behavior, not a task backlog.

- **A payload that stops matching rejects the call** — a reader throws `CONTRACT_CHANGED` rather than degrade, and the error carries no field name, so a caller reports a contract change and an operator reads the raw payload to find which field moved.
- **The image selectors are the caller's choice** — `resolveImageModel()` accepts a catalogue only when the selection leaves exactly one `gpt-image-2` row. With several rows and no selection the call fails and the message lists each candidate's `platformId`, `standardId`, unit price and unit; with a selection that matches none it fails the same way. This library has no rule for preferring one platform or the cheaper row.
- **Cost and price fields are evidence, not a settlement** — `real_cost`, `estimated_cost`, `discount_cost`, and `readImageDisplayPrice()` carry what the provider reported, and `readImageDisplayPrice()` always returns `quote_verified: false`; nothing here authorizes spending.
- **The default erasure rectangle is not clamped to the frame** — `defaultSubtitleBox()` reproduces the provider's observed proportions (`zimuTop` 570/1280, height 720/1280, width one pixel inside the frame), so the box can reach past the bottom edge on a 720x1280 source; that shape was captured from an accepted request, not guaranteed by the provider.
- **`needsUpscale()` answers `null` when it cannot know** — an unrecognised resolution label on either side produces `null` instead of a boolean, and a caller must treat that as unanswered rather than as permission to deliver.
- **Media transfer is bounded and single-origin** — `downloadMedia()` accepts only the origins in `MEDIA_ALLOWED_ORIGINS`, caps a body at `MEDIA_LIMITS` (64 MiB for an image, 512 MiB for a video), refuses redirects, and writes nothing to disk.
- **A storyboard body is never composed from scratch** — `readStoryboard()` accepts only `ratio` 9:16, `resolution` 720p, and `genNum` 1, and `withGenerationEnabled()` requires the saved duration to equal the requested content duration plus one second, because the provider derives its own video length from that field. Neither gates on `isGenerate`: the provider stores 1 on every storyboard it holds, generated or not, so the field cannot tell the two apart, and what it acts on is the `isGenerate` a caller writes into a body.
- **No transport behavior is retried or resumed** — this package performs no request of its own except the media download, so every retry, timeout, and polling decision belongs to the caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
