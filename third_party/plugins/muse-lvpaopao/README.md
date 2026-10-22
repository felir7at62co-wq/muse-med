---
description: "Search Lvpaopao titles and resume catalog-based episode downloads in qualified local WeChat runtimes."
kind: "package-bundle"
---

# muse-lvpaopao

English | [中文](README.zh.md)

## Summary

Muse's director Agent can find a Lvpaopao drama by title, read its actual episode catalog and save each account-playable episode in a resumable local task. This experimental source is development-only and excluded from Desktop release inputs and default compositions; its standalone bundle adds only the connection provider. Local setup prepares a private helper from owned resources, while an explicit SSH configuration retains the legacy remote path. Windows and a separately prepared isolated Mac copy have each passed native 36-episode download acceptance; the Mac public tool also reconciles and delivers those files without new acquisitions.

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

Development builds must explicitly mount `muse-lvpaopao/bridge` globally and the package root inside their intended Agent. The standalone [bundle patch](cordis.patch.yml) inserts only the provider, without a global tool. The consumer requires Tools, Agents, subprocess and the shared provider. The release inventory does not build or install this package.

```yaml
- insert:
    - id: muse-lvpaopao-bridge
      name: muse-lvpaopao/bridge
```

Mount the consumer in its intended Agent composition without connection credentials:

```yaml
- id: muse-lvpaopao
  name: muse-lvpaopao
```

### Local setup and explicit connections

Without an explicit connection file, `autoSetup:true` starts local preparation on the first native request. The Host-selected Python must have the pinned dependencies in the [Windows requirements file](native/requirements-windows-25560.lock) or [Mac arm64 requirements file](native/requirements-macos-arm64-269602.lock), and FFmpeg/FFprobe must be available through Host media paths or executable lookup. The bootstrap verifies the supported WeChat runtime and current process identity, copies owned helper sources into `<Muse home>/lvpaopao/runtime`, and seals their import manifest and local process attestation. It does not install WeChat, obtain credentials or log in for the user. On Mac, it requires the separately prepared isolated WeChat copy and its private home; it never creates, re-signs or launches that copy or modifies ordinary WeChat. Open Lvpaopao in the qualified logged-in WeChat; reopen it when status reports `waiting-target`.

Mac preparation immediately reports `mac-isolated-wechat-required` when the qualified copy is absent, rather than waiting for a generic timeout. Unsupported builds and invalid private homes have separate fixed errors. Correct the runtime and explicitly call `status` once; failed queries do not replay setup. An accepted `status-returned` includes `ready:true`; `hostLoginState` is auxiliary mini-program state, not desktop login or a query prerequisite.

The provider first reads `<Muse home>/lvpaopao/connection.json`. An existing valid file takes precedence over automatic setup. A local connection uses `transport:local`, absolute `localPython`/`localHelper` paths, `cwd` and the exact `helperSha256`; a legacy SSH connection uses `transport:ssh`, `sshHostAlias`, absolute Windows `remotePython`/`remoteHelper` paths, `cwd` and the digest. Existing explicit files that omit `transport` retain the legacy `ssh` default. Automatic preparation never falls back to SSH. Restart or recompose the provider after changing this private file; malformed existing settings fail activation. Do not place credentials, process attestation or playback addresses in profiles, source or model arguments.

| Provider configuration | Default | Meaning |
| --- | --- | --- |
| `connectionFile` | Muse home `lvpaopao/connection.json` | Owner-private transport settings; no model-controlled path. |
| `maxQueuedRequests` | `8` | Shared waiting requests, excluding the active request. |
| `autoSetup` | `true` | Prepare the qualified local helper when the connection file is absent. |
| `pythonExecutable` | `MUSE_LVPAOPAO_PYTHON_PATH`, then `MUSE_DOUYIN_PYTHON_PATH`, then empty | Host-selected Python; missing preparation requirements return `setup-required`. |
| `resourcesDirectory` | Package `native/` directory | Owned helper resources used for local preparation. |
| `setupTimeoutMs` | `120000` | Preparation and target-readiness wait, up to `600000` ms. |
| `setupShutdownTimeoutMs` | `10000` | Setup process cleanup wait, up to `60000` ms. |
| `helperLifetimeMs` | `3600000` | Managed connection lifetime: one hour by default, at most four hours (`14400000` ms), including target waiting. |
| `helperMaxCallbacks` | `4096` | Maximum verified callbacks per connection, up to `16384`. |

