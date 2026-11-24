---
description: "Authenticated Muse studio workers with per-account SQLite and media."
kind: "reference"
---

# Muse cloud studio

English | [中文](README.zh.md)

## Summary

The Muse account gateway selects a private production studio using the verified account ID. Each worker owns its SQLite database, configuration and media directory. Browser requests use `/studio/`, `/studio/api/v1/*` and `/studio/static/*` on the Muse Origin; they never select an account or receive a worker credential. The gateway remains the only login system.

## Deployment

`MUSE_STUDIO_CONFIG` is optional. Without configuration, authenticated studio routes return HTTP 404 `studio_not_configured`. Configure an absolute, owner-only regular JSON file outside the release. All fields below are required; these paths are illustrative and must refer to the staged Node executable, fully installed pinned backend and frontend built with `/studio/` as its base.

```json
{
  "version": 1,
  "nodeExecutable": "/opt/muse/runtime/node/bin/node",
  "backendRoot": "/opt/muse/studio/releases/current/backend-node",
  "webDistRoot": "/opt/muse/studio/releases/current/frontweb/dist",
  "tenantRoot": "/var/lib/muse/studio-tenants",
  "outboundOrigins": [],
  "trustedLocalOrigins": [],
  "limits": {
    "maxActiveInstances": 4,
    "maxConcurrentStarts": 1,
    "maxRequestsPerAccount": 16,
    "maxRequestsTotal": 64,
    "maxOutboundRequests": 4,
    "maxRequestBytes": 33554432,
    "maxTenantBytes": 1073741824,
    "startupTimeoutMs": 30000,
    "requestTimeoutMs": 300000,
    "idleTimeoutMs": 900000,
    "idleSweepMs": 1000,
    "shutdownGraceMs": 60000
  }
}
```

The runtime resolves `express`, `js-yaml`, `better-sqlite3`, `undici` and `ipaddr.js` from the backend's installed package. The pinned backend lock supplies these dependencies. Removing its assistant dependencies must retain the networking dependencies the cloud worker uses. No Mastra assistant is initialized; `/api/v1/agent/*`, other API helpers and path or account-selection overrides are refused. Installed audio, package, admission, revision, postproduction, budget, LibTV, edit and migration extensions use explicitly allowed `/api/v1/muse/` namespaces.

Build the patched checkout with `node integrations/localminidrama/build-web.mjs <checkout> --base /studio/` before staging it for this gateway. The builder includes the Muse icon and rejects missing resources, wrong URL prefixes and a missing native-frame bridge. Standalone deployments use `--base /`. Run `node --test integrations/localminidrama/tests/web-build.test.mjs` for the offline rejection cases; both commands require Python and the installed frontend Vite dependencies.

## Gateway integration

Import `loadStudioConfig` from `config.mjs`, `createStudioRuntime` from `runtime.mjs` and `studioRoute` from `proxy.mjs`. Load the optional file, then create its runtime with `await createStudioRuntime(config, {publicOrigin})`. Neither operation reads existing account databases. Pass the optional runtime into the account-server factory; keep the gateway's current account, Feishu, organization and workbench behavior.

After the existing authentication and Origin checks, before workspace forwarding, await `studioRoute(req, res, {runtime, session, isAuthorized, publicOrigin, signal})`. `session.id` is the verified stable account ID; `isAuthorized()` rechecks the same login token and account. The Host may use its private Cookie or Bearer login, so the gateway's credential parser must recognize `/studio/*`. Register the optional abort signal with existing session revocation and expiry cleanup. The route returns `false` for other URLs and settles after its owned upstream streams close. It strips browser cookies, Authorization, account/path override headers and all supplied worker credentials, then injects a private per-worker header. Backend cookies are never forwarded to the browser.

GET `/studio` redirects to `/studio/`. Normal writes require the configured Origin. The companion rejects the legacy GET endpoint that generates storyboards; use its admitted POST replacement. Uploads, downloads, range requests and event streams retain backpressure. Client cancellation or account revocation closes the proxy, not an accepted background generation. The proxy adds private no-store caching and `nosniff`; it adds no CSP, frame, COOP or COEP policy. An authenticated Desktop proxy owns its dedicated-origin embedding policy and must reject frames from a previous login.

## Worker lifecycle and storage

An account's first request starts the existing backend through `createApp()` in a separate process, bound atomically to `127.0.0.1:0`. Its working directory is `tenantRoot/<accountId>`; configuration points only to that account's database and storage. The environment keeps OS execution and locale variables, not gateway cookies, provider keys or Node loaders. Child output is not copied into gateway logs. A private PID/nonce ownership file prevents a replacement worker from reopening the same account while an old process remains alive. A dead owner's file is reclaimed only after the OS reports that PID absent; a reused live PID fails closed.

Idle cleanup checks current HTTP leases, pending image/video/task records, optional generating TTS rows, native reservations and promises descending from background jobs. When the admission extension is installed, its active-handler count keeps disconnected requests busy until their original handler settles; persisted unknown rows alone do not keep a restarted worker alive. Active work is retained even after a browser disconnects. `await runtime.close()` stops admission and drains workers. Grace expiry returns `studio_busy` without killing work; supervision continues and closes workers when their accepted jobs finish. Startup failures, capacity refusals and unavailable workers return fixed errors and retain account data. Releases and rollback preserve `tenantRoot` and its versioned manifest.

