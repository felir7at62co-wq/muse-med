---
description: "Muse publication packages and versioned local market installations."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-market

English | [中文](README.zh.md)

## Summary

Installers can download or import verified Bot and Skill releases without enabling them, then activate exact versions for new sessions while retained sessions keep their references. Creators can prepare and inspect local packages before an explicit private draft upload. A separate cloud profile stores invited publishers, immutable releases and administrator reviews.

## Table of Contents

- [Use this package](#use-this-package)
- [Publication and recovery](#publication-and-recovery)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [Desktop composition](../../../apps/desktop-host/config/desktop.cordis.patch.yml) mounts the Host service beside `agentPresets` and `skills`. Its Remote API supports a separate market UI for discovery, local installation management and publication preparation; this package does not add a Desktop settings or main-area market page. `sources().website` opens the [market website](../../../apps/market-web/README.md). `baseUrl` is an HTTPS origin; HTTP is accepted only for loopback testing. `root` defaults to `dshHomePath('muse-market')`. Compressed bytes, expanded bytes, file count, request timeout and accepted Bot modules are validated configuration fields. A download remains disabled until explicitly enabled. Enabled Bots appear in the new-session preset selector.

The `./cloud-host` plugin uses a dedicated loopback `webServer` and an absolute administrator-owned policy file. The gateway authenticates users and forwards bounded streams with a private shared secret; the market profile rejects unauthenticated actor assertions. See [gateway deployment](../../../services/muse-accounts/README.md#muse-market) for configuration and launch.

The generated Client Remote exposes downloads as `museMarket.installPackage(id)` and removal as `museMarket.removePackage(id)`. Host-local calls remain `ctx.museMarket.install(id)` and `ctx.museMarket.remove(id)`. The wire aliases avoid the Client Remote namespace's internal lifecycle methods; they do not change installation state or removal checks.

Desktop discovery reads the original public Bot and Skill catalog from `baseUrl`. `installLegacy(id, sha256)` fetches the selected archive anonymously, checks its SHA-256 against the current catalog and creates a disabled local installation. The ledger keeps the original catalog identity and digest alongside the verified local package. Repeating the same import preserves enablement. The catalog also links to the original downloads. Converted packages are available for local use, and the Host rejects publication and export of those converted packages.

Original Skills keep their invocation names and resources. The three Office Skills keep their shared helper in each Skill's directory and use an updated relative path in their instructions. Original Bots are matched against an audited list of archive digests. Their personas run with the current Desktop presets and installed tools. Codex and Claude Code delegation still requires the corresponding local provider. Legacy Bot archive expressions and installation scripts never run through market import.

<a id="publication-and-recovery"></a>
## Publication and recovery

Both content kinds use a ZIP publication with `muse-package.json`, complete manifest-declared `skills/<name>/` directories, and an explicit file index of byte sizes and SHA-256 digests. Bot rows contain only allowed installed modules and declarative JSON configuration. Package installation does not download Node modules, execute installation scripts or evaluate YAML expressions. Bot packages cannot declare a generic host-directory Skill scanner or the internal market Skill provider; the Host synthesizes the latter from the exact enabled release. Undeclared Skill trees, secret filenames, absolute host paths, links in authoring resources, path traversal, case-colliding names and oversized archives are rejected. Selected Skill resources remain executable content when an agent later uses its ordinary tools; preset scoping is not a code sandbox. Authors and reviewers inspect the complete exported archive and its third-party requirements.

When a Bot declares `@deepseek-ai/dsh-tool-skill`, its configuration must explicitly set `scopedCatalogOwner: true`, including inside groups. Otherwise the shared cloud/local manifest validator rejects the package: an unmarked child loader would lose its catalog to the Host loader. This requirement does not set `catalogSourceLimits` or rewrite the author's configuration.

A Bot manifest can bind a built-in market portrait by identifier. The `presetPortrait` field supports the full portrait library. The original `portrait` field remains supported. Skill manifests cannot bind Bot portraits.

Preparation reads only selected Skill directories and a selected Bot declaration. Unsupported local configuration fails instead of being silently omitted. Export is local; draft upload is explicit; submission and public approval are separate revision-checked actions. A publisher/name/version tuple is immutable, including rejected drafts. Upload retries retain their idempotency key. Desktop Bot preparation includes the automatically matched portrait in its export and draft upload. When uploading an imported Bot archive, the Host binds the automatic match to the uploaded copy if the archive has no portrait. Public listing excludes drafts, rejected releases and withdrawn releases. Versioned publication downloads require login.

Local files are stored by digest. The versioned installation ledger retains enablement and session references. Each Bot release receives its own `market-<release-id>` preset ID and activates on first binding. Independent Skills are pinned to each session in the local ledger and registered in its scope. Disabling a Skill changes new sessions; existing sessions retain their selected version. Referenced releases cannot be removed; referenced Bots cannot be disabled. Recovery requires the original market root and cached files. The market ledger adds no Session header fields and must be backed up with local Sessions. Cloud SQLite uses a monotonic schema version and an independent data root outside the release.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`./format` provides browser-portable metadata validation and bounded ZIP metadata previews. A preview does not verify resource bytes or file digests; cloud upload and Host installation still validate the complete archive. `package.ts` owns complete archive parsing; `local.ts` owns immutable local files and the ledger; `index.ts` adapts presets, scoped Skills and Remote actions; `server.ts` owns cloud release state. Cloud admission bounds concurrent uploads before reading their bodies. No uploaded module is installed into the profile.

</details>

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Enabled standalone Skills are pinned when a new session is created and enter only its scoped registry; Bot Skills come from the exact Bot release inside its preset scope. A selected Bot supplies its persona and plugin composition to a blank session. The shipped Desktop Host and short-drama/creation loaders advertise at most three model-invocable `muse-market` summaries per step; other sources remain uncapped. Nested loaders have independent configurations, including those declared by an uploaded Bot. The scoped registry retains all pinned Skills, and human-facing discovery has no advertising limit. This limits advertising, not invocation permissions. While the Skill loader is visible, a `/name` token alongside free text uses the existing [user-explicit Skill invocation](../../skill/tool-skill/README.md#use-this-package) to load any user-invocable bound Skill for that message, including an unadvertised one; model calls retain their independent invocation checks. Catalogs and loaded instructions use the existing durable messages, with no new Session header. Preparation and publication require explicit Remote calls; account cookies and shared gateway secrets are never returned through the Remote service.

#### Token effect

The catalog contains names and capped descriptions, not full bodies. Desktop summary selection prioritizes explicit names and then lexical matches from the latest direct user message without a model request. Loading a Skill returns its instructions through the existing `skill` tool or explicit user invocation. The summary limit caps neither loaded bodies nor the retained instruction history.

#### KV Cache effect

A Bot's persona and the session's Skill catalog affect its request prefix. Pinned versions keep existing sessions independent from later enablement changes. A changed summary selection appends a replacement catalog through the existing Skill consumer. Tool loads and explicit invocations append instruction content rather than replacing historical content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the Host and its cloud profile.

- The cloud directory returns at most 100 matches per query. Local summary ranking is deterministic lexical selection, not semantic search. The [client market](../../client/ui-muse-account/README.md) supplies the main-area page. Message-level selection chips are not implemented; explicit invocation currently reuses `/name`.
- Provider catalog candidates contain no instruction content, and a body lookup verifies only the selected release before reading the requested Skill. Initial catalog discovery still verifies all bound releases and reads their Skill files to parse descriptions and invocation controls; metadata-first discovery without body reads is deferred.
- Bot preparation accepts only portable declarations permitted by both the cloud and Desktop policies; existing product Bots with local conditions require author adaptation. Installed market Skills are not offered as authoring sources or repackaged in v1; preparation selects ordinary local sources only.
- Local drafts and their later cloud releases retain distinct immutable identities; replacing a draft ID would break retained Session references. References remain after Session deletion, and a Session copied without its market ledger cannot recover standalone Skill pins.
- This implementation has no payment, ratings, collections, team-role editor, automatic compatibility migration or automatic execution of reviewer examples.
- Downloads and uploads retry whole archives. Production capacity, Linux/macOS qualification, backup restoration and a real partner publication remain release acceptance work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
