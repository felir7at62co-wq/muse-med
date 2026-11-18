---
description: "Versioned source for Muse services deployed separately from the Desktop application."
kind: "reference"
---

# Muse services

English | [中文](README.zh.md)

## Summary

[`muse-accounts`](muse-accounts/README.md) is the source and test record for the account gateway. The Desktop build does not launch it. A release copies it with the matching runtime and global packages into a separate server release directory.

[`muse-runtime`](muse-runtime/README.md) provides graceful admission closure for the separately deployed workroom broker.

[`muse-media`](muse-media/README.md) combines a private DTK deployment with an account-authorized gateway for company media; upstream credentials remain on the server.

[`muse-host-retention`](muse-host-retention/README.md) inventories application releases and archived logs on the host and plans their retention. It never treats account databases, employee projects, provider credentials or media volumes as cleanup targets.

The [workbench login adapters](muse-workbenches/README.md) sign Script workshop and Jingliu users into their original business accounts through the Muse account gateway.
