---
kind: package-reference
description: "Download Hongguo episodes with a pinned GPL engine and Muse session permissions."
---

# Muse Hongguo download

English | [中文](README.zh.md)

## Use

Version 0.2.0 replaces the original Java/Python and licensed-v2 download backends with [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama), pinned at `bb4aec994a1fc6336da55b269481ae2196124e8d`. The plugin retains `hongguo_download_info` and `hongguo_download`; the independent metadata-search plugin remains separate. Source, GPL-3.0 license and original notices are included under `upstream/`.

Creative presets activate the plugin in each Session. `quality` is `1080p` by default; `720p` and `auto` are supported deployment settings. Set absolute `ffmpegExecutable`, `ffprobeExecutable` and `bytevc2Executable` paths. The ByteVC2 component converts these sources to H.264/AAC without changing resolution; `bytevc2Concurrency` bounds simultaneous conversions (default 1), and `bytevc2Threads` bounds decoder and encoder threads (default 2). ByteVC2 decryption keys stay in a worker thread rather than process arguments. `decryptionConcurrency` defaults to 1, `maxDecryptionBytes` to 256 MiB, and `decryptionWorkerHeapMb` to 128. The Desktop presets use bundled media tools. Downloading does not require the old Java signer, original Python modules, or v2 license service. Shared Python provisioning remains available for the independent Fanqie downloader.

Pass decimal-string `seriesIds`, optional positive `episodes`, optional `quality` (`1080p`, `720p`, `auto`), and optional `outputDir` to download. Each request freezes its selected quality; concurrent requests and retries do not change another request's source. Omitting `quality` uses the deployment setting for the open engine. Public-player and authorized-manifest requests instead default to `auto`, preserving their existing source-file behavior. Fixed qualities require at least that many pixels on the shorter edge and never silently downgrade; larger sources retain their dimensions. `auto` delegates compatibility-first selection to the upstream engine.

The default destination is the Session workspace's `downloads` directory. Read-only Sessions cannot download; workspace-write Sessions stay inside the workspace. Only full-access Sessions may select an external absolute directory. Symlinked destination components are rejected.

The pipeline checks complete ordered catalogs, transfers, decrypted MP4 structure, expected dimensions and duration, requested resolution, full video/audio decoding and SHA256 before publishing a success receipt. Cancellation and failures preserve verified episodes and the recovery journal; repeat the same request to resume. Only a verified complete declared episode list sets `complete: true`. Catalog inspection alone never confirms media availability. Plugin disposal aborts calls and waits for cleanup.

## Download tasks

Pass `mode: background` to `hongguo_download` for a Session-owned background job; the default `wait` retains foreground cancellation. `hongguo_download_task` lists and inspects tasks, pauses, resumes, cancels, retries, or removes ended records. Pause and cancel require the exact `expectedRunId` from status; only an `acknowledged` control confirms that cleanup and final state publication finished. A pending request is not confirmation.

The current workspace keeps private records under `.muse-downloads/hongguo`, configurable through `taskDirectory`. Tasks freeze the original Session or CLI owner, canonical workspace, output directory, quality and source identity. Explicit resume rechecks current write permissions and verified checkpoints. Restart never replays requests; unknown process cleanup remains blocked. Removing a record preserves media and checkpoints. Task completion for a selected subset does not claim full-series completion.

Use the [CLI profile](CLI.md) for local commands without a model or a shared Desktop account. CLI foreground operations use the same task library; an explicitly selected existing Session owner is limited to that workspace.

## Model Experience

If process exit cannot be confirmed, `cleanup_unconfirmed` retains private staging and a durable process lease. Restarted downloads refuse that lease until its process and files have been inspected. Existing destination files are never overwritten.

The model sees directory counts, actual output paths, checksums and safe errors. Download receipts distinguish `requestedQuality` from each episode's measured `width`, `height`, `quality` and `videoCodec`. Older verified files without those measurements report `null`; the requested quality never supplies invented dimensions. Only matching source and quality identities permit reuse. Media URLs, signatures, anonymous device identities and decryption keys are excluded. Tool results enter the normal Session transcript; observing the catalog does not download media.

## Known Limitations and Deferred Work

ByteVC2 requires the bundled Librempeg decoder; missing or incompatible components stop the operation. Converted files pass the same full-decoding and checksum checks as ordinary downloads; original transfer checksums remain separate. Sources can change or deny requests; an upstream refusal stops lookup. The integration has not qualified every title, episode, region or platform. Legacy checkpoints are retained but not reused across a different engine identity or quality. The combined plugin is GPL-3.0; corresponding upstream and bundled dependency source accompanies it.
