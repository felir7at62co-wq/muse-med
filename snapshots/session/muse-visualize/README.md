# Native visualization cards

English | [中文](README.zh.md)

This keyless scene mounts the actual default `short-drama` preset and Desktop tool-discovery configuration. The first model request exposes `visualize` and `skill`; the scene never calls tool search. A native Skill load precedes real create and update calls. Their persisted result metadata and the saved private-home fragment are checked independently against the complete workspace oracle.

The replay uses the dedicated `snapshot-visualize` model provider without a real-API fallback. Source mode stages retained source under the private test home. Built replay runs `scripts/prepare-visualize-snapshot.mjs` through `test:snapshot:built`: the formal toolchain validates the retained pin and local modifications, packs the plugin and the pinned React dependency tree, and rejects installation lifecycle hooks. The fixture uses public package operations to set two parent-version-specific local overrides for React's transitive dependencies, installs only the audited archives offline into its real private profile, and checks the private lockfile. It refreshes the public package resolver and checks that all eight Host peers share the running installation's module identities. Global configuration is unchanged; no personal style files or accounts are read.

For a focused built replay, run the preparation script first. `MUSE_VISUALIZE_PACKAGE` may select its unpacked `package` directory alongside the checked archives and `installation.json`; it does not redirect runtime imports to an external source tree.

`apps/web/tests/muse-visualize.e2e.ts` opens the packaged Client with the same native Session data, checks slider interaction and reload, isolates two sessions, and verifies that card prompts only draft text while retaining user drafts and attachments. Browser screenshots and acceptance receipts stay under `.artifacts/visualize-browser-ui/`.
