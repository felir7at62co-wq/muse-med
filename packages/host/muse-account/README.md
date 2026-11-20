---
description: "Sign in to MUSE for account-authorized models, web search, cloud speech and Desktop services."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

English | [中文](README.zh.md)

## Summary

Sign in to MUSE from Desktop Settings without entering a password in a model conversation. Use the account model catalog, optional web search, cloud transcription, feedback, data-station Douyin downloads and desktop remote access through the configured Muse gateway. Account credentials remain in Host storage.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Muse Desktop offers MUSE sign-in before model setup on a blank first run; **Sign in later** leaves the account available from the sidebar and **Settings → MUSE Account**. Opening the page refreshes the model catalog; use **Verify status** to ask the gateway to confirm the account identity. The account page starts Feishu browser sign-in without username, password or registration fields. The same session loads the website model catalog and authorizes model requests and speech transcription. A fresh profile selects the first Muse model automatically; an old direct default without its own configured credential selects the corresponding Muse route. Models settings still accepts custom providers and credentials, and configured custom defaults remain selected. Signing out removes only Muse routes. The official DeepSeek route and GLM-5.3 models explicitly supply their thinking protocol and required `reasoning_content` field in both transports; model history never depends on guessing the upstream vendor from the proxy URL. Official Zhipu GLM-5.3 requests retain historical thinking with `clear_thinking: false` when thinking is enabled and send `tool_stream: true` when tools are present, so tool arguments can arrive incrementally.

After each successful catalog refresh and while an Agent is being created, Muse can replace an unconfigured direct selection with the same model on its Muse route. The complete provider, model, and explicit reasoning choice must still match the observed selection; a changed account, configured personal credential, unavailable model or explicit reasoning effort, or newer choice prevents that replacement. The repair records only a future-step model selection. An already assembled request keeps its captured route, including its normal credential failure; refresh the catalog or choose a Muse model explicitly before retrying.

With a gateway that exposes personal details, the account page displays the current profile, assigned Muse groups, and Feishu department paths synchronized during an authorized sign-in. Missing directory permission and unavailable synchronization remain explicit. Token usage supports today, seven days, thirty days, or all recorded history, with model and daily summaries and paginated request details. Input includes cached input; cached and reasoning counts are also displayed separately. Unknown provider counters remain unknown rather than becoming zero in request details.

The Host first probes the personal `/api/muse/identity` capability. A valid version-one identity selects account-data-v1 without requesting another protocol's details endpoint. An unrecognized probe selects the full personal-details API; its service failures remain failures. A claimed version-one identity with invalid fields is rejected, and authentication or rate-limit responses never select another protocol. The optional `/api/muse/profile` supplies personal details, administrator-assigned Muse groups and account-level Feishu department paths; its account ID and username must match the authenticated identity. A profile HTTP 404 leaves personal details and Muse groups unavailable; absence does not establish an empty membership. The Host reads `/api/workbench?scope=self&from=…&to=…`, validates its single member, and discards task and production content. Its department paths supply organization data when no profile exists; profile organization takes precedence. A workbench HTTP 404 leaves that capability unavailable; valid empty paths mean no assigned department. Account changes during a read reject the previous account's result.

Account-level organization aggregates exceeding 100 departments are marked unavailable as a whole, without displaying a truncated list or blocking profile, Muse group and usage reads. The complete response remains bounded to 4 MiB.

The workbench's recorded server-relay history is a separate cumulative summary, independent of the selected request-ledger period. It covers available logs from the later Beijing calendar day of account creation and recording start; it is not a complete supplier bill since registration. An initial thirty-day query is reused, and older history uses consecutive, nonoverlapping windows of at most thirty days with a fixed final date. One `requestTimeoutMs` deadline bounds the whole read; changed recording metadata, invalid ranges and incomplete later windows are rejected. Missing metering metadata or unavailable metering omits history without discarding valid departments. Nullable counters remain unknown, integer overflow never produces rounded totals, limited coverage remains explicit, and write failures mark degraded health. History and the separate request ledger overlap and must never be added together.

