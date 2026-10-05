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

Muse Desktop offers MUSE sign-in before model setup on a blank first run; **Sign in later** leaves the account available from the sidebar and **Settings → MUSE Account**. Opening the page refreshes the model catalog; use **Verify status** to ask the gateway to confirm the account identity. Enter a username and password to sign in. The registration choice starts clear; select it if you want MUSE to try creating that username after a failed sign-in. A successful request clears the password field. The same session loads the website model catalog and authorizes model requests, knowledge-base access, and speech transcription. A fresh profile selects the first Muse model automatically; an old direct default without its own configured credential selects the corresponding Muse route. Models settings still accepts custom providers and credentials, and configured custom defaults remain selected. Signing out removes only Muse routes. The official DeepSeek route and GLM-5.3 models explicitly supply their thinking protocol and required `reasoning_content` field through the Muse proxy; model history never depends on guessing the upstream vendor from the proxy URL.

An existing conversation with an unconfigured direct route can use the same exact model advertised by Muse. The Host records that change through normal model selection and request headers only while the assembled provider, model and reasoning choice still match the current selection; a newer user choice remains selected. If Muse does not advertise that model, the conversation asks the user to choose an available Muse model from the picker.

The message rating and task feedback dialogs submit to the same Muse opinion inbox as the sidebar Feedback page. A submission uses the saved Desktop account and retains its category and local Session/message identifiers. The optional related-excerpt checkbox starts clear; selected diagnostics contain only bounded visible request and answer text, with known credentials removed. No tool arguments, tool results, reasoning, attachments, or full Session log are sent. A confirmed inbox receipt closes the form; login, network, and account-switch failures retain the draft. An uncertain result requires checking the inbox before another submission. Administrators review all submitted opinions at `/feedback`; ordinary users see their own.

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
| `excludedModelPrefixes` | `[]` | Case-insensitive model ID prefixes omitted from account-supplied models; custom providers are unaffected. |
| `modelRefreshMs` | 60,000 | Model catalog refresh interval in milliseconds, from 10,000 to 3,600,000. |
| `accountHome` | Active DSH home | Absolute directory containing this product's account session file. |
| `requestTimeoutMs` | 15,000 | Account and KB access request timeout in milliseconds, from 1,000 to 120,000. |
| `feedbackExcerptChars` | 1,000 | Visible characters per optional related request or answer excerpt, from 100 to 1,200. |
| `asrRequestTimeoutMs` | 300,000 | Timeout for one compressed-audio upload and gateway response, from 10,000 to 1,800,000 milliseconds. |
| `remoteAccess` | `false` | Enable the account-bound desktop connector; Muse Desktop enables it. Requires bridge, Connection and Web server providers. |
| `remoteChunkBytes` | 32,768 | Acknowledged chunk size, from 1,024 to 32,768 bytes. |
| `remoteAckTimeoutMs` | 15,000 | Handshake and acknowledgement deadline, from 1,000 to 120,000 milliseconds. |
| `remoteReconnectMaxIntervalMs` | 60,000 | Maximum network reconnection interval, from 1,000 to 300,000 milliseconds. |

The [configuration catalog](../../../docs/config-catalog.md) is generated from plugin schemas. Mount `tools`, `llm`, `sessionProjections` and `agentDefaultModel` before this plugin; the Desktop Host composition supplies these required services. This package is included in the Desktop Host profile and is not a standalone application launcher.

### Desktop access from the website

When remote access is enabled, signing in or restoring the saved account starts an outbound connection. Sign in to the same account on the website to use the desktop's sessions, files and progress. The website displays **您的电脑上的 Muse 未启动** while offline and checks for reconnection. It starts no substitute cloud agent. Each installation sends its persistent UUID, hostname and operating system. Several computers can stay connected to the same account; the website selects one and keeps every tab bound to that computer. Its switch link opens the computer list in a new tab. Sessions and files remain local to each installation.

