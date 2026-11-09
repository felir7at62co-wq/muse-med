---
description: "Prepare and bind exact Skill releases, with optional account-bound cloud publication."
kind: "package-reference"
---

# Local Skill publications

English | [中文](README.zh.md)

## Summary

Prepare and retain complete local Skill publications, select releases for future Sessions, and keep executed Sessions on their recorded versions. Storage and activation are separate: importing does not select a default. The private Desktop composition mounts both components; other named `dsh` profiles can mount either storage alone or both.

The optional `./cloud` service exchanges publications with a configured Muse Account gateway. Upload, submission, review, installation and activation remain explicit, separate operations. It requires local storage alone. Desktop mounts it with the configured account origin; custom profiles opt in explicitly. [The independent market UI](../../client/ui-muse-market/README.md) owns browsing and creator presentation.

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

<a id="account-bound-cloud"></a>
### Account-bound cloud

Add `@deepseek-ai/dsh-muse-market/cloud` to a named profile with `baseUrl` set to the same canonical HTTPS Muse Account origin used for login; loopback HTTP is allowed. Its independent `sessionFile` defaults to the Harness home's `muse-account/session.json`. It reads that file through the [Host account reader](../muse-account/README.md#host-credential-reads), refuses redirects and account revision changes, and never returns credentials. `requestTimeoutMs` covers each full HTTP response; `jsonRequestBytes` and `jsonResponseBytes` bound complete JSON, while local archive limits separately bound ZIP bytes. Oversized JSON replies refuse instead of truncating metadata.

`ctx.museMarketCloud.catalog(q, mine)` returns at most `catalogLimit` records, bounded to 100; empty search requests the current bounded catalog, not an exhaustive directory. Search matches the Skill manifest name and invocation id as well as publication metadata. `identity()` includes the authenticated `accountId` so an uncertain upload can be resumed only by its original account. `mine: true` and `identity()` require login; public catalog and `getPublication(id)` may be anonymous. Cloud publication and publisher ids are 32 hexadecimal characters; local release ids are 64-character ZIP SHA-256 values. Account ids remain separate 16-character server identities. Import `parseMarketPublicationId`, `parseMarketPublisherId` and `parseMarketUploadRequestId` from `@deepseek-ai/dsh-muse-market/cloud` to validate retained external strings and construct the branded values required by Host callers.

`publishDraft(localId, publisherId, requestId)` uploads verified original local ZIP bytes as a private draft. Retain the original account-scoped request key and archive before calling; retry an uncertain upload with that same key and archive. It never submits automatically. Explicit `review(id, revision, 'submit', '')` requests review; approve, reject and withdraw also require the original inspected revision and current server authority. A lost response triggers a GET of the original id. Only an exact matching next revision confirms the requested state; conflicts and unconfirmed replies retain the original id, inspected revision and available full observed record in structured error details. No newer revision is submitted automatically. Gateway authority is checked at request admission; later account or role changes do not retroactively cancel committed server work.

`installPublication(id, expectedSha256)` verifies the selected catalog digest, complete ZIP byte count and manifest before using the base service's disabled import. It neither changes defaults nor activates a release. Browser consumers use the public `./cloud-values` parsers, shared with the Host; the independent `lib/cloud-values.browser.js` bundle has no Node, Cordis or credential dependency. Cloud failures use `muse-market/cloud-failed` with bounded `code` and HTTP `status`; original local storage failures retain `muse-market/operation-failed`. Unloading joins owned requests and refuses later calls.

The separate `./cloud-host` provider serves a private loopback store under a dedicated named `dsh` profile, with an administrator-owned `policyFile`, fixed archive and JSON bounds, and a gateway-only secret. [Gateway deployment](../../../services/muse-accounts/README.md) owns account admission and proxy configuration. Back up its complete store, including SQLite and immutable blobs, independently of Desktop storage; unknown schema versions refuse. Neither this private endpoint nor a stored draft grants publication approval or Skill execution permission.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The archive codec](src/package.ts) checks manifests and resource digests; [local storage](src/local.ts) owns immutable packages and atomic records. [The base service](src/index.ts) serializes publication operations. [Activation](src/activation.ts), [binding projection](src/session.ts) and [Skill provider](src/skills.ts) retain and resolve exact Session selections. [Cloud transport](src/cloud.ts) verifies remote metadata and archives; [the private server](src/server.ts) owns publisher membership, immutable blobs and revision-checked review transitions.

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

An explicit caller can present storage results: discovery metadata with `complete`, release metadata with `enabled: false`, or exported archive bytes. Cloud callers can present complete validated publication metadata and review results, including structured refusal details; no cloud tool is installed automatically. With activation mounted, existing Skill consumers present the selected catalog metadata and load the complete instruction body and resource location. `muse-market/bound` records the exact selection used by those consumers.

#### Token effect

Presented storage results consume caller-owned message tokens. Activation adds selected entries through the existing Skill catalog; loading adds the full selected instructions and resource location. Resource files are read separately as needed, rather than inserted eagerly.

#### KV Cache effect

Changing defaults does not replace a bound Session's release set. Its catalog, loaded instructions and ordinary conversation history determine request-prefix changes and reuse; provider cache availability is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bounded cloud catalog is not an exhaustive enumeration; narrow the search when its limit is reached. Cloud access requires a matching configured server.
- URL, opaque and shared flat-Skill resource roots cannot be prepared as local directory bundles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
