---
description: "Sign in to MUSE and let the agent save reviewed scripts privately, then search and read account-authorized sources."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

English | [中文](README.zh.md)

## Summary

Sign in to MUSE from Desktop Settings without entering a password in a model conversation. The agent can save reviewed scripts and immutable originals privately, then synthesize cited Wiki pages in account or project scope. It can browse directories, search full text, follow links, and read historical revisions alongside administrator-granted references. These operations require a configured Muse gateway.

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

Muse Desktop offers MUSE sign-in before model setup on a blank first run; **Sign in later** leaves the account available from the sidebar and **Settings → MUSE Account**. Opening the page refreshes the model catalog; use **Verify status** to ask the gateway to confirm the account identity. The account page starts Feishu browser sign-in without username, password or registration fields. The same session loads the website model catalog and authorizes model requests, knowledge-base access, and speech transcription. A fresh profile selects the first Muse model automatically; an old direct default without its own configured credential selects the corresponding Muse route. Models settings still accepts custom providers and credentials, and configured custom defaults remain selected. Signing out removes only Muse routes. The official DeepSeek route and GLM-5.3 models explicitly supply their thinking protocol and required `reasoning_content` field in both transports; model history never depends on guessing the upstream vendor from the proxy URL. Official Zhipu GLM-5.3 requests retain historical thinking with `clear_thinking: false` when thinking is enabled and send `tool_stream: true` when tools are present, so tool arguments can arrive incrementally.

Browser sign-in opens only the configured Muse origin at its exact Desktop approval or Feishu entry URL; extra query parameters and fragments are rejected. The Host requests `provider=feishu`; a Feishu-enabled gateway redirects directly to Feishu's official authorization UI, then the user compares the Desktop code and confirms the device on a MUSE page. Gateways without Feishu support keep the original approval URL, and new gateways retain that URL for older clients that omit the provider field. The short-lived approval exchanges for a separate Desktop session. The redemption secret stays in Host memory and never reaches the UI, browser URL, agent or Session log. The Host verifies identity and writes the existing origin-bound session file before reporting success. Start, check and cancellation serialize with each other; manual login and logout first collect cancellation. A committed login uses the same model, speech, knowledge-base and remote-desktop consumers as password login. Gateway restart or lost redemption requires a new attempt. Deploy the matching account-gateway endpoints before using the browser button; legacy authentication interfaces remain available to existing consumers.

Once authentication saves the account session, Desktop reports sign-in success even if the immediate desktop-connection or model-catalog refresh fails. Reading account status likewise treats the controller's local or explicitly verified result as authoritative; refresh failures are logged independently and scheduled catalog polling can retry them. A 401 from either the provider catalog or direct-access endpoint withdraws Muse routes and removes only that login revision's model-access credentials without deleting the account session. Explicit account verification owns rejection of an invalid saved session.

When the gateway explicitly enables Desktop direct access, Muse downloads the supplier keys after login, stores `model-access.json` beside `session.json` with owner-only POSIX permissions, and streams directly to each supplier. Keys stay out of model catalogs shown to the UI, profile settings and Session logs; they are recoverable by the local OS user. Windows protection depends on the account directory ACL. Refresh retrieves current keys; startup requires online authorization rather than trusting the stored file. Logout or confirmed session rejection withdraws models, cancels requests and removes that login’s file. A concurrent newer login is preserved. Host disposal withdraws models immediately and awaits pending refresh and private-file operations; cancelled saves are removed before disposal completes, and late completions cannot register models. The gateway cannot revoke a key copied outside Muse, and a disabled account may remain usable inside Muse until its next successful authorization refresh. Supplier revocation or rotation is required to stop copied-key use.

The gateway may route individual providers through its relay while other providers connect directly. Desktop negotiates `mixed-v1` and `leased-v1` Zhipu access; when offered `transport: leased`, it acquires a temporary credential for each supplier stream without saving it to `model-access.json`. Only the model ID reaches admission; messages, images and replies travel directly to the supplier. The Host periodically checks account authorization, cancels on rejection or the request deadline, and reports completion after stream teardown. An interrupted admission or unreadable response returns `MODEL_ACCESS_UNCERTAIN`, which the default retry policy does not repeat; the gateway retains any issued reservation until its deadline. Malformed access JSON returns `INVALID_CONFIG`, caller cancellation returns `ABORTED`, and HTTP refusals retain their status and valid retry delay with the corresponding authentication, rate-limit, server or invalid-request category. This adds no retry of an ambiguous admission or supplier call. Older gateways continue to advertise relay. See the [gateway admission settings](../../../services/muse-accounts/README.md) for durable reservation recovery, deadlines, and the limits of JWT revocation and supplier concurrency.

