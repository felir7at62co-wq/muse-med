---
description: "Maintain the separately deployed, fixed-build Lvpaopao native helper."
kind: guide
---

# Lvpaopao native helper

English | [中文](README.zh.md)

This directory contains the owned runtime files and their offline regressions. The package resource manifest includes runtime sources and the dependency lock, and excludes tests, private configuration, account data and media. A prepared Python environment and media tools are still required; fresh-install dependency delivery is not accepted.

## Deployment

The exact executable and loaded DLL pairs in `passive-probe/next-stage/runtime_profiles.py` select a qualified adapter. Live Windows x64 WeChat 4.1.15.56 / WMPF 25799 acceptance covers local preparation, search, complete catalog, rankings, whole-series delivery and real interrupted-transfer resumption. Other builds require separate qualification. Windows Python dependencies are pinned in [requirements-windows-25560.lock](requirements-windows-25560.lock). Mac arm64 uses [requirements-macos-arm64-269602.lock](requirements-macos-arm64-269602.lock) and `mac_runtime.py`: only the exact, separately prepared isolated WeChat 4.1.13 / 269602 copy and private home are accepted. Its 36-episode native download, decode/hash checks, resume, search, rankings and public-tool reconciliation passed; ordinary signed WeChat and fresh installation remain unqualified.

Keep the runtime directory relationships intact. `boot.py` discovers actual process identity, verifies the platform-specific file hashes and stages a sealed private copy while retaining existing download receipts. Example process settings remain inactive; no real connection configuration, playback address or account data belongs in this source tree.

The Host owns one local or explicitly configured SSH connection to `run-persistent-host.py --rpc-stdio`. Calls in a download job share that connection. The helper checks target identity and imported files, serializes media operations and reports cleanup before exit. Episode results include the requested episode number and validated playback serial; older serial-only saved results recover the number from their verified request intent. Unknown acquisitions retain their original key for reconciliation and never request another address automatically.

## Offline checks

With compatible Python dependencies installed, run from this directory:

```sh
python3 -B -m unittest discover -s passive-probe/next-stage -p 'test_*.py'
python3 -B -m unittest discover -s passive-probe -p 'test_*.py'
node --test passive-probe/observe-launch.spec.mjs passive-probe/next-stage/operations/fixed-operation.spec.mjs
```

These checks replace native process and network behavior with synthetic fixtures. Passing them does not deploy the helper or validate a new target. Live validation additionally requires the private local configuration, exact target qualification and a separately authorized test scope; it must preserve the original receipt when retrying a download.
