# muse-med Desktop

English | [中文](README.zh.md)

The desktop application is an Electron shell around the dsh Web UI. It opens no listening port: a bundled upstream Node.js child boots the installed dsh project, versioned framed byte pipes carry Fetch requests and streaming responses without an outer Base64 envelope, Node IPC carries lifecycle control, and `dsh-app://` serves the matching client assets.

The shell displays **muse-med** and uses `renderer/icon.png`, a square PNG converted from the supplied black-background white-spider artwork; electron-builder converts it to platform installer icons. The Windows executable is `muse-med.exe`; release artifacts use `muse-med-${version}-${os}-${arch}.${ext}` across packaging and upload validation. Package identifiers and update endpoints retain their DSH identities. Packaged muse-med uses `~/.muse-med` for sessions, settings, credentials, and plugins; `MUSE_MED_HOME` explicitly overrides that location, while an inherited `DSH_HOME` does not. Development retains its isolated launcher-managed home.

## Key technical decisions

| Decision | Why | Direct consequence |
|---|---|---|
| Release identity | The shell API, Web client, backend, and plugin graph are qualified as one combination; independent versions would create untested combinations and ambiguous update availability. | Electron and `@deepseek-ai/dsh` always have the same exact version. A dsh upgrade is a Desktop release, even when the shell code is unchanged. |
| Runtime | Electron's Node.js carries Electron patches, fuses, ABI, and lifecycle constraints, while system runtimes and package-manager state are uncontrolled. | dsh runs under the bundled upstream Node.js and every package operation uses the bundled pnpm. Electron's Node.js, system Node.js, system pnpm, and user package-manager configuration are outside the execution path. The official Node.js license is bundled byte-for-byte at `runtime/node/LICENSE`. |
| Package sources | Core installation at startup adds work even when offline. | `extraResources/dsh` carries a complete production dependency tree; the profile installs only external plugins. |
| Shared modules | Host APIs can depend on module identity. | Desktop links every bundled first-party package into the profile using directory symlinks, or Windows junctions; ordinary plugin dependencies remain local. |
| State ownership | Sharing executable dependency graphs would let CLI and Desktop change each other's dsh, Cordis, plugin, or native-module versions, while two desktop processes could race on the same profile. | Electron acquires its process-lifetime single-instance lock before any profile access and exclusively owns `$DSH_HOME/profiles/desktop` plus its package-manager state. The packaged product sets its own `$DSH_HOME` before profile access; CLI data is not imported. Executable packages, plugin activation, lockfiles, and `node_modules` remain Desktop-owned. |
| Transport | A listening Web service adds port ownership, authentication, CORS, and exposure concerns; Electron and upstream Node.js also need an explicit cross-process protocol. | The application opens no Web port. `dsh-app://` carries Web assets and Fetch traffic; framed byte pipes carry bounded request and response chunks with backpressure, while Node IPC carries only child lifecycle control. |
| Plugin changes | Package installation and Host startup can fail. | Desktop stops the Host and modifies the current profile directly. Failures retain partial changes for explicit repair; there is no automatic profile rollback. |
| Updates | Independent shell and dsh updates would recreate version splits, while unchanged shell blocks should not require a complete transfer. | The Electron shell, matching dsh runtime, Node.js, and pnpm form one signed update unit. Platform update artifacts may reuse unchanged blocks, but runtime version selection never splits from the Desktop release. |

