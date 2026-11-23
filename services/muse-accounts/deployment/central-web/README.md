# Central Muse Web deployment

The loopback gateway serves the existing Muse Web under `/central/`. It validates the existing Muse account session on every new request and restricts access to the configured production account IDs. The public account gateway still owns sign-in, device selection, and account revocation. The native Web Host keeps its private listener and browser authentication.

## Install privately

Create the system user and group `muse-central-web` without a login shell. Install `central-web.mjs` from the account service and `refresh-backend-cookie.py` from this directory under `/opt/muse/central-web`, owned by root. The unit uses the existing Cloud Web Node runtime. Verify its path if that runtime changes.

Create `/etc/muse-central-web/config.json` with mode `0640` and ownership `root:muse-central-web`. Use the existing production account IDs authorized for Central Muse. The configuration needs no passwords or native credentials.

```json
{
  "publicOrigin": "https://muse.aigc-pipeline.cn",
  "accountsOrigin": "http://127.0.0.1:19389",
  "backendOrigin": "http://100.123.97.104:19490",
  "ownerAccountId": "<existing 16-character account ID>",
  "allowedAccountIds": ["<owner account ID>", "<another authorized account ID>"],
  "backendCookieFile": "/run/muse-central-web-auth/backend-cookie",
  "port": 19584
}
```

Install the service and timer units under `/etc/systemd/system`. Install `muse-central-web.tmpfiles.conf` as `/etc/tmpfiles.d/muse-central-web.conf`. The root-only service exchanges the active Cloud Web process's launch token on the private network. It atomically stores only the native Cookie in the runtime directory. The gateway process reads the Cookie but cannot write that directory or read the Cloud Web journal.

```sh
systemd-tmpfiles --create /etc/tmpfiles.d/muse-central-web.conf
systemctl daemon-reload
systemctl start muse-central-backend-cookie.service
systemctl start muse-central-web.service
```

Verify local access through the gateway before adding the Nginx include. The native startup URL must be present in the running `muse-cloud.service` invocation's journal. The timer refreshes the private Cookie every minute and uses the new startup URL after a Cloud Web restart.

When `allowedAccountIds` is present, it must include `ownerAccountId` and every ID permitted to enter Central Muse. Each request still requires a valid, enabled production account session. If the list is omitted, the owner must also retain the administrator role.

The optional `backendResponseTimeoutMs` defaults to 15000 milliseconds. The gateway bounds the time to connect and, after it forwards the entire request, the time to receive the response headers. It returns HTTP 504 when either wait expires. Uploads after connection and streams after the headers arrive use their existing behavior.

## Enable HTTPS access

Copy `nginx.central-web.conf` into `/etc/nginx` and add it as an include inside the existing HTTPS server block for the production account domain. Keep the existing account gateway and workbench route definitions. If the loopback port in the config changes, update the include to match it. Run `nginx -t` before reloading Nginx.

Check the browser sign-in page, owner access, denial for a signed-in ordinary account, and that an existing user can still open the device picker. On the central page, check assets, a session listing, and bidirectional WebSocket streaming under `/central/`. Verify a revoked login loses access. Once those checks pass, enable the gateway and cookie refresh timer for startup.

## Rollback

Remove the Central Web include from the HTTPS server block, validate Nginx, and reload it. Stop and disable `muse-central-web.service` and `muse-central-backend-cookie.timer`. Stopping the sidecar also closes existing central browser streams. The account gateway and the private Cloud Web continue to run.
