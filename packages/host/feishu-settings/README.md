# @deepseek-ai/dsh-feishu-settings

English | [中文](README.zh.md)

The product's own Feishu setup: one composition row whose own Config opens the bundled bridge, one QR registration flow, and the Web Settings page that drives both.

## What it owns

- **The `feishu` row** — this product's switch. The row is composed as id `feishu`, so the settings service serves it as the `feishu` section, and its own `enabled` field (`volatile`, default `false`) is what the page writes. The desktop composition reads that same field to set the bundled `feishu-channel` row's own `enabled` key ([`apps/desktop-host/src/feishu-gate.ts`](../../../apps/desktop-host/src/feishu-gate.ts)); the page is the only way to open it.
- **The `feishu-channel` row's section** — the bundled bridge's credentials. In this harness a plugin's settings section IS its own resolved Config, so the pair is stored by writing that row's config (`appId`, `appSecret`, `registeredBy`, each `volatile`, the secret also `role('secret')`) and read back through the redacted `describe()`, which reports only whether the secret is set. The row stays mounted while the switch is off — a disabled row has no section to write — and carries `enabled: false` as its fail-safe.
- **`feishuSetup`** — the Typert `@Remote` namespace the page calls: `status`, `setEnabled`, `setCredentials`, `beginLogin`, `cancelLogin`, `forget`.

## Registration

`beginLogin` calls the official `registerApp` from `@larksuite/channel` (the same package the bundled bridge depends on), renders the returned URL into an SVG data URL **on the Host** — the browser bundle carries no QR encoder — and writes the credentials the scan yields into the bridge row's section through the same sink a hand-entered pair uses. Failures travel as bounded codes; platform messages never reach the page, a log line, or a Remote answer.

## Storing credentials

`setCredentials` writes `appId` plus, when the field carries one, `appSecret` into the bridge row's section. The secret is required exactly while none is stored: a blank field means "keep the stored one", which is only meaningful once there is one, so the page both disables the action and says why until a secret is typed. A refused write keeps what the operator typed — the secret is the one value the page cannot reconstruct — and clears the field only after a landed write.

Every refusal reaches the page as a code with a typed reason, never as the settings service's own message: the service quotes the entry and path it wrote, and a schema rejection can quote the value it refused, which here is the secret. `feishu/credentials-unwritable` carries `section-unregistered` (this composition mounts no bridge row) or `write-rejected`; `feishu/secret-required` and `feishu/login-failed` cover the other two. The real exception goes to the host log.

## Restart sequence

Saving credentials and turning the switch on both take effect at the next backend start, because a composed entry's Config is resolved at boot. The page states this in the switch notice and in the `restart-pending` state text.

## Known Limitations and Deferred Work

- Group-message policy is read-only in this round: `approvers` and the sender/group allowlists outrank the sandbox, so the page neither edits nor displays them.
- Nothing here performs a real Feishu round trip: the shipped tests fake the registration call, so QR scanning, the live long connection, and a tenant's own permission and visibility configuration remain unverified.
- **Deliberate cross-plugin coupling**: this row writes the bridge row's section read-merge-write — the credential pair and the scanner record only, every other key preserved. The coupling follows that row's Config schema: if upstream renames or reshapes those keys, this row's written keys must move with it, or the pair lands in a key the bridge no longer reads.
- **The switch cannot make the bridge row entry-disabled.** A settings section exists only for a mounted entry, so an entry-disabled row could never receive the pair a scan produces before the bridge first runs. The shipped patch keeps the row mounted, states `enabled: false` as the fail-safe, and the staged package returns before its sync layer, control server, peer heartbeat, or QR app registration whenever that key is off.
- This package publishes no `./invariant`: every fact it owns — the stored switch, the pending ticket, the credential's presence — is already observable through the `feishuSetup` Remote surface, so there is no second observation that could diverge from it.
