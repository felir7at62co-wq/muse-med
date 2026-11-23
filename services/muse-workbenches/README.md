# Muse sign-in for Script workshop and Jingliu

English | [中文](README.zh.md)

The adapters target the November 17, 2026 workbench backup. Each FastAPI service redeems an audience-specific Muse grant, looks up the explicitly linked native user, then issues an original application session. Manuscripts, roles, budgets, project owners and collaborators retain their application IDs.

The Jingliu installer adapts both Jianying exporters to the pinned draft library, including track creation and the placement of audio and subtitles.

[Script workshop feature report (November 18, 2026)](reports/剧本工坊全功能汇报-20261118.html) · [Printable PDF](reports/剧本工坊全功能汇报-20261118.pdf)

## Install

Install on an extracted release copy. Jingliu's backend source is in [`../jingliu`](../jingliu/README.md), and `install.py --audience jingliu` applies this overlay to a release copy of it. Workshop's source is in [`../workshop`](../workshop/README.md) with the `--audience script-workshop` overlay and the upload-path, base-path and script library changes already applied, and its 视频转剧本 factory step archived; the Workshop install path stays until a release is built from that source. The installer checks known integration points before writing and can be run again. Rebuild the workshop's Next application after installing. Jingliu serves the modified static directory.

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

Verify Muse's stable account ID against the original Workshop `users.id` or Jingliu `known_users.user_id`. Maintain one mapping per service. The mapping file takes precedence over automatic accounts, so an administrator can always link a subject to an existing account. Without automatic accounts, a new member needs an existing, verified native account before sign-in, and unmatched subjects are denied. A Jingliu backend with automatic accounts (`FW_MUSE_AUTO_PROVISION`, on by default) opens an account with zero credit for an unmatched subject on first sign-in and records it in its own database. On the shared host, an unmatched subject reaches a workbench only as a [company account](#company-accounts). A mapping file can contain the following data.

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

Once a regular editor has used draft creation, import, scene editing, history restore and export in the deployed Muse client, the operator can retire the old Workshop web entry. Omit `workshopOrigin` from the client UI plugin configuration and set `archiveWorkshopWeb: true` in the shared-host edge JSON. Deploy the matching web routes and edge together. The administrator recovery entry is `/jubengongfang/_archive`; sign in as a Muse administrator with a linked Workshop account. Keep the legacy web release available to that route. The Workshop API and workers continue to run. To reopen the old entry, restore its client UI configuration and set `archiveWorkshopWeb: false`.

Prepare both original frontends with [prepare.py](shared-host/prepare.py), apply [prepare_uploads.py](shared-host/prepare_uploads.py) to the Workshop backend, and build Next with `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang`. On the server, [provision.py](shared-host/provision.py) initializes private service credentials and the first verified member under `/srv/muse-workbenches/config`. The proxy and native APIs read each application’s `bindings/*.json` file. Workshop uses a dedicated PostgreSQL database, Redis and a job worker. Jingliu keeps its SQLite database and media in its state directory. Its authenticated library serves both desktop and web. Apply `install.py --audience jingliu --library-only --backend <backend> --frontend <studio-site>` to an existing installation, then run `import_character_references.py <verified-export>` with the Jingliu service environment and Python path. The importer verifies every original image digest, retains metadata and use restrictions, and skips identical rows on repeat imports. [activate.py](shared-host/activate.py) validates the generated locations and gracefully reloads the existing Muse HTTPS server.

<a id="company-accounts"></a>
### Company accounts on the shared host

The shared-host edge admits company Muse accounts outside a workbench's mapping only when that app's entry in the edge JSON lists the company's Feishu tenant keys, for example `"autoAccounts": {"feishuTenants": ["<tenant key>"]}` under `apps["script-workshop"]`. The tenant key is the organization identifier shown with a Feishu identity on the Muse account page. Without `autoAccounts`, unmatched accounts are denied. For an unmatched account, the edge reads `/api/muse/profile` with the account's own Muse cookie and continues only when one of its Feishu identities belongs to a listed tenant. It then sends `company: true` and the Muse username to the workbench's internal session and accepts only a native user that no mapping assigns. It repeats the check when the cached native session expires after five minutes.

Workshop answers with a finalized-script library reader from `app/muse_readers.py`: one Workshop user per Muse account, with `login_id` `muse:<account ID>`, role `user`, no password and no feature flags. The edge forwards a reader's requests only for `GET /v1/auth/me`, `POST /v1/auth/logout`, listing and reading `/v1/script-library`, finalizing, and picking or recording production for one script. It refuses the reader's web entry, browser session and every other API. Workshop requires `script_pick` to pick and `script_finalize` for a reader to finalize. An administrator grants them with the complete `feature_flags` object through `PATCH /v1/admin-api/users/{id}`, and stops a reader by setting its status to `disabled`. Mapping the subject, to its reader account or another user, lifts the edge restriction; a reader account still needs `script_finalize` to finalize. Jingliu accepts the same `autoAccounts` entry once its backend opens accounts, and the edge does not restrict Jingliu's routes.

