---
description: "Deploy and verify the Muse account gateway, cloud knowledge base, and account-bound speech transcription."
kind: "package-reference"
---

# Muse accounts gateway

English | [中文](README.zh.md)

## Summary

This directory contains the separately deployed Muse account gateway. It serves account-scoped speech transcription, administrator-granted reference reading, and private script storage. Desktop and workspace packages do not launch it or store its Volcengine or TOS credentials.

## Release inputs

The gateway requires Node 22 or newer, the matching `muse-runtime` and `global` release directories, and the release-root DSH dependencies already used by the existing account, model, and KB routes. Run `npm ci --omit=dev` in this directory after copying it into each new immutable release; `package-lock.json` pins the TOS SDK. `ffprobe` must exist on the server. Never copy account databases, KB vaults, credentials, or ASR job ledgers into the release tree.

The service reads a private JSON file named by `MUSE_ASR_CONFIG`. Omit the variable to disable ASR; authenticated ASR calls then return 503. The file must be a regular file, mode 0600 on Linux, and contain these fields:

| Field | Use |
|---|---|
| `appId`, `accessToken` | Server-only Volcengine credentials with the selected ASR resource enabled. |
| `providerKind` | `standard` (default) or `flash`; each receipt retains its original provider. |
| `maxConcurrentJobs`, `maxQueuedJobs` | Shared flash worker limit (default 5, maximum 5) and waiting capacity (default 20, positive integer). Admission includes uploads; a full queue returns 429. |
| `accessKeyId`, `secretAccessKey` | Server-only TOS credentials, required for standard; omit for direct flash uploads. |
| `bucket`, `region`, `endpoint`, `prefix` | Standard only: private TOS bucket, matching official regional endpoint, and dedicated temporary prefix ending in `/`. |
| `root` | Absolute durable private directory for account-scoped job receipts and short-lived staged audio files, outside the release. |
| `ffprobePath` | Server-side `ffprobe` executable; it verifies codec and real duration for quota. |
| `timeoutMs`, `signedUrlTtlSeconds` | Provider/verification timeout; standard additionally requires a GET-only signed URL lifetime exceeding `maxDurationSeconds` by at least one hour and staying within seven days. |
| `maxAudioBytes`, `maxDurationSeconds` | Maximum uploaded audio bytes and recognized seconds. Flash rejects configuration above 100,000,000 bytes or 7,200 seconds; standard duration must stay at or below 18,000 seconds. |
| `maxDailySeconds`, `maxDailyJobs`, `maxActiveJobs` | Per-account billing ceilings; `maxActiveJobs` must be 1 so quota reservation is serialized by the single gateway process. |
| `retentionSeconds`, `sweepIntervalSeconds` | Temporary audio lifetime and background cleanup interval. Retention must cover the media duration plus one hour; with TOS it cannot exceed the signed URL lifetime. The interval is at least 60 seconds and no longer than retention. |

Standard mode requires TOS. Before upload, the gateway reads the bucket ACL and policy. It accepts owner-only ACL grants and policies without any Allow statement; missing read permission or an unverified response stops the upload. Each object is uploaded with a private ACL, then an unsigned GET must return 403 and a signed range GET must succeed before provider submission. A failed check remains in the private job ledger without a billable submit. The retention sweep deletes old objects, including unresolved tasks, while retaining receipts; standard task IDs remain queryable. An account status query also runs cleanup. A later status query removes the corresponding desktop MP3 when the gateway reports retention expiry.

Flash keeps the account-authenticated start/status API: queued jobs appear as `processing`, and completed segments contain second-based `start`, `end`, `text`, and optional `words` with the same fields. Blank and zero-duration punctuation words are omitted. The gateway durably queues private audio files and sends base64 `audio.data` directly to Volcengine independently of the upload connection; TOS is not required. Uploads accept `audio/mpeg` and `audio/wav`; the gateway verifies MP3 or 16 kHz mono PCM16 WAV before billing. Completion, silence, or retention expiry deletes the gateway file. Startup resumes queued work; a flash request interrupted after its durable `submitting` marker becomes `uncertain` and is never queried or automatically resubmitted. Provider errors and invalid responses also remain uncertain. Only failures before provider submission permit an upload retry. Receipts without a provider field use standard submit/query semantics; retain TOS configuration when old standard objects still need cleanup. Run one gateway per ledger; deployments sharing a provider concurrency allowance must divide that allowance between their configured worker limits. Mocked lifecycle tests cover these rules; the release operator owns the real flash API check.