| Consumer configuration | Default | Meaning |
| --- | --- | --- |
| `maxQueryChars` | `80` | Maximum Unicode code points in a title query. |
| `maxEpisodeCount` | `20` | Maximum requested directory page width. |
| `maxResultItems` | `50` | Maximum search candidates retained in a result. |
| `maxSeriesEpisodes` | `400` | Maximum declared series size, configurable up to `10000`. |
| `maxAttempts` | `3` | Maximum attempts per episode during one start/resume call. |
| `retryDelayMs` | `1000` | Delay between failures classified as safe to retry. |
| `seriesLockWaitMs` | `5000` | Wait for the private task lock before reporting contention. |
| `copyChunkBytes` | `1048576` | Chunk size for verified local file copies. |

### Read rankings

Call `rankings` without pagination fields to read the first reputation-board page. The result contains the service's board labels, source positions, drama titles and source IDs, plus `total` and `hasMore`. Choose other `boardType` values from the returned `boards`; keep `count` and the returned `coldStartTime` when advancing zero-based `pageIndex`. Invalid rows remain gaps with `partial:true`, rather than shifting later ranks. Rankings are live service responses, so their contents can change between calls. Select a returned source identity for details or series download.

### Download and resume a series

Ask the director Agent to download a named drama, or call `download_series` with `query`. A single normalized exact title match selects the source only when search is complete. Otherwise the tool returns candidates with `selection-required`; select `srcAppId` and `originDramaId`, then pass them as `srcAppId` and `dramaId`. Media acquisition does not start while selection is unresolved. The tool reads details and pages the directory, preserves actual returned episode numbers, and reports missing or partial coverage instead of inventing episodes.

Downloads require `downloadEnabled:true` in the resolved transport and the actual requesting Session's file permission. Automatic setup supplies this transport flag; explicit connections must configure it. The default destination is `downloads/lvpaopao` inside that Session's workspace. Relative `outputDir` values stay within the workspace; external destinations require full file access. The transport's destination never overrides the Session, and permission checks precede native catalog or media requests.

The saved task directory contains `manifest.json`, per-episode files and their receipts. Call `download_series` again with the same selected source and destination to resume. Completed files are rechecked before reuse. Each episode retains its original durable request key across retries, cancellation and scope replacement. A temporarily missing directory entry preserves its saved request key and state; incomplete catalog coverage keeps the series incomplete. Known transfer failures retry within `maxAttempts`; unknown acquisition outcomes require `download_status` with that same key before another attempt. The downloader resumes a partial transfer only with a verified prefix and a matching HTTP range validator; it does not append bytes from a changed resource.

Use `series_status` with the selected source IDs and the same destination to read saved progress and verify completed files without starting the helper or making native requests. Results distinguish completed, pending, in-progress, failed, denied, unknown and missing episodes. A series is complete only when its catalog covers every episode and every saved file passes verification. A cancelled tool call can return the outer runtime's abort result; read `series_status` afterward for the saved progress. Neither a directory response nor one successful episode establishes complete-series delivery.

`status`, `search`, `detail` and `episodes` remain available for inspection. `download_episode` and `download_status` accept an actual episode number and its original 64-character lowercase hexadecimal key. The local `download_first_episode` compatibility entry uses the same episode/download-status path and a stable first-episode key; it does not use SCP. Download drama IDs use the 64-character letter/digit/underscore/hyphen form, while `detail` and `episodes` retain their broader opaque ID validation. A returned file path does not automatically present a video or send a chat attachment.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Connection ownership and durable tasks</summary>

