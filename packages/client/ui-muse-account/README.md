---
description: "Muse account sign-in and status in Desktop Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-muse-account

English | [中文](README.zh.md)

## Summary

This client plugin adds a Muse account entry to the Desktop sidebar and Settings. It uses the authenticated Remote service from [muse-account](../../host/muse-account/README.md) to sign in, verify status, or sign out; passwords never enter a model conversation.

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

Desktop mounts this plugin beside the Host `muse-account` row. Open **Settings → MUSE Account** or the sidebar entry to enter account credentials. Registration requires a separate choice, which starts clear; a failed sign-in does not create an account automatically.

Set the required `feedbackUrl` to the product's HTTPS feedback page. The sidebar **Feedback** button opens that page without appending credentials. Desktop configures `/feedback` on the Muse gateway; browser sign-in is separate from the saved desktop session.

In Muse Desktop this plugin also provides delivery for the existing message and task feedback dialogs through `museAccount.feedback`. Their submissions use the saved Desktop login, while the sidebar page uses browser sign-in. Both arrive in the same account opinion inbox. The [dialog package](../ui-message-feedback/README.md) owns the optional excerpt choice, retained drafts, and receipt acknowledgement. Missing Muse delivery never becomes a local-only success; other profiles retain their local feedback behavior.

The Account row fills the expanded sidebar's available width with equal side insets. Feedback and the blue update control share the row below it; Feedback fills that row when no status is shown. The collapsed sidebar uses compact icon buttons.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The browser bundle mounts the generated `museAccount` Remote contribution, then registers locale copy, the Settings section, the sidebar launcher, and the first-run sign-in panel. It only exposes bounded status and error codes from the Host; saved cookies and KB bearers remain in the Host process. No runtime invariant companion is published because these registrations are visible through their owning slot and Remote registries, with no separate state to reconcile.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Muse account Host](../../host/muse-account/README.md) — login storage, knowledge-base tools, and speech access.
- [Desktop composition](../../../apps/desktop/README.md) — packaged profile and user flows.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The `museAccount` Remote namespace serves browser requests. This UI plugin adds no model-facing tools or prompt text; the Host package owns account and knowledge-base tool schemas.

#### Token effect

The UI contributes no model tokens.

#### KV Cache effect

The UI does not change the model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Account operations require the configured Muse gateway. The Host package documents the deployment and same-user file-access limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
