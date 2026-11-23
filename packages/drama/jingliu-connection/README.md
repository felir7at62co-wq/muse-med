---
kind: package-reference
description: User authorization and authenticated requests to a Jingliu production service.
---

# Jingliu account connection

English | [中文](README.zh.md)

## Summary

The Host authenticates production and media requests with the signed-in Muse account. The sidebar and production tools share a cloud project selection per conversation and studio identity. Dedicated studio origins use the original sign-in exchange.

Catalog entries include descriptions, media paths and reference-only status.

ShotFlow serves production requests at `/fwp/v2` and the original workspace at `/sfp/`. Set `studioOrigin` to an HTTPS or explicit IPv4/IPv6 loopback origin. API requests do not follow redirects; media reads follow one only to a configured storage host, as described in [Media](#media). An absent origin leaves the plugin unconfigured.

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

`billingDetails(signal)` reads the signed-in user's balance and latest 50 ledger entries through the Jingliu V2 API. The user's own studio profile determines the account to query. Each entry reports its type, timestamp and signed movement in fen. A settlement entry is the change made after the original hold. A missing ledger is reported separately from an empty ledger. The Muse account owner can read this data in the UI or through a chat tool.

The client Remote also reads the workbench data as the signed-in user, read-only: `projectConfig`, `episodeList`, `episodeShots`, `shotMedia` and `projectAssets` run the studio's read workflows (`get_project`; `list_episodes`; `list_shots` with `read_shots`; `get_shot` with `list_versions`; `list_assets` with `list_audio_clips`). `thumbnail` and `localVideo` read media as described in [Media](#media); `video` streams one studio video for a Host without local media, up to 64 MiB: its content type first, then base64 chunks. Results keep only paths under the studio's media mount, so the client never receives the studio credential or another address. Four calls serve the workbench's forms: `catalog` reads the modes with their art styles, frame ratios, resolutions and models the studio offers; `createProject` creates a production after checking every value against that catalog; `renameProject` renames one and verifies the stored name; `deleteShot` deletes one shot, which the studio does not keep.

## Media

A stored address `/fw/media/<dir>/<name>` is the permanent ID of a studio file; `<dir>` is one of `generated`, `uploads`, `outputs`, `character-references`, `exports`, `bgm-library`, `sfx-library` and `voice-library`, at most one subfolder deep, and no segment may start with a dot or end in `.part` or `.part.json`. The Host asks `POST /v2/media/resolve` for up to 200 addresses at a time and reads each file from the presigned object-storage link it returns, without the Muse cookie, the studio token or any other credential. A file the studio still keeps (`local: true`), a file in a folder object storage does not manage (`not_in_tos`), and every file on a studio that answers the resolve route with 404, is read through the Host session as before. When object storage reports no Content-Type or only `application/octet-stream`, the type the studio resolved, or else the type of the file extension, is used. A redirect from `/fwp/media/...` is followed only to a host listed in `mediaHosts`, also without credentials; any other target fails with `JINGLIU_MEDIA_REDIRECT_REFUSED`. A resolve link outside `mediaHosts` sends only that file through the Host session, and the Host logs one warning line for the batch. Media failures carry their own codes, `JINGLIU_MEDIA_NOT_FOUND`, `JINGLIU_MEDIA_UNAVAILABLE` and `JINGLIU_MEDIA_INTEGRITY`, instead of a Muse login failure. Clients never receive a storage link or a storage key.

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