The [Electron packaging and update Agent Note](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the rationale, alternatives, security constraints, and release qualification requirements behind these decisions.

## Installation ownership

Electron owns `$DSH_HOME/profiles/desktop`. Its `dependencies` contains only installed external plugins at exact versions; `dsh.profile.bundles` contains the built-in bundles followed by enabled plugins. The signed application supplies dsh, the private Desktop Host, and their production packages from `resources/dsh`. Shared package links resolve to those actual directories. Both host and plugins execute in the same bundled upstream Node process, with normal realpath resolution; Desktop does not enable `--preserve-symlinks`. The CLI cannot boot or mutate this profile.

The Desktop Host composes drama settings and Jubian tools once for all desktop sessions, with an automatic CNY 4000 ceiling per Jubian `script_id` for priced calls; local settings can change the limit. It mounts the maintained drama skill package and exposes only the product-owned `short-drama-local` preset, with shipped and personal preset roots disabled. The Windows package preparation builds a hash-locked Python, media dependency, FFmpeg, and Whisper payload; the release remains unqualified until complete installer and clean-machine checks pass. Public binary distribution also requires the corresponding-source review recorded in the media descriptor.

The local startup page exposes startup status and available recovery actions; the loaded dsh renderer receives only the desktop protocol marker. The separate plugin window receives structured list, install, remove, update, and update-check operations; neither renderer receives filesystem access, raw Electron IPC, a shell, or arbitrary pnpm arguments.

Electron chooses typed English or Chinese shell copy from its application locale and falls back to English. Menus, native dialogs, the startup page, and the plugin-management renderer use the same locale payload; the repository Client UI i18n gate checks these desktop sources.

### Short-drama resources and limits

The maintained skill tarball contains 16 skills and 82 files, with no Xiaohongshu skill. The workflow accepts user-provided reference images through core's `style_references` import/check operations and retains review and user confirmation before proceeding. These are skill-level requirements, not a new paid-tool authorization mechanism. The Python and TypeScript rendering paths select the pinned OFL-licensed Noto fonts for subtitles and watermarks. Source tests and glyph rendering with the development FFmpeg input passed; the final rebuilt installer and clean-machine font path remain to be qualified.

Local media preparation covers Python dependencies, FFmpeg, and Whisper ASR. Provider generation and account operations still require network access and the user's own credentials. Public BGM matching/downloads require network access; optional MERT index/inspect analysis is not part of the default offline media payload and retains its non-commercial license restriction. The snatch scripts use the normalized environment and current product home, but do not read credentials from the UI vault; operators must configure their supported credential source separately and must not put tokens in prompts, logs, or source files.

### Runtime and plugin activation

The [community source builder](../../third_party/plugins/README.md) supplies five required local tarball roots; missing inputs stop package preparation rather than falling back to registry binaries. Codex subscription, FFmpeg tools, and Ponytail are built-in profile bundles. Marketplace and Lark sources and packages are retained but not activated: the marketplace requires HTTP routes, and unconfigured Lark starts account onboarding and a local control server.

The product loads its bundled skills without scanning existing DSH, `.agents`, or default project skill roots; explicit plugin skill registration remains available. Drama skills are unpacked from ASAR, and the Host exposes their real `app.asar.unpacked` paths to external Python. Windows startup prepends `runtime/media/python` and `runtime/media/ffmpeg/bin` to the child search path and sets the local ASR model directory. The [media preparer](scripts/prepare-media-runtime.ts) verifies locked inputs, dependency imports, encoding, subtitle burning, draft media probing, and offline ASR before publishing its output; reuse verifies the complete file inventory and reruns that smoke. These checks on the build machine do not replace installation on a machine without development tools. The installer carries the official VC++ prerequisite, checks its installed version, and requests authorization before installing it; rejection or failure prevents successful completion and automatic launch. Redistribution requires the publisher's applicable Microsoft license, not merely the runtime's end-user license.

The [FFmpeg source-build workflow](scripts/ffmpeg-source-build/README.md) produces a binary and matching source pair for the offline release. Both CI jobs must pass before replacing the development FFmpeg input, and the corresponding-source archive must accompany the desktop release; a submitted build is not a qualified artifact.

The signed `resources/dsh/desktop-runtime.json` binds the shell version, bundled Node version, platform, architecture, shared package versions, and final file inventory. Startup reads the metadata and checks shared package records. Release schema, shell version, target compatibility, and file integrity are verified during packaging. Core packages are never copied into profile storage or installed by pnpm at first launch.

1. The main window displays a local loading page before profile preparation or backend startup. A fresh profile creates its manifest and shared package links while preserving unrelated files, then starts the actual backend once. Unchanged startups reuse the profile without scanning installed plugin manifests.
2. A compatible application upgrade refreshes shared links in the current profile and checks enabled plugins’ peer requirements. Plugin files, configuration, versions, and lockfile remain in place; pnpm does not run.
3. A changed bundled Node version, platform, or architecture reinstalls the locked plugin graph with scripts disabled, validates and links host packages, then runs approved pending builds and validates again.
4. Plugin add, update, and remove operations use bundled pnpm and Desktop-owned package-manager state. Reserved host packages must be peers; nested copies and aliases of shared packages fail validation. Ordinary plugin dependencies must resolve inside the profile.
5. Plugin changes stop the backend before modifying the current profile. Successful preparation starts the Host. Package or Host startup failures retain modified files and report the error. Unfinished package operations retain a marker so the next launch retries the locked installation and pending builds. Desktop creates no staging directories, activation journals, or rollback copies.

The loading page does not depend on the Host. Errors offer restart and reinstallation guidance. Disabling plugins and resetting Desktop are offered only when packaged application resources support profile recovery; development and early initialization failures expose restart alone. The plugin manager remains available through the application menu. Runtime identity is checked before any backend starts; plugin changes have no automatic rollback.

Reset deletes every entry in `$DSH_HOME/profiles/desktop` except the held transaction lock, then initializes the built-in profile. It removes Desktop configuration and installed third-party packages without a backup. Shared tasks, settings, and the Harness-home `.env` are untouched. Shell resource and preload failures use a self-contained document with the available recovery actions and diagnostics; its controls do not require preload.

Package transactions hold `$DSH_HOME/profiles/desktop/lock` exclusively through pnpm process exit. Reset preserves the directory and its lock until initialization and Host startup finish. Shared links use directory symlinks on macOS/Linux and junctions on Windows; cleanup removes links without deleting their targets. Canonical filesystem paths identify shared packages, so Windows path casing alone does not trigger profile activation. Native builds follow the profile’s reviewed `allowBuilds` list; installing a new build-requiring package without approval in that list fails the transaction.

## Develop

`dev:desktop` builds the current Host, client bundles, Web frontend, and Electron shell, builds the five pinned community plugins through the existing source builder, and projects their validated tarballs, frozen runtime dependencies, and the built CLI and private Desktop Host packages into a disposable desktop npm project, and launches Electron without downloading the packaged Node.js runtime or resolving dsh from npm:

```sh
pnpm run dev:desktop
```

Development Harness state defaults to `apps/desktop/.desktop-build/development/home`, the disposable npm project lives at `apps/desktop/.desktop-build/development/project`, and Electron browser data lives at `apps/desktop/.desktop-build/development/electron-user-data`. Sessions, settings, credentials, package links, and browser data therefore stay out of the user's normal Harness home. An explicit `DSH_HOME` replaces only the development Harness home. Renderer DevTools opens automatically; Main, Renderer, and dsh Host debugging listen on ports 9229, 9222, and 9230. `DSH_DESKTOP_MAIN_INSPECT_PORT`, `DSH_DESKTOP_RENDERER_DEBUG_PORT`, and `DSH_DESKTOP_HOST_INSPECT_PORT` replace those ports, while `DSH_DESKTOP_OPEN_DEVTOOLS=0` keeps the detached Renderer tools closed.

After an explicit build, `start:desktop` reconstructs the disposable project and launches the existing artifacts without building again:

```sh
pnpm run start:desktop
```

Workspace development runs the current CLI and private Desktop Host packages under the invoking Node.js and disables desktop package mutations. Its explicitly linked disposable profile is the only mode allowed to resolve bundles outside its own directory. Use an unpacked application to exercise the bundled Node.js, bundled pnpm, bundled dsh resources, plugin installation and repair paths.

## Package

The normal packaging path is one complete command. It performs release preparation before creating the host platform's installers and update metadata. Every target requires a reverse-DNS `DSH_DESKTOP_APP_ID`. macOS targets additionally require the electron-builder certificate qualifier in `DSH_DESKTOP_MACOS_SIGNING_IDENTITY`, its 10-character Apple Team ID in `DSH_DESKTOP_MACOS_TEAM_ID`, and one complete notarytool credential strategy. The App Store Connect API-key strategy uses these variables:

```sh
export DSH_DESKTOP_APP_ID='<reverse-DNS application ID>'
export DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without the Developer ID Application prefix>'
export DSH_DESKTOP_MACOS_TEAM_ID='<10-character Apple Team ID>'
export APPLE_API_KEY='<absolute path to the .p8 file>'
export APPLE_API_KEY_ID='<App Store Connect API Key ID>'
export APPLE_API_ISSUER='<App Store Connect issuer UUID>'
```

`prepare:desktop` is not a prerequisite:

```sh
pnpm run package:desktop
```

Release automation uses fixed target commands so runtime preparation, dsh preparation, and electron-builder receive the same platform and architecture:

```sh
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:win:x64
```

The macOS arm64 command requires Apple Silicon. The macOS x64 command runs on Intel macOS or Apple Silicon with Rosetta. The Windows x64 command requires Windows x64. Linux is not a supported Desktop release target.

Each target owns its packed package inputs, prepared runtime, package set, dsh tree, pnpm preparation state, unpacked application, update metadata, and final artifacts under `apps/desktop/.desktop-build/targets/<target>/`. The Node.js archive cache remains shared under `.desktop-build/downloads` because every archive name includes its version, platform, and architecture and is verified before extraction. A target build never consumes another target's mutable preparation state.

### Runtime file selection

Production packages first pass through npm's publication rules and dependency installation. [Desktop's file policy](scripts/runtime-file-policy.ts) then filters the immutable `resources/dsh/node_modules` copy before signing and integrity sealing. It omits TypeScript declarations, recognized JavaScript/CSS/TypeScript source maps, TypeScript build caches, Domino's test directory, selected native compiler outputs, and node-pty prebuilds for other platforms. It preserves runtime JavaScript, native modules and their DLL/EXE helpers, WASM, unknown assets, licenses, and notices. The policy does not alter npm tarballs, the bundled package manager, or user-installed plugin files.

