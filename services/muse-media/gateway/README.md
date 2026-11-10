# Company media gateway

English | [中文](README.zh.md)

This reference describes the independent Python ASGI gateway in front of DTK 5.1.10. It uses the pinned DTK API image's FastAPI, HTTPX and Uvicorn dependencies. One process owns the per-account request counters; SQLite owns job identity, idempotency and download reservations.

## Authentication and company membership

Each operation forwards only the current Muse session to the fixed loopback `GET /api/muse.account` endpoint. Its returned `accountId` selects a fresh account record from the read-only account file. Access requires an active record matching a configured Feishu app/tenant pair or an explicit account ID grant. Administrator status alone grants nothing. The gateway rechecks the same identity, revision and membership before returning results or files; a logout, disabled account, account switch or removed grant prevents delivery.

`Cookie: __Host-muse=…` and a Bearer carrying that same Muse session are accepted. They are never upstream DTK keys. Conflicting credentials, foreign browser origins and cross-site requests are refused. The account source directory is mounted read-only so atomic account-file replacement remains visible; it is never served as web content. Policy and account documents are reloaded for each authorization.

## Private configuration

Copy [config.example.json](config.example.json) and [policy.example.json](policy.example.json) to owner-only private files and set `MUSE_MEDIA_CONFIG` to the configuration path. Every example configuration field is mandatory; unknown, omitted, invalid or inconsistent fields stop startup. Backend origins are fixed loopback HTTP origins without trailing slashes. The public authentication origin is HTTPS. The upstream key, account source, policy and database paths are absolute. Company identity values and keys never belong in committed examples.

| Configuration fields | Meaning |
| --- | --- |
| `requests_per_minute`, `max_requests_per_account` | Account-wide frequency independent of source IP, and simultaneous heavy requests |
| `max_downloads_per_day` | Durable UTC-day submission count, including failed and uncertain submissions |
| `max_downloads_per_account`, `max_downloads_global` | Outstanding download reservations |
| `reservation_ttl_seconds` | Observation/uncertainty lease before a slot may be released without declaring task failure |
| `request_timeout_seconds`, `auth_timeout_seconds` | Total upstream and identity-operation deadlines |
| `max_request_bytes`, `max_response_bytes`, `max_file_bytes` | Input, MCP/JSON reply and delivered-file limits |
| `max_jobs_per_page`, `sqlite_timeout_seconds` | Owned receipt page size and SQLite lock wait |

Run one worker. HTTPX uses `trust_env=False` and refuses redirects; shell proxy settings cannot silently redirect production traffic. Keep the upstream DTK port private and give its key only the platform/media scopes it needs, without identity management or administrator permission. HTTP authentication failures are 401, company/origin denials are 403, and limits are 429 with `Retry-After`. REST returns 404 for foreign or missing jobs/files. MCP tool business failures instead return HTTP 200 with `isError: true`, a safe `state: failed` result and the original JSON-RPC ID; this includes invalid arguments, unavailable owned jobs and conflicting request IDs. Authentication and limits retain their HTTP status.

## MCP and owned jobs

`POST /api/media/mcp/` accepts JSON-RPC `initialize`, `ping`, `notifications/initialized`, `tools/list` and `tools/call`. Negotiation advertises the implemented 2024/2025 protocol versions; modern discovery methods are not advertised. The trailing slash is part of the endpoint. Supported tools are `parse_url`, `get_video`, `get_user`, `list_user_posts`, `list_comments`, `get_content_history`, `download_media` and `get_task_result`. `pool_status`, transcription, administrative methods and arbitrary URL/path proxying are unavailable. `GET /api/media/status` reports only readiness and the caller's configured limits.

Download calls require a stable `request_id`; identical normalized arguments reuse one account-owned receipt. Changed arguments under the same key are refused. The gateway commits the reservation before the upstream call. An explicit upstream tool or HTTP rejection becomes `failed` with a fixed public code. A timeout, incomplete or malformed response, or process loss leaves `unconfirmed` with a fixed code. Neither state triggers automatic resubmission. Pending tasks use gateway-generated `job_id` values; `get_task_result` accepts only that ID and verifies ownership before looking up the private upstream identifier. Expired observations release reservations but keep the receipt and original task for reconciliation; releasing a slot does not prove that upstream work stopped.

| Route | Response |
| --- | --- |
| `GET /readyz` | Loopback readiness and SQLite schema version; no account information |
| `GET /api/media/jobs?offset=0` | Only the caller's receipt summaries and `next_offset` |
| `GET /api/media/jobs/{job_id}` | Owned receipt and any safely projected result |
| `GET /api/media/jobs/{job_id}/files/{name}` | An owned manifest entry fetched through the fixed DTK endpoint |

