---
description: "Deploy, verify, and withdraw the company-authorized Muse media gateway."
kind: "package-reference"
---

# Company media operations

English | [中文](README.zh.md)

## Summary

Deploy the company media gateway separately from the account service. The gateway uses the existing account session, private company policy, and server-only DTK credential. The container listens on loopback port `19581`; a dedicated Nginx include exposes `/api/media/` after internal verification.

## Private deployment inputs

Keep the reviewed company policy in an owner-only file. `prepare.py` copies that policy and `/etc/muse/dtk-service-key` into `/etc/muse/media-gateway`, writes explicit limits, and creates writable state at `/var/lib/muse-media`. These files belong to the existing `muse-gateway` operating-system account. The container mounts the whole `/var/lib/muse/accounts` directory read-only so account-file replacement remains visible.

```sh
python3 prepare.py --policy /etc/muse/company-media-policy.json --image muse-company-media:REVIEWED_INPUT_HASH
sh compose.sh config --quiet
sh compose.sh up -d --wait --wait-timeout 120
python3 verify.py
```

Build only reviewed gateway source. `python3 bundle.py --archive PATH` writes a deterministic archive and per-file hashes, excludes credential files, and derives an image tag from those inputs. The Compose project uses the gateway Dockerfile and the already deployed DTK base image. Do not mount the account service's environment file or distribute the DTK key to clients.

## Storage and public activation

`python3 storage.py` sets the upstream archive limit to 20 GiB and the per-file limit to 512 MiB. It records previous and observed values without printing administrator credentials. The script does not enable transcription.

After private readiness and authentication checks pass, review the current site-file SHA-256 and activate only the owned include:

```sh
python3 nginx.py activate --expected-site-sha256 REVIEWED_SITE_SHA256
```

The script checks the reviewed hash, validates the candidate with `nginx -t`, and reloads only Nginx. A failed candidate restores the previous site without reloading. `nginx.py withdraw` removes only the owned include and preserves unrelated site changes; it also requires a freshly reviewed site hash. Neither operation restarts the account service or DTK.

## Verification and rollback

`verify.py --cookie-file PATH` checks the authorized tool list and the caller's job/status endpoints. The cookie input must be owner-only and contain one Cookie header value. Optional `--rate-check` sends a bounded tools-list burst until this account receives HTTP 429; it temporarily consumes that account's media request allowance. No content collection or video download is requested.

Receipts live under `/opt/muse/media-gateway/receipts/` and contain no cookies or service keys. Withdraw the Nginx include before stopping a faulty candidate with `sh compose.sh stop`; preserve the private configuration and SQLite state for rollback or redeployment.

## Local verification

From the repository root:

```sh
python3 -m unittest discover -s services/muse-media/ops -p 'test_*.py' -v
```

## Start and review retention

Build the immutable gateway image and run its tests with network access disabled before deployment. Qualify the native importer and recorded media snapshot separately. Place an owner-only `retention-qualification.json` beside `compose.env`, containing the gateway `code_hash`, `passed: true`, and passed checks named `gateway_runtime`, `retention_isolation`, `native_import`, and `media_snapshot`, each with its executed positive `count`. Qualification must describe actual executed checks, not configured commands.

Run `retention_prepare.py --image <reviewed-image>` from the immutable release. It refuses a second start, takes a consistent SQLite backup, preserves the original Compose environment, writes the default dry-run policy, verifies independent DTK media eviction is disabled and configures only the media gateway environment. Recreate only the gateway with this release's `compose.yml`, then verify schema 2, healthy containers and successful `media_audits` observations. The account service remains running. A failed partial preparation requires inspecting the private baseline and environment backup; do not reset its history or restore a database that accepted newer requests.

After the first successful server sweep, run `retention_schedule.py --release <immutable-release-directory>`. It installs a persistent one-time systemd review for 24 hours plus ten minutes after the initial observation. Its service invokes `retention_control.py promote`, which verifies continuous matching observations, passing qualification and the actual running image before publishing approval and enabling deletion. Short, failed, changed or interrupted previews stay in dry-run; the private result at `/opt/muse/media-gateway/receipts/retention-review.json` records the outcome. The timer is not an unconditional switch and does not automatically retry a failed review. Use `retention_control.py review --output <private-report>` to inspect readiness without enabling. A restart failure restores the policy file to dry-run; inspect the live process before another attempt.

Container logging retains the existing bounded JSON logs. Journals, Nginx logs, application release trees and Docker caches are not deleted by the media service. The [host storage report](host_storage.py) lists their usage independently; unknown release references require operator review before any removal. No deployment command runs Docker prune or recursively deletes an application release.
