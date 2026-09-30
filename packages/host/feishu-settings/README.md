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

Save the credentials, enable the switch, then restart the backend to apply both. The page reports credential saving and switch saving separately. An enabled bridge entry describes its configuration; message delivery also requires Feishu permissions and platform configuration. This page does not report a verified live connection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) adds the `feishu` Settings row. Its `enabled` field defaults to `false` and persists in the profile patch. The desktop [activation layer](../../../apps/desktop-host/src/feishu-gate.ts) reads that field at startup, preserves the bridge's composed credentials and other settings, and sets the `feishu-channel` activation key.

Credentials belong to the bridge row's settings section. The [setup service](src/service.ts) writes `appId`, `appSecret`, and `registeredBy` through the settings service and reads redacted status through `describe()`, which reports only whether the secret is set. The row stays mounted while the switch is off so its section remains writable. Settings writes merge with the row's other values.

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

- The page neither edits nor displays group-message policy: `approvers` and the sender/group allowlists outrank the sandbox.
- Package tests replace the registration call and verify settings persistence through the Loader. QR scanning, the live long connection, and a tenant's permission and visibility configuration remain unverified.
- **Deliberate cross-plugin coupling**: this row writes the bridge row's section read-merge-write — the credential pair and the scanner record only, every other key preserved. The coupling follows that row's Config schema: if upstream renames or reshapes those keys, this row's written keys must move with it, or the pair lands in a key the bridge no longer reads.
- **The switch cannot make the bridge row entry-disabled.** A settings section exists only for a mounted entry, so an entry-disabled row could never receive the pair a scan produces before the bridge first runs. The shipped patch keeps the row mounted, states `enabled: false` as the fail-safe, and the staged package returns before its sync layer, control server, peer heartbeat, or QR app registration whenever that key is off.
- This package publishes no `./invariant`: every fact it owns — the stored switch, the pending ticket, the credential's presence — is already observable through the `feishuSetup` Remote surface, so there is no second observation that could diverge from it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
