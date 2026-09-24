# Agent Note: Make the bundled Feishu bridge an explicit opt-in

Status: implemented

English | [中文](2026-09-24-desktop-feishu-bridge-opt-in.zh.md)

## Problem

The bundled Feishu bridge treats an unconfigured boot as consent: upstream it starts QR app registration when no credentials exist, opens a local control server for cross-instance synchronization, and reads a shared settings document before it answers chat. Shipping that package in the product's bundle list would register a Feishu application and open those channels on first start, and its entry config derives credentials from environment variables, so an inherited variable could point the product at another deployment's application.

## Decision

The product bundles `@moyu-good/dsh-lark-bridge` 0.6.1 as a mounted profile bundle and overrides its `feishu-channel` row in [the desktop composition patch](../../../../apps/desktop-host/config/desktop.cordis.patch.yml) with `enabled: false`, `autoRegistration: false`, and `crossInstanceSync: false`. The row also keeps `requireMention: true` and denies `ask_user_question` and `exit_plan_mode`. The plugin mounts and registers its settings section, but installs no chat channel, no channel tool, and no slash commands until an operator enables it.

The three flags come from [the compatibility overlay](../../../../third_party/plugins/compatibility/lark-desktop.mjs), which edits only the private staging tree; the pinned upstream snapshot stays unchanged. Each flag is optional with a `true` default, so an unpatched row keeps the bridge's upstream always-on behavior, and the overlay fails the build when a source anchor it rewrites is missing or duplicated.

With the product's flags in place, the bridge skips the cross-instance block entirely: it reads no shared settings document, starts no control server, publishes no peer heartbeat, and renews no presence. `DSH_SYNC_HOME` is resolved only by that sync store's directory lookup, so the product never reads another deployment's sync directory. Disabled or without credentials, it also starts no QR registration.

The settings section registers before the disabled gate, which is what keeps the package configurable while inert. Credentials are entered in the `dsh-lark-bridge` settings section of the product's own settings document, never in the row; the registration declares `applies: 'restart'`, so a change takes effect on the next backend start. A patch replaces the whole config of the row it targets, which is exactly why `appId` and `appSecret` are absent: the base bundle row derives them from `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, and keeping those keys would let an inherited variable bind the product to another deployment's application.

Enabling the bridge with `crossInstanceSync` false keeps the chat path and drops the arbitration path: inbound messages are no longer checked against a retired device or a cloud-arbitrated active endpoint, and the command path receives no sync context.

Two credentials are not a promise that the bridge works for a tenant. The Feishu application's own permissions and visibility scope decide who can reach the bot and which message, reaction, and slash-panel APIs answer; this plugin's authorization lists only narrow that reach.

## Alternatives considered

**Ship the bridge unmounted and let users add it later.** An unmounted package registers no settings section, so the product could not accept credentials before enabling it, and every enablement would need an install the product's own settings cannot express.

**Rely on the upstream defaults and document them.** First boot would register a Feishu application and open a control server without the operator asking; the product's default has to be inert.

**Keep the environment-derived credentials in the row.** An inherited `FEISHU_APP_ID` would bind the product to another deployment's application, which is the cross-deployment reuse the product's own home and settings exist to prevent.

**Gate the bridge with `enabled` alone.** Turning it on for chat would also turn on QR registration, cross-instance device arbitration, and a second home read; an operator choosing chat has not chosen those.

**Patch the pinned upstream source in place.** The recorded upstream revision stays byte-identical and the reviewed edits live in the build overlay, which refuses an unreviewed revision before writing any staged file.

## Consequences

The [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own plugin ownership, shared package identity, and package lifecycle; the [independent-product decision](2026-09-23-muse-med-independent-desktop.md) owns the product home, its settings, and its composition; the [community-source proposal](../../proposed/process/2026-09-23-muse-med-community-plugin-source.md) owns source retention and the explicit-activation requirement. None is fully superseded.

The overlay test pins each rewrite, the unchanged upstream snapshot, and rejection of an unreviewed revision without a partial write. The runtime check boots the compiled staged plugin through a real Loader with a real settings provider and the same three flags the product row sets: with a stored `enabled: true` and no credentials it registers no app, opens no control socket, makes no external request, and reads nothing under an unrelated `DSH_SYNC_HOME`; the settings section reports `restart` and the stored value; with credentials one channel connects, an inbound message reaches the agent instead of a device-arbitration reply, and disposal closes the channel. The resolved-config check pins the overlay's `true` defaults, and the product row check pins the three flags plus the absent credentials.

No real Feishu round trip was performed. QR onboarding, the live long connection, card rendering, and a tenant's own permission and visibility configuration remain unverified, as does enabling the bridge in the packaged product.
