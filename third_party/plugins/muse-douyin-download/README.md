---
description: "Profile layer for authorized Douyin page data and verified, resumable selected-video downloads."
kind: "package-bundle"
---

# Muse Douyin data and download tools

English | [中文](README.zh.md)

## Summary

Active profiles gain selected-work page data, verified downloads and persistent download-task controls. Default downloads wait for their result; background downloads return an accepted task that can be inspected, canceled or explicitly resumed. The owned bundle uses the matching Desktop Host for authorized internal-browser playback and keeps task state in the private Host settings directory. It never accepts Cookie files, signed media addresses or arbitrary output paths.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [owned bundle](../owned-downloads.json) includes [its profile patch](cordis.patch.yml). Adding the archive to a profile inserts this provider; the profile must supply `agents`, `tools`, `subprocess`, `jobs`, a scoped Jobs controller and `sandboxPolicy`. Browser playback additionally needs the matching Desktop transport. Installation alone does not provide that transport.

`douyin_download` accepts a selected official HTTPS video/share `url`, or a checked `urls` list, and writes verified media into the initiating session's `source/media/douyin/` directory. Public requests always ignore saved browser settings. `publicOnly:true` disables the internal-browser fallback. Unsupported public share data can use the same authorized browser fallback as unavailable public media. No browser profile, Cookie file, remembered account or arbitrary output directory is accepted by the tool.

### Persistent downloads

`mode:wait` is the default. It keeps the existing single or batch status/receipt fields and adds `downloadTask:{id,state,jobId}`. `mode:background` returns `status:queued` with that durable task receipt after acceptance; it does not mean the media finished. The durable ID is derived from the real owner Session and logged tool call, so retries of that same call do not start another runner. Native `result.taskId` remains the browser UUID; it is never replaced by the persistent `downloadTask.id`. Every explicit resume starts a new process-local `jobId`.

`douyin_download_task` accepts `action:list` or `status`, `resume`, `cancel` with a persistent `taskId`. Controls require the exact live owner and original canonical workspace; another Session cannot inspect or control the task. Status/list remain offline and available under read-only policy. New downloads and resume resolve the current file policy before network work. Cancel, owner disposal, Jobs cancellation and plugin unload wait for the admitted subprocess/native operation and its final state writes. Background work owns its own controller, so completion or cancellation of the accepting tool call does not stop the accepted task.

Tasks progress through `queued`, `running` and `completed`, or stop as `waiting_user`, `waiting_source`, `interrupted`, `cancelled` or `failed`. Only verified completed items count as completed. Login/verification requires normal user action and explicit resume; source unavailability is separate. Tasks run in admission order, videos in selection order, and a canceled queued task does not release its successor ahead of the preceding task. Progress updates describe individual videos, while Jobs delivers completion or action-needed outcomes without periodic model messages. Foreground callers collect the Jobs settlement themselves.

Resume checks each completed file, SHA-256, size, source receipt and video identity before skipping it. A changed completed receipt stops resume rather than guessing success. A known video ID may reuse an independently reverified file in the same canonical workspace; no foreign Session task metadata is returned. Repeated selections keep input order and disclose `reused`, `reusedSelections` and `uniqueVideos`, so fulfilled selections are not presented as distinct videos. Unresolved short links have unknown video identity and cannot be deduplicated in advance; once resolved, an item cannot change its target ID.

The registry is `settingsHome/plugin-data/muse-douyin-download/tasks/v1/registry.json`, with schema version 1, owner/call acceptance identity, canonical target workspace, official selections, per-item states and verified receipts. Private files use exclusive leases, bounded reads, revision checks, private temporary files and atomic publication. Initializing a registry marks dead-runner tasks interrupted without replaying downloads; it never steals an alive or ambiguous Host lease. Jobs IDs from an older registry instance are cleared. Missing `settingsHome` fails explicitly rather than using temporary storage; missing media executables retain the earlier blocked-runtime result without creating a task.

If media verification succeeds but its registry write fails, wait results return `partial`/`interrupted` plus `verifiedButUnrecordedReceipts`, a registration error and whether the final state was recorded. Background Jobs returns the same concrete file evidence. Those receipts do not become durable completed entries. A process crash between publishing media and registering the item can leave an unregistered file; it requires manual inspection and is never certified from its filename.

### Runtime and configuration

The packaged integration requires Desktop Host protocol 8 and `douyinBrowser.version === 4` for page data and internal-browser acquisition. Versions 2 and 3 are rejected before browser data or download IPC. The version 4 download method requires the explicit fifth `nativeTimeoutMs` argument; application and plugin must be upgraded together. Installing the plugin alone does not add the browser transport. Desktop selects its validated bundled Python automatically, preserves explicit media executables, and discovers existing ffmpeg/ffprobe from the bundled media directory or ordinary PATH without installing packages or changing PATH. Mac installers include architecture-matched media executables; runtime discovery does not install dependencies. Packaged Python scripts and their extractor archive reside outside ASAR so the bundled interpreter can open them. Background playback also requires `supportsBackgroundDownload:true`; its internal sixth argument is `{background:true}`. An older bridge never silently falls back to foreground playback for a background task.