The request ledger covers gateway relay requests, uses inclusive UTC date ranges, and retains nullable supplier counters and ledger health. Its full-range summary stays separate from cursor-paginated request records; following a cursor retains the successful response's dates across UTC midnight. Today, seven days and thirty days are supported for this ledger; all-history paging rejects with `muse-account/unsupported-period`.

Browser sign-in opens only the configured Muse origin at its exact Desktop approval or Feishu entry URL; extra query parameters and fragments are rejected. The Host requests `provider=feishu`; a Feishu-enabled gateway redirects directly to Feishu's official authorization UI, then the user compares the Desktop code and confirms the device on a MUSE page. Gateways without Feishu support keep the original approval URL, and new gateways retain that URL for older clients that omit the provider field. The short-lived approval exchanges for a separate Desktop session. The redemption secret stays in Host memory and never reaches the UI, browser URL, agent or Session log. The Host verifies identity and writes the existing origin-bound session file before reporting success. Start, check and cancellation serialize with each other; manual login and logout first collect cancellation. A committed login uses the same model, speech and remote-desktop consumers as password login. Gateway restart or lost redemption requires a new attempt. Deploy the matching account-gateway endpoints before using the browser button; legacy authentication interfaces remain available to existing consumers.

Once authentication saves the account session, Desktop reports sign-in success even if the immediate desktop-connection or model-catalog refresh fails. Reading account status likewise treats the controller's local or explicitly verified result as authoritative; refresh failures are logged independently and scheduled catalog polling can retry them. A 401 from the provider catalog withdraws Muse routes without deleting the account session. Explicit account verification owns rejection of an invalid saved session.

Supplier credentials never reach Desktop. Every Muse model request goes to the account gateway relay with the signed-in session, and the gateway calls the supplier with keys that stay on the server. The catalog request negotiates no other transport, and any supplier address or credential field in a catalog response is discarded unread. Each catalog refresh, including the one at startup and while signed out, first deletes any `model-access.json` that older Desktop versions saved beside `session.json`; a filesystem failure other than absence fails that refresh. Keys those versions downloaded remain valid at the supplier until they are rotated there.

Model refusals and cancelled streams expose fixed diagnostics with their error category, HTTP status and retry delay when available. The Host diagnostic log records only provider, model, category, HTTP status, and a bounded supplier request ID; supplier error text, credentials, authorization headers, diagnostic request IDs and chained exceptions do not enter Session logs. Successful model content and replay metadata remain intact. Content-safety refusals retain `CONTENT_FILTER` and never become a transient retry category.

After bounded retries on the selected Muse account route, classified quota, rate limit, server, timeout, connection, and empty-response failures try other authorized, selectable suppliers in the same turn, choosing at most one model per supplier. The same model takes priority, then a model in the same family. A candidate must support images anywhere in the current history, the original model's context capacity, an explicit output limit, and an explicit reasoning effort. Each switch records the normal model selection and assembles the next step's prompt and tools again; tool calls from failed streams never execute. Exhausting candidates stops with an error. Logout, user cancellation, account or supplier authentication failure, content safety refusal, invalid requests, uncertain admission, and request deadlines never switch routes; personal providers are never selected automatically.

Each Muse model call receives a random `client_request_id`. Host diagnostics correlate its Session, provider, model and purpose with bounded response identifiers, completion reason and usage when available. Diagnostic token counts accept only nonnegative safe integers; invalid fields are omitted without changing model stream chunks. The adapter passes the public request-header preparation waterfall; only requests to the configured Muse relay origin carry `x-muse-client-request-id`. Diagnostic records exclude message bodies, credentials, complete headers and exception text; these request identifiers do not add Session events or change replay metadata. A client request identifier names one prepared call; gateway HTTP attempts have separate identifiers.

Models use each account model's declared default thinking level until the user explicitly selects another offered level. The prepared model carries that default into the logged request; models without thinking support receive no default effort. Yunying's exact `gpt-6.1-sol` model uses `max_completion_tokens` for its output limit.

On the `volcengine-ark` account route, DeepSeek V4.1 Flash `260910` and `261017` IDs with either `v4-1` or `v4.1` use `thinking.type`. The `alibaba-bailian` route's exact `deepseek-v4.1-flash-1017` ID uses `enable_thinking`. Both preserve assistant `reasoning_content` through tool continuations and honor the catalog's default effort or an explicit `off` choice. The account catalog declares each model's supported efforts.

