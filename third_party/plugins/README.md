# Community plugin source and builds

English | [中文](README.zh.md)

These seven source snapshots retain the community plugins used by Muse Med. [sources.json](sources.json) records each public upstream repository, version, license, and either its revision or recovered release archive SHA-256. The snapshots retain upstream source and manifests; some text files normalize CRLF to LF. No installed profile, credentials, user media, or generated runtime is a build input. The translation gate excludes the seven upstream directories and hash-checked embedded upstream resources; Muse-owned source and documentation remain checked.

[owned-downloads.json](owned-downloads.json) separately pins the Muse Hongguo and Douyin download bundles. The inventory also includes the local [reverse tools](muse-reverse-tools/README.md) and independent [Fanqie downloader](muse-fanqie-download/README.md). Their READMEs own configuration and verification limits; they do not change the retained upstream inventory.

## Build

Use an installed checkout with the current Host and Client packages already built. From the repository root:

```sh
pnpm --dir third_party/plugins/toolchain run build --out ../../../.artifacts/community-plugins
pnpm --dir third_party/plugins/toolchain run test:host
pnpm --dir third_party/plugins/toolchain run test:build
```

[build.mjs](build.mjs) installs the separate [toolchain lock](toolchain/pnpm-lock.yaml) with frozen resolution and install scripts disabled, then compiles and packs each plugin serially in temporary staging. `--only dsh-ffmpeg` selects one source directory. Staging links to this checkout's built Host packages, never a live profile. Child checks use a temporary Harness home and omit credential-bearing environment variables. The helper removes its links before deleting staging; source directories receive no generated output or `node_modules`. The bridge's upstream JavaScript source already lives in `lib`.

Each tarball retains its upstream license and Codex notices, adds the bundled Heroicons license where needed, and records the upstream pin, reviewed Host/vendor versions, and toolchain-lock digest in `SOURCE.json`. The [Host qualification](compatibility/host-runtime.mjs) rejects unreviewed Host or vendor releases. Artifact manifests disable lifecycle scripts, pin runtime dependencies, and explicitly admit the reviewed Host and vendor prereleases in peer alternatives. They omit the retired `dsh-invariants` dependency; Ponytail exports and compiles only its main provider. Upstream manifests and source files remain unchanged.

The Codex staged-runtime overlay records its changes in `SOURCE.json`: subtask inspection and preparation accept only the reviewed Host provider version, and the CLI remains pinned to `0.153.4`. The provider and Host adapter share the Host's installed pi-ai `0.87.1`; the copied runtime and artifact peer admit that exact version. The overlay checks the retained provider module and catalog fixture SHA-256 values. Copied checks use the current model catalog and exercise custom context with GPT-5.6 Luna; removed offline models receive no invented aliases. It resolves the CLI manifest and wrapper under `app.asar.unpacked` when packaged. Retained upstream files remain unchanged; unexpected source text fails the overlay rather than silently skipping it.

Codex subscription models appear in the model picker only while a Codex OAuth account is connected. Muse login does not authorize the subscription provider; disconnecting Codex hides its models on the next list request. Its model menus and sticky group headings use the theme's opaque base fill in both light and dark modes. The private staging overlay uses the shared portal and viewport placement with one pane at a time, preserves model, effort, speed and output-detail actions, and records these choices in `SOURCE.json`.

The Desktop panel also lists runtime-registered MCP tools as read-only connections. The built-in `muse-account` connection is labeled Muse knowledge base and reports its registered tool count. The compatibility overlay never copies credentials, environment values, or private launch arguments into the listing.

## Compatibility and Desktop integration

`dsh-skill-mcp-panel` is pinned to upstream 2.1.2. Its Web sidebar manages Skills and MCP server configuration for the active profile. The bundled artifact does not expose the upstream `dsh-panel` executable: Desktop launches supported Node applications only through `dsh` profiles. The panel's gateway configures MCP connections; the actual MCP client remains `@deepseek-ai/dsh-mcp-client`. Its retained model, gateway, slot, and icon checks run during the isolated build.

The builder imports every built Host entry. Codex runs 26 retained upstream checks against the current DSH APIs and pi-ai 0.87.1, including model preparation and authenticated-carrier validation; the upstream registration context is a test double, not a full Desktop Loader. Eight additional Codex checks load the real provider, Host adapter, and CLI, exercise authenticated subscription SSE and subagent transport with simulated peers, and reject runtime-version drift and incorrect archive paths. FFmpeg runs 89 retained checks. The build tests check exported artifact files and byte-identical tarballs for every pinned plugin from two clean staging directories on the same platform. They do not establish cross-platform or whole-installer byte identity.

The [Desktop package target](../../apps/desktop/scripts/package-target.ts) builds both inventories in step S6 and places their tarballs beside first-party packed inputs. [Package-set preparation](../../apps/desktop/scripts/prepare-package-set.ts) selects the [source plugin names](../../apps/desktop/src/core-package-set.ts) as explicit roots and rejects registry substitution. Desktop development also builds and stages both inventories. Packaging is not activation: the release still needs a real Desktop Host/Client smoke. Account login, paid requests, and real media encoding are outside these keyless build checks.

Market's HTTP UI is not suitable for the portless Desktop carrier. Codex uses the optional connection fetch carrier rather than requiring a Web server. FFmpeg needs the product's configured encoder paths. Do not infer enabled features from a tarball's presence.

