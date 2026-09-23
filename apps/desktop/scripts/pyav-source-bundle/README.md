---
description: "Collect pinned PyAV Windows wheel sources and review the separate source-archive release requirements."
---

# PyAV wheel source bundle

English | [中文](README.zh.md)

## Summary

Collect source inputs for the preserved `av-18.1.0-cp311-abi3-win_amd64.whl`, including its FFmpeg 8.1.2 DLL dependencies. This source-only operation does not rebuild or replace the wheel, edit the desktop media lock, or qualify an installer. The separate [FFmpeg 9.0.2 recipe](../ffmpeg-source-build/README.md) cannot supply this wheel's matching sources.

## Table of Contents

- [Collect and verify](#collect-and-verify)
- [Distribution requirements](#distribution-requirements)
- [Dev Note](#dev-note)

<a id="collect-and-verify"></a>
## Collect and verify

From this directory, use Python 3.11+ with network access and a trusted CA store for HTTPS collection. The Windows validation host uses standard `SSL_CERT_FILE` pointing to an existing Mozilla CA bundle; never disable TLS certificate verification. Keep generated sources in the repository's ignored `.artifacts` directory:

```sh
python build.py build ../../../../.artifacts/pyav-source-bundle
python build.py verify ../../../../.artifacts/pyav-source-bundle
```

The bundle collects pinned PyAV and pyav-ffmpeg repositories, every source archive declared by `pkg.py` (parsed as AST, never executed), exact MSYS2 recipes with local/external patches and native sources, and the certifi 2026.7.22 and tqdm 4.70.1 sdists. A SHA256 inventory records the collected files. The pinned inputs belong to the script's lock, not to the desktop runtime selection.

The output contains `source/`, `pyav-18.1.0-windows-vendor-sources.tar.gz`, `manifest.json`, and `SHA256SUMS`. Collection reuses cached archives only after rechecking their bytes against the pinned hashes; a mismatch fails rather than silently replacing the cache.

A complete network build and verification must pass before distribution; unit tests or a partial download are insufficient. Release maintainers own this qualification. The complete collection and its built-in byte verification have passed.

<a id="distribution-requirements"></a>
## Distribution requirements

Preserve the wheel with SHA256 `ea1480b7a8d5405cb5f382b344731bf125fd2c1c6fae3964f6c48595628387ff`. Retain all copyright and license notices and link the matching source archive from the same desktop release; temporary build artifacts are not a distribution source offer.

The DLL's LGPL3 report does not establish its complete licensing: upstream `patches/ffmpeg.patch` removes x264/x265 from FFmpeg's GPL list, while the shipped x264/x265 code is GPL. Notices and distribution review must account for the actual included code, not only the reported license string. Source collection gives no legal guarantee, codec patent clearance, byte-identical rebuild guarantee, or evidence that the complete installer is ready.

<a id="dev-note"></a>
## Dev Note

The [PyAV source-bundle decision](../../../../.agents/notes/implemented/process/2026-09-23-pyav-wheel-source-bundle.md) records the upstream evidence and why the two FFmpeg source collections remain separate.
