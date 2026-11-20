---
description: "Deploy and verify the read-only Muse console for administrators: tasks, generation records and service health."
kind: "package-reference"
---

# Muse console

English | [中文](README.zh.md)

## Summary

The Muse console is a separately deployed, read-only web service for administrators at `/console` on the Muse site. It adds what the existing site pages lack, estimated spend per model request and the health of company services, and links the existing pages for tasks (`/workbench`), accounts (`/admin`), usage (`/admin/usage`) and feedback (`/feedback`) from the same navigation. It holds no gateway credential, no provider key and no conversation content.

## Pages

- `/console` redirects to the generation records.
- **Generation records** (`/console/records`): totals for today, 7 days or 30 days in Asia/Shanghai calendar days; spend by person and department; one row per model request with route, outcome, token counts, duration and estimated cost; filters by department, person, route, model and status; CSV export of up to 10,000 rows. Exported cells that start like a spreadsheet formula are prefixed with `'`.
- **Services** (`/console/services`): systemd state, start time, restart count and release of each configured service, and per-route request volume, failure rate and average duration over the last 24 hours.

## Access

The console forwards the viewer's own `__Host-muse` session cookie to the account gateway on loopback. `/api/muse/profile` identifies the viewer; an answer to `/api/workbench?scope=organization` with `administrator: true` grants the console. Without a session the console answers 401 with a sign-in link; other accounts receive 403. Gateway failures return 502 and never fall back to a weaker check. Results are cached per session for 30 seconds. Department heads are not supported yet because the gateway does not persist department membership outside its process.

## Data

`export.mjs` runs as the gateway service user from a one-minute timer. It reads the gateway's `requests.sqlite` read-only and writes `export.sqlite` with the same metadata columns, re-reading the last 30 minutes so finished requests replace active ones, and a per-day table by account, route and model for range totals. It keeps 120 days. The target uses a rollback journal and mode 0640 with group `muse-console` so the console opens it read-only. The first run copies all history: about 3.5 minutes and 760 MB for 2.85 million rows.

Estimated spend applies a versioned price table (`MUSE_CONSOLE_PRICES_FILE`) per route and model: uncached input, cache-hit input and output per million tokens, in CNY. Requests without a matching row are counted as unpriced rather than as zero. Estimates are not supplier bills.

## Configuration

`deploy/console.example.env` lists every variable. `MUSE_CONSOLE_GATEWAY_ORIGIN` must be a plain loopback HTTP origin. `MUSE_CONSOLE_SERVICES_FILE` lists `{id, name, unit, release?}` entries; `release` is a symlink whose target names the running version. Invalid configuration stops the process at startup.

## Deployment

1. Create the `muse-console` system user and group, `/var/lib/muse-console/export` owned by `muse-gateway:muse-console` with mode 2750, and copy this directory to a release under `/opt/muse/console/`, pointing `current` at it.
2. Install the environment file as `/etc/muse/console.env` (read by systemd), the price and service files under `/etc/muse-console/` owned by `root:muse-console` with mode 0750 for the directory and 0640 for the files, and the units in `deploy/`. The console user cannot enter `/etc/muse`.
3. Run `muse-console-export.service` once and wait for the first copy; then enable `muse-console-export.timer` and start `muse-console.service`.
4. Add `deploy/nginx-console.conf` inside the site's TLS server block before the catch-all location, test the configuration and reload nginx.
5. Verify `/console/healthz` returns `ok`, an anonymous request returns 401 and an administrator sees all three pages.

Rollback removes the nginx locations and stops the console and the timer; the gateway is not touched. The console stops within 10 seconds of SIGTERM.

## Tests

Run `node --test` in this directory with Node 22.12 or later.