### Muse remote desktop and Feishu

`@wenbin_wb/dsh-bridge` retains upstream version 2.12.1 at the fixed revision in [sources.json](sources.json), including its MIT attribution. The [normalization record](dsh-bridge/MUSE_SOURCE_NORMALIZATION.json) records original and local SHA-256 values for 21 text files whose trailing whitespace or final newlines were normalized. The [reviewed overlay](compatibility/bridge-desktop.mjs) pins that record, checks each normalized file and every retained module before packing, and includes the record in `SOURCE.json`. The private artifact exposes the Muse remote provider at `./remote` and an optional Feishu provider at the root. It excludes upstream application bins, LAN proxy, standalone tunnel server, Cloudflare, self-update, and upstream password/QR authentication.

The remote provider reuses `CustomTunnelClient` connection setup and native WebSocket upgrade handling. The Muse adapter streams raw native bytes without accumulating complete frames, including Host Ping and browser Pong, and supplies account/device authentication, streamed HTTP uploads and downloads, per-chunk acknowledgements, cancellation, continued reconnects at the configured interval, and awaited shutdown. Its local transport tests cover binary uploads, Range responses, partial native frames, `/api/remote.mux` heartbeat round trips, cancellation, and rejected credentials. The handshake adds hostname and operating system to its installation UUID. The cloud relay authenticates the account and routes each browser tab to its selected installation while other computers stay connected; the desktop forwards only to its own loopback Host. This is a private outbound connection and creates no public tunnel hostname.

The Feishu provider reuses the upstream gateway, conversation node, commands, cards, and approvals with the maintained SDK. Its adapter uses current Host services for workspace and session metadata and titles, preserves the `feishu-channel` credential section, enforces mention/sender policy before media downloads, rejects outbound files whose physical path leaves the active workspace, and awaits owned work during unload. The provider defaults off and requires saved credentials before activation. Desktop profile migration preserves credential values and backups while turning the product switch off; replacing an app or scanner clears its previous sender and session bindings. Live Feishu QR registration, message delivery, and tenant permissions remain unverified.

### Hongguo public metadata

`muse-hongguo-search` retains the recovered 0.1.0 JavaScript source, MIT license, [recovery record](muse-hongguo-search/RECOVERY.md), and original release archive. Its original development commit was not recovered; `sources.json` pins the verified archive SHA-256. The [Host overlay](compatibility/hongguo-host.mjs) verifies all 22 retained files against a fixed inventory, adds the exact tested tools peer, and disables global activation. Standard, PTC, Cordis, Short Drama, and Editing activate the four tools in their own scopes; Minimal retains no Hongguo tools.

Search, detail, rankings, and collection filtering use public official metadata pages without a key or Cookie; no initial user configuration is required. Results distinguish collections, likes, heat, approximate counts, and incomplete coverage. Search covers the initial window, and rankings cover the requested public boards rather than the entire platform. Website requests remain serial, rate limited, cached, and cancellable; access restrictions fail explicitly. The plugin does not download videos. Its 20 recovered offline tests and real Host registration, canonical results, prompt discovery, input rejection, cancellation, and unload checks run during packaging. `test:hongguo` checks two clean, identical tarballs; live site availability is a separate read-only check.

### Muse local tools

Build the owned download bundles from the repository root with the separate [builder](build-downloads.mjs):

```sh
node third_party/plugins/build-downloads.mjs --out .artifacts/download-plugins
```

Standard, PTC, Cordis, Short Drama, and Editing activate `hongguo_download_info`, `hongguo_download`, `douyin_download`, `reverse_skill`, `reverse_analyze`, `fanqie_download_info`, and `fanqie_download` inside their agent scopes; Minimal contributes none. The tools use the initiating conversation's workspace for output. Installing the tarballs with `dsh plugin --profile headless add <tarball>` activates their bundle patches in that profile; building a new Desktop release includes them through the preset compositions.

Download bundle packing accepts npm and pnpm lifecycle entries, runs the JavaScript entry directly on Windows, and disables lifecycle scripts through the package-manager environment. `node --test third_party/plugins/download-pack.test.mjs` verifies all owned archives through the pnpm entry used by Desktop packaging, checks credential-file exclusion, and preserves source manifests. The Node tar parser reads archive members by exact Unicode paths. Reverse and Fanqie archives must contain the files declared in `SOURCE.json` with their exact SHA-256, except upstream `.gitignore` metadata excluded by npm.

Hongguo defaults to the supplied source's legacy interfaces and accepts several series IDs. The operator must supply the original `config.json`, `devices.json`, and a working signing service through the package's documented configuration. Missing source configuration fails explicitly, and public preview episodes do not establish full-series availability. Douyin accepts a list of user-selected video links, verifies each download with FFmpeg, and reports blocked or partial batches. A list of videos alone does not establish complete coverage of a drama; platform login or verification takes place in Muse's internal Browser panel, without external profiles or Cookie-file import.

## Licenses

See each retained upstream license and notice before redistribution. The build preserves the Codex PSD codec notices and includes the full license of bundled Heroicons. Runtime dependencies retain their own licenses in the packaged dependency graph. Muse Med does not claim authorship or endorsement by these projects.