Flash uses the provider's default language detection for both accepted client values, `zh` and `auto`; it sends no explicit language option. The standard adapter retains its language parameters.

No credential value belongs in Git, systemd `Environment=`, Desktop settings, logs, or model tool results. Both environments enable the KB machine endpoint with `MUSE_KB_VAULT` and a private `MUSE_KB_SECRET` file. Set `MUSE_KB_DOCUMENT_GRANTS` to an administrator-maintained regular JSON file outside the writable shared vault and outside editor-writable directories; on POSIX it cannot be group- or world-writable. An absent file path grants no shared documents. The gateway checks each shared document's full SHA-256 before search or reading. Do not copy the development vault into production based on its file count or titles. Without KB configuration, the route is absent; with it, an unauthenticated `/api/kb/mcp` request returns 401.

Set `MUSE_KB_USER_ROOT` to an existing, owner-only absolute directory outside the shared vault before starting a KB-enabled gateway. Missing, permissive, or overlapping roots stop startup. A signed-in account can submit 1–12 reviewed Markdown script sections per `ingest_script` call, with a 2 MiB request limit and a 400,000-character section limit. Each section stores its title, project-relative source identifier, and immutable text below the stable account ID; results report saved, duplicate, or failed sections separately. The account reads its own `private/SRC-...` IDs through `search`, `read`, and `read_opening`. Other accounts and machine tokens cannot read these private IDs. Personal recall is keyword-based; semantic vectors apply only to granted shared documents. No video binary is uploaded through this tool. The server must be deployed and configured before Desktop can use this capability; source packaging alone does not activate it.

Desktop model access uses the same account session and global model directory as the website. `GET /api/desktop-models/providers` returns public metadata; `POST /api/desktop-models/:provider/chat/completions` accepts the session token as Bearer authentication and requires the configured public Origin. Upstream credentials remain on the server. Requests are limited to four active streams per account and the configured model output limit. Logout, account revocation, and session expiry abort active desktop streams.

## Verification and release

Run `node --test *.test.mjs` here; all provider and TOS operations in these tests are mocked. A real provider request is a separate authorized, billable integration check. Before cutover, save the current service unit and release pointer, keep the previous immutable release, and snapshot the job ledger and account state without exposing their contents. Stage development first, then production. Verify `/login` returns 200, unauthenticated `/api/kb/mcp` returns 401 when configured, and an authenticated GET of a random `/api/asr/jobs/:id` returns 404 when ASR is configured; 503 means it is disabled. With two test accounts, save one reviewed short script, confirm the owner can search and read its `private/SRC-...` ID, and confirm the other account cannot. Test a granted shared KB search and one separately approved short ASR fixture before declaring the service healthy. Revert the unit to its previous release if checks fail; retain the durable job ledger so already submitted task IDs can still be queried. Do not delete previous releases or temporary TOS objects as part of rollback.

The observed server unit paths before rc3 are `/opt/muse/dev/releases/dev-0.3.0-rc35/muse-accounts` and `/opt/muse/prod/releases/dev-0.3.0-rc35/muse-accounts`. The service unit names are `muse-dev-accounts.service` and `muse-accounts.service`. Deployment tooling must replace these with a new release path only after source and config checks pass. No deployment is performed by this directory.

## Provider basis

The ASR adapter supports the user's Pi-verified v3 large-model recording-file **standard 1.0** route with `volc.bigasr.auc` and the [flash route](https://www.volcengine.com/docs/6561/1631584) at `/api/v3/auc/bigmodel/recognize/flash` with `volc.bigasr.auc_turbo`. The [standard product limit](https://www.volcengine.com/docs/6561/1354871?lang=zh) is five hours. [TOS signed URLs](https://docs.volcengine.com/docs/TorchObjectStorage/URLcontainsasignature?lang=en) may live at most seven days. [TOS bucket policies](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketPoliciesNodejsSDK?lang=en) and [bucket ACLs](https://docs.volcengine.com/docs/TorchObjectStorage/ManagingBucketACLsNodejsSDK?lang=zh) both affect access, so the pre-upload check reads both. The older `/api/v1/auc` small-model document does not describe this v3 adapter. Real provider verification remains a release operation.
