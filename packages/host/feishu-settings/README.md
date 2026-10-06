---
description: "Configure the bundled Feishu bot, save app credentials, and diagnose setup or restart status from Settings."
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu-settings

English | [中文](README.zh.md)

## Summary

Configure the bundled Feishu bot from Settings → Feishu. Save an existing app's credentials or register an app by scanning a QR code. Save credentials and enabled state separately, then restart the backend to apply them. An enabled entry does not confirm message delivery or a live connection.

## Table of Contents

- [Storing credentials](#storing-credentials)
- [Registration](#registration)
- [Restart sequence](#restart-sequence)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="storing-credentials"></a>
## Storing credentials

Select **Save credentials** after entering an App ID and App Secret. The enable switch saves only the enabled state; it does not save values entered in the credential fields. `setCredentials` writes the pair into the bridge row's section. The secret is required while none is stored; a blank field keeps a stored secret. The page clears the typed secret only when the returned status confirms the requested App ID and a stored secret. A refused or unconfirmed save keeps the typed values for retry.

<a id="registration"></a>
## Registration

Scan the QR code to register an app instead of entering an existing credential pair. A completed registration saves the returned credentials; a failed registration reports a bounded error code.

<a id="restart-sequence"></a>
## Restart sequence

Save the credentials, enable the switch, then restart the backend to apply both. The page reports credential saving and switch saving separately. An enabled switch without credentials leaves the bridge mounted and writable; save the missing pair and restart again. An enabled bridge entry describes its configuration; message delivery also requires Feishu permissions and platform configuration. This page does not report a verified live connection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Published Client code uses `lib/client.js`; `lib/types/client` contains declarations only.

The [bundle patch](cordis.patch.yml) adds the `feishu` Settings row. Its `enabled` field defaults to `false` and persists in the profile patch. The desktop [dependency layer](../../../apps/desktop-host/src/feishu-gate.ts) requires `feishuSetup` before the bridge resolves Config and retains its other dependencies. The [Host plugin](src/index.ts) installs a config waterfall listener before publishing that service. It captures the product switch and the bridge's complete credential pair at startup, projects only runtime activation, and delegates interpolation before reading credential expressions. Subsequent credential or switch edits leave activation fixed until the next backend start; the user profile remains editable.

Credentials belong to the `@wenbin_wb/dsh-bridge` row's `feishu-channel` settings section. The [setup service](src/service.ts) writes `appId`, `appSecret`, and `registeredBy` through the settings service and reads public fields through redacted `describe()`. The Host checks the bridge's volatile secret for a nonempty value and returns only its presence; an empty schema default is not a stored credential. The row stays mounted while off or missing credentials so its section remains writable. Replacing the app or scanner clears its previous sender and active-session bindings; other settings remain merged.

Registration calls the official `registerApp` from `@larksuite/channel`, renders the returned URL into an SVG data URL on the Host, and saves credentials through the same settings operation as manual entry. The browser bundle carries no QR encoder. Platform registration messages never reach the page, a log line, or a Remote answer.

Settings refusals reach the page as typed codes rather than the settings service's own message, which can include the rejected secret. `feishu/credentials-unwritable` distinguishes an absent bridge section from a rejected write; `feishu/secret-required` and `feishu/login-failed` cover missing secrets and registration failures. The underlying settings exception goes to the Host log.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this package manages Feishu setup through Settings and registers no model tools, prompt text, or request tokens.

#### KV Cache effect

Saving credentials or changing the enabled state does not alter model requests or invalidate an already reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Credential persistence is verified independently of live message delivery. The following limits apply to setup and bridge integration.

- The page neither edits nor displays group-message policy: the bridge's sender/group allowlist and mention requirement control inbound access.
- Package tests replace the registration call and verify settings persistence through the Loader. QR scanning, the live long connection, and a tenant's permission and visibility configuration remain unverified.
- This row writes the bridge's credential section through settings; its keys must remain aligned with the [reviewed provider schema](../../../third_party/plugins/compatibility/muse-feishu-channel.mjs).
- The bridge row remains mounted with `enabled: false` so credentials can be saved before activation. Its staged provider returns before creating a gateway or conversation node whenever the switch is off. Desktop migration preserves legacy credentials and backups, turns the product switch off, and requires explicit activation.
- This package publishes no `./invariant`: every fact it owns — the stored switch, the pending ticket, the credential's presence — is already observable through the `feishuSetup` Remote surface, so there is no second observation that could diverge from it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
