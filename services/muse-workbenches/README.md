# Muse sign-in for Script workshop and Jingliu

English | [中文](README.zh.md)

The adapters target the November 17, 2026 workbench backup. Each FastAPI service redeems an audience-specific Muse grant, looks up the explicitly linked native user, then issues an original application session. Manuscripts, roles, budgets, project owners and collaborators retain their application IDs.

The Jingliu installer adapts both Jianying exporters to the pinned draft library, including track creation and the placement of audio and subtitles.

## Install

Install on an extracted release copy. The installer checks known integration points before writing and can be run again. Rebuild the workshop's Next application after installing. Jingliu serves the modified static directory.

```sh
python3 install.py --audience script-workshop \
  --backend "$EXTRACTED/01-drama/code/services/orchestrator" \
  --frontend "$EXTRACTED/01-drama/code/apps/web"
python3 install.py --audience jingliu \
  --backend "$EXTRACTED/02-jingliu/backend/backend" \
  --frontend "$EXTRACTED/02-jingliu/frontend/dist-prod"
```

## Configure each server

Provide the following environment variables separately for each workbench. The application service user needs read access to the bindings and write access to the private directory holding pending requests.

| Variable | Value |
|---|---|
| `MUSE_WORKBENCH_ISSUER` | Canonical HTTPS origin of the Muse account gateway |
| `MUSE_WORKBENCH_PUBLIC_ORIGIN` | User-visible origin serving both the application page and its API |
| `MUSE_WORKBENCH_SECRET` | Dedicated random client secret matching this application's gateway registration |
| `MUSE_WORKBENCH_BINDINGS` | Absolute path to the administrator-maintained account mapping |
| `MUSE_WORKBENCH_STATE_DB` | Absolute path to this workbench's private SQLite database for pending login attempts |
| `MUSE_WORKBENCH_PARENT_ORIGIN` | Exact Muse parent origin, such as `dsh-app://app` for Desktop. Omit for standalone use |

Use HTTPS except on a local loopback test deployment. Keep Workshop's `AUTH_REQUIRED=true`, a private `JWT_SECRET` of at least 32 characters and its native database configuration. Set Jingliu's `FW_AUTH_UPSTREAM` to enable native request authentication and project access checks. The Muse gateway origin is a valid value. Both applications check these settings at startup. Run the grant gateway as one issuing process. Share each workbench's pending-request database among its local workers or route each exchange to the originating replica.

Register `script-workshop` and `jingliu` under `MUSE_WORKBENCH_LOGIN_CONFIG` at the [Muse gateway](../muse-accounts/README.md). Example callbacks are `https://scripts.example.com/v1/auth/muse/callback` and `https://jingliu.example.com/fwp/v2/auth/muse/callback`.

### Existing accounts

Verify Muse's stable account ID against the original Workshop `users.id` or Jingliu `known_users.user_id`. Maintain one mapping per service. New members need an existing, verified native account before sign-in. Unmatched subjects are denied. A mapping file can contain the following data.

```json
{"issuer":"https://accounts.example.com","users":{"verified-muse-subject":74111}}
```

To resolve an existing Jingliu administrator role that disagrees with local `FW_ADMIN_USER_IDS`, an administrator can add `"jingliuRoles":{"verified-muse-subject":"admin"}` to Jingliu's mapping after verifying the intended role. Accepted role values are `user`, `admin` and `superadmin`. Unresolved differences stop issuance. Workshop uses the original active user's role.

### Web routing

Forward Workshop's `/v1/` to its API unchanged. Keep the existing Next routes and `/api/` proxy. For Jingliu, serve `/sfp/` from the installed static directory and proxy `/fwp/` to FastAPI after removing the prefix. Configure the exact Muse frame ancestor and omit login-code query strings from access logs.

```nginx
# script-workshop
location = /login { return 302 /v1/auth/muse/login; }
location = /register { return 302 /v1/auth/muse/login; }
location /v1/ { proxy_pass http://workshop_api; }
# jingliu
location /sfp/ { alias /srv/jingliu/dist-prod/; }
location /fwp/ { proxy_pass http://jingliu_api/; }
```

For a temporary test of the archived prebuilt Next application, also inject `<script src="/v1/auth/muse/storage.js"></script>` at the start of the head of every Workshop HTML document. Prefer a freshly built Next application for deployment. Installed frontend sources already include the script.

The shared-host deployment serves Workshop at `/jubengongfang/` and Jingliu at `/jingliu/` on the Muse account domain. The [path proxy](shared-host/nginx_locations.py) verifies the live Muse cookie and the application’s account mapping on each business request. The native API receives its own bearer token. The entry page stores native browser state per tab and linked account. Both applications share the Muse web origin, so serve only company-controlled application code on these paths.

Prepare both original frontends with [prepare.py](shared-host/prepare.py), apply [prepare_uploads.py](shared-host/prepare_uploads.py) to the Workshop backend, and build Next with `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang`. On the server, [provision.py](shared-host/provision.py) initializes private service credentials and the first verified member under `/srv/muse-workbenches/config`. The proxy and native APIs read each application’s `bindings/*.json` file. Workshop uses a dedicated PostgreSQL database, Redis and a job worker. Jingliu keeps its SQLite database and media in its state directory. Its authenticated library serves both desktop and web. Apply `install.py --audience jingliu --library-only --backend <backend> --frontend <studio-site>` to an existing installation, then run `import_character_references.py <verified-export>` with the Jingliu service environment and Python path. The importer verifies every original image digest, retains metadata and use restrictions, and skips identical rows on repeat imports. [activate.py](shared-host/activate.py) validates the generated locations and gracefully reloads the existing Muse HTTPS server.

### Desktop and browser sessions

Desktop opens `/v1/auth/muse/embed` or `/fwp/v2/auth/muse/embed`. The frame authenticates against the current Muse Host, saves the linked user's native credential in tab-scoped storage and opens `/v2` or `/sfp/`. Switching Desktop accounts replaces the frame. Standalone pages ask for confirmation at the Muse gateway and use the original application's independent browser storage. Removing an account mapping prevents new sessions. Revoke previously issued native credentials according to each application's policy when immediate sign-out is required.

Jingliu chat tools call `POST .../auth/muse/challenge`, obtain a Muse grant and call `POST .../auth/muse/exchange` with the request ID and code. The original business session authorizes subsequent tool calls.

## Verify

Run `python -m unittest discover -s services/muse-workbenches -v` with the application backend dependencies installed. Run `node --test services/muse-workbenches/test_embedded_storage.mjs` for Chromium coverage of embedded storage with test authorization. Set `CHROME_PATH` to select a local Chrome. For deployment acceptance, sign in through the real gateway with two independently mapped users and verify their original projects, private drafts, role and balance.
