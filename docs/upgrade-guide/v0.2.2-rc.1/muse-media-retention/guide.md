---
kind: upgrade-guide
description: "The company media ledger advances to schema 2 and requires a compatible gateway for recovery."
---

# Company media retention ledger

English | [中文](guide.zh.md)

## Change

The company media gateway upgrades its private SQLite ledger from schema 1 to 2, retaining jobs and adding transfer leases, import confirmations, deletion fences and audit records. A schema-1 gateway refuses the upgraded database. Desktop Session logs and account storage do not change.

## Migration

1. Back up the media ledger with SQLite's backup API before replacing the gateway. Keep the account service running and preserve the current ledger when accepting new media requests.
2. Deploy the new gateway with retention disabled, verify readiness reports `schema_version: 2`, then use the [retention procedure](../../../../services/muse-media/gateway/README.md) to disable independent upstream eviction and start dry-run observations.
3. Run a continuous 24-hour dry-run with the final policy and runtime before approval. Missing, failed or interrupted observations keep deletion disabled. Existing clients retain seven-day protection; updated clients confirm imports only after local verification.
4. Recover using the new gateway with retention disabled or set to dry-run. Do not start the old gateway against schema 2 or restore an old ledger over newly accepted requests. Unknown deletion results remain fenced until reconciled.
