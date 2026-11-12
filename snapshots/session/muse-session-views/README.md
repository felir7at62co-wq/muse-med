# Packaged Session views

English | [中文](README.zh.md)

This keyless artifact-consumer scene verifies ordinary Session cards through the real Deep View plugin, native tool discovery and authenticated HTTP reply route. It requires `MUSE_MAIN_DEEP_VIEW_PACKAGE` to name an unpacked package produced by the community build pipeline. The Headless harness installs that package in its isolated profile; the native Loader checks its manifest and Host compatibility. An absent artifact is a prerequisite failure, not a skipped scene. Retained third-party source and compatibility exemptions are never changed by this test.

Build the Host and the reviewed plugin, then unpack its archive before replay. Run these commands from the repository root:

```sh
pnpm run build
pnpm --dir third_party/plugins/toolchain run build --only deep-view --out ../../../.artifacts/snapshot-community
mkdir -p .artifacts/snapshot-deep-view
tar -xzf .artifacts/snapshot-community/deep-view-0.1.2.tgz -C .artifacts/snapshot-deep-view
export MUSE_MAIN_DEEP_VIEW_PACKAGE="$PWD/.artifacts/snapshot-deep-view/package"
DSH_EXAMPLE_MODE=lib node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t muse-session-views
```

Keep the same environment variable when running the complete snapshot lane. The unpacked directory must remain beneath the repository so its declared Host peers resolve through the workspace installation. The source launcher can consume this reviewed JavaScript package too, but this scene does not provide a zero-build fallback to retained source. Refresh writes the current output oracle without changing the committed canonical recording.
