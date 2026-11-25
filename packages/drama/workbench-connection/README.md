---
kind: package-reference
description: Script Workshop sessions for the signed-in Muse user and the Muse-account sign-in core shared with the Jingliu connection.
---

# Workbench connection

English | [中文](README.zh.md)

## Summary

The default export is the Host service `workshopConnection`. It opens Script Workshop sessions as the user signed in to Muse, so Workshop tools act with that user's own Workshop account and see only that user's jobs. The `@deepseek-ai/dsh-workbench-connection/transport` entry exports `WorkbenchSessions`, the sign-in and request core that `@deepseek-ai/dsh-jingliu-connection` uses for Jingliu. Native Workshop and Jingliu tokens stay in Host memory and never reach model input, tool arguments or tool results.

## Table of Contents

- [Configure the Workshop](#configure-the-workshop)
- [Sign in](#sign-in)
- [Host API](#host-api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configure-the-workshop"></a>
## Configure the Workshop

Set `workshopOrigin` to one of these deployments. An absent origin leaves the service unconfigured, and every connection reports `WORKSHOP_UNCONFIGURED`. Any other value fails at plugin load with `WORKSHOP_ORIGIN_INVALID`. `timeoutMs` (default 30000, 1–120000) bounds one JSON request including its body.

| `workshopOrigin` | Sign-in | API root |
| --- | --- | --- |
| `<Muse gateway>/jubengongfang` | The Muse gateway authorizes each request with the Muse login cookie | `<origin>/v1` |
| An HTTPS origin, or `http://127.0.0.1:<port>` / `http://[::1]:<port>` | Muse grant exchange at `/v1/auth/muse/challenge` and `/v1/auth/muse/exchange` | `<origin>/v1` |

The Desktop Host mounts the service with `MUSE_SCRIPT_WORKSHOP_ORIGIN`, or `<MUSE_BASE_URL>/jubengongfang` when that variable is unset.

<a id="sign-in"></a>
## Sign in

Sign in through Muse account settings; there is no separate Workshop login. On the gateway mount, the Host sends each request through the Muse account service, which attaches the Muse cookie only for its issuing gateway and only for `/jubengongfang/v1/` paths. `GET /v1/auth/me` identifies the Workshop user. On a dedicated origin, the Host requests a challenge, obtains a one-time `script-workshop` grant from the Muse gateway, and exchanges it for the Workshop's `access_token`, which it sends as a bearer token. Requests never follow redirects; `WorkbenchSession.fetch` with `redirect: 'manual'` returns the redirect response for the caller to check. A failed upstream fetch rejects with its own error; only a refusal by the Muse account service reports a Muse login failure.

A session belongs to the Muse login that opened it. It is discarded when Muse announces a login change, when another login is active before or after a request, or when the Workshop answers 401. A request in flight during such a change rejects with `WORKSHOP_ACCOUNT_CHANGED` and discards its response. The next connection signs in again with the current login.

<a id="host-api"></a>
## Host API

`ctx.workshopConnection.connection()` resolves a `WorkbenchSession`. Concurrent callers share one sign-in. `request(path, options)` sends JSON below the API root and returns the parsed response; a non-2xx response throws `WorkbenchHttpError` with the HTTP `status`, the service's `detail.code` or `WORKSHOP_HTTP_ERROR`, and its message. `identity` is a digest of the deployment and the Workshop user ID. `fetch(url, init)` and `check()` serve raw media reads; Jingliu uses them for studio media.

`WorkbenchSessions` takes a `WorkbenchDefinition` naming the audience, gateway mount, API root, credential field and user-facing name, and a `WorkbenchDeployment` with the validated origin, timeout and an optional loopback preview credential. `disconnect(signal)` revokes a dedicated deployment's native token at `/auth/logout`; on the gateway mount it only discards the session.

`@deepseek-ai/dsh-workbench-connection/scripts` exports parsers for finalized-script lists, details and summaries returned by the Workshop API.

`workshopConnection` is also a Typert Remote service for the Client's 剧本 tab: `scripts` reads one page of the finalized-script library with counts per stage, `script` reads one script with its versions and one version's episodes, `pickScript` picks a version for production, and `scriptProduction` records the Jingliu project a picked script became. Every member can read the library; the Workshop refuses `pickScript` and `scriptProduction` without the `script_pick` permission. `scriptList`, `scriptDetail` and `scriptOf` check the responses; one that does not match fails with `WORKSHOP_INVALID_RESULT`.

The draft editor uses the same signed-in account for draft creation and import, episode and structured screenplay edits, candidate review, version restore, export, and publishing. Only the owner of the Muse connection can invoke these draft methods remotely. A save or restore targets one episode revision. A publish targets the reviewed whole-draft revision.

<a id="model-experience"></a>
## Model Experience

### Workshop tool failures

#### What the model sees

A Workshop tool can fail with `WORKSHOP_SIGN_IN_REQUIRED`, `WORKSHOP_MUSE_AUTH_UNAVAILABLE`, `WORKSHOP_UNCONFIGURED`, `WORKSHOP_MUSE_EXCHANGE_FAILED` or `WORKSHOP_ACCOUNT_CHANGED`, each with a Chinese message that tells the user what to do. Grants, cookies and tokens are never included.

#### Token effect

The service adds no tool definitions or system instructions; only a failing call's short message enters the conversation.

#### KV Cache effect

Signing in and account changes leave the system prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No sign-in commands for the Workshop** — unlike Jingliu, there is no `/workshop-login` or `/workshop-logout`; the first Workshop tool call signs in and a Muse account change ends the session.
- **Account binding lives on the server** — a Muse account without a Workshop account mapping fails with `WORKSHOP_MUSE_EXCHANGE_FAILED` and asks the user to have an administrator check the binding.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer notes</summary>

The Workshop's own sign-in routes and the gateway mount are defined in `services/muse-workbenches/muse_login.py` and `shared-host/edge.mjs` of the workbench deployment tree.

</details>
