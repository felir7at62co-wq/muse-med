---
kind: upgrade-guide
description: Muse Douyin browser acquisition requires version 4 and an explicit native timeout budget.
---

# Muse Douyin internal browser

English | [中文](guide.zh.md)

## Change

The `douyin_download` tool removes `browser`, `browserProfile`, `rememberBrowser` and `cookieFile`. Public requests ignore saved external-browser selection. Authorized internal playback requires matching Desktop Main and Host protocol 6 and browser acquisition version 4; installing the plugin alone is insufficient. Mismatched acquisition versions return `DESKTOP_HOST_REQUIRED` before starting a native request.

Native receipts distinguish `player-exact`, `provider-detail-verified`, and `player-metadata-verified`. The provider method binds a page-generated successful official detail response to its exact work ID and plain MP4 addresses, reports `currentSrcMatched:false`, and compares local duration and aspect ratio after download. It does not require equality between distinct player/provider transcode URLs. Receipt consumers must preserve this identification method; all methods keep the Host, Session, guest and video binding. Player metadata retains its independent player-parent source label without claiming a detail response.

The Host ready message includes `hostProtocolVersion:6`; mismatched or absent versions refuse startup. Browser acquisition version 4 provides `data(agent, selection, signal)` and requires `download(agent, url, signal, maxDownloadBytes, nativeTimeoutMs)`. The bundled plugin refuses versions 2 and 3 for both methods; mixed application/plugin versions are unsupported. `douyin_data` returns exact-work public counters, separate comment-query status, and optional verified download. Missing public play counts and placeholder zero values are unavailable. Normal Creator-page access reads the selected own-work list row only when its string ID, modification permission and statistics ID match. Missing ownership reports `CREATOR_OWNERSHIP_UNVERIFIED`; normal login does not claim official OAuth authorization.

## Migration

1. Install the accompanying Muse application and its bundled `muse-douyin-download` together. For custom Host integration, update Main and Host together to protocol 6 and browser acquisition to version 4. Pass both validated `maxDownloadBytes` and `nativeTimeoutMs` through preparation, download and file verification.
2. Remove the four external-browser arguments from tool callers; pass the official `url` or `urls`. Use `publicOnly:true` to disable browser fallback.
3. Ship or resolve ffmpeg/ffprobe and the validated primary runtime. Confirm normal page playback, automatic acquisition and a fully decoded file receipt before declaring live acceptance. Existing external-browser selection files are not read, migrated or deleted.

`maxDownloadBytes` defaults to 512 MiB and accepts 1 byte to 8 GiB. The same setting applies to public requests and internal-browser files. `nativeTimeoutMs` defaults to 1800000 milliseconds and accepts integers from 1000 to 7200000. Native transfer and complete local verification each receive that independent budget; preparation and media association each retain a separate 120-second deadline. The transfer budget starts after media selection; Host download IPC also allows the association interval and 10 seconds for delivery. Public Python `timeoutMs` remains independent. Lower `maxVideos` or the budgets if the combined batch deadline exceeds the Node timer range.

Official Douyin video tabs retain workspace-scoped login across application restarts. The tool call starts each video without a second permission prompt; first-time login and platform verification require the user. Other browser tabs remain temporary.
