---
description: "Rank local or public music by emotion and download selected tracks, with optional non-commercial analysis."
kind: "package-bundle"
---

# @deepseek-ai/dsh-perception-bgm

English | [中文](README.zh.md)

## Summary

Find BGM candidates near a requested mood on a 1–9 valence/arousal scale. `match` reads a local index or a configured public catalogue without Python or model weights. Select a remote candidate explicitly with `download` to obtain a verified local file for composition. `index` and `inspect` require a separately prepared Python runtime and models; the MERT backbone is restricted to non-commercial use.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The bundle's [patch](cordis.patch.yml) contributes one `perception-bgm` row to a profile with the tools registry. The package does not automatically install or activate itself in a running profile. Desktop assembly and profile-install verification remain release-owner tasks.

Without `catalogUrl`, `match` reads `indexPath` and preserves the local candidate `path` result. A missing or empty local index asks for indexing. With `catalogUrl`, `match` reads only that public catalogue and returns `track_id`, original `name`, public `url` and measurements, never a nonexistent local path. It downloads no audio automatically. Call `download` with the selected `track_id`; its verified `path` can be supplied directly as a `drama_bgm` track source. Cached reuse verifies SHA-256 again and still requires the live catalogue. `index` and `inspect` remain local, optional analysis methods; Python dependency errors occur only when their worker starts.

The published catalogue at `https://muse.tos-cn-beijing.volces.com/bgm/index.json` was exercised through `match` and one verified download without credentials or Python. It is not enabled by default; profile configuration chooses it. Public audio rights and the non-commercial analysis-model license are separate obligations.

| Configuration | Resolution |
|---|---|
| `pythonExecutable` | Existing absolute executable; otherwise `DSH_PERCEPTION_PYTHON`; an unusable path prevents analysis only |
| `weightsPath` | Existing absolute emotion-head checkpoint; otherwise `DSH_PERCEPTION_BGM_WEIGHTS`, then `<DSH_HOME>/perception/bgm/J_all.ckpt` |
| `dataDir` | Defaults to package `python/data`; analysis deployments must supply an external directory with **all** packaged static data plus `btc_model_large_voca.pt` |
| `indexPath` | Defaults to `<DSH_HOME>/perception/bgm/bgm-index.json`; keep it writable and outside the installation |
| `env` | Explicit worker environment; use `HF_HOME` for the prepared cache and `HF_HUB_OFFLINE=1` to forbid downloads |
| `callTimeoutMs` | Defaults to 300000 milliseconds per analysis |
| `catalogUrl` | Omitted: local index; configured: canonical HTTPS catalogue URL without credentials, query or fragment |
| `cacheDir` | Defaults to `<DSH_HOME>/perception/bgm/cache`; absolute directory for verified downloads |
| `networkTimeoutMs` | Defaults to 60000 milliseconds for the complete match/download operation |
| `maxCatalogBytes` | Defaults to 2097152 decoded bytes |
| `maxTrackBytes` | Defaults to 134217728 bytes per catalogue track |

No model weights ship in npm. See [sources and licenses](SOURCES.md) before acquiring weights; the default package data directory alone is insufficient for analysis. Without offline mode, the first analysis can download the frozen MERT snapshot. Ambient cache-location environment variables override the same entries in `env`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The public manifest is `{version:1,tracks:[{id,name,sha256,bytes,url,valence,arousal,moods}]}`. Each `id` equals its `sha256:<64 lowercase hex>` digest. Track URLs must exactly match the catalogue's origin plus `/bgm/tracks/<hash>.<audio extension>`. HTTPS transfers omit credentials and reject redirects, partial responses, oversize bodies, invalid measurements, duplicate IDs and unsafe filenames. Downloads stream into exclusive files in private temporary directories, verify size and SHA-256, then atomically rename into content-addressed cache paths; errors remove staging files. Caller cancellation and plugin unload abort network operations.

The TypeScript tool ranks cached or public measurements and lazily starts an isolated NDJSON Python worker only for analysis. The worker uses the maintained Music2Emotion inference adapter and vendored helpers. Each chord/key operation owns a random OS temporary directory, removed on return or exception; no intermediate is written into package data. No invariant companion is published because the package has no independently maintained observations to reconcile.

From the repository root, the focused source build and offline checks are:

```sh
pnpm exec tsc -p packages/perception/perception-bgm/tsconfig.json
pnpm exec tsdown --config packages/perception/perception-bgm/tsdown.config.ts
pnpm exec vitest run packages/perception/perception-bgm/tests/match-loader.spec.ts packages/perception/perception-bgm/tests/tools.spec.ts packages/perception/perception-bgm/tests/bundle-patch.spec.ts packages/perception/perception-bgm/tests/remote-library.spec.ts
python -B packages/perception/perception-bgm/tests/test_runtime_resources.py
```

From this package directory, check the standard npm file list after building:

```sh
npm pack --dry-run --json --ignore-scripts --cache .test-npm-cache | node tests/check-pack.mjs
```

The manifest includes every `lib/*.js` chunk, declarations, worker scripts, vendored Python, static data, and source/license records. It excludes checkpoints and caches by an explicit allowlist. Python regression tests stub heavy libraries and do not analyze audio or access the network.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sources, revisions and licensing](SOURCES.md)
- [Harness profile architecture](../../../docs/architecture.md)
- [Tool implementation](src/index.ts)

-----

<a id="model-experience"></a>
## Model Experience

### The `bgm_match` tool schema

#### What the model sees

One tool exposes `match`, `download`, `index`, and `inspect`. Its description states “返回的是候选排序，不是决定” and identifies MERT as “仅限非商业用途”. Public candidates contain stable IDs rather than local paths; only an explicit download returns a verified local `path`. Results include measured valence/arousal, mood tags and candidate distance; the agent chooses the track.

#### Token effect

The mount adds one fixed tool schema. Match results are bounded to at most 20 candidates; index failure lists grow with failed files. Python analysis does not call a language model.

#### KV Cache effect

Append-only. Stable schema text preserves the request prefix; calls add tool results without rewriting earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Python runtime, interpreter, model weights and caches are optional local data prepared outside the package by `scripts/runtime.py`; nothing it writes is packed, no upstream wheel hashes are recorded, and clean-machine or redistributable-payload verification remains undone. MERT cannot be treated as commercially licensed by this package's MIT metadata.
- The worker directly owns a local subprocess; subprocess-service integration and awaited process teardown remain separate lifecycle work. Forced termination can bypass Python temporary-directory cleanup.
- The public catalogue must remain reachable even for cached downloads. The cache has no automatic eviction; no upload credential is accepted or needed.
- Concurrent writers to one index are not coordinated. Use one index writer at a time; malformed or unreadable indexes are currently treated as empty.
- The package remains private and uses workspace dependency ranges. A release packer must resolve those ranges, include its runtime dependency closure, and wire the Host TypeScript aggregate and package discovery.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`scripts/runtime.py` is maintainer tooling and is not packed. `prepare` (Windows x64 only) reads a standalone CPython 3.11.16 base, an already validated CPU environment, the frozen Hugging Face cache, two checkpoints and two hash-pinned wheels, and writes one self-contained tree: the copied interpreter, `Lib/site-packages`, the `Library/bin` DLLs that the MKL and Intel OpenMP distributions record outside site-packages, `models/J_all.ckpt`, `models/data` and `models/hf-cache`. It copies only RECORD-listed resources, takes nothing from the base's own `site-packages` or `Scripts`, refuses venv launchers, bytecode, startup modules and external `.pth` paths, drops the reviewed setuptools `distutils-precedence.pth`, and records that decision plus a SHA-256 for every installed file in `runtime-manifest.json`.

`verify` re-hashes that inventory before and after a run, probes with `-I -B -X utf8` and requires `sys.prefix`, `sys.base_prefix` and every `sys.path` entry to resolve inside the tree, repeats the probe after renaming the tree, and analyses one real track offline through `worker_main.py`. Because the base interpreter is copied in, no uv-managed installation under `%APPDATA%` is consulted at run time and the source environment is disposable.

Point `pythonExecutable`, `weightsPath` and `dataDir` at the tree's `python\python.exe`, `models\J_all.ckpt` and `models\data`, and set `env.HF_HOME` to `models\hf-cache`. The worker launch allowlist forwards `HF_HOME` and ambient system variables but never `OMP_NUM_THREADS`, `MKL_NUM_THREADS` or `OPENBLAS_NUM_THREADS`, so a deployment that wants pinned BLAS threading must set them in `env`; the validated analysis run used `1` for each.

</details>