The packaged application runs compiled JavaScript and pre-generated Typert metadata; it does not compile TypeScript plugins. Source-level debugger navigation and editor declarations remain available in development packages. [Copy-policy tests](tests/runtime-file-policy.spec.ts) cover exclusions and retained assets; `prepare:dsh` runs the [payload smoke](tests/fixtures/runtime-payload-smoke.mjs) under the bundled Node before the Host smoke and final inventory verification. Before publishing the inventory, the [Codex check](scripts/verify-codex-runtime.ts) requires the source-pinned provider, CLI, and declared target-platform package entirely inside the payload, then runs `--version` with bundled Node in an isolated home. A missing optional download or incorrect executable version fails preparation. The frozen production-install phase gives pnpm a bounded 30-minute `fetch-timeout` for complete tarball response bodies. Lockfile metadata resolution retains pnpm's default deadline and retries. Builders may set `DSH_DESKTOP_FETCH_TIMEOUT_MS` to positive integer milliseconds up to 2,147,483,647; other inherited npm configuration remains excluded.

The [Host smoke](scripts/smoke-runtime.ts) starts in an isolated home, waits for the credentials Service without supplying credentials, mounts the complete product preset, and checks its tools and bundled skills. Preparation requires the smoke's completion record after Agent disposal, not merely Host readiness; startup fails after 60 seconds without readiness. The runtime root manifest supplies the complete CLI, Desktop Host, and source-plugin dependency graph used by preset discovery.

