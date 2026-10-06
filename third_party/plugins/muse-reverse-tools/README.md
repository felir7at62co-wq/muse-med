# Muse reverse tools

English | [中文](README.zh.md)

Muse can inspect a workspace binary without executing it and load a methodology from the pinned MIT-licensed reverse-skill project. `reverse_analyze` returns its SHA-256, size, executable format and bounded Mach-O symbol names with exact addresses. `reverse_skill` selects the upstream route and returns the original instructions and installed resource paths. PE and ELF identification does not extract their symbols; ZIP and DMG identification does not unpack them.

The Desktop creative and coding presets mount this bundle. Independent profiles can install the package and apply `cordis.patch.yml`. Configuration accepts an absolute `assetRoot` (default: packaged resources), `maxFileBytes` (64 MiB), `maxSymbols` (200), `maxSymbolNameBytes` (2048), and `timeoutMs` (60 seconds). Relative resource roots, missing resources and non-positive limits reject activation. Targets must be regular files inside the initiating session workspace; outside targets and file symlinks are refused. Copy a user-authorized external sample into that workspace first. Reads preserve the target and respond to cancellation; unloading aborts and awaits active reads.

The resource pack includes methodology and scripts, not Java/Python, decompilers, commercial licenses, MCP services or the separately licensed CTF sidecar. Loading this bundle installs nothing and grants no target or network authorization. Follow upstream scope and script consent requirements for deeper work; do not represent static identification as reconstructed source or a working download engine. Optional external tools retain their own licensing and installation requirements.

Upstream revision and per-file SHA-256 values are recorded in `SOURCE.json`; preserve the shipped MIT and nested license notices. Run `node --test tests/*.test.js` for offline behavior checks and `node scripts/pack.mjs --out <absolute-directory>` for the npm archive. No TOS credential is needed or bundled.
