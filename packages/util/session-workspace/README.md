---
description: "Optional compatibility helpers for recorded Session origins and trusted Node Host production-root checks."
kind: "package-library"
---

# @deepseek-ai/dsh-session-workspace

English | [中文](README.zh.md)

## Summary

Use this optional compatibility library to read a Session's initial recorded directory and check trusted production-root paths on the Node Host. Existing exports remain maintained for explicitly importing plugins; shipped runtime compositions do not load it by default. Callers own directory creation, writes and authorization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import helpers from `@deepseek-ai/dsh-session-workspace` when a Node plugin needs the original `Session.header.cwd` or trusted Host path checks. This library registers no plugin or configuration section. For the effective directory after Session changes, use `ctx.workingDirectory.get(session)` from [`dsh-working-directory`](../../session/working-directory/README.md).

| Helper | Behavior |
|---|---|
| `sessionLookup` | Reads the optional Host `sessions` service; a null, absent, or non-callable service returns `undefined`. |
| `sessionDirectory` | Returns a live Session's initial recorded `header.cwd`; invalid identity, missing service, or unknown session throws `DomainRecordError`. |
| `trySessionDirectory` | Returns initial `header.cwd`, or `undefined` for absent identity, missing service, unknown session, or lookup failure. |
| `verifiedDirectory` | Checks an existing absolute Host directory with Node `lstat` and `realpath`, rejecting detected links or redirects. |
| `resolveProductionRoot` | Verifies the nonempty session directory first; uses the configured root only when no session directory is stated. Returns the root and `fromSession`. |
| `productionSubdirectory` | Resolves trusted path segments below a verified root, rejecting traversal and redirects in existing segments. Missing directories remain uncreated. |
| `unknownFailureMessage` | Adds the failure class and at most 300 characters of detail to the caller's fallback message. |

These helpers do not follow `working-directory/change` events. An invalid stated session-origin directory fails instead of falling back to another project's configured root. A live session opened without `cwd` is a valid `sessionDirectory` result with an undefined directory.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[session.ts](src/session.ts) depends only on the session lookup fields it reads. [root.ts](src/root.ts) checks trusted metadata paths through Node's local filesystem, independently of `ctx.fs`. These observations do not grant Session permissions. [errors.ts](src/errors.ts) supplies coded domain failures, including `INVALID_ARGUMENT`, `NOT_FOUND`, `DEPENDENCY_MISSING`, and `OUTSIDE_WORKSPACE` for resolution errors. Callers branch on codes, not messages.

No runtime invariant companion is published: the helpers keep no independently mutable registry or cached directory state to reconcile.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session package](../../core/session/README.md) — recorded session identity and working directory.
- [Working directory service](../../session/working-directory/README.md) — effective Session directories and committed changes.
- [Filesystem service](../../fs/fs/README.md) — backend-aware access through the configured filesystem.
- [Utility group](../README.md) — shared utility packages.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

`sessionDirectory` and `resolveProductionRoot` are caller-facing helpers. This package adds no tool schema or prompt; a consuming tool owns any displayed path or `DomainRecordError` message.

#### Token effect

The helpers contribute no model tokens directly.

#### KV Cache effect

The helpers do not modify model request history or prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Directory checks observe current filesystem state and cannot prevent another process from replacing a path afterward.
- Root and subdirectory inputs come from trusted session metadata or deployment configuration. Node Host path checks neither access remote filesystem backends nor provide a sandbox for model-supplied paths.
- Directory creation, project identity records, layout, and write authorization belong to consumers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