Model menus expose only the effort levels advertised by the account catalog. Yunying GPT-6.1 Sol supports `low`, `medium`, `high`, `xhigh`, and `max`; Gemini 3.1 Pro supports `low`, `medium`, and `high`. The Session menu retains its personal-default save behavior without changing the server catalog defaults. Gemini keeps `include_thoughts: true` alongside the selected `reasoning_effort`. A requested level does not guarantee that the supplier returns a visible summary on every step.

A model choice saved during catalog refresh takes precedence over initial account default selection. The refreshed catalog remains available; an unrelated settings write failure still rejects the refresh.

An existing conversation with an unconfigured direct route can use the same exact model advertised by Muse. The Host records that change through normal model selection and request headers only while the assembled provider, model and reasoning choice still match the current selection; a newer user choice remains selected. If Muse does not advertise that model, the conversation asks the user to choose an available Muse model from the picker.

The message rating and task feedback dialogs submit to the Muse opinion inbox through the [account UI](../../client/ui-muse-account/README.md). A submission uses the saved Desktop account and retains its category and local Session/message identifiers. The optional related-excerpt checkbox starts clear; selected diagnostics contain only bounded visible request and answer text, with known credentials removed. No tool arguments, tool results, reasoning, attachments, or full Session log are sent. A confirmed inbox receipt closes the form; login, network, and account-switch failures retain the draft. An uncertain result requires checking the inbox before another submission. Administrators review all submitted opinions at `/feedback`; ordinary users see their own.

With `feedbackTools: true`, `muse_feedback_submit` submits an explicit user problem or suggestion from the calling Agent’s Session, and `muse_feedback_status` reads a receipt owned by the signed-in account. The tools expose no administrator operations. Submission requires a stable `requestId`, title, category and text; related visible excerpts remain opt-in. Retain the original key and identical content after an uncertain result. A matching legacy-server receipt is still confirmed, but reports unavailable duplicate protection and must not be resubmitted. Changing captured excerpts or feedback text under an existing key is rejected as a conflict. Status replies omit transcript, attachments and history, and remove known credentials. A saved submission is distinct from a fix or a released version.

### Account-authorized web search

With `webSearch: true`, Muse Desktop selects the `muse` search provider while retaining the existing `http` provider for `web_fetch`. The existing `web_search` tool sends each query and optional result count to the same-origin `/api/web/search` endpoint using the saved Muse session. Official search API keys remain on the server; local `DEEPSEEK_API_KEY`, model credentials and DeepSeek Account sign-in are not required. Non-Muse profiles retain their configured search providers.

Search refuses redirects, observes its own `searchRequestTimeoutMs` deadline, caps gateway JSON at 1 MiB, and returns only validated source URLs, titles, snippets or summary fallbacks, and dates. The tool's source limit remains in force. Signing out or switching accounts during a request rejects its result. Errors use fixed diagnostics without raw gateway bodies, credential values or transport exceptions; there is no automatic retry. Unloading the plugin cancels and awaits active searches. The account gateway must deploy this endpoint before a client selects the provider.

### Company media

With `mediaTools: true`, four deferred tools use the current private Muse login: `muse_media_data`, `muse_media_download`, `muse_media_task`, and `muse_media_import`. `muse_media_download` saves TikTok and Bilibili works only; a Douyin platform or any Douyin host in its URL or share text fails with `douyin-unsupported` before the login is read, and the result directs the model to `douyin_download`. Desktop enables them without asking employees for an upstream API key. The matching [company media gateway](../../../services/muse-media/gateway/README.md) checks company membership, task ownership and per-account limits. Permission rejection does not delete the Muse login. Every call captures the current login revision and rejects delivery after an account change; unload aborts and settles requests and local helpers.