MCP calls return JSON `result.structuredContent` and matching text content. Read results use `state: ok`; tasks use `pending`, `unconfirmed`, `cloud_saved`, `partial` or `failed`. Receipts contain `job_id`, tool, timestamps, `automatic_resubmit: false`, optional `request_id`/safe `code`, and safe file facts (`name`, `bytes`, `sha256`, `kind`). Download receipts disclose `file_coverage` with reported/accepted/rejected counts, completeness and truncation. A finished upstream record is `cloud_saved` only when every reported manifest entry is accepted; filtered, duplicate, unfinished or truncated entries make it `partial`, and no valid files makes it `failed`. Unknown receipts include `reservation_active` and `next_action`. Upstream IDs, server paths, raw errors, signed media URLs, cookies and keys are excluded. Public content remains untrusted source material, and unavailable metrics remain null.

All admitted operations count against the same account frequency bucket, including MCP discovery and receipt queries. Receipt queries bypass heavy-request concurrency so completed tasks can release download reservations. File delivery holds its request slot until sending ends. Files are staged privately, checked against the persisted manifest's byte count and SHA-256, authorized again, then sent and deleted in a response `finally` path. This confirms cloud bytes, not media decoding or local asset registration.

## Running and verification

Build with the gateway directory as context:

```sh
docker build -t muse-company-media:local services/muse-media/gateway
```

The image entry point runs `python -m uvicorn app:configured_app --factory --app-dir /app/gateway --host 127.0.0.1 --port 19581 --workers 1`. Deploy with host networking, a read-only root filesystem, dropped capabilities, owner-only configuration/key mounts, a read-only account source directory and a writable private database directory. The factory loads `MUSE_MEDIA_CONFIG` before startup. Mount only the state directory writable; never publish the upstream port or raw key.

For local verification, use Python 3.12 or later with the same FastAPI/HTTPX dependencies, then run:

```sh
python -m unittest discover -s services/muse-media/gateway -p 'test_*.py' -v
python -m compileall -q services/muse-media/gateway
```

The tests use real ASGI routes with isolated account files and SQLite databases, mocked external HTTP, controlled clocks and explicit concurrent requests. They cover authorization, cross-account access, limits, duplicate submission, unknown outcomes, restart recovery, bounded JSON/SSE, secret removal and interrupted file sending without contacting a platform. Production readiness still requires the deployed container, authenticated Muse session, reverse proxy and a bounded platform request to be verified separately.

## Retention and dry-run approval

Set `MUSE_MEDIA_RETENTION_CONFIG` to a private file matching [retention.example.json](retention.example.json) to run the owned five-minute retention loop. Absence leaves the loop disabled. The media ledger upgrades monotonically from schema 1 to 2, preserving jobs and adding file leases, import receipts, deletion fences and audits; schema-1 binaries cannot reopen it. Recovery keeps the upgraded database and runs this binary with retention disabled or in dry-run mode. Do not restore an earlier database after new requests have been accepted.

The independent DTK `media.max_bytes` eviction must first be set to zero. Its filesystem capacity guard remains enabled. Each sweep verifies this setting through the media storage API; a mismatch blocks deletion and invalidates the observation window. The gateway applies the replacement 20 GiB admission limit, 16/12 GiB high/low marks and 80/85/92 percent disk thresholds. Pressure only changes the processing order and batch target: it never shortens a retention promise. When no eligible files can make space, new downloads stop while queries and existing file delivery remain available.

An issued file lease protects the exact owner, filename and digest for two hours, including local decoding after HTTP delivery. Only `POST /api/media/jobs/{job_id}/files/{name}/imported` with that lease and digest confirms a local import; serving bytes does not. Confirmed imports retain their cloud copy for 24 hours, unconfirmed jobs for seven days. All owners and manifest files sharing a physical upstream directory must qualify. Each nonempty upstream manifest must fit the accepted limit, contain only complete and unique files, and match every owner's durable names, sizes, hashes and kinds; an incomplete or mismatched manifest protects the entire directory. Pins, active leases, unfinished or uncertain downloads, unknown references and empty manifests protect the directory. Old clients do not acknowledge imports and receive the longer retention period.

Dry-run records candidates and protections without deleting media or orphan gateway staging files. Enabling requires an owner-only approval file matching an uninterrupted 24-hour sequence for the exact runtime code and policy: no errors, deletion, independent eviction, clock regression or gaps above ten minutes. Changing rules or executable modules requires another dry-run. The loop reloads the policy on every sweep and before each deletion, so switching back to dry-run also stops later deletions without relying on restart success. Every enabled deletion repeats the complete inventory and protection checks under the same admission lock used to grant leases and create download jobs. It deletes only through the upstream files API and confirms the inventory before marking receipts `failed / cloud_media_evicted`; prior file facts remain readable and no download is resubmitted. An uncertain delete leaves a persistent fence that blocks further deletes, transfers and new downloads until operator reconciliation. No shell recursion or arbitrary path deletion is provided. Direct upstream administrators must not submit or delete media concurrently with the managed cleanup.

The loop also identifies regular `media-*` files abandoned in its own staging directory for 24 hours, excluding all active file leases. It never scans projects, credentials, source releases, database files or arbitrary Docker volumes. Enabled audit records expire after 90 days; the dry-run approval evidence remains. Log rotation and old application release removal use separate operator-reviewed policies, not the media deleter.
