---
kind: package-reference
description: User authorization and authenticated requests to a Jingliu production service.
---

# Jingliu account connection

English | [中文](README.zh.md)

## Summary

The desktop Host connects to the configured ShotFlow production gateway under `/fwp/v2`. Set `studioOrigin` to the HTTPS origin or to an explicit IPv4/IPv6 loopback origin. The original web workspace is served from `/sfp/`. Requests do not follow redirects. An absent origin leaves the plugin unconfigured.

## Table of Contents

- [Sign in](#sign-in)
- [Host API](#host-api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Sign in

Sign in through Muse account settings. Chat tools automatically exchange a short-lived, Jingliu-specific Muse grant for a tool connection at the configured studio. The Muse account cookie stays with its issuing gateway. `/jingliu-login` checks the current connection. `/jingliu-logout` closes the current tool connection. Calling a tool again reconnects under the active Muse login.

For isolated loopback previews, configure `localPreviewToken: true` and supply the test session in the Host environment as `MUSE_JINGLIU_SESSION_TOKEN`. This mode accepts only literal loopback origins and reads no saved account. An authenticated request to `/auth/me` establishes the account before a tool selects its project.

## Host API

Host plugins call `ctx.jingliuConnection.connection()` for a verified `JingliuSession`. Its `identity` identifies the Jingliu user and server for submission receipts. The Host also verifies the current Muse login before dispatch and before returning the response. Its `request(path, options)` accepts supported routes relative to the V2 API and returns parsed JSON. Workflow tools choose which results to present.

## Model Experience

### Account changes during a workflow call

#### What the model sees

A workflow tool can report `JINGLIU_ACCOUNT_CHANGED` when the signed-in account changes after preparing a request. The authorization token stays on the Host.

#### Token effect

Signing in adds no tool definitions or system instructions.

#### KV Cache effect

Account changes leave the system prefix unchanged.

## Known Limitations and Deferred Work

- Existing production instances served over plain HTTP require a trusted loopback tunnel or a deployment with HTTPS. The studio must implement `/fwp/v2/auth/muse/challenge` and `/fwp/v2/auth/muse/exchange` and register the Jingliu audience with the Muse account gateway.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
