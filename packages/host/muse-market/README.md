---
description: "Prepare and retain verified local Skill publication archives without activating their instructions."
kind: "package-reference"
---

# Local Skill publications

English | [中文](README.zh.md)

## Summary

Prepare, import, verify, export and remove local Skill publications with their complete resources. Mount `@deepseek-ai/dsh-muse-market` explicitly in a named `dsh` profile when a caller needs verified, immutable local archives. All installations remain disabled, and Desktop does not mount the package by default.

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
```

### Publication lifecycle


Each ZIP contains one Skill, its complete resource directory and `muse-package.json` with every resource's SHA-256 and byte count. Paths must be portable to Windows and POSIX, and cannot include private configuration names. Bot manifests and plugin rows are rejected. Imported releases are identified by their exact archive SHA-256; repeated imports retain the same installation.

All installations remain disabled. Storage neither registers a Skill provider nor executes instructions, plugins or scripts. `sources()` preserves the registry's discovery completeness; an incomplete or empty observation does not establish that another provider has no Skills.

Preparing a directory bundle retains its original `SKILL.md`, `whenToUse`, metadata, invocation settings and all resource bytes. Virtual Skills retain their registered instructions and metadata. A flat Markdown Skill whose resource directory is shared with other Skills cannot be prepared: create a separate directory containing `SKILL.md` and only its intended resources, register that bundle, and select it explicitly. The service never moves or removes the original Skill.

### Storage and configuration

`root` selects an absolute private directory, defaulting to the resolved Harness home's `muse-market` directory. `archiveBytes`, `expandedBytes`, `fileCount` and `recordBytes` bound compressed archives, expanded files, entry counts and complete manifest/ledger records. Configuration is validated when the plugin loads.

`installations.json` uses the package-owned private version-1 format. A successful atomic ledger replacement commits an installation. A failed replacement leaves the previous installations intact; a fully written, unreferenced package cache may remain and is verified before reuse. Removing an installation removes its ledger record and retains immutable cache bytes. Export verifies the archive and complete extracted tree before returning the original ZIP.

Back up the complete `root` directory if retaining local publications. Session backups alone do not include this independent storage. Invalid or unsupported ledgers, links, special files and changed resources fail explicitly.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The archive codec](src/package.ts) checks explicit manifests and file digests; [local storage](src/local.ts) owns the immutable resource tree and atomic installation ledger. [The service](src/index.ts) serializes explicit publication operations and does not register a Skill provider.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Skill registry](../../skill/skill/README.md) — current invocation metadata and resource providers.
- [Filesystem Skills](../../skill/skill-filesystem/README.md) — discovery of existing user and project Skills.
- [Local publication backup](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-publication-storage/guide.md) — retain archives with their installation ledger.

<a id="model-experience"></a>
## Model Experience

### Caller-owned publication results

#### What the model sees

An explicit caller decides whether to show publication results in a conversation. The service returns discovery metadata with `complete`, verified release metadata with `enabled: false`, or original archive bytes for export; it contributes no model-facing schema, prompt or Skill provider. It never inserts the packaged instructions into a model request.

#### Token effect

No default model request receives these results. A caller that presents them owns the resulting tool-history or message tokens; this package assembles no model request and adds no standing instructions.

#### KV Cache effect

The service does not change an existing model-request prefix. A consumer's selected result content and history updates determine any additional tokens and prefix reuse; provider cache availability remains outside this service.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Activation, session-version binding, market browsing UI, upload, review and cloud requests are not provided. Local installation is not publication approval or permission to execute a Skill.
- URL, opaque and shared flat-Skill resource roots cannot be prepared as local directory bundles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