Cloud submission requires a stable `requestId`; uncertainty requires querying the original job, never a new submission key. `cloud_saved` describes complete cloud storage only. `partial` exposes only individually accepted files and remains partial after importing one of them. Import uses the exact filename from the cloud manifest, including accepted spaces and parentheses, without renaming it. Manifest and import validation share the same filename policy: an ASCII letter or digit first, at most 128 characters from letters, digits, dot, underscore, hyphen, space and parentheses, with no `..` or path separators. The importer requires an initiating local workspace, rejects read-only policy and existing-file replacement, and uses the configured OS sandbox for workspace-write helpers. Complete byte counts, SHA-256, FFprobe metadata and full FFmpeg decoding must pass before publication. Metadata and decoding run through the configured managed subprocess service with the same workspace policy and bounded output. The receiver waits for those facts on its private control pipe before accepting a commit. `local_ready` identifies one verified image or video, with its source job state and file coverage; images do not establish video success. Use the existing `present` tool with the returned path for file cards and video inventory. The private helper is bundled inline, has no public executable, and receives no account credential.

<a id="data-station-douyin-downloads"></a>
### Data-station Douyin downloads

With `douyinDownloadTool: true`, the deferred `douyin_download` tool is the only Douyin video downloader. It sends the current Muse session token in `X-Muse-Account-Token` to the data station at `douyinStationPath` on the `baseUrl` origin; the public `/data/` proxy clears `Authorization`, and the station refuses requests carrying `Origin`. Requests carry no cookie, `Origin` or requester name, refuse redirects, bound the complete JSON reply with `douyinMaxReplyBytes`, and reject a reply that echoes the token. The station checks the token with the Muse gateway, admits only its team list, and records the verified member as the requester.

With `dataStation: true`, the `museAccount` remote methods `dataBoards`, `dataPeriod`, `dataStock`, `dataRush` and `dataCollector` serve the drawer's 数据 tab: data-station rankings, the 储备看板, 立即转写 and the 绿泡泡 collector state, `dataWork` reads one work's record for the 剧本 tab's source-work card, and `dataWorks` searches the station's whole collection (全收录) for the 数据 tab and the `data_station_search` tool, read at `dataStationPath` on the `baseUrl` origin with the same account token, no cookie and no `Origin`. The station runs each request as the member the token names, so 立即转写 records that member. Replies are bounded by `dataMaxReplyBytes` and validated, a reply that echoes the token is refused, and failures surface as fixed `muse-data/<code>` remote errors. The same setting registers the deferred `data_station_search` tool: it searches the whole collection by title, author, ID, description and tags on one platform or all, `dataSearchPageSize` works per page, newest observation first, and reports each work's station ID, episodes or words, platform metrics, last ranking and the first 300 characters of its description; failures come back as fixed codes with guidance.

`action: download` queues one work from a URL, share text or `aweme_id`, or every episode of one series from `mix_id` or a `douyin.com/collection/<id>` link. A `v.douyin.com` share link is resolved by one redirect read within `douyinLinkTimeoutMs`, without its body or any account credential. `action: query` reads existing records without submitting, and `action: quota` reports availability and the daily allowance that the station shares between its web page and Muse. `wait_seconds` from 0 to `douyinMaxWaitSeconds` polls records every `douyinPollIntervalMs` until every work is `done` or `failed`; cancellation ends the wait. A query requests at most `douyinListLimit` records. Results list each work's state and, when done, its public storage address; a private-mode record reads its signed address and `expiresAt`. These addresses are not local files. The station does not download a queued or saved work again, and resubmitting a failed work queues it again. Fixed codes report sign-in, team list, daily allowance, station availability, account change, unconfirmed submission, timeout and cancellation without station response text. Every request rechecks the login revision captured when the call started.

### Shared voice registration