The connector exchanges the existing Host bootstrap URL for a private loopback cookie. Both that cookie and the Muse session stay in HTTP headers. Switching accounts awaits closure of the old transport. Logout detaches before contacting the gateway; a failed logout keeps that saved revision paused until a new login. Closing a browser stream removes its observer without cancelling agent work or retrying a submitted request. Revocation and expiry close access.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authenticated `museAccount` Remote namespace carries [Settings UI](../../client/ui-muse-account/README.md) calls to the Host account controller. The controller sends credentials to the configured gateway, confirms the returned identity, and atomically saves an origin-bound cookie in the product home. Its Remote responses contain fixed error categories and account identity, never the password or cookie.

The authenticated `museAccount.feedback` Remote verifies the live feedback target, captures the origin-bound account revision, and rechecks it after preparing the text. It sends one same-origin JSON POST to `/api/muse.feedback` with the captured cookie and Origin header, without following redirects or retrying unknown writes. A receipt must match the username and exact submitted title, body, and category. Switching accounts during submission reports an account-change result; check the original account inbox. Muse Desktop disables the upstream Session-log delivery plugin. The typed Host `/feedback <text>` command retains its local recording behavior.

The Host starts a bundled local MCP child and waits for tool discovery. For each KB call, the child exchanges the current saved cookie through `/api/kb/access` for a fresh short-lived bearer and calls the same-origin MCP endpoint; it never persists or returns the bearer. `muse_kb_ingest_script` submits up to 12 reviewed Markdown episodes or chapters, with a 2 MiB total request limit, and reports each saved, duplicate, or failed section. The nine `muse_kb_wiki_*` tools expose immutable source capture, directory browsing, full-text search, source/page reading, cited page writes, history, links, status, and migration preview. Scope defaults to `private`; `project` requires an account-local `project_id`, and `shared` uses explicit grants and administrator-only writes. Page writes carry original-source character citations and `expected_revision`; conflicts require reading and merging the current page before retrying. Capture creates a pending source page, while migration preview changes neither originals nor grants. Legacy reads retain their 6,000-character pages and 24,000-character opening limit.

Local failures return fixed codes without upstream response text. Bounded recognized Wiki errors distinguish revision conflicts, busy writes, invalid citations, unresolved links, and access refusal. The model receives fixed recovery guidance for retryable Wiki edits; unknown errors and bearer-containing results remain rejected. Each call rereads the account session, so refreshed login and sign-out apply without restarting the MCP child.

The Host-only `MuseAsrClient` reads the same saved account session for the `audio_transcribe` tool. A submit carries the receipt's optional `X-Muse-Asr-Purpose` (`subtitles` or `screenplay`); a query uses the existing account-scoped job ID. Omission preserves legacy routing. The client accepts optional safe purpose and service-version metadata and retains sentence and word timestamps in seconds, refusing invalid spans. Desktop exposes no provider keys, resource picker, or TOS credentials. Missing account login, gateway, or server ASR configuration has an explicit failure. The server deployment and task limits are documented in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

Transcription refusals distinguish queue capacity, upload contention, account request rate, provider service limits, daily account quota, and idempotency conflicts. The client keeps validated `Retry-After` seconds but discards upstream diagnostics. It never retries a submission inside an HTTP call; the receipt-owning tool controls explicit recovery.

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

After the bundled MCP server connects, the model receives sixteen schemas: account status, the four legacy source operations, nine scoped Wiki operations, participation reporting, and authorized project portfolios. Wiki results contain source/page IDs, digests, revisions, citations, links, bounded excerpts, and continuation offsets. The write tools distinguish immutable captures from synthesized pages and reviewed script sections. `muse_kb_wiki_record_project` distinguishes a saved contribution from an unsynchronized overview; `muse_kb_wiki_project_portfolio` identifies own-account or authorized cross-account access. Password, cookie, and bearer are absent from tool arguments and results. Model-visible arguments and results remain Session data.

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