The [provider](src/bridge.ts) owns one lazy local or explicit SSH connection and serializes native requests shared by Agents. Agent disposal settles its owned requests and copies without disposing the Host provider. Confirmed cancellation preserves a live transport. A `target-not-ready` result or `transfer-failed` after confirmed worker cleanup also preserves a healthy connection; terminal failures or unconfirmed cleanup retire that generation. After confirmed cleanup, an explicit `status` may recover it. The provider does not replay failed business requests automatically.

The [series engine](src/series.ts) locks each source/destination task and saves episode state before acquisition. The [episode copy](src/episode-download.ts) checks source identity, original key, playable-episode authorization, decoded-file metadata and exact local bytes before publishing a receipt. Local copies and native transfers retain validated partial state for resumption. The [catalog resolver](src/catalog.ts) controls title selection and actual directory coverage; the tool projection exposes bounded metadata instead of signed playback addresses or arbitrary helper errors.

Helper cleanup requires disposal, script unload, detach, server closure and managed process exit. Mac download receipts use the current user’s Keychain with authenticated ECIES encryption; Windows retains DPAPI. Mac HTTPS uses system roots with hostname and certificate verification enabled. Temporary target-object changes may persist until those objects are destroyed or the target restarts; unloading a hook does not promise full rollback. The [bootstrap](native/boot.py) verifies the exact supported runtime rather than accepting other versions by name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The [plugin build overview](../README.md) describes Desktop package delivery. [Provider settings](src/bridge.ts) and [transport settings](src/config.ts) own their accepted configuration fields. The [native resource manifest](scripts/native-resources.mjs) identifies owned files staged for packaging.

-----

<a id="model-experience"></a>
## Model Experience

### Scoped tool

#### What the model sees

The director Agent sees one `lvpaopao` declaration for catalog inspection, title-based whole-series download, per-episode reconciliation and saved progress. Results contain bounded readiness, candidate identities, actual episode coverage, durable task paths and verified local-file metadata. Missing setup and incomplete downloads remain explicit results. Neither the provider nor the consumer adds a system-prompt section.

#### Token effect

The consumer contributes one tool declaration. Each call appends its bounded canonical result through normal logged tool history; the full per-episode manifest stays on disk instead of entering every result.

#### KV Cache effect

Results append to the conversation. Mounting or changing the consumer schema can change subsequent tool declarations; this package does not guarantee provider cache reuse.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The current verification and deployment limits remain explicit:

- Live qualification on Windows x64 WeChat 4.1.15.56 / WMPF 25799 covers local helper preparation, title search, complete catalog, rankings with source-detail readback, 36 episode downloads and whole-series tool delivery, full decode/hash checks, original-key recovery and a real 1 MiB interrupted transfer resumed from the same saved address. Qualification uses a prepared test environment; it does not establish fresh-install acceptance.
- Mac arm64 WeChat 4.1.13 / 269602 acceptance uses an exact-hash isolated copy with a private home. Search, full catalog, rankings, all 36 native episode downloads, complete decode/hash checks and 1 MiB interruption/resumption passed. A real Session and shared plugin connection reconciled all original keys, delivered the series and reused it with zero new acquisitions. Ordinary signed Mac WeChat, fresh installation, other builds and continued native business after active cancellation remain unqualified.
- Downloads require account-playable episodes. The plugin does not purchase episodes, watch ads or unlock access. Denied or unresolved episodes keep the series incomplete. Technical access does not grant content reuse rights.
- The package manifest includes owned native sources and a pinned dependency file for staged resource delivery; it excludes WeChat binaries, extracted target source, credentials, private attestation and media. This revision has not been packaged or released, and installed-resource delivery has not been accepted. Available Python dependencies, media tools, a genuine supported runtime and user login remain preparation requirements.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
