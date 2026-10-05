---
kind: upgrade-guide
description: Muse Douyin tool arguments no longer accept external browser profiles or Cookie files.
---

# Muse Douyin internal browser

English | [中文](guide.zh.md)

## Change

The `douyin_download` tool removes `browser`, `browserProfile`, `rememberBrowser` and `cookieFile`. Public requests ignore saved external-browser selection. Authorized internal playback requires Desktop Host protocol 5 and its one-use browser transport; installing the plugin alone is insufficient.

Native receipts distinguish `player-exact` from `provider-detail-verified`. The provider method binds a page-generated successful official detail response to its exact work ID and plain MP4 addresses, reports `currentSrcMatched:false`, and compares local duration and aspect ratio after download. It does not require equality between distinct player/provider transcode URLs. Receipt consumers must preserve this identification method; both methods keep the Host, Session, guest and video binding.

## Migration

1. Apply the accompanying Desktop Host patch and install `muse-douyin-download-0.2.0-dev.native.1.tgz` together together with the Muse application.
2. Remove the four external-browser arguments from tool callers; pass the official `url` or `urls`. Use `publicOnly:true` to disable browser fallback.
3. Ship or resolve ffmpeg/ffprobe and the validated primary runtime. Confirm normal page playback, automatic acquisition and a fully decoded file receipt before declaring live acceptance. Existing external-browser selection files are not read, migrated or deleted.

Official Douyin video tabs retain workspace-scoped login across application restarts. The tool call starts each video without a second permission prompt; first-time login and platform verification require the user. Other browser tabs remain temporary.
