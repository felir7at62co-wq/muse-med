---
kind: package-reference
description: User authorization and authenticated requests to a Jingliu production service.
---

# Jingliu account connection

English | [中文](README.zh.md)

## Summary

The Host authenticates the mounted production API and media requests with the signed-in Muse account. A cloud project selection is stored per local conversation and studio identity. The right sidebar and production tools read that same selection. Dedicated studio origins support the original sign-in exchange.

Catalog entries include descriptions, media paths and reference-only status.

The desktop Host connects to the configured ShotFlow production gateway under `/fwp/v2`. Set `studioOrigin` to the HTTPS origin or to an explicit IPv4/IPv6 loopback origin. The original web workspace is served from `/sfp/`. API requests do not follow redirects; media reads follow one only to a configured storage host, as described in [Media](#media). An absent origin leaves the plugin unconfigured.

## Table of Contents

- [Sign in](#sign-in)
- [Host API](#host-api)
- [Media](#media)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Sign in

Sign in through Muse account settings. Chat tools automatically exchange a short-lived, Jingliu-specific Muse grant for a tool connection at the configured studio. The Muse account cookie stays with its issuing gateway. `/jingliu-login` checks the current connection. `/jingliu-logout` closes the current tool connection. Calling a tool again reconnects under the active Muse login.

For isolated loopback previews, configure `localPreviewToken: true` and supply the test session in the Host environment as `MUSE_JINGLIU_SESSION_TOKEN`. This mode accepts only literal loopback origins and reads no saved account. An authenticated request to `/auth/me` establishes the account before a tool selects its project.

## Host API

Host plugins call `ctx.jingliuConnection.connection()` for a verified `JingliuSession`. Its `identity` identifies the Jingliu user and server for submission receipts. The Host also verifies the current Muse login before dispatch and before returning the response. Its `request(path, options)` accepts supported routes relative to the V2 API and returns parsed JSON. Workflow tools choose which results to present. Sign-in, account-change checks and bounded JSON requests come from the shared [workbench connection](../workbench-connection/README.md) core.

The client Remote also reads the workbench data as the signed-in user, read-only: `projectConfig`, `episodeList`, `episodeShots`, `shotMedia` and `projectAssets` run the studio's read workflows (`get_project`; `list_episodes`; `list_shots` with `read_shots`; `get_shot` with `list_versions`; `list_assets` with `list_audio_clips`). `thumbnail` and `localVideo` read media as described in [Media](#media); `video` streams one studio video for a Host without local media, up to 64 MiB: its content type first, then base64 chunks. Results keep only paths under the studio's media mount, so the client never receives the studio credential or another address. Four calls serve the workbench's forms: `catalog` reads the modes with their art styles, frame ratios, resolutions and models the studio offers; `createProject` creates a production after checking every value against that catalog; `renameProject` renames one and verifies the stored name; `deleteShot` deletes one shot, which the studio does not keep.

## Media

A stored address `/fw/media/<dir>/<name>` is the permanent ID of a studio file. The Host asks `POST /v2/media/resolve` for up to 200 addresses at a time and reads each file from the presigned object-storage link it returns, without the Muse cookie, the studio token or any other credential. A file the studio still keeps (`local: true`), and every file on a studio that answers the resolve route with 404, is read through the Host session as before. A redirect from `/fwp/media/...` is followed only to a host listed in `mediaHosts`, also without credentials; any other target fails with `JINGLIU_MEDIA_REDIRECT_REFUSED`, and a resolve link outside `mediaHosts` fails with `JINGLIU_MEDIA_HOST_REFUSED`. Media failures carry their own codes, `JINGLIU_MEDIA_NOT_FOUND`, `JINGLIU_MEDIA_UNAVAILABLE` and `JINGLIU_MEDIA_INTEGRITY`, instead of a Muse login failure. Clients never receive a storage link or a storage key.

With `localMedia: true`, which only the desktop Host sets, files are downloaded into local folders: thumbnails into `jingliu/media/<account>` in the Host home, and videos and tool downloads into `<workspace>/jingliu/<project>/<dir>/<name>`. Each folder keeps an index, `.muse-media.json`, of address, size and ETag, so a file listed there with its size is used again without a download. Downloads check the size, and the MD5 when the ETag is a single-part MD5; they resume an interrupted `.part` file with a byte range, run at most `mediaDownloads` at a time and stop after `mediaTimeoutMs`. Files a tool or Jianying draft uses are kept; other files a folder holds beyond `mediaCacheBytes` are removed, least recently used first. Thumbnails reach the client through the Host's `/api/file` route and videos through `/api/video`, so neither is held in memory. Without `localMedia`, as on the Web Host, nothing is written to disk: a thumbnail is returned inline up to 8 MiB and a video streams up to 64 MiB.

`JingliuSession.upload(file, projectId, signal)` uploads a local image, audio or video file: `POST /v2/media/upload-url` signs a PUT link on a `mediaHosts` host, the Host sends the file there without credentials, and `POST /v2/media/upload-complete` confirms its address and size. The result is the permanent `/fw/media/uploads/...` address. A studio without these routes fails with `JINGLIU_UPLOAD_UNSUPPORTED`. `download` and `place`, present only with `localMedia`, give tools the same indexed folders and link a downloaded file into a second location.

| Config | Default | Meaning |
|---|---|---|
| `localMedia` | `false` | Keep media as local files; set only by the desktop Host. |
| `mediaHosts` | `[]` | Exact `host[:port]` values of presigned links; HTTPS, or HTTP on loopback. |
| `mediaDownloads` | 4 | Simultaneous downloads. |
| `mediaCacheBytes` | 2 GiB | Viewed files one folder keeps before eviction. |
| `mediaMaxBytes` | 2 GiB | Largest download whose size the studio does not state. |
| `mediaTimeoutMs` | 30 min | Longest download or upload. |

## Model Experience

### Account changes during a workflow call

#### What the model sees

A workflow tool can report `JINGLIU_ACCOUNT_CHANGED` when the signed-in account changes after preparing a request. The authorization token stays on the Host.

#### Token effect

Signing in adds no tool definitions or system instructions.

#### KV Cache effect

Account changes leave the system prefix unchanged.

## Known Limitations and Deferred Work

- The Host reads presigned links only on `mediaHosts`; the deployment lists the storage host the studio signs for. A studio without the resolve and upload routes keeps media reads through the Host and cannot accept uploads from Muse.
- Existing production instances served over plain HTTP require a trusted loopback tunnel or a deployment with HTTPS. The studio must implement `/fwp/v2/auth/muse/challenge` and `/fwp/v2/auth/muse/exchange` and register the Jingliu audience with the Muse account gateway.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
