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

<a id="understand-the-implementation"></a>
## Understand the implementation

[Remote adapters](src/client/market-remote.ts) preserve all fifteen operation results and structured errors. [The controller](src/client/market-controller.ts) owns private request currency. The renderer owns the registered creator draft store; it contains user choices and original retry identities, not a replacement installation or cloud ledger. Components use framework hooks, derived slot props and existing Button, Modal and Toast primitives. Market cards and source form controls follow the shared neutral hairline treatment in [Web styling](../../../docs/web-styling.md).

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
