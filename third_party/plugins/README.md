# Community plugin source and builds

English | [中文](README.zh.md)

These six source snapshots retain the community plugins used by Muse Med. [sources.json](sources.json) pins each public upstream repository, revision, version, and license. The snapshots retain upstream source and manifests; some text files normalize CRLF to LF. No installed profile, credentials, user media, or generated runtime is a build input. The translation gate excludes only these six upstream directories; this README and other owned documentation remain paired.

## Build

Use an installed checkout with the current Host and Client packages already built. From the repository root:

```sh
pnpm exec node third_party/plugins/build.mjs --out .artifacts/community-plugins
pnpm exec node --test third_party/plugins/build.test.mjs
```

[build.mjs](build.mjs) installs the separate [toolchain lock](toolchain/pnpm-lock.yaml) with frozen resolution and install scripts disabled, then compiles and packs each plugin serially in temporary staging. `--only dsh-ffmpeg` selects one source directory. Staging links to this checkout's built Host packages, never a live profile. Child checks use a temporary Harness home and omit credential-bearing environment variables. The helper removes its links before deleting staging; source directories receive neither `lib` nor `node_modules`.

Each tarball retains its upstream license and Codex notices, adds the bundled Heroicons license where needed, and records the upstream pin, Host version, and toolchain-lock digest in `SOURCE.json`. Artifact manifests disable lifecycle scripts, pin runtime dependencies used by the build, and add only the exact tested Host version to DSH peer alternatives. Upstream manifests remain unchanged. A different Host version fails pending a new compatibility review.

The Codex staged-runtime overlay records its changes in `SOURCE.json`: subtask inspection and preparation accept only provider `0.1.7-rc.5`, and the CLI remains pinned to `0.153.4`. It resolves the CLI manifest and wrapper under `app.asar.unpacked` when packaged. Retained upstream files remain unchanged; unexpected source text fails the overlay rather than silently skipping it.

The Desktop panel also lists runtime-registered MCP tools as read-only connections. The built-in `muse-account` connection is labeled Muse knowledge base and reports its registered tool count. The compatibility overlay never copies credentials, environment values, or private launch arguments into the listing.

## Compatibility and Desktop integration

`dsh-skill-mcp-panel` is pinned to upstream 2.1.2. Its Web sidebar manages Skills and MCP server configuration for the active profile. The bundled artifact does not expose the upstream `dsh-panel` executable: Desktop launches supported Node applications only through `dsh` profiles. The panel's gateway configures MCP connections; the actual MCP client remains `@deepseek-ai/dsh-mcp-client`. Its retained model, gateway, slot, and icon checks run during the isolated build.

The builder imports every built Host entry. Codex runs 26 retained upstream checks against the current DSH APIs and pi-ai 0.85.1, including model preparation and authenticated-carrier validation; the upstream registration context is a test double, not a full Desktop Loader. Six additional Codex checks load the real provider and CLI, exercise its authenticated transport with a local simulated peer, and reject runtime-version drift and incorrect archive paths. FFmpeg runs 89 retained checks. The build test checks all exported artifact files and byte-identical tarballs for all six plugins from two clean staging directories on the same platform. It does not establish cross-platform or whole-installer byte identity.

The [Desktop package target](../../apps/desktop/scripts/package-target.ts) is the integration point for placing these tarballs beside first-party packed inputs. [Package-set preparation](../../apps/desktop/scripts/prepare-package-set.ts) must select the six plugin names as explicit roots; the source workspace must not substitute registry packages for these tarballs. Packaging is not activation: the release still needs a real Desktop Host/Client smoke. Account login, paid requests, and real media encoding are outside these keyless build checks.

Market's HTTP UI is not suitable for the portless Desktop carrier. Lark's upstream activation starts an onboarding request without credentials and owns a local control server; keep it inactive until explicitly configured. Codex uses the optional connection fetch carrier rather than requiring a Web server. FFmpeg needs the product's configured encoder paths. Do not infer enabled features from a tarball's presence.

## Licenses

See each retained upstream license and notice before redistribution. The build preserves the Codex PSD codec notices and includes the full license of bundled Heroicons. Runtime dependencies retain their own licenses in the packaged dependency graph. Muse Med does not claim authorship or endorsement by these projects.
