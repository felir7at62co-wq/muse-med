---
kind: upgrade-guide
description: "Desktop-mode Web access selects an installation instead of binding the whole account to one online computer."
---
# Muse Web selects a computer

English | [中文](guide.zh.md)

## Change

In desktop mode, several installations can stay online for the same account. The website enters `/desktop/<installation-UUID>/` automatically when exactly one is online; otherwise it shows the computer picker. `/computers` always opens the picker. Each tab stays on its selected installation, including during disconnection. Unselected desktop requests return 503 with `desktop-selection-required` when several computers are online; `/api/desktop/status` adds `selection-required`.

The version-1 account store adds `desktopDevices` with names, operating systems and latest connection times. Existing `desktopDeviceId` records remain readable and preserved. New clients send optional `deviceName` and `platform` fields in the version-1 handshake; older clients receive a UUID-based label. The exported `MuseDesktopTunnelOptions` requires those two fields from provider consumers.

## Migration

1. Deploy the account gateway and the Muse desktop bridge from the same release. Keep the existing private account database and installation identities. Set `MUSE_WORKSPACE_MODE=desktop`; cloud mode retains its existing behavior.
2. Update custom `MuseDesktopTunnelOptions` consumers to supply `deviceName` (1–80 characters without control characters) and `platform` (`win32`, `darwin`, `linux` or `unknown`). Forward assets, HTTP requests and WebSockets through the selected `/desktop/<installation-UUID>/` URL. Let the gateway check ownership and strip the prefix.
3. Sign in on two computers and the website. Confirm that the picker lists both, separate tabs show their respective sessions, and stopping one computer leaves the other usable. The disconnected tab must wait for its original computer. See [gateway deployment](../../../../services/muse-accounts/README.md#desktop-website-access) for transport configuration.
