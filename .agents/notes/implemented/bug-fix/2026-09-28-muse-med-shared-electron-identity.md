# Agent Note: Give muse-med its own Electron identity

Status: implemented

English | [中文](2026-09-28-muse-med-shared-electron-identity.zh.md)

## Problem

An installed `muse-med` 0.1.6-alpha.3 reported its version but would not start: double-clicking it or launching it from a command line left the process gone within eight seconds, exit code 0, no output, and no file written to any home. The machine also ran eight `DeepSeek Harness` processes, and `%APPDATA%\@deepseek-ai\dsh-desktop` — the upstream product's userData directory — was still being written.

Both products derived that directory from the same packaged package name, `@deepseek-ai/dsh-desktop`; the packaged manifest now carries `muse-med` through `extraMetadata` in the same configuration file, and the runtime identity above is stated explicitly either way. `productName` and `executableName` in [`electron-builder.config.mjs`](../../../../apps/desktop/electron-builder.config.mjs) rename the executable and the artifacts; they do not rename the application identity Electron uses for `userData`. Electron derives `userData` from the application name and puts the `SingletonLock`, `SingletonCookie`, and `SingletonSocket` files behind `app.requestSingleInstanceLock()` in that same directory, so a running DeepSeek Harness already held the only instance lock: [`claimDesktopSingleInstance`](../../../../apps/desktop/src/single-instance.ts) read `requestSingleInstanceLock() === false`, called `application.quit()`, and the shell exited by itself. Nothing in `apps/desktop/src/main.ts` or any other shipped module set the name or the userData path before that claim. Sharing the directory also shared Chromium caches, updater state, and every future window-state file with the upstream product.

## Decision

[`applyDesktopProductIdentity`](../../../../apps/desktop/src/product-identity.ts) is the first statement of `apps/desktop/src/main.ts`, ahead of the product home, every path read, and the lock claim. It calls `app.setName('muse-med')` and then `app.setPath('userData', join(app.getPath('appData'), 'muse-med'))` — `%APPDATA%\muse-med` on Windows, with no `@` and no path separator in the directory name. It creates that directory first, because `app.setPath` documents an Error for a directory that does not exist and the single-instance files are created inside it.

A launch that already received `--user-data-dir` keeps that directory: the development launcher passes one, Chromium honors it for `app.getPath('userData')`, and overriding it would move development storage into the installed product's directory. `sessionData` follows `userData` unless it is set separately, so the single call covers Chromium storage as well.

Packaging identity is unchanged. electron-builder's `appId`, the macOS bundle identity, the updater endpoints, and the protocols still come from the release environment, as the [independent-product decision](../architecture/2026-09-23-muse-med-independent-desktop.md) records. The runtime identity is now product-owned as well, which that decision did not cover.

The old shared directory is left exactly where it is and nothing is migrated out of it. Its Chromium caches, `Preferences`, cookies, local storage, and updater download cache are regenerable or belong to the upstream product, and the only files in it that are load-bearing — the `Singleton*` files — must never be copied, because a copied lock would make the new directory fail the same way. The product's own state is unaffected: sessions, settings, and credentials live in `~/.muse`, or in `MUSE_MED_HOME`, which is a separate path from Electron's userData. No user data is discarded, because no user data was ever written to the old directory by this product alone.

## Testing

`apps/desktop/tests/product-identity.spec.ts` drives an injectable application stub: the userData path is `join(appData, 'muse-med')` and never `join(appData, '@deepseek-ai', 'dsh-desktop')`, the directory exists after the call, the recorded call order is `setName` → `getPath('appData')` → `setPath('userData')` → `requestSingleInstanceLock`, and a stub whose `commandLine.hasSwitch('user-data-dir')` is true records `setName` alone. `apps/desktop/tests/main-startup.spec.ts` asserts the same order at the real call site in `main.ts` and derives the upstream directory from `apps/desktop/package.json`'s package name, so restoring that name fails the test. `apps/desktop/tests/single-instance.spec.ts` keeps the existing behavior: a second process quits without lifecycle work, and a later launch routes to the primary process instead of opening another window.

The Electron facts above were probed on this machine with Electron 44: `--user-data-dir` overrides `app.getPath('userData')` in both argument positions, and `app.setPath` accepted a missing directory, which is why the documented Error is handled by creating the directory instead of relying on either outcome.

## Alternatives considered

**Reuse `resolveDesktopAppId` for the userData name.** It resolves the packaging `DSH_DESKTOP_APP_ID` and validates a reverse-DNS identifier; it lives in `apps/desktop/scripts/desktop-release-environment.mjs`, which the packaged `files` list excludes, so a packaged process cannot import it, and the packaged environment does not carry the variable. Making userData depend on it would also change the macOS bundle identity, the updater identity, and the Windows app id, which is a release-line decision rather than a launch fix. The product name in `src` stays the one source of the directory name, and it matches `productName` and `executableName`.

**Migrate the old userData directory.** The directory belongs to the installed DeepSeek Harness and is still written by it; its contents cannot be attributed to either product. Copying it would import the upstream product's renderer state and its `Singleton*` files, and the second of those breaks the new lock outright.

**Keep one shared directory and drop the single-instance lock.** Removing the lock would let two processes write one Chromium profile and one product profile, and it would leave the shared data defect in place.

## Consequences

An installed Muse and an installed DeepSeek Harness can run at the same time: each product owns its own name, userData directory, and process lock. A machine that already installed `muse-med` starts the new build with empty Electron storage — Chromium caches, `Preferences`, cookies, and local storage are regenerated, and an update downloaded into the old shared directory is downloaded again. Product data is untouched.

The [independent-product decision](../architecture/2026-09-23-muse-med-independent-desktop.md) and the [bundled-runtime decision](../architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continue to own the product home, the preset roster, and package lifecycle; neither is superseded. A real two-process launch on a machine where both products are installed is not verified here: it needs the next installed build, and packaging stays with the release line.