Windows release qualification also runs [native cleanup and replacement checks](scripts/smoke-windows.ps1) manually after the Desktop build. Set `$Electron` to the prepared Electron executable and `$Makensis`, `$SevenZip`, and `$PluginDir` to the pinned builder’s NSIS compiler, 7-Zip executable, and x86-unicode NSIS plugin directory. From the repository root, run the command below. It verifies Electron junction cleanup, installer scratch cleanup, and both locked-file replacement modes; it is not part of the unit-test lane.

```powershell
pwsh -NoProfile -File apps/desktop/scripts/smoke-windows.ps1 -Electron $Electron -Makensis $Makensis -SevenZip $SevenZip -PluginDir $PluginDir
```

### Upload updates

`DSH_DESKTOP_AUTO_UPDATE_ENV` selects `test` or `production` for both the URL embedded during packaging and the later COS upload; an absent value selects `test`. Test packaging requires its HTTPS origin in `DOWNLOAD_TEST_ORIGIN`, while the production origin remains `https://download.deepseek.com`. Upload additionally requires the selected deployment's COS bucket in `DOWNLOAD_TEST_COS_BUCKET` or `DOWNLOAD_PROD_COS_BUCKET`. The target path is `_/harness/desktop/stable/<target>/`, where `target` is `mac-arm64`, `mac-x64`, or `win-x64`.

