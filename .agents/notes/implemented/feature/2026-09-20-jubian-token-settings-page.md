# Agent Note: The Jubian admin token as a Web Settings page

Status: implemented

English | [中文](2026-09-20-jubian-token-settings-page.zh.md)

## Problem

`dsh-tool-jubian` resolves `JUBIANAI_ADMIN_TOKEN` through `ctx.credentials` on every call, and a deployment could only supply it from the inherited process environment, `$DSH_HOME/.credentials.yaml`, or a `.env` file. A person running the Web GUI therefore had to leave the app, find the credential file, edit it by hand, and restart. The generic `credentials` Remote namespace already exists in that GUI, but it is a configuration surface over the whole seam: it takes the reference name as an argument, so a page that used it could write any reference in the deployment, not only this one.

## Decision

`@deepseek-ai/dsh-tool-jubian` gains a browser half and the `jubianToken` Remote namespace, and the package now builds and publishes both.

The Host half is `src/token.ts`: a `TypertRemoteService` named `jubianToken` with `describe`, `set`, and `unset`, mounted by the row's own `apply` beside the five tools. The reference is a module constant, `credentialRef(JUBIAN_TOKEN_REF)`, never a parameter, so this namespace can write exactly one credential. No method returns a value: every answer is the credential seam's `CredentialInfo` — configured, source, writable — projected field by field, because the Gateway carries a business result without decoding it and a provider that returned extra properties would otherwise widen what reaches the browser. `set` refuses an empty or whitespace-only value as `gateway/bad-request` naming `unset`, and a provider refusal is `jubian-token/rejected`, declared in this package's `src/types.ts`, whose details carry only the reference.

The browser half is `src/client/`: `mount.ts` mounts the generated `./remote` contribution with `ctx.remote.$mount` and then registers `settings.section` (`id: 'jubian'`, `order: 16`) on a child fiber that waits for `remote.jubianToken`; `JubianTokenSection.tsx` renders the status line, one password field, Save, and Clear. `remote.jubianToken` is deliberately absent from the plugin's own `inject`: the plugin provides that service, so declaring it would park the fiber on an arrival its own `apply` must cause. The entry, `src/client/index.ts`, only binds `mountJubianTokenSettings` to the generated artifact.

The page is registered in three places: `tsconfig.client.json` references the package's new client leaf, `package.json` declares `dsh.client` with a `./client` export, and the package's own `cordis.patch.yml` row — the bundle patch a profile already consumes — is what mounts the plugin in the Web profile. No row was added to `packages/bundle/web-app/cordis.patch.yml`. That roster is for the profile's own composition, and this package ships its row in its own bundle patch; a second row with the same id would collapse onto the first in `EntryGroup.update`, so the edit would have silently mounted the paid Jubian tools in every default Web session while changing nothing for a deployment that already lists the bundle.

## Alternatives considered

**Reuse the existing `credentials` Remote namespace.** `ctx.remote.credentials` already offers `describe`, `set`, and `unset`, and `ui-settings-models` and `ui-settings-plugins` already call it. It takes the reference name as its argument, which is precisely the authority this page must not have: the requirement is that the page writes one fixed reference. A dedicated namespace makes that a property of the wire contract rather than of the caller's good behaviour.

**Add the contribution to the `api-remotes` client assembly.** That is how every other namespace reaches the browser, and it would leave this package's browser entry a plain `inject`-declared plugin with no mount lifecycle. It also splits one package's feature across two, and the assembly is a hand-maintained list of other packages' artifacts. `client-ui-agent-team` already establishes the self-mount for a package that owns its own generated contribution, so this package does that instead.

**Accept the token through `settings` instead of `credentials`.** The settings seam carries redacted values on the same terms, but the credential seam already owns token storage, repair, source layering, and the writability check this page reports; routing through settings would add a second store for one string.

## Consequences

A person can now set the token from the GUI, and the row picks it up on the next call without a restart, because the transport re-resolves per operation. The write path crosses the browser/Host boundary in one direction only.

The cost is a second way to write one reference: `ctx.remote.credentials` and `ctx.remote.jubianToken` both reach `ctx.credentials.set` for `JUBIANAI_ADMIN_TOKEN`. They are not interchangeable — the generic namespace needs the reference name, this one cannot take one — but a deployment that wants a single audit point must watch the seam, not either namespace.

The package is now dual-face, so its build has two compiler faces and its browser entry imports a generated artifact that exists only after a Host build. `packages/jubian/tool-jubian/src/client/index.ts` is therefore outside the per-file coverage gate, on the same stated grounds as `packages/experimental/client-ui-agent-team/src/client/index.ts`: the import it binds has no source form to execute against.

The page cannot clear a token supplied by a read-only source: `describe` reports `writable: false`, both buttons are disabled, and the copy says why. That is the credential seam's shadowing rule showing through, not a gap in the page.

## Testing

`packages/jubian/tool-jubian/tests/token.spec.ts` drives the namespace over the real in-memory credential provider, so the stored value is read back from the seam rather than from a stub, and covers the refusal, the empty-value guard, and a provider that widens its reply. `tests/browser-plugin.client.spec.tsx` registers into the production `SlotRegistry` and a real `LocaleRuntime` with a `$mount` that records the contribution and provides the namespace, and `tests/section.client.spec.tsx` feeds the component its props directly, asserting the copy a user reads in each credential state. `npx vitest run --coverage packages/jubian/tool-jubian` reports per-file 100% statements, branches, functions, and lines over the covered sources.
