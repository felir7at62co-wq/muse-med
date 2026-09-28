# Agent Note: MUSE account access and authorized knowledge-base reading

Status: implemented

English | [中文](2026-09-28-muse-account-kb-access.zh.md)

## Problem

Muse Desktop needs account access to the script and Wiki sources that an editor can cite and read. A model-facing login tool would place a password in the tool-call arguments and the durable Session log. A static knowledge-base token in configuration would outlive the user's account session and could be copied into a model result.

## Decision

The private `dsh-muse-account` Host package owns the Desktop Settings page, authenticated `museAccount` Remote methods, an origin-bound local session, and a bundled read-only MCP child. The page submits the password directly to the Host. The login request carries an explicit `registerIfMissing` boolean; the page presents this choice unselected until the user opts in. The Host attempts registration only after a rejected sign-in and only when this value is true. Model tools expose status, search, full-text page reading, and opening-page reading; none accepts a password or performs login, registration, or logout.

The Host saves the gateway cookie in the product home. Each knowledge-base call exchanges the current cookie at the same-origin `/api/kb/access` endpoint for a short-lived bearer, then passes it to the remote read-only MCP endpoint. The bearer is neither persisted nor returned. The local bridge accepts only the configured origin and fixed MCP path, rejects redirects and non-text responses, and bounds admitted result text. The server decides which source and Wiki IDs the account may read; `read_opening` accepts only a granted `SRC-...` search result marked `标定: viral-script`. A search excerpt does not satisfy the editing preset's [opening-read requirement](2026-09-28-muse-editor-sourced-opening.md); the editor follows an authorized ID to the relevant pages.

Password handling and cookie protection are separate properties. The UI and Remote route keep the password out of model calls and Session data. A process running as the same OS user may still read the cookie file through filesystem tools; full isolation requires an OS credential store, a separate process identity, or narrower sandbox file access.

## Alternatives considered

**Expose the original account MCP login tool to the model.** It would make login conversational, but the tool arguments would be logged as Session data. The Settings route keeps credentials out of that record.

**Configure a persistent knowledge-base bearer.** It would avoid a cookie exchange for every call, but logout, password changes, or account disablement would not promptly revoke a copied token. The gateway issues a fresh short-lived token from the live account session.

**Trust the client-side page as a complete secret boundary.** The page controls model invocation but shares an OS account with agent tools. The design states that limit instead of claiming that Remote authentication protects local files from the same user.

## Consequences

Desktop startup waits for the account Remote service and bundled MCP discovery, so a broken child process fails the package's activation rather than leaving an apparently ready account feature. The MCP client uses generic text cards for the four tools; reads return 6,000-character pages and local failures use fixed codes. MCP tool arguments and returned source pages are model-visible Session data; the password, cookie, and bearer remain outside those tool fields. Source grants are checked by the gateway on every read. Focused account, gateway, KB and MCP tests cover the local path; a live gateway login and remote KB round trip remain deployment verification.