The update destination and upload credentials follow the selected deployment:

| Environment | Public origin | COS bucket | COS credentials |
|---|---|---|---|
| `test` or unset | `DOWNLOAD_TEST_ORIGIN` | `DOWNLOAD_TEST_COS_BUCKET` | `DOWNLOAD_TEST_COS_SECRET_ID`, `DOWNLOAD_TEST_COS_SECRET_KEY` |
| `production` | `https://download.deepseek.com` | `DOWNLOAD_PROD_COS_BUCKET` | `DOWNLOAD_PROD_COS_SECRET_ID`, `DOWNLOAD_PROD_COS_SECRET_KEY` |

Package and upload one target under the same environment. For example, the default test deployment uses:

```sh
export DOWNLOAD_TEST_ORIGIN='https://desktop-updates.example.com'
pnpm run package:desktop:mac:arm64

export DOWNLOAD_TEST_COS_BUCKET='<test COS bucket>'
export DOWNLOAD_TEST_COS_SECRET_ID='<test COS SecretId>'
export DOWNLOAD_TEST_COS_SECRET_KEY='<test COS SecretKey>'
pnpm run upload:mac:arm64
```

Set `DSH_DESKTOP_AUTO_UPDATE_ENV=production` before packaging, then provide `DOWNLOAD_PROD_COS_BUCKET` and the production credential pair before running `upload:mac:arm64`, `upload:mac:x64`, or `upload:win:x64`. Packaging does not require a COS bucket or credentials. It explicitly disables electron-builder publishing, strips all four COS credential fields from its subprocesses, and writes a target completion record only after electron-builder and every signing or notarization hook succeeds. Upload requires that record to match the selected environment, target, public URL, and current dsh version; it also requires the root dsh version, Desktop version, channel metadata version, artifact names, sizes, and SHA-512 values to agree before it reads the selected COS credential pair. It uploads only that target's immutable versioned artifacts, uploads the version-derived channel metadata last with `no-cache`, and never deletes historical objects. Stable releases use `latest-mac.yml` or `latest.yml`; a prerelease such as `alpha` uses `alpha-mac.yml` or `alpha.yml`, matching electron-builder's emitted filename.

