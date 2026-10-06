---
kind: upgrade-guide
description: Muse Douyin tool arguments no longer accept external browser profiles or Cookie files.
---

# Muse Douyin internal browser

English | [中文](guide.zh.md)

## Change

The `douyin_download` tool removes `browser`, `browserProfile`, `rememberBrowser` and `cookieFile`. Public requests ignore saved external-browser selection. Authorized internal playback requires Desktop Host protocol 5 and browser acquisition version 2; installing the plugin alone is insufficient. Mismatched acquisition versions return `DESKTOP_HOST_REQUIRED` before starting a native request.

Native receipts distinguish `player-exact` from `provider-detail-verified`. The provider method binds a page-generated successful official detail response to its exact work ID and plain MP4 addresses, reports `currentSrcMatched:false`, and compares local duration and aspect ratio after download. It does not require equality between distinct player/provider transcode URLs. Receipt consumers must preserve this identification method; both methods keep the Host, Session, guest and video binding.

## Migration

1. Install the accompanying Muse application and its bundled `muse-douyin-download` together. For custom Host integration, update the browser acquisition to version 2 and forward the validated `maxDownloadBytes` through preparation, download and file verification.
2. Remove the four external-browser arguments from tool callers; pass the official `url` or `urls`. Use `publicOnly:true` to disable browser fallback.
3. Ship or resolve ffmpeg/ffprobe and the validated primary runtime. Confirm normal page playback, automatic acquisition and a fully decoded file receipt before declaring live acceptance. Existing external-browser selection files are not read, migrated or deleted.

`maxDownloadBytes` defaults to 512 MiB and accepts 1 byte to 8 GiB. The same setting applies to public requests and internal-browser files.

Official Douyin video tabs retain workspace-scoped login across application restarts. The tool call starts each video without a second permission prompt; first-time login and platform verification require the user. Other browser tabs remain temporary.