After admission succeeds, a failed account-liveness check returns non-retryable `MODEL_ACCESS_CHECK_FAILED`, retaining a known HTTP status and valid retry delay. Reaching the access deadline returns non-retryable `MODEL_REQUEST_DEADLINE`. Caller cancellation remains `ABORTED`. These failures abort supplier work, settle the checker and attempt release of the original reservation without acquiring another one; failed release retains the server reservation until its deadline.

Model refusals and cancelled streams expose fixed diagnostics with their error category, HTTP status and retry delay when available. The Host diagnostic log records only provider, model, category, HTTP status, and a bounded supplier request ID; supplier error text, credentials, authorization headers, diagnostic request IDs and chained exceptions do not enter Session logs. Successful model content and replay metadata remain intact. Content-safety refusals retain `CONTENT_FILTER` and never become a transient retry category.

Models use each account model's declared default thinking level until the user explicitly selects another offered level. The prepared model carries that default into the logged request; models without thinking support receive no default effort.

A model choice saved during catalog refresh takes precedence over initial account default selection. The refreshed catalog remains available; an unrelated settings write failure still rejects the refresh.

An existing conversation with an unconfigured direct route can use the same exact model advertised by Muse. The Host records that change through normal model selection and request headers only while the assembled provider, model and reasoning choice still match the current selection; a newer user choice remains selected. If Muse does not advertise that model, the conversation asks the user to choose an available Muse model from the picker.

The message rating and task feedback dialogs submit to the Muse opinion inbox; **Muse Bot settings → Feedback** opens the native Session feedback form described by the [account UI](../../client/ui-muse-account/README.md). A submission uses the saved Desktop account and retains its category and local Session/message identifiers. The optional related-excerpt checkbox starts clear; selected diagnostics contain only bounded visible request and answer text, with known credentials removed. No tool arguments, tool results, reasoning, attachments, or full Session log are sent. A confirmed inbox receipt closes the form; login, network, and account-switch failures retain the draft. An uncertain result requires checking the inbox before another submission. Administrators review all submitted opinions at `/feedback`; ordinary users see their own.

### Shared voice registration

