---
description: "Maintain the separately deployed, fixed-build Lvpaopao Windows helper."
kind: guide
---

# Lvpaopao Windows helper

English | [中文](README.zh.md)

This directory preserves the owned helper source and offline regressions used by the adapter. It is excluded from the npm runtime archive. The Desktop dependency does not install Python, instrumentation dependencies or the helper on Windows.

## Deployment

Qualification is limited to Windows x64 WeChat 4.1.13.65 / WMPF 25560 and the exact executable, DLL and entry-byte checks in the inactive examples. The tested Python was 3.14.5 x64; wheel versions and hashes are recorded in [requirements-windows-25560.lock](requirements-windows-25560.lock). Media verification used ffmpeg and ffprobe 8.1.1. Other builds require separate analysis and qualification.

Keep the `passive-probe` and `next-stage` relative directories intact. The example configurations deliberately omit live process IDs, creation times, paths and proof hashes. A deployment needs genuine process identity, passive observation and launch-scene proof from that Windows environment before sealing with `seal-persistent-helper.py`. That script hashes real local inputs; it does not create valid identity evidence. No real connection settings, proof receipts, encrypted playback address or account data belong here.

The adapter calls the sealed `run-persistent-host.py --rpc-stdio` over one Host-owned SSH connection. Its ten-minute lifetime includes target-launch waiting. The helper verifies the target and imports manifest, serializes its bounded operations and confirms disposal, unloading, detachment and server closure before exit. Fresh-address acquisition and complete-series media downloads have no whole-adapter acceptance. Previously verified first-episode transfer reused a private saved receipt without requesting a new playback address.

## Offline checks

With compatible Python dependencies installed, run from this directory:

```sh
python3 -B -m unittest discover -s passive-probe/next-stage -p 'test_*.py'
python3 -B -m unittest discover -s passive-probe -p 'test_*.py'
node --test passive-probe/observe-launch.spec.mjs passive-probe/next-stage/operations/fixed-operation.spec.mjs
```

These checks replace native process and network behavior with synthetic fixtures. Passing them does not deploy the helper or validate a new Windows target. Live validation additionally requires the private local configuration, exact target qualification and a separately authorized test scope; it must preserve the original receipt when retrying a download.
