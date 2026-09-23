---
description: "Choose the Jubian HTTP client, business-data helpers, or model-facing tools for reading assets and submitting media tasks."
kind: "package-group"
---

# jubian/ — Jubian media tasks and assets

English | [中文](README.zh.md)

## Summary

Read Jubian projects, assets, and media tasks, or submit explicitly authorized generation requests. Use `jubian` for authenticated transport and write accounting, `jubian-api` for provider data and request builders, and `tool-jubian` for model-facing operations. Paid submissions require credentials and budget authorization; these packages do not choose creative content or replace the drama workflow.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose the entry point that matches the caller:

| Package | Role |
|---|---|
| [`jubian`](jubian/README.md) | Authenticated HTTP transport, bounded responses, safe errors, and the local write ledger and budget check |
| [`jubian-api`](jubian-api/README.md) | Typed readers, request builders, model selection, and verified media downloads |
| [`tool-jubian`](tool-jubian/README.md) | Model-facing tools and the token and image-route Remote namespaces used by Settings |

<a id="related-documentation"></a>
## Related documentation

- [Tools subsystem](../../docs/subsystems/tools.md) — registration, argument validation, execution, and model-facing results.
- [Credentials subsystem](../../docs/subsystems/credentials.md) — credential lookup and authorization owned by the host.
- [Typert subsystem](../../docs/subsystems/typert.md) — typed Remote methods used by the Settings consumers.
- [Drama packages](../drama/README.md) — shot preparation, BGM composition, and episode delivery outside the provider adapter.

<a id="dev-note"></a>
## Dev Note

None.
