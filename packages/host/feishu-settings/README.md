# @deepseek-ai/dsh-feishu-settings

English | [中文](README.zh.md)

The product's own Feishu setup: one settings section that opens the bundled bridge's gate, one QR registration flow, and the Web Settings page that drives both.

## What it owns

- **`feishu`** — this product's switch. `enabled` defaults to `false`, so an absent, empty, or unreadable settings document means off. The desktop composition reads the same key to compute the bundled `feishu-channel` row's **entry-level `disabled`** ([`apps/desktop-host/src/feishu-gate.ts`](../../../apps/desktop-host/src/feishu-gate.ts)); that entry switch is the only activation authority, and the page is the only way to open it.
- **`dsh-lark-bridge`** — the bundled bridge's own section, which this row **pre-registers while the switch is off** (that is exactly when the gate disables the bridge row, so the bridge's own registration cannot exist). The settings service refuses to write an unregistered namespace, so this pre-registration is what lets the page store the credential pair before the bridge ever runs. The pair therefore lives in the bridge's user layer, which the bridge resolves over its composed config — no composed entry, and no configuration dump, can carry it.
- **`feishuSetup`** — the Typert `@Remote` namespace the page calls: `status`, `setEnabled`, `setCredentials`, `beginLogin`, `cancelLogin`, `forget`.

## Two-layer truth

The product switch and the bridge's own section are separate layers, and the page reports both. Even with the switch on, a stored `dsh-lark-bridge.enabled: false` wins over the row's composed config, and the page says so (`overridden`) instead of claiming the bot runs.

## Registration

`beginLogin` calls the official `registerApp` from `@larksuite/channel` (the same package the bundled bridge depends on), renders the returned URL into an SVG data URL **on the Host** — the browser bundle carries no QR encoder — and writes the credentials the scan yields into the bridge's section. Failures travel as bounded codes; platform messages never reach the page, a log line, or a Remote answer.

## Restart sequence

Saving credentials and turning the switch on both take effect at the next backend start, because a composed entry's `disabled` and a settings section's `config` are resolved at boot. The page states this in the switch notice and in the `restart-pending` state text.

## Known Limitations and Deferred Work

- Group-message policy is read-only in this round: `approvers` and the sender/group allowlists outrank the sandbox, so the page neither edits nor displays them.
- Nothing here performs a real Feishu round trip: the shipped tests fake the registration call, so QR scanning, the live long connection, and a tenant's own permission and visibility configuration remain unverified.
- The page reports the bridge's own `enabled` override but does not clear it: clearing a key in a namespace owned by another plugin is that plugin's contract, and the page links the operator to the settings document instead.
- **Deliberate cross-plugin coupling**: this row pre-registers the `dsh-lark-bridge` namespace while the switch is off, and writes that section read-merge-write — the `appId`/`appSecret` pair only, every other key preserved. The coupling follows the bridge's own Config schema: if upstream renames or reshapes those credential keys, this row's placeholder schema and written keys must move with it, or the pair lands in a key the bridge no longer reads.
- This package publishes no `./invariant`: every fact it owns — the stored switch, the pending ticket, the credential's presence — is already observable through the `feishuSetup` Remote surface, so there is no second observation that could diverge from it.
