---
description: "Sign in to MUSE from Desktop Settings and let the agent search and page through account-authorized script and Wiki sources."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

English | [中文](README.zh.md)

## Summary

Sign in to MUSE from Desktop Settings, check the saved account, and sign out without entering a password in a model conversation. The agent can search the knowledge base and read authorized script or Wiki pages by ID. Editing mode can read a script opening before drafting. Account access requires the configured MUSE gateway and a server-side source grant.

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

In Muse Desktop, open **Settings → MUSE Account**. The page first shows the locally saved status; use **Verify status** to ask the gateway to confirm it. Enter a username and password to sign in. The registration choice starts clear; select it if you want MUSE to try creating that username after a failed sign-in. A successful request clears the password field.

### Minimal configuration

The Desktop Host mounts this row from [`desktop.cordis.patch.yml`](../../../apps/desktop-host/config/desktop.cordis.patch.yml):

```yaml
- name: '@deepseek-ai/dsh-muse-account'
  config:
    baseUrl: https://dev.muse.aigc-pipeline.cn
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | Required | HTTPS gateway origin; loopback HTTP is allowed for a local gateway. |
| `accountHome` | Active DSH home | Absolute directory containing this product's account session file. |
| `requestTimeoutMs` | 15,000 | Account and KB access request timeout in milliseconds, from 1,000 to 120,000. |

The [configuration catalog](../../../docs/config-catalog.md) is generated from plugin schemas. This package is included in the Desktop Host profile and is not a standalone application launcher.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authenticated `museAccount` Remote namespace carries Settings calls to the Host account controller. The controller sends credentials to the configured gateway, confirms the returned identity, and atomically saves an origin-bound cookie in the product home. Its Remote responses contain fixed error categories and account identity, never the password or cookie.

The Host starts a bundled local MCP child and waits for its tool discovery. The child reads the saved cookie when a knowledge-base tool runs, exchanges it for a short-lived bearer through `/api/kb/access`, and calls the same-origin read-only MCP endpoint. It does not persist or return the bearer. Search returns authorized IDs with `类型` and `标定` text; `read` pages through a granted source or Wiki document; `read_opening` accepts only a granted `SRC-...` source marked `标定: viral-script` and pages through its first 24,000 characters. The MCP client presents these tools in its generic text card; each read returns a 6,000-character page plus continuation metadata, and local failures return fixed codes without upstream response text.

This package has no `./invariant`: the account status and registered MCP tools are available through their owning service and tool registry, with no independent observation that could diverge.

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

After the bundled MCP server connects, the model receives the schemas for `mcp__muse-account__muse_account_status`, `mcp__muse-account__muse_kb_search`, `mcp__muse-account__muse_kb_read`, and `mcp__muse-account__muse_kb_read_opening`. A status call returns local or gateway-confirmed identity. Search returns excerpts and IDs; each read call returns one 6,000-character page with source and continuation information. The password, cookie, and bearer have no model tool argument or result field. Tool call arguments and results that do reach the model remain Session data.

#### Token effect

The four tool schemas add a stable request cost while the server is mounted. Calls append the returned text to the conversation; each local KB result is capped at 128 KiB and the gateway provides 6,000-character pages. This package adds no system-prompt text.

#### KV Cache effect

Stable tool schemas preserve an already reusable request prefix. A new tool result extends the conversation; account status and KB content can change between calls without replacing earlier logged tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the bundled Desktop account flow.

- **Same-user file access** — the saved cookie is outside the model conversation, but an agent process running as the same OS user may be able to read the session file through file tools. UI and Remote routing do not provide complete isolation; stronger separation requires OS credential storage, a separate account, or narrower sandbox read permissions.
- **Gateway dependency** — login and knowledge-base reads require the configured gateway. The integration tests use local substitutes; live account login, source grants, and a remote MCP round trip remain unverified here.
- **Agent instruction** — editing mode asks the agent to read relevant opening pages before drafting; the Host does not enforce a prewriting gate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
