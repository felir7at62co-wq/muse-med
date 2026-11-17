---
kind: package-reference
description: "Manage local Skill releases and optional cloud publication without changing account settings."
---

# Skill market UI

English | [中文](README.zh.md)

## Summary

Browse publications, manage complete local Skill packages, prepare one source Skill, and explicitly select defaults for new chats. Cloud drafts and moderation use the configured account gateway. This plugin is independent of account settings and can be unloaded without removing sign-in, feedback or onboarding.

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

Mount this package in a named `dsh` profile with the local publication and activation services. Desktop supplies these rows and the optional cloud client. Sidebar navigation opens a global panel; Settings links to the same panel. All actions use generated local, activation and cloud Remotes. The interface provides Chinese, English, Japanese, Spanish, French, German, Russian and Portuguese copy.

Selecting a ZIP imports it as a disabled local release. Preparing one source retains its complete resources and metadata. Installing a cloud version verifies its selected digest before importing. A separate confirmation selects a default with the previously observed archive SHA; a conflict refetches the current default and requires a new choice. Defaults apply to new chats and blank chats before their first task. Executed chats retain their recorded version; legacy executed chats do not acquire a market binding. Removing a retained release refuses without removing its row.

Local import, export, preparation and default management remain available without cloud access or login. Cloud search is bounded and does not establish a complete catalog. Refresh verifies current account capabilities; lost connections or account changes revoke private controls. Older search and private responses cannot replace a newer view or account generation. Previous useful local content stays visible when a request fails.

Upload retains an attempt's original account id, request key, archive and publisher across panel remounts. Upload only creates a private draft. Re-signing into the original account permits the original-key retry; another account cannot reuse it. Changing the selection or preparing another package does not silently discard an uncertain attempt. The explicit discard confirmation explains that a server draft may already exist. Submission and moderation use the displayed original publication revision. An uncertain review reads the original id without resubmitting a newer revision.

Disposal removes the panel, navigation, dictionaries, feedback overlay and Remote registrations. Toast outcomes outlive panel navigation; plugin disposal suppresses late outcomes. The [publication package](../../host/muse-market/README.md) owns archive validation, storage, activation and cloud authority.

Discovery combines moderated publications with the original public Skill directory. Each publication id and original-source id remains visible; matching names and versions do not hide another publisher. Each source retains its own results and retry state, so one unavailable directory does not erase the other. Scrolling reveals further cards. Original downloads are converted by the Host and imported without changing the default for new chats; the Host supplies verified original-to-local archive identities across restarts.

Public directories load independently of local inventory and default-version reads. A local failure retains available results and shows a retry notice without blocking public search. Anonymous original-resource installation retains its result across account revocation; panel disposal still suppresses late callbacks.

Discovery, local releases, publication details and creation previews share the same purpose-based character matching and silhouette framing. A recognized published `presetPortrait` takes precedence; otherwise the Skill name, title, category and description select an included character. Hover or keyboard focus reveals its Skill introduction. The images are packaged assets and do not require an image model or a remote image service.

The market uses a dedicated header, three-column character cards and a separate creator view with source-Skill and ZIP modes. Source or metadata edits invalidate a prepared selection so upload cannot use an earlier preview. The first-visit guide explains discovery, import and explicit activation; closing it retains only the existing `dsh.muse-market.guide.v1` dismissal marker, and the header can reopen it.

Creation opens a separate main panel with direct source-Skill and ZIP modes, while the creator center lists publications independently of local-source availability. ZIP preparation retains its original package and binds an unassigned character into a separate upload package. The prepared metadata and character remain identical in preview, export and upload. A successful upload returns to publication management. Character cards support pointer, keyboard and touch introductions, with an included fallback image for failed artwork loads.

The [standalone browser entry](src/client/browser.tsx) shares resource cards, details, characters and publication filters with Desktop. Its explicit browser operations support public catalogs, ZIP preview, confirmed upload, moderation and verified file downloads. The browser never reports local installation or enables a default. Upload previews use the actual prepared archive, and retries keep its original bytes, account, team and request key. Private downloads retain the selected account and permission revision; either changing discards their result. Public downloads remain independent of internal navigation and account changes. Import and activation remain Desktop actions.

The browser upload panel remains mounted across internal market navigation, retaining an in-flight or uncertain upload's archive and request key. Background completion does not change the selected page. A verified account change hides the previous account's preview and suppresses its completion callback; returning to the original account permits retry with the original key.

Browser identity failures preserve their cause: network failures offer local retry, while a rejected login offers sign-in. Local ZIP preview remains available without a login. Inactive upload controls and notices are hidden from the accessibility tree during discovery.

<a id="understand-the-implementation"></a>
## Understand the implementation

[Remote adapters](src/client/market-remote.ts) preserve the generated operation results and structured errors. [The controller](src/client/market-controller.ts) owns private request currency. The renderer owns the registered creator draft store; it contains user choices and original retry identities, not a replacement installation or cloud ledger. Components use framework hooks, derived slot props and existing Button, Modal and Toast primitives.

<a id="further-exploration"></a>
## Further Exploration

- [Account UI](../ui-muse-account/README.md) — sign-in and account status.
- [Cloud identity migration](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-market-identity/guide.md) — matching account DTOs and browser parser exports.

<a id="model-experience"></a>
## Model Experience

### Explicit publication choices

#### What the model sees

Panel navigation and cloud browsing add no model messages. The `museMarketActivation` service and existing Skill consumers expose the selected release through the recorded Session binding and normal Skill loading.

#### Token effect

UI state consumes no model tokens. Loading a selected Skill retains the existing catalog and instruction-token behavior.

#### KV Cache effect

Navigation does not change the request prefix. Default changes affect eligible unbound chats; executed chats keep their existing binding.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Cloud operations require a matching configured server. This UI does not deploy that server, publish automatically or change an executed chat's release binding. The global panel does not claim a selected Session binding.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