`MuseAccountService.requestVoiceSlot` is Host-only and uses the current private Muse session to call the [shared registration coordinator](../../../services/muse-accounts/README.md#shared-voice-registration). It sends the Jubian token only as a private transport header, verifies the account revision after the response, refuses redirects, bounds strict UTF-8 coordination responses to 16 KiB and performs no retries. It is not a Remote method or model-visible credential accessor. Unconfigured servers refuse new coordinated registration; existing audio reuse and non-audio work remain available.

### Cloud transcription

Cloud transcription responses retain only validated provider quota categories and an optional `recovery.retry_after` delay in seconds. A lifetime quota requires restoring the original application's allowance before querying its existing task; neither this metadata nor an HTTP 429 authorizes a new paid submission.

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
| `hiddenProviderIds` | `[]` | Exact account provider IDs kept registered for saved Sessions but omitted from new model selections and account defaults. IDs follow the gateway's lowercase identifier syntax; personal adapters are unaffected. |
| `modelRefreshMs` | 60,000 | Model catalog refresh interval in milliseconds, from 10,000 to 3,600,000. |
| `accountHome` | Active DSH home | Absolute directory containing this product's account session file. |
| `requestTimeoutMs` | 15,000 | Account and KB access request timeout in milliseconds, from 1,000 to 120,000. |
| `modelRequestImageMaxBytes` | Adapter default (`20 MiB`) | Optional positive safe integer limiting accumulated base64 images per model request. Mount `compaction-image-offload` to log omission of the oldest image occurrences and retry; source attachments remain readable. This does not limit text output. |
| `feedbackExcerptChars` | 1,000 | Visible characters per optional related request or answer excerpt, from 100 to 1,200. |
| `activityReportIntervalMs` | 30,000 | Minimum interval between activity reports for one login, from 1,000 to 3,600,000 milliseconds. |
| `activityRequestTimeoutMs` | 5,000 | Best-effort activity request deadline, from 100 to 30,000 milliseconds. |
| `asrRequestTimeoutMs` | 300,000 | Timeout for one compressed-audio upload and gateway response, from 10,000 to 1,800,000 milliseconds. |
| `remoteAccess` | `false` | Enable the account-bound desktop connector; Muse Desktop enables it. Requires bridge, Connection and Web server providers. |
| `remoteChunkBytes` | 32,768 | Acknowledged chunk size, from 1,024 to 32,768 bytes. |
| `remoteAckTimeoutMs` | 15,000 | Handshake and acknowledgement deadline, from 1,000 to 120,000 milliseconds. |
| `remoteReconnectMaxIntervalMs` | 60,000 | Maximum network reconnection interval, from 1,000 to 300,000 milliseconds. |

The [configuration catalog](../../../docs/config-catalog.md) is generated from plugin schemas. Mount `tools`, `llm`, `sessionProjections` and `agentDefaultModel` before this plugin; the Desktop Host composition supplies these required services. This package is included in the Desktop Host profile and is not a standalone application launcher.

### Desktop access from the website

When remote access is enabled, signing in or restoring the saved account starts an outbound connection. Sign in to the same account on the website to use the desktop's sessions, files and progress. The website displays **您的电脑上的 Muse 未启动** while offline and checks for reconnection. It starts no substitute cloud agent. Each installation sends its persistent UUID, hostname and operating system. Several computers can stay connected to the same account; the website selects one and keeps every tab bound to that computer. Its switch link opens the computer list in a new tab. Sessions and files remain local to each installation.

The connector exchanges the existing Host bootstrap URL for a private loopback cookie. Both that cookie and the Muse session stay in HTTP headers. Switching accounts awaits closure of the old transport. Logout detaches before contacting the gateway; a failed logout keeps that saved revision paused until a new login. Closing a browser stream removes its observer without cancelling agent work or retrying a submitted request. Revocation and expiry close access.

Committed human input in a root turn sends a best-effort `task-start` marker to `/api/muse.activity` for administrator usage statistics. Goal continuations, subagents, saved history and model-catalog refreshes do not report activity. Reports contain no task identifiers, titles, paths, messages or client timestamps; the gateway records its own time. The Host captures and rechecks the saved login revision, throttles each login with `activityReportIntervalMs`, and bounds requests with `activityRequestTimeoutMs`. Reporting never delays a task, retries failed writes or persists a delivery queue; offline activity may therefore be absent. Plugin unload aborts and awaits pending reporting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authenticated `museAccount` Remote namespace carries [Settings UI](../../client/ui-muse-account/README.md) calls to the Host account controller. The controller sends credentials to the configured gateway, confirms the returned identity, and atomically saves an origin-bound cookie in the product home. Its Remote responses contain fixed error categories and account identity, never the password or cookie.

Account gateway requests resolve the current global fetch when no transport is injected; an explicitly injected transport remains fixed for the client lifetime.

Verified account status exposes administrator navigation only when the current gateway returns strict `admin: true` and the exact `/admin` path. The Host converts that path to its configured origin; it discards other administrator destinations. Locally cached status never reports administrator navigation, and login persistence stores only username, environment and workspace label beside the existing session fields.

The authenticated `museAccount.feedback` Remote receives Typert-validated identifiers and ratings, verifies the live feedback target, captures the origin-bound account revision, and rechecks it after preparing the text. It sends one same-origin JSON POST to `/api/muse.feedback` with the captured cookie and Origin header, without following redirects or retrying unknown writes. A receipt must match the username and exact submitted title, body, and category. Switching accounts during submission reports an account-change result; check the original account inbox. Muse Desktop disables the upstream Session-log delivery plugin. The typed Host `/feedback <text>` command retains its local recording behavior.

The Host runs the package's built `lib/types/mcp-server.js` under plain Node and waits for MCP tool discovery. Source profiles mounting this plugin require `pnpm run build` first. For each KB call, the child exchanges the current saved cookie through `/api/kb/access` for a fresh short-lived bearer and calls the same-origin MCP endpoint; it never persists or returns the bearer. `muse_kb_ingest_script` submits up to 12 reviewed Markdown episodes or chapters, with a 2 MiB total request limit, and reports each saved, duplicate, or failed section. The nine `muse_kb_wiki_*` tools expose immutable source capture, directory browsing, full-text search, source/page reading, cited page writes, history, links, status, and migration preview. Scope defaults to `private`; `project` requires an account-local `project_id`, and `shared` uses explicit grants and administrator-only writes. Page writes carry original-source character citations and `expected_revision`; conflicts require reading and merging the current page before retrying. Capture creates a pending source page, while migration preview changes neither originals nor grants. Legacy reads retain their 6,000-character pages and 24,000-character opening limit.

The MCP SDK validates remote response fields; the local bridge accepts only text blocks. Local failures return fixed codes without upstream response text. Bounded recognized Wiki errors distinguish revision conflicts, busy writes, invalid citations, unresolved links, and access refusal. The model receives fixed recovery guidance for retryable Wiki edits; unknown errors and bearer-containing results remain rejected. Each call rereads the account session, so refreshed login and sign-out apply without restarting the MCP child.

The Host-only `MuseAsrClient` reads the same saved account session for the `audio_transcribe` tool. A submit carries the receipt's optional `X-Muse-Asr-Purpose` (`subtitles` or `screenplay`); a query uses the existing account-scoped job ID. Omission preserves legacy routing. The client validates optional purpose, actual service version, accepted-queue state, fixed error categories, bounded provider diagnostics, and recovery instructions. Unknown metadata remains absent; purpose never implies a historical service version. Sentence and word timestamps remain in seconds, with invalid spans refused. Desktop exposes no provider keys, resource picker, or TOS credentials. Missing account login, gateway, or server ASR configuration has an explicit failure. The server deployment and task limits are documented in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

Host transcription calls accept a caller cancellation signal alongside the request timeout. They abort uploads and response reads, preserve the caller’s cancellation reason, and await transport or unread-body cleanup before settling. Cancellation does not revoke an already accepted gateway job.

Transcription refusals distinguish queue capacity, upload contention, account request rate, provider service limits, daily account quota, and idempotency conflicts. The client keeps validated `Retry-After` seconds and only safe diagnostic categories, operation, HTTP status, and numeric provider code; it discards response bodies, signed URLs, account/resource identities, and credentials. It never retries a submission inside an HTTP call; the receipt-owning tool controls explicit recovery.

No runtime invariant companion is published because account status and registered MCP tools are available through their owning service and tool registry, with no independent observation that could diverge.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client](../../mcp/mcp-client/README.md) — server-qualified tool names and lifecycle.
- [Desktop composition](../../../apps/desktop/README.md) — the shipped application profile.
- [Account and KB decision](../../../.agents/notes/implemented/feature/2026-09-28-muse-account-kb-access.md) — credential and source-access choices.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