`MuseAccountService.requestVoiceSlot` is Host-only and uses the current private Muse session to call the [shared registration coordinator](../../../services/muse-accounts/README.md#shared-voice-registration). It sends the Jubian token only as a private transport header, verifies the account revision after the response, refuses redirects, bounds strict UTF-8 coordination responses to 16 KiB and performs no retries. It is not a Remote method or model-visible credential accessor. Unconfigured servers refuse new coordinated registration; existing audio reuse and non-audio work remain available.

<a id="host-credential-reads"></a>
### Host credential reads

For a registered writing or production workbench, the Host uses its current Muse session to obtain an audience-specific, one-time code from the account gateway. The workbench redeems the code with its own verifier and service credential. The Host rejects a pending grant if the account changes. A workbench served by the Muse gateway itself receives Host requests through `requestMountedWorkbench(audience, owner, url, options)`: the Muse cookie is attached only for the current login, only on the gateway origin and only below that workbench's paths, `/jingliu/fwp/v2/` and `/jingliu/fwp/media/` for Jingliu and `/jubengongfang/v1/` for Script Workshop.

The package's main export `readMuseSession(file, baseUrl)` reads the explicitly selected private session file for one configured canonical gateway origin. An absent file or a session for another origin returns null; malformed stored data refuses. Host integrations can reuse this reader without mounting the account's model providers. The returned cookie is private Host data and must never enter Remote results, model messages or another origin's requests. [`muse-market/cloud`](../muse-market/README.md#account-bound-cloud) uses this reader with its independent `sessionFile` setting.

Successful local sign-in, sign-out and browser-login completion emit ordinary `muse-account/session-changed`; changed observed account status also emits it. The notification carries no credential or identity payload. Consumers revoke cached private capabilities and query the actual current identity again; external session-file replacements are verified by the account-bound transport on each request.

### Cloud transcription

Cloud transcription responses retain only validated provider quota categories and an optional `recovery.retry_after` delay in seconds. A lifetime quota requires restoring the original application's allowance before querying its existing task; neither this metadata nor an HTTP 429 authorizes a new paid submission.

After the native importer finishes verification and publication, the account transport sends one bounded, owner-scoped import confirmation using the exact file lease and digest. Ordinary reads, failed decodes and incomplete transfers do not confirm imports. A failed or lost confirmation is not retried and leaves the longer cloud retention period; it does not invalidate an otherwise verified local file. Old servers without a lease remain usable. Account changes and cancellation before local commit still refuse delivery; confirmation cannot roll back an already committed local file.

### Minimal configuration

The Desktop Host mounts this row from [`desktop.cordis.patch.yml`](../../../apps/desktop-host/config/desktop.cordis.patch.yml):

```yaml
- name: '@deepseek-ai/dsh-muse-account'
  config:
    baseUrl: https://muse.aigc-pipeline.cn
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | Required | HTTPS gateway origin; loopback HTTP is allowed for a local gateway. |
| `excludedModelPrefixes` | `[]` | Case-insensitive model-name prefixes omitted from account-supplied models; an optional provider path is stripped before comparison. Custom providers are unaffected. |
| `excludedModels` | `[]` | Exact `{ providerId, modelId }` pairs omitted from the account catalog. Other providers with the same model ID and personal adapters are unaffected. |
| `excludedProviderIds` | `[]` | Exact account provider IDs omitted from the catalog. IDs follow the gateway's lowercase identifier syntax; personal adapters are unaffected. |
| `hiddenProviderIds` | `[]` | Exact account provider IDs kept registered for saved Sessions but omitted from new model selections and account defaults, except for `visibleModels`. IDs follow the gateway's lowercase identifier syntax; personal adapters are unaffected. |
| `visibleModels` | `[]` | Exact `{ providerId, modelId }` pairs selectable within hidden account providers. Excluded providers and models remain excluded; other providers and personal adapters are unaffected. |
| `modelRefreshMs` | 60,000 | Model catalog refresh interval in milliseconds, from 10,000 to 3,600,000. |
| `accountHome` | Active DSH home | Absolute directory containing this product's account session file. |
| `requestTimeoutMs` | 15,000 | Account gateway request timeout in milliseconds, from 1,000 to 120,000. |
| `webSearch` | `false` | Register the `muse` search provider when the web service is present; Muse Desktop enables it. |
| `searchRequestTimeoutMs` | 60,000 | Independent account-authorized search timeout in milliseconds, from 1,000 to 120,000. |
| `modelRequestImageMaxBytes` | Adapter default (`20 MiB`) | Optional positive safe integer limiting accumulated base64 images per model request. Mount `compaction-image-offload` to log omission of the oldest image occurrences and retry; source attachments remain readable. This does not limit text output. |
| `modelRetryPolicy` | Adapter default (normal, 5 retries, 0.5–10 s) | Optional provider `retryPolicy` for every account model route, validated at load. `dsh-llm-retry` applies it to failed steps and `compaction-basic` to summary requests. |
| `feedbackTools` | `false` | Register explicit user submission and owner-scoped receipt-query tools; Muse Desktop enables them. |
| `mediaTools` | `false` | Register four deferred company media tools; Desktop enables them. |
| `mediaRequestTimeoutMs` | 60,000 | Metadata and receipt deadline in milliseconds, 1,000–120,000. |
| `mediaFileTimeoutMs` | 1,800,000 | Whole file-transfer and consumer deadline, 10,000–3,600,000 ms. |
| `mediaVerifyTimeoutMs` | 1,800,000 | Local helper and complete decoding deadline, 10,000–3,600,000 ms. |
| `mediaMaxReplyBytes` | 1,048,576 | Complete JSON reply cap, 1 KiB–16 MiB. |
| `mediaMaxFileBytes` | 536,870,912 | Per-file import byte cap; positive safe integer. |
| `mediaDirectory` | `source/media/company` | Relative destination with slash-separated letters, digits, underscores or hyphens. |
| `mediaNodePath` | `node` | Private helper Node executable; Desktop supplies its current executable. |
| `mediaFfmpegPath` | `ffmpeg` | Full-decoding executable; Desktop supplies `DSH_FFMPEG_PATH`. |
| `mediaFfprobePath` | `ffprobe` | Metadata executable; Desktop supplies `DSH_FFPROBE_PATH`. |
| `mediaCommandGraceMs` | 1,000 | Process termination grace, 100–30,000 ms. |
| `mediaCommandMaxOutputBytes` | 65,536 | Complete helper report and diagnostic cap, 1 KiB–1 MiB. |
| `mediaMaxPixels` | 67,108,864 | Maximum imported width × height; positive safe integer. |
| `mediaMaxDurationSeconds` | 7,200 | Maximum accepted video duration, 1–86,400 seconds. |
| `douyinDownloadTool` | `false` | Register the deferred data-station `douyin_download` tool; Desktop enables it. |
| `douyinStationPath` | `/data/api/muse-client/douyin` | Absolute route prefix joined to the `baseUrl` origin; slash-separated segments of letters, digits, `.`, `_`, `~` or `-`, without `.` or `..` segments or a trailing slash. |
| `douyinRequestTimeoutMs` | 15,000 | One station request and its complete reply, 1,000–120,000 ms. |
| `douyinLinkTimeoutMs` | 10,000 | One share-link redirect read, 1,000–60,000 ms. |
| `douyinMaxReplyBytes` | 1,048,576 | Complete station JSON reply cap, 1 KiB–16 MiB. |
| `douyinMaxWaitSeconds` | 60 | Largest `wait_seconds`, 0–600. |
| `douyinPollIntervalMs` | 5,000 | Pause between record queries while waiting, 1,000–60,000 ms. |
| `douyinListLimit` | 300 | Records requested by one query, 1–500; the station page holds at most 500. |
| `dataStation` | `false` | Serve the 数据 tab's data-station remote methods and register `data_station_search` and `data_station_requeue` (立即转写); Desktop enables it. |
| `dataStationPath` | `/data/api/muse-client/data` | Absolute member route prefix joined to the `baseUrl` origin, with the same segment rules as `douyinStationPath`. |
| `dataRequestTimeoutMs` | 20,000 | One data-station read or 立即转写 and its complete reply, 1,000–120,000 ms. |
| `dataMaxReplyBytes` | 8,388,608 | Complete ranking or 储备看板 JSON reply cap, 1 KiB–32 MiB. |
| `dataSearchPageSize` | 10 | Works one `data_station_search` call returns, 1–50. |
| `feedbackExcerptChars` | 1,000 | Visible characters per optional related request or answer excerpt, from 100 to 1,200. |
| `activityReportIntervalMs` | 30,000 | Minimum interval between activity reports for one login, from 1,000 to 3,600,000 milliseconds. |
| `activityRequestTimeoutMs` | 5,000 | Best-effort activity request deadline, from 100 to 30,000 milliseconds. |
| `asrRequestTimeoutMs` | 300,000 | Timeout for one compressed-audio upload and gateway response, from 10,000 to 1,800,000 milliseconds. |
| `remoteAccess` | `false` | Enable the account-bound desktop connector; Muse Desktop enables it. Requires bridge, Connection and Web server providers. |
| `remoteChunkBytes` | 32,768 | Acknowledged chunk size, from 1,024 to 32,768 bytes. |
| `remoteAckTimeoutMs` | 15,000 | Handshake and acknowledgement deadline, from 1,000 to 120,000 milliseconds. |
| `remoteReconnectMaxIntervalMs` | 60,000 | Maximum network reconnection interval, from 1,000 to 300,000 milliseconds. |

The [configuration catalog](../../../docs/config-catalog.md) is generated from plugin schemas. Mount `tools`, `llm`, `sessionProjections`, `agentDefaultModel` and `sessions` before this plugin; the Desktop Host composition supplies these required services. This package is included in the Desktop Host profile and is not a standalone application launcher.

### Desktop access from the website

When remote access is enabled, signing in or restoring the saved account starts an outbound connection. Sign in to the same account on the website to use the desktop's sessions, files and progress. The website displays **您的电脑上的 Muse 未启动** while offline and checks for reconnection. It starts no substitute cloud agent. Each installation sends its persistent UUID, hostname and operating system. Several computers can stay connected to the same account; the website selects one and keeps every tab bound to that computer. Its switch link opens the computer list in a new tab. Sessions and files remain local to each installation.

The connector exchanges the existing Host bootstrap URL for a private loopback cookie. Both that cookie and the Muse session stay in HTTP headers. Switching accounts awaits closure of the old transport. Logout detaches before contacting the gateway; a failed logout keeps that saved revision paused until a new login. Closing a browser stream removes its observer without cancelling agent work or retrying a submitted request. Revocation and expiry close access.

Committed human input in a root turn sends a best-effort `task-start` marker to `/api/muse.activity` for administrator usage statistics. Goal continuations, subagents, saved history and model-catalog refreshes do not report activity. Reports contain no task identifiers, titles, paths, messages or client timestamps; the gateway records its own time. The Host captures and rechecks the saved login revision, throttles each login with `activityReportIntervalMs`, and bounds requests with `activityRequestTimeoutMs`. Overlapping root turns coalesce, with at most one pending account capture and one pending network request. Reporting never delays a task, retries failed writes or persists a delivery queue; offline activity may therefore be absent. Plugin unload aborts and awaits pending reporting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authenticated `museAccount` Remote namespace carries [Settings UI](../../client/ui-muse-account/README.md) calls to the Host account controller. The controller sends credentials to the configured gateway, confirms the returned identity, and atomically saves an origin-bound cookie in the product home. Its Remote responses contain fixed error categories and account identity, never the password or cookie.

Account gateway requests resolve the current global fetch when no transport is injected; an explicitly injected transport remains fixed for the client lifetime.

Verified account status exposes administrator navigation only when the current gateway returns strict `admin: true` and the exact `/admin` path. The Host converts that path to its configured origin; it discards other administrator destinations. Locally cached status never reports administrator navigation, and login persistence stores only username, environment and workspace label beside the existing session fields.

The authenticated `museAccount.details` Remote reads `/api/muse.account/details` with the saved cookie, validates a response of at most 4 MiB, and discards private and unrecognized fields. A login revision change before completion rejects the result. The gateway authenticates ownership; callers cannot select another account. Direct and leased Muse model routes send one content-free terminal receipt to `/api/muse.account/usage` using the login captured with their prepared route and the existing request UUID. Relay requests are recorded by the gateway and are not reported again by Desktop. Direct receipts contain only route identifiers, status and validated counters; they never contain messages, session identifiers or supplier credentials. Receipt work does not delay or retry model output, and Host disposal cancels and drains in-flight reports.

The authenticated `museAccount.feedback` Remote receives Typert-validated identifiers and ratings, verifies the live feedback target, captures the origin-bound account revision, and rechecks it after preparing the text. It sends one same-origin JSON POST to `/api/muse.feedback` with the captured cookie and Origin header, without following redirects or retrying unknown writes. A receipt must match the username and exact submitted title, body, and category. Switching accounts during submission reports an account-change result; check the original account inbox. Muse Desktop disables the upstream Session-log delivery plugin. The typed Host `/feedback <text>` command retains its local recording behavior.

The Host-only `MuseAsrClient` reads the same saved account session for the `audio_transcribe` tool. A submit carries the receipt's optional `X-Muse-Asr-Purpose` (`subtitles` or `screenplay`); a query uses the existing account-scoped job ID. Omission preserves legacy routing. The client validates optional purpose, actual service version, accepted-queue state, fixed error categories, bounded provider diagnostics, and recovery instructions. Unknown metadata remains absent; purpose never implies a historical service version. Sentence and word timestamps remain in seconds, with invalid spans refused. Desktop exposes no provider keys, resource picker, or TOS credentials. Missing account login, gateway, or server ASR configuration has an explicit failure. The server deployment and task limits are documented in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

Host transcription calls accept a caller cancellation signal alongside the request timeout. They abort uploads and response reads, preserve the caller’s cancellation reason, and await transport or unread-body cleanup before settling. Cancellation does not revoke an already accepted gateway job.

Transcription refusals distinguish queue capacity, upload contention, account request rate, provider service limits, daily account quota, and idempotency conflicts. The client keeps validated `Retry-After` seconds and only safe diagnostic categories, operation, HTTP status, and numeric provider code; it discards response bodies, signed URLs, account/resource identities, and credentials. It never retries a submission inside an HTTP call; the receipt-owning tool controls explicit recovery.

No runtime invariant companion is published because the account controller and model registry own the observable account and routing state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client](../../mcp/mcp-client/README.md) — server-qualified tool names and lifecycle.
- [Desktop composition](../../../apps/desktop/README.md) — the shipped application profile.
- [Built-in KB removal](../../../docs/upgrade-guide/v0.2.1-alpha.1/muse-account-kb-removal/guide.md) — removed tools and custom MCP configuration.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Model requests use the selected account provider and model. Optional account search returns validated sources through the existing `web_search` tool. With `douyinDownloadTool`, the deferred [`douyin_download`](../../../docs/tool-catalog.md#deepseek-aidsh-muse-account) schema describes data-station Douyin downloads in Chinese; its results contain work states, public storage addresses and fixed failure codes. With `dataStation`, the deferred `data_station_search` schema describes the whole-collection search in Chinese; one page of results is compact JSON of at most `dataSearchPageSize` works. The package contributes no account-status or knowledge-base tool schemas. Passwords and cookies stay outside tool arguments and results. When the configured model image budget is exceeded, the composed image-offload executor logs placeholders for the oldest image occurrences; the model can read their original attachments again.

#### Token effect

When `feedbackTools` is enabled, two feedback tool schemas join the model request; receipt results enter normal tool history. With feedback and media tools disabled, the package adds no tool schemas or system-prompt text. Enabling `mediaTools` registers four deferred schemas; discovery controls admission, while accepted results enter ordinary logged tool history. Enabling `douyinDownloadTool` registers one deferred schema; a whole-series result lists every returned episode with its address, so up to `douyinListLimit` work entries enter tool history. Optional account search uses the existing web tool schema and appends its returned sources to the conversation.

#### KV Cache effect

Account settings and status remain Host and Client data. The official account routes `deepseek-flash` and `deepseek-v4.1-flash-261017` keep changed system text in conversation order, preserving the earlier request prefix. Other account routes keep their declared prompt behavior; tool additions remain subject to each route's tool-history support. Model selection still determines which provider cache can be reused.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the bundled Desktop account flow.

- **Same-user file access** — the saved cookie is outside the model conversation, but an agent process running as the same OS user may be able to read the session file through file tools. UI and Remote routing do not provide complete isolation; stronger separation requires OS credential storage, a separate account, or narrower sandbox read permissions.
- **Gateway dependency** — account-authorized models, web search and speech require matching deployed gateway services. Source packaging alone does not enable them.
- **Usage coverage** — account history may still contain direct-route counts that older clients reported; those are client reports, not supplier billing records. Historical calls before tracking are not reconstructed.
- **Data-station dependency** — `douyin_download` requires the data station's account-token routes under `douyinStationPath` and its team list. Without them, every action reports `unavailable` or `team-access-required`; no local downloader takes over.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
