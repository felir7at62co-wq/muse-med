---
description: "Configure the separate loopback Skill catalog through an ordinary dsh profile."
kind: "package-reference"
---

# Skill catalog profile

English | [中文](README.zh.md)

## Summary

This directory defines a dedicated `dsh` profile with two plugins: the loopback HTTP server and the Skill catalog provider. It has no package binary or agent preset. The [account gateway](../README.md#skill-market-proxy) authenticates public requests and forwards them to this private catalog; the [market package](../../../packages/host/muse-market/README.md#account-bound-cloud) defines publication and installation behavior.

## Launch

Copy `package.json` and `cordis.patch.yml` into `$DSH_HOME/profiles/market`, then install their matching runtime dependencies through the deployment's package source. Keep the profile, private policy and durable storage outside immutable release directories. Run the installed `dsh` launcher:

```sh
MUSE_MARKET_PORT=8921 MUSE_MARKET_POLICY=/etc/muse/market-catalog.json dsh --profile market
```

Both environment variables are required. The port is an integer from 0 through 65535; zero asks the operating system to allocate a port atomically. The provider binds only `127.0.0.1`. The gateway's configured upstream must use the actual catalog port. Normal launcher shutdown stops route admission, interrupts incomplete request bodies, awaits admitted HTTP work and closes SQLite.

## Private policy

`MUSE_MARKET_POLICY` names an absolute, non-symlink regular JSON file, at most 64 KiB, with all eight fields below and no extra fields. On POSIX it must not be writable by group or other users. `root` is an absolute private durable-storage directory; `secretFile` is an absolute, owner-only, non-symlink regular file containing the same 32–256 character URL-safe secret configured at the gateway. The secret file is at most 1024 bytes; surrounding whitespace is trimmed.

```json
{
  "root": "/var/lib/muse/market",
  "secretFile": "/etc/muse/market-gateway-secret",
  "maxReleases": 10000,
  "maxActiveUploads": 2,
  "jsonRequestBytes": 65536,
  "jsonResponseBytes": 4194304,
  "catalogLimit": 100,
  "limits": {
    "archiveBytes": 16777216,
    "expandedBytes": 67108864,
    "fileCount": 1024,
    "recordBytes": 1048576
  }
}
```

All numeric settings are positive integers. `maxReleases` permits 1–100000 stored publications; `maxActiveUploads` permits 1–32 concurrently uploading accounts, with one upload per account. `catalogLimit` permits 1–100 returned records. JSON request budgets permit 1 KiB–16 MiB and response budgets 1 KiB–64 MiB. Archive budgets permit 1 KiB–64 MiB, expanded bytes 1 KiB–256 MiB, file count 2–4096 and per-record bytes 1 KiB–16 MiB. A complete catalog response must fit `jsonResponseBytes`; exceeding it returns an explicit error instead of truncating records. Configure compatible budgets independently at the gateway.

The server authenticates the shared Bearer secret before accepting an optional gateway actor assertion. Anonymous catalog requests can read published records; identity, download and mutation requests require an actor. The actor is the gateway's current 16-character account identity, username and administrator flag. Publication and publishing-team identities are separate 32-character hexadecimal identifiers; local release identities remain archive SHA-256 hashes.

## Storage and limits

SQLite `market.sqlite` and immutable `blobs/<sha256>.zip` archives live under `root`. The catalog supports schema version 1 and refuses newer versions without resetting or downgrading them. Existing Bot rows are filtered before strict Skill parsing and remain stored with their original archive bytes. Unsupported Skill records fail explicitly. Publication storage does not execute archive resources.

Uploads retain the original account-scoped request key, publishing team and exact archive bytes. Repeating that combination returns the same publication; changing its bytes or team returns a conflict. Verified archives use atomic installation and SHA-256 filenames. A later failed database write can leave verified, unreferenced cache archives; this service retains them and performs no automatic garbage collection. Do not remove an archive that another publication can reference.

Approval verifies the immutable archive outside the database transaction, then rechecks the requested revision and permissions inside a short synchronous SQLite transaction. Concurrent review requests can commit only once at a given revision. An uncertain upload requires the original key and bytes; an uncertain review requires reading the original publication before another action.

Catalog results are bounded arrays, at most `catalogLimit`, after visibility, retired-kind and query filtering. Queries search the package name, declared Skill names, publication identifier and descriptive metadata. A result does not claim to enumerate all matches; this protocol has no cursor pagination. `recordBytes` limits an individual stored manifest, independently of the complete JSON response budget.
