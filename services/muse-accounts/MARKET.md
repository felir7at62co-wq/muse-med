---
description: "Configure the separate Muse market profile and its authenticated account-gateway proxy."
kind: "reference"
---

# Muse market deployment

English | [中文](MARKET.zh.md)

## Summary

The account gateway serves `/market` before desktop forwarding. A separate `dsh` profile owns the SQLite catalog, bounded package validation and private file storage. The browser can use the market while its Desktop is offline. This page describes deployment configuration; it does not establish production capacity or partner acceptance.

## Table of Contents

- [Profile and gateway](#profile-and-gateway)
- [Operations](#operations)
- [Dev Note](#dev-note)

-----

<a id="profile-and-gateway"></a>
## Profile and gateway

Use a release containing `@deepseek-ai/dsh-muse-market` and its matching CLI. Copy [market-profile](market-profile/package.json) into the dedicated Harness home's `profiles/muse-market/` directory. Keep its `cordis.patch.yml` beside the manifest. Start the market process through `dsh --profile muse-market`, with `MUSE_MARKET_PORT` set to an unused loopback port and `MUSE_MARKET_POLICY` set to an absolute policy-file path. Keep the cloud profile separate from user Desktop profiles and machine-wide preference patches. The profile opens no agent or model provider.

The market policy file has the following fields. Paths are deployment-specific; create a private shared-secret file containing 32–256 URL-safe characters and keep its contents out of configuration examples and logs.

```json
{
  "root": "/var/lib/muse-market/catalog",
  "secretFile": "/etc/muse/market-secret",
  "limits": { "archiveBytes": 16777216, "expandedBytes": 67108864, "fileCount": 512 },
  "maxReleases": 1000,
  "maxActiveUploads": 2,
  "allowedPlugins": ["@deepseek-ai/dsh-persona", "@deepseek-ai/dsh-tool-skill"]
}
```

Set `MUSE_MARKET_CONFIG` on the account gateway to a separate administrator-owned JSON file:

```json
{
  "upstream": "http://127.0.0.1:19389",
  "secretFile": "/etc/muse/market-secret",
  "archiveBytes": 16777216,
  "requestTimeoutMs": 60000
}
```

The port must match `MUSE_MARKET_PORT`. If the gateway and catalog run as different OS users, give each user its own owner-only secret file with the same secret value and set the corresponding path separately. Policy files cannot be symlinks or writable by group/other users; the secret file must additionally be owner-only on POSIX. The gateway forwards its authenticated account identity with the shared secret and streams bounded uploads and downloads. Browser-supplied actor headers and cookies are not forwarded. The catalog rejects direct unauthenticated access. `MUSE_MARKET_CONFIG` absent keeps all market routes disabled; an invalid configured file fails startup.

An administrator opens the website creator center and creates a publishing team for an existing account ID. Invited authors upload a ZIP as a private draft, inspect the exported content and submit it. Administrators download and inspect the exact package and verify examples before approval. Draft content is immutable: fixes use a new version. Review requires the revision currently displayed. Public distribution stops on withdrawal; installed files remain available locally. The [package reference](../../packages/host/muse-market/README.md) owns publication format, local enablement and recovery limits.

The [shared market website](../../apps/market-web/README.md) can replace the gateway HTML at the reverse proxy while keeping account and API routes on the gateway. Its public configuration contains resource limits and admitted plugin names, never the gateway secret or storage paths.

<a id="operations"></a>
## Operations

Run one market process per catalog root. Apply independent process memory, CPU, request-time and disk limits after measuring the actual host; bounded archives still require memory for decompression. Keep the catalog outside the release tree. Monitor failed uploads, disk use, process health and database errors without logging credentials or package contents. The sample release cap and upload bounds are policy examples, not a capacity assessment.

For a consistent filesystem backup, stop the market profile gracefully, copy its complete root, then restart it. Back up the account store separately and preserve publisher account IDs. Restore into a different private root, start the same release against it, and verify a published package digest, author visibility and an unauthorized download. Do not copy a live SQLite database while omitting WAL files. Desktop backup must include both Sessions and its market installation root. A copied Session alone does not carry standalone Skill pins.

Build before running `node --test services/muse-accounts/market.test.mjs`; this integration uses the built cloud plugin, real HTTP carrier, authenticated gateway and streaming proxy. Verify `/market` is public, anonymous `/api/market/v1/me` returns 401, invited authors can upload, readers cannot see drafts, and disabling an account revokes subsequent access. Linux/macOS installation checks, a real partner example and production backup restoration remain release acceptance requirements.

After building the website TypeScript program and market package, `node --test services/muse-accounts/market-host.test.mjs` exercises the actual browser adapter, authenticated gateway, cloud catalog and Muse Host together. It imports the two handoff archives through browser download and Host download, enables their exact versions, reads Bot and standalone Skill instructions through a real agent scope, then verifies restart recovery. Its accounts, ports and data roots are isolated fixtures; it does not validate a production browser login or make a model request.

<a id="dev-note"></a>
## Dev Note

`market-proxy.mjs` has no database or archive parser. The cloud plugin trusts only the private loopback gateway credential. Package validation runs in the separate profile process; reviewers execute examples in an independent environment without production credentials. The website uses a restrictive content-security policy and renders publication fields as text.