The macOS configuration uses the required release environment instead of accepting whichever certificate appears first in a keychain. It rejects empty values, a malformed Team ID, a signing identity that includes electron-builder's unsupported `Developer ID Application:` prefix, and incomplete notarization credentials. macOS packaging requires the configured identity and its private key. Runtime preparation applies that identity, a secure timestamp, and hardened runtime to every embedded Mach-O file; after signing the application, a deep strict check rejects any other leaf authority or Team ID before artifact creation. The fixed-target macOS installer commands create separate copies of the signed application and run two artifact lanes concurrently. One lane notarizes and staples the App before generating the ZIP and its update metadata. The other encloses its signed App copy in a signed DMG, then notarizes, staples, and verifies the DMG; its inner App has no individually stapled ticket. Both lanes must finish successfully before their artifacts reach the final directory and the release completion record is written. Directory-only commands also require notarization credentials and wait for Apple notarization and App stapling. The [parallel notarization decision](../../.agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.md) owns copy isolation and container ticket semantics. The private key can come from the login keychain or electron-builder's standard `CSC_LINK` input; ambient `CSC_NAME` and certificate discovery order do not select the release owner. Notary credentials may instead use electron-builder's complete Apple ID or keychain-profile strategy. The two macOS identity variables are also required when repeating the application check manually with `pnpm --dir apps/desktop run verify:mac-signature -- <path-to-app>`.