### Desktop and browser sessions

Desktop opens `/v1/auth/muse/embed` or `/fwp/v2/auth/muse/embed`. The frame authenticates against the current Muse Host, saves the linked user's native credential in tab-scoped storage and opens `/v2` or `/sfp/`. Switching Desktop accounts replaces the frame. Standalone pages ask for confirmation at the Muse gateway and use the original application's independent browser storage. Removing an account mapping prevents new sessions unless the account qualifies as a company account. Revoke previously issued native credentials according to each application's policy when immediate sign-out is required.

Jingliu chat tools call `POST .../auth/muse/challenge`, obtain a Muse grant and call `POST .../auth/muse/exchange` with the request ID and code. The original business session authorizes subsequent tool calls.

## Muse video transcription

Workshop uploads, imported video links, TOS uploads, retries and TikHub's draft action use the Muse [episode runner](../../integrations/muse-hit-transcription/native.py). Draft ownership stays in Workshop. An episode keeps its original Muse Session, input digest and references on retry. An explicit full rerun creates a new revision. Speech recognition, whole-episode OCR, visual review, dialogue comparison and Word verification must finish before the native chapter and its material index are committed together.

Apply `install.py --audience script-workshop --reverse-only --backend <extracted-backend>` to an existing deployment. [configure_reverse.py](shared-host/configure_reverse.py) installs the versioned runner and a private SDK home from the operator-authorized cloud profile. Set `MUSE_WORKSHOP_REVERSE_CONFIG` to the resulting private JSON path and `VIDEO_TMP_DIR` to a persistent directory inside the Workshop uploads volume. All Workshop processes using the same state root share the configured number of episode slots. Successful delivery creates an editable draft. The authenticated API lists its materials at `GET /v1/video/jobs/{draft_id}/episodes/{episode}/materials` and serves the numbered entry below that path.

### Private media storage

Use a private production media bucket in the chosen region. Keep each application's production and test prefixes separate. Store manuscripts and access controls in their native databases. Configure these fields in the two server environments.

| Service | Settings and access |
|---|---|
| Workshop intake | `ALIYUN_OSS_BUCKET`, `ALIYUN_OSS_REGION`, `ALIYUN_OSS_ENDPOINT_INTERNAL`, `ALIYUN_OSS_ENDPOINT_PUBLIC`, `ALIYUN_OSS_KEY_PREFIX=workshop/prod/`, `ALIYUN_OSS_ACCESS_KEY_ID` and `ALIYUN_OSS_ACCESS_KEY_SECRET` configure the Volcengine TOS client. Grant its identity upload, read and native multipart operations on its intake prefix. The browser uses the Workshop upload endpoint until TOS is configured, then switches to resumable direct uploads. Batch folder upload uses TOS. |
| Muse reverse materials | Set `tosPrefix` in the Workshop runner JSON to `reverse/prod` and grant the Workshop identity read and write there. Muse verifies each file then writes the index last. The chapter stores the bucket, index key and digest. An authorized download receives a five-minute signed URL. With the prefix unset, materials use the private server volume. |
| Jingliu | Set `FW_TOS_BUCKET`, `FW_TOS_REGION`, `FW_TOS_ENDPOINT` (hostname), `FW_TOS_KEY_PREFIX=jingliu/prod/`, `FW_TOS_ACCESS_KEY_ID` and `FW_TOS_ACCESS_KEY_SECRET`. Its own identity needs the operations used by its media flows on its prefix. The default `FW_TOS_DIRS` covers `uploads` and `generated`. Imported shared-character images are in `character-references`; migrate and verify those existing bytes before enabling storage or eviction for that directory. |

Set the public endpoint to the browser-accessible regional hostname. Use the internal endpoint only from a service with working access to that region's internal network. Allow the actual workbench HTTPS origin in bucket CORS with the upload and preview methods and headers, exposing `ETag` for multipart completion. Keep private intake and reverse prefixes outside Workshop's public CDN allowlist. Existing objects keep their original keys. Reconcile counts and digests before moving stored media or adding expiry rules. `ARK_TOS_BUCKET` serves the archived Ark file flow and is separate from Muse transcription. [CORS](https://docs.volcengine.com/docs/torch-object-storage/cor-srules?lang=zh) · [TOS policies](https://docs.volcengine.com/docs/torch-object-storage/bucket-policy-templates-and-parameters?lang=zh).

## Verify

Run `python -m unittest discover -s services/muse-workbenches -v` with the application backend dependencies installed. Run `node --test services/muse-workbenches/test_embedded_storage.mjs` for Chromium coverage of embedded storage with test authorization. Set `CHROME_PATH` to select a local Chrome. For deployment acceptance, sign in through the real gateway with two independently mapped users and verify their original projects, private drafts, role and balance.
