# Agent Note: Make the bundled Feishu bridge an explicit opt-in

Status: implemented

English | [中文](2026-09-24-desktop-feishu-bridge-opt-in.zh.md)

## Problem

A bundled chat bridge can start onboarding, control servers, or cross-instance reads before the operator chooses chat. Environment-derived credentials can also bind the product to another deployment's application. Bundling a package must not authorize those effects.

## Decision

The product carries `@wenbin_wb/dsh-bridge` through the [reviewed staging overlay](../../../../third_party/plugins/compatibility/bridge-desktop.mjs). The retained upstream snapshot stays unchanged. The artifact exposes an optional Feishu provider with `enabled: false`; upstream root activation, LAN/control servers, Cloudflare, self-update, and upstream password/QR authentication are excluded.

The [desktop activation layer](../../../../apps/desktop-host/src/feishu-gate.ts) reads the product's `feishu.enabled` switch at backend startup and carries it into `feishu-channel.enabled`. The row stays mounted while off so its Config-derived settings section can accept credentials before activation. The provider creates no gateway or conversation node while off, requires credentials when on, retains the mention requirement, and denies tools whose answers require another interface.

The setup row writes credentials into the active profile's `feishu-channel` section through settings. Volatile fields remain writable, secrets are redacted, and changing the app or scanner withdraws previous sender and session bindings. Profile migration preserves legacy credentials and backups and turns the product switch off. The bridge reads workspace and session metadata through current Host services; it does not read another deployment's storage or legacy storage generations.

The legacy Muse Web launcher independently defaults its user-installed old bridge row to entry-disabled. It preserves an existing operator choice. Desktop composition does not control that separate Web profile. Feishu app registration belongs to the product Settings action, and the Muse remote provider uses account/device authentication independently of the Feishu switch.

## Alternatives considered

**Ship the bridge unmounted and require later installation.** An unmounted row has no settings section for credentials, so the product cannot configure it before activation.

**Accept upstream defaults or environment-derived credentials.** They permit unrequested onboarding and cross-deployment credential reuse.

**Enable the entire upstream root for chat.** Choosing chat does not authorize LAN servers, public tunnels, standalone updates, or another home read. The reviewed artifact exposes only the required providers.

**Patch retained source in place.** Reviewable adaptation belongs in private staging; the overlay checks every retained module before writing.

## Consequences

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) owns shared package identity and lifecycle, and the [independent-product decision](2026-09-23-muse-med-independent-desktop.md) owns the product home and composition.

The [overlay checks](../../../../third_party/plugins/compatibility/bridge-desktop.test.mjs) verify source-review rejection and public-service metadata reads. The [Desktop Loader checks](../../../../apps/desktop/tests/feishu-setup-loader.spec.ts) verify the real patch composition and product switch; the [credential checks](../../../../packages/host/feishu-settings/tests/service.spec.ts) verify profile writes, redaction, and binding withdrawal. Artifact checks exercise the real provider and conversation node with a synthetic SDK peer. Live QR registration, message delivery, cards, tenant permissions, and packaged activation remain unverified.

A service receives dependencies from its injected scope; consumers resolve settings there and pass them explicitly. Cordis wraps services in a proxy, so implementation fields use TypeScript-private fields rather than JavaScript `#private` slots. Settings keys must remain aligned with the bridge Config.
