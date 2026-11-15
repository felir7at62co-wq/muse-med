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

## Access and recovery

Keep the administrator password and service key on the server. Do not distribute them to employee clients. The upstream media archive is shared across the instance; the Muse company gateway owns employee authorization, task ownership, and limits.

Use `sh compose.sh ps -a` for component status. Preserve the private files and Docker volumes when recreating containers; deleting either can lose access or media. Installing or rebuilding images may require an operator-provided network proxy. Running the service does not require the installation machine to remain connected.

## Local verification

From the repository root:

```sh
python3 -m unittest discover -s services/muse-media/deploy -p 'test_*.py' -v
```
