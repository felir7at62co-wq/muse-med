---
description: "Prepare local Skill publications and select exact releases for each Session."
kind: "package-reference"
---

# Local Skill publications

English | [中文](README.zh.md)

## Summary

Prepare and retain complete local Skill publications, select releases for future Sessions, and keep executed Sessions on their recorded versions. Storage and activation are separate: importing does not select a default. The private Desktop composition mounts both components; other named `dsh` profiles can mount either storage alone or both.

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

A deployment that resolves this private package can mount it in its named profile's composition:

```yaml
- id: muse-market
  name: '@deepseek-ai/dsh-muse-market'
  config:
    root: /absolute/private/muse-market
- id: muse-market-activation
  name: '@deepseek-ai/dsh-muse-market/activation'
```

The activation row has no separate configuration and uses the base service's resolved storage. Omit that row for storage alone.

### Publication lifecycle

Each ZIP contains one Skill, its complete resource directory and `muse-package.json` with every resource's SHA-256 and byte count. Paths must be portable to Windows and POSIX, and cannot include private configuration names. Bot manifests and plugin rows are rejected. Imported releases are identified by their exact archive SHA-256; repeated imports retain the same installation.

The six base publication methods retain their storage semantics. `installed()` records retain `enabled: false` as a legacy storage field, not activation state; use the activation observations below. Storage alone neither registers a Skill provider nor executes instructions, plugins or scripts. `sources()` preserves discovery completeness; an incomplete or empty observation does not establish that another provider has no Skills.

Preparing a directory bundle retains its original `SKILL.md`, `whenToUse`, metadata, invocation settings and all resource bytes. Virtual Skills retain their registered instructions and metadata. A flat Markdown Skill whose resource directory is shared with other Skills cannot be prepared: create a separate directory containing `SKILL.md` and only its intended resources, register that bundle, and select it explicitly. The service never moves or removes the original Skill.

### Default releases and Session binding

`ctx.museMarketActivation.defaults()` returns the activation revision and complete default selections. `setDefault({skillName, expected, target})` explicitly selects an installed archive SHA or disables that default with `target: null`; `expected` is the previously observed SHA or null. A stale choice refuses with `default-conflict`; repeating an already-selected target is idempotent. Existing bound Sessions do not change.

Before a participating Session's first model request, activation records the complete release set in required `muse-market/bound`. A full-prefix fork inherits that recorded set. `binding({sessionId})` returns `bound` for a fixed selection, `blank` for an unexecuted Session previewing current defaults, or `legacy` for an executed Session with no binding event and no market Skills. A blank Session selects the current defaults on its first task. Existing Skill catalog, loader and invocation controls use the selected release.

Missing or changed cache bytes leave the recorded candidate visible and make loading refuse; no lower-priority Skill or newer default replaces it. Restore the exact ZIP and matching extracted resources from backup. Removing a default release requires disabling its default first; a release retained by a Session binding still refuses removal.

### Storage and configuration

`root` selects an absolute private directory, defaulting to the resolved Harness home's `muse-market` directory. `archiveBytes`, `expandedBytes`, `fileCount` and `recordBytes` bound compressed archives, expanded files, entry counts and complete manifest/ledger records. Configuration is validated when the plugin loads.

Storage reads private version-1 and version-2 `installations.json` records. Loading activation migrates version 1 to version 2 with empty defaults, preserving original bytes in exclusive `installations.v1.backup.json`. A conflicting backup or oversized successor refuses before ledger replacement. Successful bounded atomic replacement commits changes; failure retains the previous ledger. Removing an unused installation retains immutable cache bytes. Export verifies the archive and complete extracted tree before returning the original ZIP.

Back up the complete `root` directory if retaining local publications. Session backups alone do not include this independent storage. Invalid or unsupported ledgers, links, special files and changed resources fail explicitly.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The archive codec](src/package.ts) checks manifests and resource digests; [local storage](src/local.ts) owns immutable packages and atomic records. [The base service](src/index.ts) serializes publication operations. [Activation](src/activation.ts), [binding projection](src/session.ts) and [Skill provider](src/skills.ts) retain and resolve exact Session selections.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Skill registry](../../skill/skill/README.md) — current invocation metadata and resource providers.
- [Filesystem Skills](../../skill/skill-filesystem/README.md) — discovery of existing user and project Skills.
- [Local publication backup](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-publication-storage/guide.md) — retain archives with their installation ledger.

<a id="model-experience"></a>
## Model Experience

### Publication results and selected Skills

#### What the model sees

An explicit caller can present storage results: discovery metadata with `complete`, release metadata with `enabled: false`, or exported archive bytes. With activation mounted, existing Skill consumers present the selected catalog metadata and load the complete instruction body and resource location. `muse-market/bound` records the exact selection used by those consumers.

#### Token effect

Presented storage results consume caller-owned message tokens. Activation adds selected entries through the existing Skill catalog; loading adds the full selected instructions and resource location. Resource files are read separately as needed, rather than inserted eagerly.

#### KV Cache effect

Changing defaults does not replace a bound Session's release set. Its catalog, loaded instructions and ordinary conversation history determine request-prefix changes and reuse; provider cache availability is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Bounded catalog presentation, market browsing UI, upload, review and cloud requests are not provided. Local storage or activation is not publication approval or permission to execute a Skill.
- URL, opaque and shared flat-Skill resource roots cannot be prepared as local directory bundles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
