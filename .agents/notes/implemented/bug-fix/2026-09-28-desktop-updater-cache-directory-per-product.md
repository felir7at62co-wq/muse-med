# Agent Note: the Desktop updater caches installers under this product's own directory

Status: implemented

English | [中文](2026-09-28-desktop-updater-cache-directory-per-product.zh.md)

## Problem

Packaging left the updater cache directory at electron-builder's derived default, and that default put this product and the official DeepSeek Harness on one directory: `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater` on Windows, the matching path below `~/Library/Caches` on macOS. electron-updater stores the downloaded installer in it under a fixed file name (`CURRENT_APP_INSTALLER_FILE_NAME` is `installer.exe`), so the directory is one slot that either product's updater may fill and either product's updater may then execute.

That is not a hypothetical. One machine's `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater` was read holding the official product's installer (860,747,005 bytes, VersionInfo 0.1.7-rc.2), and a later read of the same path found this product's own installer (861,634,377 bytes, VersionInfo 0.1.6-alpha.3, product `muse-med`) — the slot had been overwritten across products. The installed `E:\muse-med` build of `0.1.6-alpha.3` records that shared directory as its own in its packaged `resources/app-update.yml`, so its update flow reads and writes a directory another installed product also owns. An update that hands one product's installer to the other installs the wrong program.

The value is derived from the packaged `package.json` `name`, not from `appId` and not from any configuration field. `AppInfo.updaterCacheDirName` in `app-builder-lib` 26.15.3 returns `sanitizeFileName(name).toLowerCase() + '-updater'`; `sanitizeFileName('@deepseek-ai/dsh-desktop')` drops the `/` and keeps the `@`, giving `@deepseek-aidsh-desktop`, and that is exactly the value the installed `app-update.yml` records. Every product whose packaged manifest carries that upstream name therefore shares one cache directory — the app id plays no part in it, which the `@pi-desktopdesktop-updater` directory on the same machine reproduces from the unrelated `@pi-desktop/desktop`.

## Decision

The packaged manifest restates the product name, so the derived directory belongs to this product alone: `extraMetadata: { name: 'muse-med' }` in [electron-builder.config.mjs](../../../../apps/desktop/electron-builder.config.mjs) yields `muse-med-updater`. The name contains no `@` and no `/`, so no part of it can be read as a path or a scope.

electron-builder 26 exposes no configuration field for this value. `updaterCacheDirName` is declared only on the publish-provider options (`GithubOptions` and its siblings) in app-builder-lib's generated `scheme.json`, and it is absent from `Configuration` in `out/configuration.d.ts`; `PublishManager.getAppUpdatePublishConfiguration` assembles the serialized `app-update.yml` as `{ ...publishConfigs[0], updaterCacheDirName: packager.appInfo.updaterCacheDirName }`, so a value supplied on the `github` publish entry is overwritten before it is written and the packaged `package.json` `name` is the only reachable input. Restating the name in `extraMetadata` is what makes the derived value this product's own.

The same getter feeds the installer's side of the exchange, so installer and updater agree on one directory. `NsisTarget` defines `APP_PACKAGE_STORE_FILE` and `APP_INSTALLER_STORE_FILE` as `${appInfo.updaterCacheDirName}\<fixed file name>`, and `templates/nsis/include/installer.nsh` moves the running installer to `$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}` for later reuse. A runtime override inside the app would have left those defines naming a different directory than the updater wrote.

## Consequences

