# Muse company media

English | [中文](README.zh.md)

Muse company media combines a private DTK deployment with an account-authorized gateway. The desktop authenticates with its current Muse login; upstream credentials remain on the server. Cloud downloads become local assets only after a client imports and validates the files.

## Components

| Directory | Responsibility |
| --- | --- |
| [deploy](deploy/README.md) | Pinned upstream source, private DTK deployment and infrastructure verification |
| [gateway](gateway/README.md) | Company membership, MCP input validation, account limits, owned jobs and file delivery |
| [ops](ops/README.md) | Gateway release packaging, private configuration, HTTPS activation and rollback |

The gateway runs independently of the existing Muse account process and uses its authenticated identity endpoint. Deployment does not require replacing or restarting the account gateway. See the gateway reference for private configuration, HTTP responses and verification commands.

## MCP client verification

The opt-in [SDK acceptance test](tests/mcp-client.test.mjs) uses the SDK installed for `dsh-mcp-client` and a private session belonging to the operator. It verifies negotiation, tool metadata, authentication, denied origins and unknown-job isolation without requesting platform content or downloading media. Without the session variable, the test explicitly skips.

```sh
MUSE_MEDIA_SESSION_FILE=/absolute/private/session.json node --test services/muse-media/tests/mcp-client.test.mjs
```

Set `MUSE_MEDIA_HTTP_PROXY` only when the verification machine needs an HTTP proxy; the cloud service does not inherit it.
