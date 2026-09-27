# @deepseek-ai/dsh-feishu-settings

English | [中文](README.zh.md)

The product's own Feishu setup: one settings section that opens the bundled bridge's gate, one QR registration flow, and the Web Settings page that drives both.

## What it owns

- **`feishu`** — this product's switch. `enabled` defaults to `false`, so an absent, empty, or unreadable settings document means off. The desktop composition reads the same key to compute the bundled `feishu-channel` row's **entry-level `disabled`** ([`apps/desktop-host/src/feishu-gate.ts`](../../../apps/desktop-host/src/feishu-gate.ts)); that entry switch is the only activation authority, and the page is the only way to open it.
- **`dsh-lark-bridge`** — the bundled bridge's own section, owned by whichever row runs the bridge. That row registers the namespace with its own schema and resolves the stored pair over its composed config, so this row registers a placeholder **only while the name is still free** at the moment the page reads or writes — a composition whose bridge row never mounts (the Web profile's gate keeps it disabled until an operator turns it on) has no other registrant, and the settings service refuses to write an unregistered namespace. The pair therefore lives in the bridge's user layer, which the bridge resolves over its composed config — no composed entry, and no configuration dump, can carry it.
- **`feishuSetup`** — the Typert `@Remote` namespace the page calls: `status`, `setEnabled`, `setCredentials`, `beginLogin`, `cancelLogin`, `forget`.

## Two-layer truth

The product switch and the bridge's own section are separate layers, and the page reports both. Even with the switch on, a stored `dsh-lark-bridge.enabled: false` wins over the row's composed config, and the page says so (`overridden`) instead of claiming the bot runs.

## Registration

`beginLogin` calls the official `registerApp` from `@larksuite/channel` (the same package the bundled bridge depends on), renders the returned URL into an SVG data URL **on the Host** — the browser bundle carries no QR encoder — and writes the credentials the scan yields into the bridge's section through the same sink a hand-entered pair uses. Failures travel as bounded codes; platform messages never reach the page, a log line, or a Remote answer.

## Storing credentials

`setCredentials` writes `appId` plus, when the field carries one, `appSecret` into the bridge's section. The secret is required exactly while none is stored: a blank field means "keep the stored one", which is only meaningful once there is one, so the page both disables the action and says why until a secret is typed. A refused write keeps what the operator typed — the secret is the one value the page cannot reconstruct — and clears the field only after a landed write.

Every refusal reaches the page as a code with a typed reason, never as the settings service's own message: the service quotes the section and path it wrote, and a schema rejection can quote the value it refused, which here is the secret. `feishu/credentials-unwritable` carries `section-unregistered`, `provider-read-only`, or `write-rejected`; `feishu/secret-required` and `feishu/login-failed` cover the other two refusals. The real exception goes to the host log.

## Restart sequence

Saving credentials and turning the switch on both take effect at the next backend start, because a composed entry's `disabled` and a settings section's `config` are resolved at boot. The page states this in the switch notice and in the `restart-pending` state text.

## Known Limitations and Deferred Work

- Group-message policy is read-only in this round: `approvers` and the sender/group allowlists outrank the sandbox, so the page neither edits nor displays them.
- Nothing here performs a real Feishu round trip: the shipped tests fake the registration call, so QR scanning, the live long connection, and a tenant's own permission and visibility configuration remain unverified.
- The page reports the bridge's own `enabled` override but does not clear it: clearing a key in a namespace owned by another plugin is that plugin's contract, and the page links the operator to the settings document instead.
- **Deliberate cross-plugin coupling**: this row registers the `dsh-lark-bridge` namespace while no other row owns it, and writes that section read-merge-write — the `appId`/`appSecret` pair only, every other key preserved. The coupling follows the bridge's own Config schema: if upstream renames or reshapes those credential keys, this row's placeholder schema and written keys must move with it, or the pair lands in a key the bridge no longer reads.
- **Registration order is a race this row cannot observe**: a composition that does run the bridge registers that section while the Loader settles, which is before the Web server answers any page call — but a page call reaching this row first would take the name, and the bridge's own registration would then fail and leave it on entry config alone. Detecting that would need a Loader view of sibling rows, which the context this row is mounted on does not provide.
- This package publishes no `./invariant`: every fact it owns — the stored switch, the pending ticket, the credential's presence — is already observable through the `feishuSetup` Remote surface, so there is no second observation that could diverge from it.