The public runner requires `agents`, `tools`, `subprocess`, `jobs` and `sandboxPolicy`; browser fallback additionally uses the Host-owned transport. Deployment settings remain `pythonExecutable`, `ffprobeExecutable`, `ffmpegExecutable`, `settingsHome`, `requestTimeoutMs`, `timeoutMs`, `nativeTimeoutMs`, `maxDownloadBytes`, `graceMs`, `maxVideos`, `dataTimeoutMs`, and `maxComments`. Runner defaults are 120 seconds, 512 MiB and 20 links; page-data defaults are 30 seconds per link and 20 comments per page. `requestTimeoutMs` also allows delivery of the page result before the outer transport deadline. `maxDownloadBytes` (1 byte to 8 GiB) applies to public acquisition, internal-browser transfer and native-file verification. Internal-browser acquisition allows one active task. Preparation has a separate 120-second deadline; `nativeTimeoutMs` defaults to 30 minutes (integer 1 second to 2 hours) after media selection for the native transfer, then starts a fresh equal budget for complete local verification. Media association has its own 120-second deadline. The Host download IPC allows that association interval, the native budget and another 10 seconds for result delivery. This setting is independent of the public Python `timeoutMs`; tool deadlines include both acquisition paths, verification and transport cleanup. Configurations whose combined batch deadline exceeds the Node timer range are rejected; reduce `maxVideos` or the budgets. Missing verification executables return a blocked result.

Task limits are configurable: `taskMaxTasks` defaults to 1,000, `taskRegistryMaxBytes` to 16 MiB, `taskLockTimeoutMs` to 5,000, `taskLockPollMs` to 25, `taskReceiptMaxBytes` to 256 KiB and `taskOutputMaxBytes` to 64 KiB. They reject exhausted or oversized operations instead of truncating durable evidence. Registry and receipt streams enforce their byte caps while reading; video hashing stops beyond the expected verified size.

### Page data and optional downloads

`douyin_data` accepts either `url` or `urls`, within `maxVideos`, and reads each selected work in order. `source` is `public`, `creator`, or `auto`; every successful result identifies `public-page` or `creator-page` and its observation time. Creator data requires normal login and evidence associating the exact work with that account. A browser login does not grant OAuth API scopes. `auto` uses the public page. `creator` opens the normal Creator content-management page and requires a matching string work ID, its aligned modification permission and the same ID in its statistics. It reads only the selected row; a missing verified own-work association returns `CREATOR_OWNERSHIP_UNVERIFIED`. Complete normal page loading or navigate to older works when needed. Public data does not substitute for unavailable creator data.

The five counters are plays, likes, comments, shares and favorites. Each counter reports an exact number, a rounded display, or `null` with a reason. Public counters come from the exact normal page detail response, its initial data, or the unique visible work action strip; exposed positive play counts are retained; missing values and placeholder zero remain unavailable. `includeComments:true` requests one observed page, bounded by `commentLimit` and `maxComments`; `commentCursor` applies to one selected link only. The total comment count is independent of returned comment items. The Desktop provider returns `COMMENTS_UNAVAILABLE` for comment content and pagination; it preserves observed counters and marks the result partial. The data format supports bounded comment text, comment IDs and numeric counts without account identifiers or credentials.

`download:true` acquires each selected work through the existing downloader, using its validated canonical URL when page data already resolved a share link and includes a separate download result. A failed download preserves available data; unavailable data can accompany a verified download. Batch results are `complete`, `partial` or `blocked`, with each item kept in input order. Cancellation joins the admitted browser read or child process, retains already observed data in the logged cancellation result and prevents the next link from starting. Page reads need no Python or media executables. Data remains in the model-visible, persisted tool result; this tool does not create another statistics file.

`douyin_data.download:true` keeps its existing call-bound acquisition behavior. Use `douyin_download mode:background` when durable task controls are needed.

### Internal playback and results

In wait mode, public access failure opens the official page in the existing isolated Browser panel; the user performs ordinary login, verification and playback. The Host starts the exact video download after the initial main-document navigation finishes, and playback inspection waits for document loading. Background mode uses a dedicated task guest in the same workspace login partition, independent of the selected Session and Renderer sidebar lease. A login requirement stops as `waiting_user`; open the normal Browser to sign in, then resume explicitly. Page-data observation retains its target-bound reload and blocks document replacement. Failed navigation, playback inspection, DNS, staging and native initiation keep distinct blocked codes. Official tabs retain workspace login across restarts; unrelated tabs remain process-local. No external browser databases, credential export, signatures or access-control/CAPTCHA/DRM bypass are used.

