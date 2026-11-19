# Muse sign-in and production services for Jingliu

English | [中文](README.zh.md)

This adapter connects the November 17, 2026 Jingliu backend and frontend. After Muse sign-in, Jingliu uses the linked native user ID for projects, collaborators, permissions and balances. Desktop and Web use the same project and asset catalog.

## Install

Run the installer against an extracted Jingliu release. It checks the source hooks, installs Muse sign-in and shared characters, and adapts both Jianying exporters for video, audio and subtitles.

```sh
python3 install.py --audience jingliu \
  --backend "$EXTRACTED/02-jingliu/backend/backend" \
  --frontend "$EXTRACTED/02-jingliu/frontend/dist-prod"
```

## Configure

| Variable | Value |
|---|---|
| `MUSE_WORKBENCH_ISSUER` | Canonical HTTPS origin of the Muse account gateway |
| `MUSE_WORKBENCH_PUBLIC_ORIGIN` | User-visible origin serving both the application page and its API |
| `MUSE_WORKBENCH_SECRET` | Dedicated random client secret matching this application's gateway registration |
| `MUSE_WORKBENCH_BINDINGS` | Absolute path to the administrator-maintained account mapping |
| `MUSE_WORKBENCH_STATE_DB` | Absolute path to this workbench's private SQLite database for pending login attempts |
| `MUSE_WORKBENCH_PARENT_ORIGIN` | Exact Muse parent origin, such as `dsh-app://app` for Desktop. Omit for standalone use |

Set `FW_AUTH_UPSTREAM` to the Muse gateway origin to enable native project access checks. The gateway reads the `jingliu` registration from `MUSE_WORKBENCH_LOGIN_CONFIG`. A dedicated site's callback is `https://jingliu.example.com/fwp/v2/auth/muse/callback`. The service user needs read access to the bindings and write access to the pending-request database.

### Existing accounts and shared assets

The mapping's `issuer` identifies the Muse gateway and `users` maps verified Muse account IDs to Jingliu `known_users.user_id`. Administrators can confirm existing roles using `jingliuRoles`. Jingliu verifies the role and access before issuing a session.

For existing installations use `install.py --audience jingliu --library-only` to update shared assets. Run `import_character_references.py <verified-export>` in the Jingliu service environment to import characters by original image digest. Repeated imports retain existing assets.

### Web and Desktop

The [path proxy](shared-host/nginx_locations.py) serves `/jingliu/` on the Muse origin and checks the current Muse login and mapped account on each business request. Jingliu retains its credentials, SQLite database and media directory. A dedicated site signs in at `/fwp/v2/auth/muse/embed` before opening `/sfp/`. Embedded sessions are scoped to the tab and account. Desktop tools use the same production identity.

Run [frontend preparation](shared-host/prepare.py) with `--studio <static-directory>` for a path-mounted deployment. [Service provisioning](shared-host/provision.py) initializes the credential and first verified member. The [service units](shared-host/units.py) run Jingliu and its account proxy.

Set `FW_TOS_BUCKET`, `FW_TOS_REGION`, `FW_TOS_ENDPOINT` (hostname), `FW_TOS_KEY_PREFIX=jingliu/prod/`, `FW_TOS_ACCESS_KEY_ID` and `FW_TOS_ACCESS_KEY_SECRET`. Its own identity needs the operations used by its media flows on its prefix. The default `FW_TOS_DIRS` covers `uploads` and `generated`. Imported shared-character images are in `character-references`; migrate and verify those existing bytes before enabling storage or eviction for that directory.