The packaged `package.json` `name` becomes `muse-med`, which is the name this product's launch already claims for Electron: [`applyDesktopProductIdentity`](../../../../apps/desktop/src/product-identity.ts) calls `app.setName('muse-med')` and pins userData to `%APPDATA%\muse-med` ahead of the single-instance lock, as [the shared Electron identity note](2026-09-28-muse-med-shared-electron-identity.md) decides. This change moves no userData directory; it removes the disagreement between the manifest and the runtime identity, so an Electron default derived from the manifest now lands on the directory the launch sets explicitly. The old shared `%APPDATA%\@deepseek-ai\dsh-desktop` and the decision to leave it untouched remain that note's. This product's own state is unaffected by either change, because sessions, settings, and credentials live in [`~/.muse`](../../../../apps/desktop/src/product-home.ts), or in `MUSE_MED_HOME`, which is outside `app.getPath('userData')`.

**That note's manifest facts are now historical.** Its Problem paragraph and `applyDesktopProductIdentity`'s JSDoc both state that the packaged manifest keeps `@deepseek-ai/dsh-desktop` and derives the shared directory from it; builds from this change carry `muse-med` instead. Its runtime identity decision, its userData decision, and its instance-lock reasoning are unchanged and still own those facts.

Installer identity does not move with the name. The uninstall registry key and the NSIS app GUID are derived from `appInfo.id` (`UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)` in `NsisTarget`), so an installed `0.1.6-alpha.3` is still detected and upgraded in place rather than installed beside; the uninstaller's `$APPDATA\<APP_PACKAGE_NAME>` removal follows the new name, which is the directory the new build actually uses. Shortcuts, their AppUserModelID, the installation directory, artifact names, the macOS bundle identifier, and the bundled dsh runtime's own `package.json` are untouched — `extraMetadata` rewrites only the app manifest inside the asar, and no workspace manifest resolves `@deepseek-ai/dsh-desktop` by name. Linux gains the product name for its binary as a side effect, since `linuxPackager` falls back to `appInfo.sanitizedName` there.

**An installed `0.1.6-alpha.3` keeps the shared directory until it is replaced.** This change alters what packaging writes, so it cannot reach the `app-update.yml` already installed on a machine: the fix is in effect from the next install or update onward, and only builds from that point record and use `muse-med-updater`.

## Alternatives considered

**Set `updaterCacheDirName` as configuration.** Not available in electron-builder 26.15.3: it is not a `Configuration` field, and no runtime code reads one for it. A value on the `github` publish entry is discarded by the serializer that owns the written `app-update.yml`, so it would read as a fix while changing nothing.

**Rename `apps/desktop/package.json`.** Rejected: that renames a workspace package that every manifest and tool resolves, while `extraMetadata` confines the rename to the packaged manifest that electron-builder reads the value from.

**Override the cache directory in the update coordinator.** Rejected: electron-updater would then write outside the directory the NSIS defines name, losing the installer-store reuse those defines exist for, and the packaged `app-update.yml` would still record the shared value for every other reader.

**Prefix this product's token onto the upstream name.** Rejected: the packaged manifest would still carry the upstream product's package name, which is the identity this product is separating from, and the derived directory would keep reading as that product's.

## Verification

`pnpm exec vitest run apps/desktop/tests/updater-cache-directory.spec.ts apps/desktop/tests/nsis-payload-assets.spec.ts apps/desktop/tests/macos-signature.spec.ts apps/desktop/tests/desktop-build-paths.spec.ts` passes, 17 tests over four files, exit code 0. [`updater-cache-directory.spec.ts`](../../../../apps/desktop/tests/updater-cache-directory.spec.ts) pins the packaged manifest name and the `muse-med-updater` directory it derives, and rejects `@deepseek-aidsh-desktop-updater` so the shared value cannot return unnoticed.

Not verified here: the `updaterCacheDirName` line in a packaged `resources/app-update.yml`. The derivation, the fixed installer file name, and the write site were read from the installed `0.1.6-alpha.3` bundle and app-builder-lib 26.15.3, but only a package run emits the file; this change was not packaged.

The [Desktop packaging and update record](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the release stream this directory serves, and the [uninstall cleanup proposal](../feature/2026-09-08-desktop-uninstall-preserve-dsh-home.md) owns what a future uninstaller removes from either directory.
