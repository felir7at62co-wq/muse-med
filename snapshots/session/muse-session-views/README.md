# Packaged Session views

English | [中文](README.zh.md)

This keyless artifact-consumer scene verifies ordinary Session cards through the real Deep View plugin, native tool discovery and authenticated HTTP reply route. It requires the unpacked package that the community build pipeline produces: `pnpm run test:snapshot:built` prepares it under `.artifacts/snapshot-deep-view/package`, and `MUSE_MAIN_DEEP_VIEW_PACKAGE` names another unpacked package instead. The Headless harness installs that package in its isolated profile; the native Loader checks its manifest and Host compatibility. An absent artifact is a prerequisite failure, not a skipped scene. Retained third-party source and compatibility exemptions are never changed by this test.

Build the Host and the reviewed plugin, then unpack its archive before replay. Run these commands from the repository root:

```sh
pnpm run build
node scripts/prepare-deep-view-snapshot.mjs
DSH_EXAMPLE_MODE=lib node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t muse-session-views
```

The unpacked directory must remain beneath the repository so its declared Host peers resolve through the workspace installation. The source launcher can consume this reviewed JavaScript package too, but this scene does not provide a zero-build fallback to retained source. Refresh writes the current output oracle without changing the committed canonical recording.
