---
kind: upgrade-guide
description: Muse Desktop replaces inherited Hongguo source and interpreter paths with its bundled local runtime.
---

# Muse Hongguo local runtime

English | [中文](guide.zh.md)

## Change

Muse Desktop supplies its own verified Java 17, CPython 3.11, PyCryptodome and original signer/decryption resources. The shell replaces inherited `MUSE_HONGGUO_LEGACY_APP_DIR`, `MUSE_HONGGUO_JAVA_PATH` and `MUSE_HONGGUO_PYTHON_PATH` values with bundled paths and enables `bootstrapDevices`. On first use, the original generator creates one private device. Muse retains that device across launches and starts an authenticated local signer lazily. Existing standalone profiles retain their explicit configuration.

The plugin tarball contains the Python bridges but excludes native runtimes, original bytecode, saved devices and tokens. Installing only the tarball does not provide the Desktop runtime.

`maxEpisodes` is removed. Full downloads use the source's declared total and require the complete continuous episode list. The tool no longer applies a separate episode-count cap to source, manifest, public catalogs or selected episode numbers. Public availability and file validation still apply.

## Migration

1. Install the accompanying Muse Desktop package for automatic local setup. Remove inherited `MUSE_HONGGUO_SIGN_SERVER` and `MUSE_HONGGUO_SIGN_TOKEN` entries when selecting the bundled signer. Keep these entries only for an explicitly managed external signer.
2. For standalone profiles, retain the original source and compatible media executables. Supply `javaExecutable` and omit `signServer` to start an owned signer, or keep explicit `signServer` and `signTokenEnv` for the external signer. Enable `bootstrapDevices` only for a generic source containing the pinned original `devicepool.pyc`; existing device configuration is retained.
3. Call `hongguo_download_info` to confirm the declared episode counts. Call `hongguo_download` with several `seriesIds` and omit `episodes` for full series. Confirm `complete: true`, `fullDecodeChecked: true` and the final manifest for every requested series. Source availability alone does not establish successful downloads.
4. Remove `maxEpisodes` from standalone configuration. It is rejected as an unknown field; no replacement is required.

See the [plugin configuration](../../../../third_party/plugins/muse-hongguo-download/README.md) for timeouts and media requirements. Modified immutable source files fail explicitly; Muse does not overwrite saved devices or credentials.
