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

The sidebar opens the Skill market in the main panel; Settings retains a shortcut. Discovery, details, local packages and creator controls share the existing Host Remote. Scroll long release details within the dialog while its title and close button stay visible. Downloading and enabling are separate actions, and only confirmed Host results update local state. Existing sessions keep their bound versions. **My capabilities** shows each Skill installation's activation and actions. Discovery uses the exact installed release when present and otherwise recognizes a ZIP import with identical bytes.

Discovery shows published releases and the original Muse collection. A guide introduces discovery and installation on the first visit. Closing it saves the choice on the current client. **Market guide** opens it again.

The desktop market can import an original package by its listed digest and then enable it from discovery or My capabilities. Enabled original Skill details show the command to use it in a Muse conversation. The website and desktop market both offer the original archive download. Imported originals are ineligible for publication or export as a release package.

Enabled Skills are available by their invocation names in Muse conversations. The Muse Bot sidebar footer also opens the Skill market.

In the market, **Create Skill** opens the Skill form in the separate creation and upload page. **Upload ZIP** selects an existing Skill package. The form previews the listing and lets you export the package or upload a private draft. The creator center lists cloud Skill releases and review actions. The UI excludes historical Bot records, and the Host and browser adapters enforce Skill-only operations.

Skill cards and creator previews use a shared square portrait area. Built-in artwork uses the same visible size for static portraits and animation frames, with each portrait's proportions preserved.

Skill cards, author previews, and ZIP previews automatically choose the same Muse character from the Skill name and purpose. The shared library includes 50 characters. The editor updates the character as you select a local Skill or enter its details.

The [standalone website](../../../apps/market-web/README.md) uses the same market page through an explicit browser adapter. It previews Skill ZIP metadata locally, uploads only after confirmation and downloads a digest-verified archive. Browser downloads do not install or enable a capability.

Creator center separates cloud releases from local packages. Preparing or exporting stays local; uploading creates a private cloud draft with a different identity, retaining the same upload request key for retries. Team membership and administrator status come from the server. Submission, approval, rejection with a required note and withdrawal use the displayed revision and show only server-confirmed states. Cloud conflicts refresh the list without automatically retrying a transition. These controls do not implement authorization in the browser.

Muse matches a built-in portrait from the Skill name, title, description and category and stores its identifier in the prepared ZIP. Upload previews keep a portrait already bound to the ZIP. If the ZIP has no binding, Muse matches a portrait from the metadata and binds it when uploading the cloud draft.

Skill cards and author previews share portraits, hover, focus and click introductions, and optional sprite playback. Reduced motion, hidden or offscreen artwork, and loading failures retain a static portrait.

Desktop mounts this plugin beside the Host `muse-account` row. Open **Settings → MUSE** or the sidebar **MUSE** entry and choose **Sign in with Feishu**. With Feishu enabled, the gateway opens the official Feishu authorization page directly. After authorization, confirm the matching device code; the page automatically displays the account after the Host saves its login. Reopen the website or check the result after a connection failure, or cancel the pending login. Closing the account page cancels an unredeemed approval; an already-running save settles first. The first-run dialog uses the same sign-in flow. Existing Host login interfaces and account data remain available.

Each opening verifies the saved login with the gateway before displaying account status. Retry and **Verify sign-in** also request online verification. A gateway outage shows an error and retry action without deleting the saved session; a confirmed invalid session shows the Feishu sign-in entry. Verification success is not persisted as a trusted flag. Successful verification on retry also advances the first-run sign-in page. Closing a page ignores its delayed status, sign-in and sign-out results; an accepted Host sign-in can still update the saved session.

The signed-in account area shows **User management** only when the Host returns a verified administrator identity and an administration URL. Reverification immediately hides that entry until it succeeds again. Cached or ordinary identities never show it. The button opens the Host-validated administration URL without appending credentials.

Existing Desktop compositions continue to supply the required `feedbackUrl` setting for compatibility. It accepts HTTPS pages without URL credentials; local gateways may use HTTP only on `localhost`, `127.0.0.1`, or `[::1]`, with an optional explicit port and a non-root page path. In **Muse Bot settings → Feedback**, open the native session feedback form and submit it after reviewing the content.

In Muse Desktop this plugin also provides delivery for the existing message and task feedback dialogs through `museAccount.feedback`. Their submissions use the saved Desktop login and arrive in the account opinion inbox. The [dialog package](../ui-message-feedback/README.md) owns the optional excerpt choice, retained drafts, and receipt acknowledgement. Missing Muse delivery never becomes a local-only success; other profiles retain their local feedback behavior.

The sidebar shows one account button beside connection and update status. The expanded button includes its label; the collapsed button uses a compact icon with a tooltip.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Market registration mounts the generated `museMarket` contribution, main panel, sidebar entry, Settings shortcut and shell-owned operation feedback. [Character media](src/client/market-character-generation.ts) describes the prebuilt sprite cells and revisions displayed in market cards. The original account registration and Host implementation remain independent. Client test fixtures use the `.client.ts` suffix so the Host aggregate does not import TSX.

The sprite player clips each cell in source-image coordinates, keeping neighboring frames out of letterbox margins. Each instance owns its clipping ID so discovery cards and author previews can coexist. Hover and focus switch loaded frame sequences without restarting visibility tracking or returning to the fallback portrait. The prepared sprite fixture includes transparent gutters around all four frames.

The Host and Client compile through `tsconfig.host.json` and `tsconfig.client.json`; the package root config only combines these programs. The browser bundle mounts the generated `museAccount` Remote contribution, then registers locale copy, the Settings section, the sidebar launcher, and the first-run sign-in panel. It only exposes bounded status and error codes from the Host; saved cookies and KB bearers remain in the Host process. No runtime invariant companion is published because these registrations are visible through their owning slot and Remote registries, with no separate state to reconcile.

The sidebar account button exposes `data-muse-account-launcher` for Muse Bot to open native Settings without depending on its localized label.

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

- Cloud operations require the configured account gateway and market service. The static design preview uses mocked operations and does not prove a cloud connection. The market automatically matches built-in artwork from Skill metadata.

- Account operations require the configured Muse gateway. The Host package documents the deployment and same-user file-access limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