macOS signing visits real files without following Framework symlink aliases. PAK resources retain all shipped languages and are sealed by the enclosing Framework or application signature instead of receiving individual signatures. The [release policy](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns the dependency patch and verification requirements.

Company proxies can accelerate uploads to Apple's notarization service. See the company internal documentation for configuration.

### Unsigned Windows test installer

The Windows installer supports English and Simplified Chinese. It defaults to a dedicated `muse-med` installation directory; do not install directly into a drive root. On Windows x64, use the complete unsigned packaging command for local installation testing:

```sh
pnpm run package:desktop:win:x64:unsigned
```

The command requires `DSH_DESKTOP_APP_ID` and the normal build dependencies, including Python and Visual C++ build tools for native modules. Set `PYTHON` to the Python executable when it is absent from `PATH`. It writes the installer to `.desktop-build/targets/win-x64/unsigned-artifacts/`, omits automatic-update configuration, strips signing credentials, and creates no release completion record. It does not require EV credentials or an update origin. The signed packaging and upload commands retain their release requirements.

### Windows EV signing

Windows packaging fixes the 7-Zip filter to `BCJ` for compatibility with the bundled NSIS decoder. This preserves ARM64 binaries carried by dependencies in x64 installers; automatic ARM64 filtering produces entries that this decoder cannot extract.

NSIS removes its temporary extraction tree during installation, before the completion page or an automatic launch. The installed production packages remain ordinary files; startup does not extract them again. Installation still writes the complete application tree.

Windows release packaging requires `DSH_DESKTOP_WINDOWS_CER_FILE` to identify the public GlobalSign EV leaf certificate, `DSH_DESKTOP_WINDOWS_SIGNTOOL` to identify the SafeNet-compatible SignTool executable, `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` to identify the matching private-key container, and `DSH_DESKTOP_WINDOWS_TOKEN_PIN` to contain the SafeNet Token Password. The certificate file remains outside source control, and the matching private key stays on the USB token. Set the four inputs before running the fixed Windows target:

```powershell
$env:DSH_DESKTOP_WINDOWS_CER_FILE = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL = 'C:\path\to\the\validated\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet private-key container name>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN = '<SafeNet Token Password>'
pnpm run package:desktop:win:x64
```

Insert and unlock the token before packaging. The electron-builder hook passes each artifact to the CRLF `scripts/windows-sign.cmd`, which invokes the configured SignTool once with `/f`, SafeNet `/kc "[{{PIN}}]=container"`, `/csp "eToken Base Cryptographic Provider"`, a SHA-256 file digest, and a DigiCert SHA-256 RFC 3161 timestamp. The hook never substitutes electron-builder's bundled SignTool and never retries a failed signing request. Windows release packaging fails instead of emitting unsigned artifacts when the SignTool, certificate, container, PIN, token, or signature is unavailable.

The PIN cannot contain `]`, a quote, or a line break because those characters delimit the SafeNet `/kc` value or its CMD argument. The CMD disables delayed expansion so a PIN containing `!` reaches SafeNet unchanged. Packaging withholds every `DSH_DESKTOP_WINDOWS_*` field from build and runtime-preparation subprocesses, gives electron-builder only the four configured inputs, gives the signing CMD only the validated signing fields in an otherwise scrubbed environment, clears those fields before SignTool starts, and redacts SignTool diagnostics. SafeNet still requires the PIN in the SignTool process command line. Inject it as an ephemeral secret only on a controlled self-hosted Windows runner with the physical token attached; never commit it, put it in `.env`, or persist it as a Windows user or system environment variable.

Create a runnable application directory instead of an installer by using the matching `:dir` command, such as:

```sh
pnpm run package:desktop:dir
pnpm run package:desktop:mac:arm64:dir
```

To inspect or troubleshoot the prepared host-target resources without invoking electron-builder, stop the same pipeline after preparation:

```sh
pnpm run prepare:desktop
```

This diagnostic command is an alternative stopping point, not the first half of a two-command build. A later `package:desktop*` command repeats the official build and preparation so it cannot consume stale dsh packages, runtime files, or dsh content.

Every package command builds the repository, packs the first-party production closures rooted at dsh and the private Desktop Host, and prepares target-specific Node and pnpm executables. `prepare:dsh` installs the production graph once at build time, copies materialized packages into `extraResources/dsh`, removes package-manager metadata, and writes `desktop-runtime.json` with shared package versions and final file hashes. On macOS it signs and verifies native files before inventory generation; electron-builder excludes this already-signed tree from nested re-signing. Resource mappings explicitly include `dsh/node_modules`, which the default root-directory filter omits; the copied inventory is checked before signing and again after signing. Signed installer, notarization, installed upgrade, and target-specific native-module qualification require the release environment.

An unpacked artifact contains Electron, the materialized dsh production tree, upstream Node.js and pnpm, and the shell application. Installer size and filesystem size differ; release qualification measures both, plus the profile’s plugin storage and first-launch latency. The runtime trades more application files for eliminating core package installation on the user’s machine.

## Updates

A packaged application checks its target-specific release stream ten seconds after the main window opens; the localized **Check for Updates…** menu item triggers the same check manually. An available release opens one native confirmation dialog. Accepting it waits for an in-flight check, downloads and verifies the signed Desktop release, stops the dsh child, and hands installation plus restart to electron-updater. The next launch displays the local loading page while reconciling the version-bound runtime.

Signed packaging emits generic-provider channel metadata for the deployment selected by `DSH_DESKTOP_AUTO_UPDATE_ENV`. NSIS differential packages and the macOS ZIP target allow electron-updater to reuse unchanged blocks; the manually installed DMG is notarized without a blockmap because it is not a macOS updater payload. The runtime and shell still form one signed Desktop release. macOS signing and notarization credentials use electron-builder's standard environment; Windows EV signing uses the public certificate, validated SignTool, SafeNet container, and runner PIN described above. The required Desktop release environment selects the application and platform signature identities that the build verifies.

## Low-level development overrides

An unpackaged Electron process uses `.desktop-build/development/project` under its application directory as its development project. `DSH_DESKTOP_NODE_BINARY`, `DSH_DESKTOP_PNPM_ENTRY`, and `DSH_DESKTOP_DSH_DIR` select explicit runtime resources. Packaged applications ignore these variables, resolve signed resources from `process.resourcesPath`, and use the managed Desktop profile.

## Known limitations

- The Web "Open In..." action is disabled in Desktop because its host plugin requires HTTP routes; Desktop does not provide a `webServer`.
- Release signing, notarization, update hosting, and previous-version installed-artifact qualification require the production release environment.
- Desktop plugins with dependency lifecycle scripts are rejected unless their package appears in the desktop project's reviewed `allowBuilds` policy.
- The independent product does not migrate existing DSH sessions or credentials. Users configure their accounts in the product; explicitly pointing `MUSE_MED_HOME` at an existing DSH home opts out of data isolation and is not a migration.