After the bundled MCP server connects, the model receives sixteen schemas: account status, the four legacy source operations, nine scoped Wiki operations, participation reporting, and authorized project portfolios. Wiki results contain source/page IDs, digests, revisions, citations, links, bounded excerpts, and continuation offsets. The write tools distinguish immutable captures from synthesized pages and reviewed script sections. `muse_kb_wiki_record_project` distinguishes a saved contribution from an unsynchronized overview; `muse_kb_wiki_project_portfolio` identifies own-account or authorized cross-account access. Password, cookie, and bearer are absent from tool arguments and results. Model-visible arguments and results remain Session data. When the configured model image budget is exceeded, the composed image-offload executor logs placeholders for the oldest image occurrences; the model can read their original attachments again.

#### Token effect

The sixteen tool schemas add a stable request cost while the server is mounted. Calls append returned text to the conversation; legacy results are capped at 128 KiB, while Wiki results allow up to 4 MiB for link graphs and citations. Reads provide 6,000-character pages. Results above the relevant limit are rejected, including unusually large ambiguous-link candidate lists. This package adds no system-prompt text.

#### KV Cache effect

Stable tool schemas preserve an already reusable request prefix. A new tool result extends the conversation; account status and KB content can change between calls without replacing earlier logged tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the bundled Desktop account flow.

- **Same-user file access** — the saved cookie is outside the model conversation, but an agent process running as the same OS user may be able to read the session file through file tools. UI and Remote routing do not provide complete isolation; stronger separation requires OS credential storage, a separate account, or narrower sandbox read permissions.
- **Gateway dependency** — account-private writes and KB reads require the deployed gateway with a private user root and explicit shared-document grants. Source packaging alone does not activate them.
- **Participation reporting** — the tool saves and verifies the agent's report, without independently checking artifacts or proving completion. Presets prompt milestone updates; they do not observe every shell operation. Minimal mode retains local pending records because it has no Wiki tools.
- **Agent instruction** — editing mode prompts the agent to read useful script and case material before drafting; the Host does not enforce a prewriting gate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
