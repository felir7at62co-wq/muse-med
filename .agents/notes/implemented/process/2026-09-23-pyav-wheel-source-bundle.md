# Agent Note: Preserve PyAV wheel sources independently of executable FFmpeg

Status: implemented

English | [中文](2026-09-23-pyav-wheel-source-bundle.zh.md)

## Problem

The preserved PyAV Windows wheel embeds FFmpeg 8.1.2 DLLs, independently of the desktop's FFmpeg 9.0.2 executables. The DLL license string reports LGPL3, but upstream `patches/ffmpeg.patch` reclassifies x264/x265 out of the GPL list. That string cannot justify omitting notices or sources for the shipped GPL code.

## Decision

The [source-only collector](../../../../apps/desktop/scripts/pyav-source-bundle/README.md) retains the existing wheel and desktop media lock. It collects pinned repositories, all `pkg.py` source archives without executing that file, exact MSYS2 recipes and their patches/native sources, and the certifi/tqdm sdists into a SHA256-inventoried bundle.

PyAV tag [v18.1.0](https://github.com/PyAV-Org/PyAV/tree/v18.1.0) selects pyav-ffmpeg `8.1.2-1`. The [lock](../../../../apps/desktop/scripts/pyav-source-bundle/lock.json) owns the exact repository, MINGW-packages recipe, and native pthread source revisions.

The authenticated Windows log for [upstream run `28393781929`, job `84127236786`](https://github.com/PyAV-Org/pyav-ffmpeg/actions/runs/28393781929/job/84127236786) establishes gcc/gcc-libs `16.1.0-5`, iconv `1.19-1`, pthreads `14.0.0.r92.g818fa6510-1`, and zlib `1.3.2-2` rather than inferred current package versions.

## Alternatives considered

**Use the executable FFmpeg source pair.** Its 9.0.2 sources do not match the wheel's 8.1.2 DLLs. The [existing source-pairing decision](2026-09-23-muse-ffmpeg-source-pairing.md) remains active and independent; this collector neither supersedes it nor changes its recipe.

**Treat the DLL license string as sufficient.** The upstream patch and included GPL x264/x265 contradict that shortcut. Distribution review must inspect the actual code and retain its notices.

## Verification

From the collector directory, `python -B test_build.py` passes seven tests and `python -B build.py --help` confirms the `build`/`verify` interface. The full collection command documented in the README completes successfully, including its built-in byte verification.

## Consequences

The collection avoids wheel replacement while making the source inputs reviewable. A full bundle build and verification remain prerequisites to distribution, followed by retained notices and a matching source-archive link on the same release. This does not establish legal compliance, reproducible wheel bytes, or complete installer readiness. Local tests cannot replace the full download and archive verification.
