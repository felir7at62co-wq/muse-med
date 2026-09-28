# Agent Note: Store the Feishu credential pair when no bridge row owns the section

Status: implemented

English | [中文](2026-09-28-feishu-credential-save-refused.zh.md)

## Problem

Saving App ID and App Secret in the Feishu Settings page failed with `gateway/internal` whenever the product switch was already on and the composition ran no bridge row — the muse Web profile's gate keeps `feishu-channel` entry-disabled until an operator turns it on, and the official profile mounts no gate at all. The row registered the bridge's `dsh-lark-bridge` settings section only while `feishu.enabled` was false, on the assumption that the switch off is the one boot in which the bridge row cannot run. With the switch on and no bridge, nothing registered that namespace, so `provider.update` threw `settings namespace "dsh-lark-bridge" is not registered`; the row discarded the exception and threw a bare `Error('bridge-settings-unavailable')`, which carries no `RemoteError` marker and therefore folded to `gateway/internal` at the Gateway. The page showed the generic "operation failed" line, the status read had no descriptor to read and reported "no credentials stored", and the same defect hit a completed QR scan, which writes through that one sink.

Two page defects made the failure harder to escape. A save whose secret field was blank was accepted, storing an app id with no secret, which is what a settings document with `dsh-lark-bridge.appId` and no `appSecret` records. And a refused save cleared the secret field, discarding the one value the page cannot reconstruct from any answer it receives.

## Decision

`FeishuSetupService` registers the bridge's section when the name is free at the moment the page reads or writes it, and never takes a name another row already owns. The bridge row remains the owner wherever it runs: it registers that namespace with its own `Config` schema and resolves the stored pair over its entry config, and a second registration would fail that one and leave the bridge on entry config alone.

Every refusal leaves the Host as a `RemoteError` with a declared code, so the Gateway carries it instead of folding it to `gateway/internal`:

- `feishu/credentials-unwritable` with `reason` — `section-unregistered` (no row owns the section, and this row could not register it), `provider-read-only`, or `write-rejected` (the settings service or the section's schema refused the pair).
- `feishu/secret-required` — nothing is stored and the request carried no secret.
- `feishu/login-failed` with the platform's bounded `code`; the platform's own text never crosses, and the QR path writes through the same sink as a hand-entered pair.

The settings service's exception goes to the host log, never to the page: its message quotes the section and path it wrote, and a schema rejection can quote the refused value, which here is the secret. The reasons are a closed vocabulary for the same reason.

The page states what it knows: the secret field is required while none is stored, blank meaning "keep the stored one" only once there is one; a refused save keeps both fields as typed and shows the reason; only a landed write clears the secret.

## Alternatives considered

**Store the secret through the credentials seam.** The sibling Jubian page keeps its admin token under a `CredentialRef`, and `.credentials.yaml` is where a stored secret belongs. It cannot work here, because the consumer is the third-party bridge: it resolves `appId`/`appSecret` from its composed entry config, its own settings section, and `~/.dsh/dsh-lark-bridge/settings.json`, and never reads `ctx.credentials` for them (its only use of that service is the optional cloud carrier). Moving the pair there would need a third-party plugin change to consume it, and until then the page would store a value nothing reads.

**Register the placeholder unconditionally.** This fails a running bridge's own registration — the settings service refuses a duplicate namespace — and the bridge then runs on entry config alone, which is where the pair it never reads is stored. The failure would be silent, logged only by the bridge, and worse than the one being fixed.

**Keep the switch-conditional registration and report the failure better.** The page would still be unable to save in exactly the composition the operator is looking at, and the fix for a reported "cannot save" is to be able to save.

**Decide ownership from the Loader.** Reading `feishu-channel`'s entry state is the precise rule, but the context this row is mounted on does not enumerate sibling rows: `ctx.loader.entries()` from inside the row yielded the include entry with an empty subtree where the same call from the composition root yielded every row. The `rowStateOf` probe keeps its existing contract until a Loader view of siblings exists.

## Related

[The Feishu opt-in decision](../architecture/2026-09-24-desktop-feishu-bridge-opt-in.md) continues to own the gate, the bundle, and the two-step flow; its account of how the setup row comes to own the bridge's settings section is corrected to the rule above. It is not superseded.

## Consequences

The write path no longer depends on the product switch, so the pair saves in the Web profile, which is where the report came from, and in any composition whose bridge row never mounts. A page call that reaches this row before a running bridge registers the section would take the name and leave that bridge on entry config alone; the race is bounded to the boot window, before the Web server answers any page call, and is recorded in the package README's Known Limitations because the row cannot observe it.

`setCredentials` now refuses a blank secret while nothing is stored, so the previously accepted "app id only" write no longer exists; the page disables the action and says why instead of offering it.

## Testing

`packages/host/feishu-settings/tests/service.spec.ts` drives the real file provider: a save with the switch on and no bridge row succeeds and `status()` reports `hasSecret`; a section owned by a running bridge registration is written through, not duplicated; a completed scan stores through the same sink; each refusal reason is asserted by code, typed reason, and the absence of the secret from the failure and from the document; a blank secret with nothing stored is refused and stores nothing. `tests/section.client.spec.tsx` pins the page: the action is unavailable until the required secret is typed, a refused save keeps the typed secret and shows the reason, a landed save clears it, and the controls are the shared `Switch` and `Input` primitives reached only through locale keys. `apps/desktop/tests/feishu-setup-loader.spec.ts` composes the shipped patch files through a real Loader and asserts the stored pair is readable by the page, still absent from every composed entry, diagnostic, and Remote answer.