`maxTenantBytes` is an admission quota over current file bytes plus reserved incoming writes. In-flight model downloads, SQLite growth, extraction and FFmpeg output can exceed it; it is not an OS filesystem limit. Excess usage refuses new writes without deleting files or killing a production job. Instance, start, inbound-request and outbound-request limits are independent. The worker is a trusted pinned application process, not a container, OS user sandbox or CPU/memory quota.

## Outbound access and references

`outboundOrigins` lists exact, administrator-audited HTTPS provider and media-CDN Origins. The empty example enables no supplier requests. `trustedLocalOrigins` is an explicit subset allowing private/local provider services; production normally leaves it empty. HTTP requires such an exception. Ordinary users cannot override this policy with model settings. Model URLs are checked before configuration is saved; model calls, polling, downloads and redirects are checked again by HTTP/HTTPS, raw-socket and fetch/Undici guards. Every new connection resolves all DNS answers, refuses a nonpublic answer unless explicitly trusted, and pins the actual socket to a checked address. Custom agents, lookups, dispatchers and Unix sockets cannot bypass those audited channels. The pinned backend's JavaScript networking is covered; loading arbitrary native extensions or new unaudited transports requires separate review.

Local media fields reject traversal and filesystem URLs. Worker storage URLs use the root-relative `/studio/static` base so embedded previews, uploads and downloads stay on their authenticated proxy origin. Temporary generation references under `/studio/static/` or the configured Muse public Origin map to this account's `/static/` files for inline/provider upload; adopted asset fields are not rewritten. A Host iframe must preserve relative references instead of turning them into a `dsh-app:` or loopback URL. Authenticated Muse media is not an anonymous supplier-readable image host. Providers requiring public references need an explicitly authorized upload service or an inline transport.

<a id="native-production-usage"></a>
## Production usage

`createStudioUsageReader(config)` from `studio-usage.mjs` creates a lazy reader. Its `await query(accountId, {from, to, limit, cursor})` opens only the verified account's existing database read-only, closes it after one snapshot and never starts or leases a worker. The authenticated gateway selects `accountId`; a personal route cannot accept another account ID, and an administrator must select an existing account. Dates include both UTC days, default to the latest 30 days and span at most 366 days; pages default to 50 records, allow at most 100 and bind cursors to the account and dates.

The result uses `version: 2` and `scope: studio-all`. It combines native admission, independent TTS, Fal, LibTV API and LibTV CLI records. A dedicated task and its budget reservation count once; native child reservations belong to their original operation. Budget entries without a saved task remain visible, with missing native operations marked unknown. Linked image/video/audio/task counts identify associated records, not successful films or additional paid submissions. Free imports, local merging and earlier uninstrumented history do not become invented paid requests. The reader supports existing declared schema generations, including CLI versions 1–3, without migrating them. Releasing an unknown CLI operation's admission lock keeps its public outcome unknown and its budget hold unchanged.

Input/output aliases count once; totals are never inferred from other fields. Absent reports remain `null`, actual zero remains zero, and coverage describes saved supplier snapshots. Repeated polling updates one resource report. Malformed reports, persistence errors or integer overflow degrade health; an overflowing metric becomes unknown independently of other metrics. `budgetTotals` groups currencies separately: `reservedMinor` records original reservations, `heldMinor` counts amounts still awaiting reconciliation, and `settledMinor` remains null until a user-confirmed invoice exists. These are budget observations, not verified supplier charges. Relay usage remains a separate scope.

Rows use the original operation's creation date, including later supplier reports and linked reservations. Opaque cursors encode `[2, accountId, from, to, createdAt, source, sequence, operationId]`; source and operation identity break equal-time insertion ties. Old cursors must be discarded. Fal task errors take precedence over the first error in segment order; `awaiting-review` covers incomplete submission or unverified media, while unknown results remain unknown. Persisted phases do not prove live worker activity or supplier finality. Missing databases and uninstrumented databases have explicit statuses rather than an asserted historical zero. The reader selects no prompts, receipts, provider configuration, CLI input captures or media; descriptor mismatches, links and unsupported schemas fail closed.

## Verification

Run `node --test integrations/localminidrama/cloud/cloud.test.mjs integrations/localminidrama/cloud/network-policy.test.mjs integrations/localminidrama/cloud/proxy.test.mjs`. Real backend tests require the installed pinned source at `.local/localminidrama`, or `LOCALMINIDRAMA_SOURCE`; absence explicitly skips those cases. Fixtures create new Muse accounts, separate real SQLite workers, generated PNGs and local HTTP suppliers. They cover account/static/config/history isolation, DNS/redirect refusal, concurrency, cancellation, graceful shutdown and retained data without reading existing conversations or invoking paid models.

The embedded-media browser case also needs `apps/web` development dependencies and Playwright Chromium installed. It renders an uploaded image through an account proxy and verifies the same reference reaches a local supplier inline. Missing browser resources explicitly skip that case; a skip is not browser acceptance evidence.

Run `node --test integrations/localminidrama/cloud/studio-usage.test.mjs` for the read-only metadata reader. Its isolated SQLite fixtures cover all installed sources, account isolation, active WAL reads, report replacement, unknown/overflow values, pagination and unsafe filesystem selections without model requests or existing account data. The adjacent `studio-usage-fal.test.mjs` compares Fal phases with the real postproduction owner and checks missing-segment refusal without writes.
