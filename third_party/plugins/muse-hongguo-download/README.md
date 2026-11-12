---
kind: package-reference
description: "Download Hongguo episodes with a pinned GPL engine and Muse session permissions."
---

# Muse Hongguo download

English | [中文](README.zh.md)

## Use

Version 0.2.0 replaces the original Java/Python and licensed-v2 download backends with [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama), pinned at `bb4aec994a1fc6336da55b269481ae2196124e8d`. The plugin retains `hongguo_download_info` and `hongguo_download`; the independent metadata-search plugin remains separate. Source, GPL-3.0 license and original notices are included under `upstream/`.

Creative presets activate the plugin in each Session. `quality` is `1080p` by default; `720p` and `auto` are supported deployment settings. Set absolute `ffmpegExecutable` and `ffprobeExecutable` paths. The Desktop presets use bundled media tools. Downloading does not require the old Java signer, original Python modules, or v2 license service. Shared Python provisioning remains available for the independent Fanqie downloader.

Pass decimal-string `seriesIds`, optional positive `episodes`, and optional `outputDir` to download. The default destination is the Session workspace's `downloads` directory. Read-only Sessions cannot download; workspace-write Sessions stay inside the workspace. Only full-access Sessions may select an external absolute directory. Symlinked destination components are rejected.

The pipeline checks complete ordered catalogs, transfers, decrypted MP4 structure, expected dimensions and duration, requested resolution, full video/audio decoding and SHA256 before publishing a success receipt. Cancellation and failures preserve verified episodes and the recovery journal; repeat the same request to resume. Only a verified complete declared episode list sets `complete: true`. Catalog inspection alone never confirms media availability. Plugin disposal aborts calls and waits for cleanup.

## Model Experience

The model sees directory counts, actual output paths, checksums and safe errors. Media URLs, signatures, anonymous device identities and decryption keys are excluded. Tool results enter the normal Session transcript; observing the catalog does not download media.

## Known Limitations and Deferred Work

ByteVC2 sources are rejected clearly before download because Muse does not bundle that decoder. Sources can change or deny requests; an upstream refusal stops lookup. The integration has not qualified every title, episode, region or platform. Legacy checkpoints are retained but not reused across a different engine identity or quality. The combined plugin is GPL-3.0; corresponding upstream and bundled dependency source accompanies it.
