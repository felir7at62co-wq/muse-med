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

The sidebar opens the Bot & Skills market in the main panel; Settings retains a shortcut. Discovery, details, local packages and creator controls share the existing Host Remote. Downloading and enabling are separate actions, and only confirmed Host results update local state. Existing sessions keep their bound versions.

The [standalone website](../../../apps/market-web/README.md) uses the same market page through an explicit browser adapter. It previews ZIP metadata locally, uploads only after confirmation and downloads a digest-verified archive. Browser downloads do not install or enable a capability. Private cloud cards use local sample artwork only for the two exact handoff archive digests; presentation remains outside release metadata. A local ZIP import can match a later cloud listing by archive digest while enablement keeps its existing local identifier.

Creator center separates cloud releases from local packages. Preparing or exporting stays local; uploading creates a private cloud draft with a different identity, retaining the same upload request key for retries. Team membership and administrator status come from the server. Submission, approval, rejection with a required note and withdrawal use the displayed revision and show only server-confirmed states. Cloud conflicts refresh the list without automatically retrying a transition. These controls do not implement authorization in the browser.

Muse creator preview recommends a built-in portrait from the Bot title, description and category. The creator can choose another portrait before preparing the ZIP. The selected identifier is stored in the prepared package for export and draft upload.

Bot cards and author previews share portraits, hover/focus/click introductions and optional sprite playback. Local portraits accept PNG, JPEG and WebP up to 4 MB. Character generation requires a separately injected adapter; production supplies none. The design fixture explicitly simulates portrait and animation jobs using prepared artwork. Applying a character changes only the current local preview, not the package or its permissions. Reduced motion, hidden/offscreen artwork and loading failures retain a static portrait.

Desktop mounts this plugin beside the Host `muse-account` row. Open **Settings → MUSE** or the sidebar **MUSE** entry and choose **Sign in with Feishu**. With Feishu enabled, the gateway opens the official Feishu authorization page directly. After authorization, confirm the matching device code; the page automatically displays the account after the Host saves its login. Reopen the website or check the result after a connection failure, or cancel the pending login. Closing the account page cancels an unredeemed approval; an already-running save settles first. The first-run dialog uses the same sign-in flow. Existing Host login interfaces and account data remain available.

Each opening verifies the saved login with the gateway before displaying account status. Retry and **Verify sign-in** also request online verification. A gateway outage shows an error and retry action without deleting the saved session; a confirmed invalid session shows the Feishu sign-in entry. Verification success is not persisted as a trusted flag. Successful verification on retry also advances the first-run sign-in page. Closing a page ignores its delayed status, sign-in and sign-out results; an accepted Host sign-in can still update the saved session.

The signed-in account area shows **User management** only when the Host returns a verified administrator identity and an administration URL. Reverification immediately hides that entry until it succeeds again. Cached or ordinary identities never show it. The button opens the Host-validated administration URL without appending credentials.

Existing Desktop compositions continue to supply the required `feedbackUrl` setting for compatibility. It accepts HTTPS pages without URL credentials; local gateways may use HTTP only on `localhost`, `127.0.0.1`, or `[::1]`, with an optional explicit port and a non-root page path. In **Muse Bot settings → Feedback**, open the native session feedback form and submit it after reviewing the content.

In Muse Desktop this plugin also provides delivery for the existing message and task feedback dialogs through `museAccount.feedback`. Their submissions use the saved Desktop login and arrive in the account opinion inbox. The [dialog package](../ui-message-feedback/README.md) owns the optional excerpt choice, retained drafts, and receipt acknowledgement. Missing Muse delivery never becomes a local-only success; other profiles retain their local feedback behavior.

The sidebar shows one account button beside connection and update status. The expanded button includes its label; the collapsed button uses a compact icon with a tooltip.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Market registration mounts the generated `museMarket` contribution, main panel, sidebar entry, Settings shortcut and shell-owned operation feedback. [Media adapter types](src/client/market-character-generation.ts) describe separate generation jobs and character revisions; adapters validate their wire data and media metadata. The original account registration and Host implementation remain independent. Client test fixtures use the `.client.ts` suffix so the Host aggregate does not import TSX.

The sprite player clips each cell in source-image coordinates, keeping neighboring frames out of letterbox margins. Each instance owns its clipping ID so discovery cards and author previews can coexist. Hover and focus switch loaded frame sequences without restarting visibility tracking or returning to the fallback portrait. The prepared sprite fixture includes transparent gutters around all four frames.

The Host and Client compile through `tsconfig.host.json` and `tsconfig.client.json`; the package root config only combines these programs. The browser bundle mounts the generated `museAccount` Remote contribution, then registers locale copy, the Settings section, the sidebar launcher, and the first-run sign-in panel. It only exposes bounded status and error codes from the Host; saved cookies and KB bearers remain in the Host process. No runtime invariant companion is published because these registrations are visible through their owning slot and Remote registries, with no separate state to reconcile.

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

- Cloud operations require the configured account gateway and market service. The static design preview uses mocked operations and does not prove a cloud connection. Character media persistence, real image generation, review and release binding are not connected; closing the author form discards local character edits. Desktop and visual acceptance remain required.

- Account operations require the configured Muse gateway. The Host package documents the deployment and same-user file-access limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