Success requires actual nonzero bytes within the bound, ffprobe video/duration/dimension checks, complete ffmpeg decoding and SHA-256. Files selected from detail or player metadata must also match their source duration (within 0.25 seconds) and aspect ratio (within 1%). A source receipt includes the public video page, task/target IDs, bytes, duration, dimensions, identification method, a media hostname and hashed transient URL; it never includes Cookie, Authorization or signed media URLs. Files are published without overwriting existing output. `STAGED` is transport completion only, not the tool's downloaded result. Batches return `complete`, `partial` or `blocked` per verified item.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[The entry](src/index.js) registers data, download and task-control tools. [Tasks](src/tasks.js) own the shared FIFO executor, live-owner checks, Jobs lifecycle and receipt revalidation; [the private store](src/task-store.js) owns the versioned registry and execution leases. [Receipt evidence](src/receipt.js) preserves the Host public identification fields and checks stable equality with source.json, rejecting unknown credential/media-address fields. [The runner](src/runner.js) waits for process exit, bounds output and scrubs sensitive environment entries.

The transport identifies media through `player-exact`, `provider-detail-verified`, or `player-metadata-verified`. `player-exact` pairs target-specific public `_ROUTER_DATA` or bounded player-parent `awemeInfo` properties with the exact visible player's observed successful MP4 source. A player-added `__vid` must equal the string work ID; other URL components and ordered decoded query entries must match the supplied address. Its native transfer retains the unchanged visible source. The current document retains at most 16 successful MP4 media or XHR response addresses and clears them on document replacement.

`provider-detail-verified` uses a page-generated official target detail JSON response, its exact work ID and bounded plain MP4 addresses, with matching visible-player duration. `player-metadata-verified` uses only the nearest player-parent public `awemeInfo`, requiring the exact string work ID and unique duration, dimensions and source facts. Repeated identical records are deduplicated; conflicting nearest records cannot be resolved by an outer recommendation roster. The metadata duration must match the visible player within 0.25 seconds and its aspect ratio within 1%. Metadata acquisition needs neither a prior MP4 response nor a detail response. Both verified branches permit loaded same-origin blob playback, report `currentSrcMatched:false`, and retain the unchanged plain HTTPS MP4 address from their respective source. Their receipts identify either official detail-response facts or `player-parent-awemeInfo` facts; one cannot stand in for the other. Acquisition never rewrites signed URLs, makes an API request, starts playback or changes a paused player.

CDN requests and redirects require public DNS results from the leased browser network context. A native verified transfer requires MP4 MIME and a successful final 200/206 response. Missing associations wait for available detail observation until the existing deadline; unavailable observation, protected media, fragments and ambiguous associations remain blocked. Public player addresses accept strings or `{src}` entries; acquisition requires a unique visible player with loaded media data and no media keys or active protection flags. Observation of 200/206 alone does not indicate a complete download. A one-use Host/owner/Session/task/lease/target authorization enables only the exact native attempt; generic browser downloads remain rejected. Sidebar Session switching or panel closure revokes foreground playback. Background playback survives Session switching with its own task lease; document replacement, invalid navigation, expiry, cancellation and Host disconnect still revoke the attempt and cancel verification.

Run the focused artifact-plane checks after building the declared workspace peers:

```sh
pnpm --dir third_party/plugins/muse-douyin-download run test
pnpm --dir third_party/plugins/muse-douyin-download run check
pnpm --dir third_party/plugins/muse-douyin-download run package -- --out /tmp/muse-douyin-stage5-package
```

[Packaging](scripts/pack.mjs) copies the canonical locked Python extractor into private staging, preserves its unpacked script/runtime layout, and records the Host/protocol/bridge version and every plugin source hash in `SOURCE.json`. Browser acquisition still depends on the matching Host. The [blocked-batch Session replay](../../../snapshots/session/muse-douyin-blocked-batch/snapshot.yml) covers explicit failures through real scoped tools and the agent loop.

</details>

-----

<a id="model-experience"></a>
## Model Experience

The active provider exposes three tools with logged JSON results. Background acceptance reports queued rather than downloaded; task inspection distinguishes completed, source/user waits and interruptions. Jobs progress is observable without periodic prompt injection, and final reports preserve partial receipts and source failures. Page-data output retains its independent field precision and missing reasons.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Ordinary login, authorized playback and available unprotected source media remain prerequisites. This package does not bypass verification or DRM, recover arbitrary unregistered files, download live/fragmented/protected media, or infer missing page counters. Native capability, local offline tests and synthetic media do not establish live Douyin availability; live acceptance needs normal playback and that URL’s actual fully verified file receipt.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers</summary>

Task regressions use real built Jobs/agent peers, isolated Host settings/workspace directories, explicit process-exit barriers and local MP4 fixtures. They prove lifecycle, ownership and receipt handling; production Python/native verification owns complete decoding. Test fixtures do not access live user projects, cookies or browser profiles.

</details>
