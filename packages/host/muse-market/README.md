---
description: "Muse publication packages and versioned local market installations."
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-market

English | [中文](README.zh.md)

## Summary

Installers can download or import verified Skill releases, then explicitly enable exact versions for new sessions while retained sessions keep their references. Creators can prepare and inspect local packages before an explicit private draft upload. A separate cloud profile stores invited publishers, immutable releases and administrator reviews.

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

Desktop and the cloud market profile install this private package from a workspace-built tarball. The tarball contains the Host plugin, cloud profile entry, package format helpers and generated Remote modules.

The [Desktop composition](../../../apps/desktop-host/config/desktop.cordis.patch.yml) mounts the Host service beside `agentPresets` and `skills`. Its Remote API supports the separate market UI for discovery, local installation management and publication preparation. `sources().website` opens the [market website](../../../apps/market-web/README.md), and `sources().skills` lists authoring sources. `baseUrl` is an HTTPS origin; HTTP is accepted only for loopback testing. `root` defaults to `dshHomePath('muse-market')`. Compressed bytes, expanded bytes, file count, request timeout and historical module validation are explicit policy fields. A download remains disabled until explicitly enabled.

The `./cloud-host` plugin uses a dedicated loopback `webServer` and an absolute administrator-owned policy file. The gateway authenticates users and forwards bounded streams with a private shared secret; the market profile rejects unauthenticated actor assertions. See [gateway deployment](../../../services/muse-accounts/README.md#muse-market) for configuration and launch.

The generated Client Remote exposes downloads as `museMarket.installPackage(id)` and removal as `museMarket.removePackage(id)`. Host-local calls remain `ctx.museMarket.install(id)` and `ctx.museMarket.remove(id)`. The wire aliases avoid the Client Remote namespace's internal lifecycle methods; they do not change installation state or removal checks.

Desktop discovery reads the original public Skill catalog from `baseUrl`. `installLegacy(id, sha256)` fetches the selected archive anonymously, checks its SHA-256 against the current catalog and creates a disabled local installation. The ledger keeps the original catalog identity and digest alongside the verified local package. Repeating the same import preserves enablement. The catalog also links to the original downloads. Converted packages are available for local use, and the Host rejects publication and export of those converted packages.

Original Skills keep their invocation names and resources. The three Office Skills keep their shared helper in each Skill's directory and use an updated relative path in their instructions.

<a id="publication-and-recovery"></a>
## Publication and recovery

A Skill ZIP publication contains `muse-package.json`, complete manifest-declared `skills/<name>/` directories, and an explicit file index of byte sizes and SHA-256 digests. Package installation does not execute installation scripts or evaluate YAML expressions. Undeclared Skill trees, secret filenames, absolute host paths, links in authoring resources, path traversal, case-colliding names and oversized archives are rejected. Selected Skill resources remain executable content when an agent later uses its ordinary tools. Authors and reviewers inspect the complete exported archive and its third-party requirements.

A Skill manifest binds an automatically matched Muse character through `presetPortrait`. The identifier uses the shared library of 50 portraits. Web and Desktop previews use the same purpose matching and portrait framing as published cards.

`prepare(metadata, skillNames)` reads selected local Skill directories. Export is local; draft upload is explicit; submission and public approval are separate revision-checked actions. A publisher/name/version tuple is immutable, including rejected drafts. Upload retries retain their idempotency key. Preparation and ZIP upload persist the automatically matched portrait for consistent review and discovery. Public listing excludes drafts, rejected releases and withdrawn releases. Versioned publication downloads require login. Market operations accept Skills only. Bot archives fail with `skill-only`; historical cloud Bot identifiers return `not-found`.

Local files are stored by digest. The versioned installation ledger retains enablement and session references. An ordinary blank draft refreshes its provisional Skill binding at the first step of its first turn, including when Desktop reuses a draft created before enablement. Later turns retain their exact versions, including after an interrupted task. Referenced releases cannot be removed. Historical Bot records are decoded solely to restore existing bound sessions and are excluded from market lists and new-session choices. Recovery requires the original market root and cached files. The market ledger adds no Session header fields and must be backed up with local Sessions. Cloud SQLite uses a monotonic schema version and an independent data root outside the release.

Importing a ZIP with the same SHA-256 digest as an installed cloud release reuses that release's identity and enablement, with export and explicit draft upload still available. Preparing a local publication retains its own draft identity.

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

Enabled Skills enter a session's scoped registry, with blank drafts refreshing their selection at the first step of the first turn. The shipped Desktop Host and short-drama/creation loaders advertise at most three model-invocable `muse-market` summaries per step; other sources remain uncapped. The scoped registry retains all pinned Skills, and human-facing discovery has no advertising limit. While the Skill loader is visible, a `/name` token alongside free text uses the existing [user-explicit Skill invocation](../../skill/tool-skill/README.md#use-this-package) to load any user-invocable bound Skill for that message, including an unadvertised one; model calls retain their independent invocation checks. Catalogs and loaded instructions use the existing durable messages. Preparation and publication require explicit Remote calls; account cookies and shared gateway secrets are never returned through the Remote service.

#### Token effect

The catalog contains names and capped descriptions, not full bodies. Desktop summary selection prioritizes explicit names and then lexical matches from the latest direct user message without a model request. Loading a Skill returns its instructions through the existing `skill` tool or explicit user invocation. The summary limit caps neither loaded bodies nor the retained instruction history.

#### KV Cache effect

The session's Skill catalog affects its request prefix. Pinned versions keep existing sessions independent from later enablement changes. A changed summary selection appends a replacement catalog through the existing Skill consumer. Tool loads and explicit invocations append instruction content rather than replacing historical content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the Host and its cloud profile.

- The cloud directory returns at most 100 matches per query. Local summary ranking is deterministic lexical selection, not semantic search. The [client market](../../client/ui-muse-account/README.md) supplies the main-area page. Message-level selection chips are not implemented; explicit invocation currently reuses `/name`.
- Provider catalog candidates contain no instruction content, and a body lookup verifies only the selected release before reading the requested Skill. Initial catalog discovery still verifies all bound releases and reads their Skill files to parse descriptions and invocation controls; metadata-first discovery without body reads is deferred.
- Installed market Skills are not offered as authoring sources or repackaged in v1; preparation selects ordinary local sources only.
- Local drafts and their later cloud releases retain distinct immutable identities; replacing a draft ID would break retained Session references. References remain after Session deletion, and a Session copied without its market ledger cannot recover standalone Skill pins.
- This implementation has no payment, ratings, collections, team-role editor, automatic compatibility migration or automatic execution of reviewer examples.
- Downloads and uploads retry whole archives. Production capacity, Linux/macOS qualification, backup restoration and a real partner publication remain release acceptance work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
