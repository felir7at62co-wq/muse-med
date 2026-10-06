---
description: "Read-only session working-directory and production-root resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-workspace

English | [中文](README.zh.md)

## Summary

Resolve a session's recorded working directory and verify the production directory a plugin may use. These helpers read session metadata and filesystem state; callers own directory creation and writes.

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

Import helpers from `@deepseek-ai/dsh-session-workspace`. This package registers no plugin or configuration section.

| Helper | Behavior |
|---|---|
| `sessionLookup` | Reads the optional Host `sessions` service; a null, absent, or non-callable service returns `undefined`. |
| `sessionDirectory` | Returns a live session's recorded `cwd`; invalid identity, missing service, or unknown session throws `DomainRecordError`. |
| `trySessionDirectory` | Returns `cwd`, or `undefined` for absent identity, missing service, unknown session, or lookup failure. |
| `verifiedDirectory` | Requires an existing absolute directory and rejects symbolic links or paths redirected by realpath resolution. |
| `resolveProductionRoot` | Verifies the nonempty session directory first; uses the configured root only when no session directory is stated. Returns the root and `fromSession`. |
| `productionSubdirectory` | Resolves trusted path segments below a verified root, rejecting traversal and redirects in existing segments. Missing directories remain uncreated. |
| `unknownFailureMessage` | Adds the failure class and at most 300 characters of detail to the caller's fallback message. |

An invalid stated session directory fails instead of falling back to another project's configured root. A live session opened without `cwd` is a valid `sessionDirectory` result with an undefined directory.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[session.ts](src/session.ts) depends only on the session lookup fields it reads. [root.ts](src/root.ts) verifies trusted metadata paths with filesystem observations. [errors.ts](src/errors.ts) supplies coded domain failures, including `INVALID_ARGUMENT`, `NOT_FOUND`, `DEPENDENCY_MISSING`, and `OUTSIDE_WORKSPACE` for resolution errors. Callers branch on codes, not messages.

No runtime invariant companion is published: the helpers keep no independently mutable registry or cached directory state to reconcile.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session package](../../core/session/README.md) — recorded session identity and working directory.
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
- Root and subdirectory inputs come from trusted session metadata or deployment configuration; these functions do not provide a sandbox for model-supplied paths.
- Directory creation, project identity records, layout, and write authorization belong to consumers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
