---
description: "Deploy and verify the Muse account gateway, cloud knowledge base, and account-bound speech transcription."
kind: "package-reference"
---

# Muse accounts gateway

English | [中文](README.zh.md)

## Summary

This directory versions the complete account gateway source and local tests copied from the rc35 service release, plus the rc3 ASR and production KB changes. It is a separately deployed Node service. Desktop and workspace packages neither launch it nor store its Volcengine or TOS credentials.

## Release inputs

The gateway requires Node 22 or newer, the matching `muse-runtime` and `global` release directories, and the release-root DSH dependencies already used by the existing account, model, and KB routes. Run `npm ci --omit=dev` in this directory after copying it into each new immutable release; `package-lock.json` pins the TOS SDK. `ffprobe` must exist on the server. Never copy account databases, KB vaults, credentials, or ASR job ledgers into the release tree.

The service reads a private JSON file named by `MUSE_ASR_CONFIG`. Omit the variable to disable ASR; authenticated ASR calls then return 503. The file must be a regular file, mode 0600 on Linux, and contain these fields:

| Field | Use |
|---|---|
| `appId`, `accessToken` | Server-only Volcengine recording-file 1.0 credentials. |
| `accessKeyId`, `secretAccessKey` | Server-only TOS credentials. |
| `bucket`, `region`, `endpoint`, `prefix` | Private TOS bucket, matching official regional endpoint, and dedicated temporary prefix ending in `/`. |
| `root` | Absolute durable private directory for account-scoped job receipts and short-lived staged MP3 files, outside the release. |
| `ffprobePath` | Server-side `ffprobe` executable; it verifies codec and real duration for quota. |
| `timeoutMs`, `signedUrlTtlSeconds` | Provider/verification timeout and GET-only signed URL lifetime. The latter must exceed `maxDurationSeconds` by at least one hour and stay within seven days. |
| `maxAudioBytes`, `maxDurationSeconds` | Maximum uploaded MP3 bytes and recognized seconds; keep duration at or below 18,000. |
| `maxDailySeconds`, `maxDailyJobs`, `maxActiveJobs` | Per-account billing ceilings; `maxActiveJobs` must be 1 so quota reservation is serialized by the single gateway process. |
| `retentionSeconds`, `sweepIntervalSeconds` | Temporary TOS object lifetime and background cleanup interval. Retention must cover the media duration plus one hour and cannot exceed the signed URL lifetime; the interval is at least 60 seconds and no longer than retention. |

Before upload, the gateway reads the bucket ACL and policy. It accepts owner-only ACL grants and policies without any Allow statement; missing read permission or an unverified response stops the upload. Each object is uploaded with a private ACL, then an unsigned GET must return 403 and a signed range GET must succeed before provider submission. A failed check remains in the private job ledger without a billable submit. The retention sweep deletes old objects, including unresolved tasks, while retaining their job IDs for read-only provider queries; an account status query also runs cleanup. A later status query removes the corresponding local MP3 when the gateway reports retention expiry.

No credential value belongs in Git, systemd `Environment=`, Desktop settings, logs, or model tool results. Both development and production can enable the KB machine endpoint with `MUSE_KB_VAULT` and the private `MUSE_KB_SECRET` file. Without KB configuration, the route is absent and an unauthenticated request follows the normal login redirect; a configured endpoint rejects an unauthenticated request with 401 before browser session routing. The existing KB search reads the whole configured vault for every granted account. Provision only a separately authorized shared vault; do not copy the development vault into production based on its file count or titles.

## Verification and release

Run `node --test *.test.mjs` here; all provider and TOS operations in these tests are mocked. A real provider request is a separate authorized, billable integration check. Before cutover, save the current service unit and release pointer, keep the previous immutable release, and snapshot the job ledger and account state without exposing their contents. Stage development first, then production. Verify `/login` returns 200, unauthenticated `/api/kb/mcp` returns 401 when configured, and an authenticated GET of a random `/api/asr/jobs/:id` returns 404 when ASR is configured; 503 means it is disabled. Test an authorized KB search and one separately approved short ASR fixture before declaring the service healthy. Revert the unit to its previous release if checks fail; retain the durable job ledger so already submitted task IDs can still be queried. Do not delete previous releases or temporary TOS objects as part of rollback.

The observed server unit paths before rc3 are `/opt/muse/dev/releases/dev-0.3.0-rc35/muse-accounts` and `/opt/muse/prod/releases/dev-0.3.0-rc35/muse-accounts`. The service unit names are `muse-dev-accounts.service` and `muse-accounts.service`. Deployment tooling must replace these with a new release path only after source and config checks pass. No deployment is performed by this directory.

## Provider basis

The ASR adapter implements the user's Pi-verified v3 large-model recording-file **standard 1.0** route and `volc.bigasr.auc` resource. The [Volcengine product limit](https://www.volcengine.com/docs/6561/1354871?lang=zh) is five hours. [TOS signed URLs](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en) may live at most seven days. [TOS bucket policies](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en) and [bucket ACLs](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh) both affect access, so the pre-upload check reads both. The older `/api/v1/auc` small-model document does not describe this v3 adapter. Submit/query status handling is based on the user's Pi session and remains subject to an authorized real API verification.
