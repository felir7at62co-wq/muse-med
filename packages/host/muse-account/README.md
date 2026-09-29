---
description: "Sign in to MUSE and let the agent save reviewed scripts privately, then search and read account-authorized sources."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

English | [中文](README.zh.md)

## Summary

Sign in to MUSE from Desktop Settings without entering a password in a model conversation. The agent can save reviewed scripts from authorized video or novel material to this account's private knowledge base, then search and read them by ID. It can also read administrator-granted script and Wiki references. These operations require a configured Muse gateway.

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

Muse Desktop offers MUSE sign-in before model setup on a blank first run; **Sign in later** leaves the account available from the sidebar and **Settings → MUSE Account**. Opening the page refreshes the model catalog; use **Verify status** to ask the gateway to confirm the account identity. Enter a username and password to sign in. The registration choice starts clear; select it if you want MUSE to try creating that username after a failed sign-in. A successful request clears the password field. The same session loads the website model catalog and authorizes model requests, knowledge-base access, and speech transcription. A fresh profile selects the first Muse model automatically. Models settings still accepts custom providers and credentials; an explicit custom default is preserved. Signing out removes only Muse routes. The official DeepSeek route explicitly supplies its thinking protocol and required `reasoning_content` field through the Muse proxy; model history never depends on guessing the upstream vendor from the proxy URL.

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
| `asrRequestTimeoutMs` | 300,000 | Timeout for one compressed-audio upload and gateway response, from 10,000 to 1,800,000 milliseconds. |

The [configuration catalog](../../../docs/config-catalog.md) is generated from plugin schemas. This package is included in the Desktop Host profile and is not a standalone application launcher.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authenticated `museAccount` Remote namespace carries [Settings UI](../../client/ui-muse-account/README.md) calls to the Host account controller. The controller sends credentials to the configured gateway, confirms the returned identity, and atomically saves an origin-bound cookie in the product home. Its Remote responses contain fixed error categories and account identity, never the password or cookie.

The Host starts a bundled local MCP child and waits for tool discovery. For each KB call, the child exchanges the saved cookie through `/api/kb/access` for a short-lived bearer and calls the same-origin MCP endpoint; it never persists or returns the bearer. `muse_kb_ingest_script` submits up to 12 reviewed Markdown episodes or chapters, with a 2 MiB total request limit, and reports each saved, duplicate, or failed section. Search returns the account's private `private/SRC-...` IDs and administrator-granted shared IDs; read pages either source, while opening reads stop after 24,000 characters. Each read returns a 6,000-character page and continuation data; local failures return fixed codes without upstream response text.

The Host-only `MuseAsrClient` reads the same saved account session for the `audio_transcribe` tool. It sends audio and queries account-scoped job IDs through the gateway; the client validates and retains sentence and word timestamps in seconds, refusing invalid spans. No ASR or TOS credential setting appears in Desktop. Missing account login, gateway, or server ASR configuration has an explicit failure. The server deployment and task limits are documented in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

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

After the bundled MCP server connects, the model receives the schemas for `mcp__muse-account__muse_account_status`, `mcp__muse-account__muse_kb_ingest_script`, `mcp__muse-account__muse_kb_search`, `mcp__muse-account__muse_kb_read`, and `mcp__muse-account__muse_kb_read_opening`. The write tool accepts reviewed script text and source identifiers, then returns an outcome and private ID per section. Search returns excerpts and IDs; each read returns one 6,000-character page and continuation information. Password, cookie, and bearer are absent from tool arguments and results. Model-visible arguments and results remain Session data.

#### Token effect

The five tool schemas add a stable request cost while the server is mounted. Calls append returned text to the conversation; each local KB result is capped at 128 KiB and the gateway provides 6,000-character pages. This package adds no system-prompt text.

#### KV Cache effect

Stable tool schemas preserve an already reusable request prefix. A new tool result extends the conversation; account status and KB content can change between calls without replacing earlier logged tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the bundled Desktop account flow.

- **Same-user file access** — the saved cookie is outside the model conversation, but an agent process running as the same OS user may be able to read the session file through file tools. UI and Remote routing do not provide complete isolation; stronger separation requires OS credential storage, a separate account, or narrower sandbox read permissions.
- **Gateway dependency** — account-private writes and KB reads require the deployed gateway with a private user root and explicit shared-document grants. Source packaging alone does not activate them; live login, grants, and a remote MCP round trip remain unverified here.
- **Agent instruction** — editing mode prompts the agent to read useful script and case material before drafting; the Host does not enforce a prewriting gate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
