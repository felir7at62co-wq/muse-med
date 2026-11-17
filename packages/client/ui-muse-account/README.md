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

Desktop mounts this plugin beside the Host `muse-account` row. Open **Settings → MUSE** or the sidebar **MUSE** entry and choose **Sign in with Feishu**. With Feishu enabled, the gateway opens the official Feishu authorization page directly. After authorization, confirm the matching device code; the page automatically displays the account after the Host saves its login. Reopen the website or check the result after a connection failure, or cancel the pending login. Closing the account page cancels an unredeemed approval; an already-running save settles first. The first-run dialog uses the same sign-in flow. Existing Host login interfaces and account data remain available.

Each opening verifies the saved login with the gateway before displaying account status. Retry and **Verify sign-in** also request online verification. A gateway outage shows an error and retry action without deleting the saved session; a confirmed invalid session shows the Feishu sign-in entry. Verification success is not persisted as a trusted flag. Successful verification on retry also advances the first-run sign-in page. Closing a page ignores its delayed status, sign-in and sign-out results; an accepted Host sign-in can still update the saved session.

The signed-in account area shows **User management** only when the Host returns a verified administrator identity and an administration URL. Reverification immediately hides that entry until it succeeds again. Cached or ordinary identities never show it. The button opens the Host-validated administration URL without appending credentials.

After verification, the page shows your account dates, bound Feishu identities, Feishu department paths, and administrator-assigned MUSE groups with their descriptions. Department synchronization states distinguish missing directory permission, temporary failure, and identities that require another Feishu sign-in to synchronize. A Feishu tenant identifier is shown separately from department membership.

**Token usage** shows reported input, output, total, cached-input and reasoning counts, request coverage, model and Beijing-date summaries, and paginated request details. Choose today, the last 7 or 30 days, or all time, then refresh to read current data. Gateway observations and Desktop direct-request reports are identified separately. Missing counts display **Not reported**; totals add known values only, and cached input and reasoning counts are subsets of input and output. Direct reports can be absent, including after an offline request; these figures do not establish supplier billing totals. A refresh failure retains the last successful data and its displayed period. Reverification and sign-out hide private details immediately; delayed responses cannot restore them.

Services with the personal relay ledger show the available request totals and cursor-paginated records independently. Their periods use UTC and offer today, the last 7 days, and the last 30 days. Pagination retains the displayed date range; refreshing returns to the first page and recalculates the selected period. The page identifies unobserved direct, custom, and rented channels, retains unknown counters, and omits unavailable model and day summaries. When the service provides a personal profile, it also shows account dates and administrator-assigned Muse groups. Account-level Feishu department paths and their synchronization time can also appear from the service's verified personal workbench when detailed profiles are unavailable. Missing profile, group, or department information has its own availability notice; it does not imply an empty membership or hide recorded usage.

Existing Desktop compositions continue to supply the required `feedbackUrl` setting for compatibility. It accepts HTTPS pages without URL credentials; local gateways may use HTTP only on `localhost`, `127.0.0.1`, or `[::1]`, with an optional explicit port and a non-root page path.

In Muse Desktop this plugin also provides delivery for the existing message and task feedback dialogs through `museAccount.feedback`. Their submissions use the saved Desktop login and arrive in the account opinion inbox. The [dialog package](../ui-message-feedback/README.md) owns the optional excerpt choice, retained drafts, and receipt acknowledgement. Missing Muse delivery never becomes a local-only success; other profiles retain their local feedback behavior.

The sidebar shows one account button beside connection and update status. The expanded button includes its label; the collapsed button uses a compact icon with a tooltip.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host and Client compile through `tsconfig.host.json` and `tsconfig.client.json`; the package root config only combines these programs. The browser bundle mounts the generated `museAccount` Remote contribution, then registers locale copy, the Settings section, the sidebar launcher, and the first-run sign-in panel. It only exposes bounded status and error codes from the Host; saved cookies remain in the Host process. No runtime invariant companion is published because these registrations are visible through their owning slot and Remote registries, with no separate state to reconcile.

The sidebar account button exposes `data-muse-account-launcher` for native controls to open Settings without depending on its localized label.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Muse account Host](../../host/muse-account/README.md) — login storage, model routing, and speech access.
- [Desktop composition](../../../apps/desktop/README.md) — packaged profile and user flows.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The `museAccount` Remote namespace serves browser requests. This UI plugin adds no model-facing tools or prompt text; the Host package owns account-authorized model and speech services.

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
