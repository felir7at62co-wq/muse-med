---
description: "Deploy and verify the private cloud media service used by Muse."
kind: "package-reference"
---

# DTK deployment

English | [中文](README.zh.md)

## Summary

Deploy DTK as a private cloud service for platform data and media downloads. The service listens on loopback and must remain behind the Muse company gateway. The upstream checkout, release images, and browser revision are pinned in [upstream.json](upstream.json).

## Deployment

Use a Linux host with Docker Compose v2, enough disk for downloaded media, and the pinned upstream source extracted to `/opt/muse/dtk/source-v5.1.10`. Keep the verified source archive at `/opt/muse/dtk/source-v5.1.10.tar.gz`. Follow the [upstream deployment guide](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/v5.1.10/documents/zh/02-installation.md) for image acquisition and browser-image construction.

`python3 build-browser.py --source /opt/muse/dtk/source-v5.1.10 --apt-mirror https://mirrors.aliyun.com/debian` builds a separate browser Dockerfile after validating the upstream file hash. The optional mirror changes Debian package locations and preserves package-signature checks. Build metadata records the generated file hash; the upstream source remains unchanged.

Run the preparation and Compose commands from this directory:

```sh
python3 prepare.py --source /opt/muse/dtk/source-v5.1.10
sh compose.sh config --quiet
sh compose.sh up -d --wait --wait-timeout 240
python3 verify.py --source /opt/muse/dtk/source-v5.1.10
```

Preparation creates `/etc/muse/dtk.env` and `/etc/muse/dtk-admin.json` with mode `0600`; repeated runs preserve their values. New configuration defaults to loopback port `19580` without a transcriber URL. The Compose wrapper selects the `browser` and `downloader` profiles. Existing private files are preserved; verification checks the running configuration independently. A temporary build proxy must not be added to the runtime environment.

Verification initializes the private administrator once, saves a limited service key in `/etc/muse/dtk-service-key`, and writes a secret-free receipt to `/opt/muse/dtk/receipts/deployment.json`. It checks running version, image identifiers, database migration, sidecar health, anonymous rejection, and the MCP tool list without requesting platform content.

All verifier HTTP requests go directly to loopback without using an installation proxy. Before private bootstrap, it checks the actual running container port publications and transcriber settings. Published ports must use loopback, and the API must publish `127.0.0.1:<port>` to container port `8000/tcp`; host/shared network modes or missing observations fail verification. API and worker transcriber settings must be disabled, no transcriber container may be running, and the authenticated API must explicitly report the unconfigured transcriber state before a limited key is issued.

Readiness has one monotonic 120-second budget covering probe startup, response headers and body, retries and sleeps. `--readiness-timeout <seconds>` accepts a positive finite budget for this phase; it does not bound the later setup and runtime checks. Operating-system process creation and termination can add uninterruptible overhead; time spent starting a probe reduces its remaining wait rather than renewing the budget. A timed-out anonymous probe is terminated and reaped before another probe starts.

A successful receipt records observed `publishedBindings`, `networkModes` and `transcriberRuntime`. The `profiles` field is removed because running containers do not establish which Compose profile flags started them; `images` identifies the observed services. Check the exit status and a fresh `verifiedAt` when using a receipt. Failed verification does not replace an earlier receipt.

## Patched API image

The API, worker and migration services run `muse-dtk-app:5.1.10`: the pinned API image with [patches](patches) applied to its Python package. [dtk-douyin-search.patch](patches/dtk-douyin-search.patch) adds Douyin post and account search, which Douyin answers to a signed-in identity only, with replay fixtures redacted from replies captured on 2026-11-15. `sh build-patched.sh` applies every patch to a copy of the pinned source, builds the image from [Dockerfile.patched](Dockerfile.patched), and labels it `com.muse.dtk.patches.sha256`; the upstream revision and version labels stay unchanged, so verification still checks the pin. Set `DTK_IMAGE=muse-dtk-app` in `/etc/muse/dtk.env`, then recreate only the application services:

```sh
sh build-patched.sh
sh compose.sh up -d --no-deps --wait --wait-timeout 180 api worker
```

Rolling back restores `DTK_IMAGE=evil0ctal/douyin_tiktok_download_api` and recreates the same services. The patches change no database schema.

## Signed-in identities

Douyin search needs a logged-in cookie jar from a dedicated account, never a personal or company-critical one. On a machine holding the server SSH key, the operator runs `python3 import-identity.py` and pastes the account's `cookie` and `user-agent` request headers at hidden prompts; the cookie travels on SSH standard input only. The script previews the jar on the server, stores it only when it carries a login, keeps it out of rotation, and asks the platform for a login check. Afterwards limit its rotation to the search endpoints in the console identity drawer. A Douyin login lasts 60 days; DTK raises `cookie_expiring` three days before `sid_guard` expires, and a new import replaces the expired identity.

## Access and recovery

Keep the administrator password and service key on the server. Do not distribute them to employee clients. The upstream media archive is shared across the instance; the Muse company gateway owns employee authorization, task ownership, and limits.

Use `sh compose.sh ps -a` for component status. Preserve the private files and Docker volumes when recreating containers; deleting either can lose access or media. Installing or rebuilding images may require an operator-provided network proxy. Running the service does not require the installation machine to remain connected.

## Local verification

From the repository root:

```sh
python3 -m unittest discover -s services/muse-media/deploy -p 'test_*.py' -v
```
