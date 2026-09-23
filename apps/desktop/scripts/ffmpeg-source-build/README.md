---
description: "Pinned Windows x64 FFmpeg cross-build, matching dependency sources and release qualification for the offline muse-med installer."
---

# Self-built FFmpeg and corresponding sources

English | [中文](README.zh.md)

## Summary

This directory owns the manual [FFmpeg workflow](../../../../.github/workflows/muse-ffmpeg.yml), not the desktop installer. It prepares GPLv3 Windows x64 FFmpeg/ffprobe with libx264, libass and zlib from fixed source revisions, and pairs each binary ZIP with its source archive. It does not publish a release, update the desktop media lock, or install tools on an end user's computer. No successful cross-build or native smoke result is recorded in this checkout; release qualification requires a successful workflow run.

## Table of Contents

- [Inputs and tools](#inputs-and-tools)
- [Build and rebuild](#build-and-rebuild)
- [Artifacts and release handoff](#artifacts-and-release-handoff)
- [Verification and limitations](#verification-and-limitations)
- [Dev Note](#dev-note)

<a id="inputs-and-tools"></a>
## Inputs and tools

[lock.json](lock.json) pins the BtbN build scripts, FFmpeg 9.0.2 source revision, and Linux amd64 downloader/toolchain container digests. The selected dependency root is x264/libass/zlib; BtbN resolves its own transitive dependencies and their pinned source revisions. This is not Gyan's binary or its full feature set. The generated configuration includes fonts, iconv, XML and subtitle support; it does not request the unrelated GPU, AV1, x265 or network-library dependencies from BtbN's full build.

The build needs Linux amd64, Python 3.11+, Bash, Git, Docker with buildx, network access to the pinned public repositories/images, and sufficient temporary disk space for those images and source caches. It invokes no host package installer. GitHub's dedicated Ubuntu job cross-compiles; a separate Windows job executes the resulting PE binaries. Source downloads happen before compilation; dependency compilation and FFmpeg compilation run with Docker networking disabled.

<a id="build-and-rebuild"></a>
## Build and rebuild

The workflow is manual-only and has read-only repository permissions. Its Linux build and Windows smoke jobs must both pass. The local Linux entry point is below; the output directory must not already exist. These build/rebuild commands require remote qualification and have not been executed on the current Windows development host.

```sh
python3 -B apps/desktop/scripts/ffmpeg-source-build/build.py build /absolute/new-output
```

An extracted source archive contains the recipe, full FFmpeg source, BtbN scripts and local patch, generated Dockerfile, every selected dependency source cache, and build evidence. A source-offline rebuild uses those files instead of fetching source repositories. It still needs Docker and the recorded toolchain image, which Docker may download by digest; the source archive does not embed a multi-gigabyte compiler image.

```sh
tar -xzf muse-ffmpeg-9.0.2-corresponding-source.tar.gz
python3 -B source/recipe/build.py build /absolute/new-output --sources source
```

<a id="artifacts-and-release-handoff"></a>
## Artifacts and release handoff

The workflow artifact contains four files: the Windows binary ZIP, matching corresponding-source tarball, `build-manifest.json`, and `SHA256SUMS`. The manifest binds the two archives, the two executable hashes, source-cache hashes and locked inputs; the checksum inventory also covers the manifest. Source evidence includes FFmpeg configure output, compiler version, the toolchain and dependency image identities, and Docker version. Dependency copyright/license files are retained in the source caches and copied into the binary ZIP's `licenses/` directory; an unrecognized license layout fails the build for review.

Only after both workflow jobs pass may a maintainer replace the development-only FFmpeg entry in the desktop media lock with this exact binary ZIP and hash. Keep the runtime ZIP's `ffmpeg/bin`, `LICENSE.txt`, `README.txt` and `licenses/` together. Publish its matching source tarball, manifest and checksum inventory beside the desktop release, and retain them while distributing that binary. GitHub Actions' 30-day artifact retention is not source distribution. Re-run the desktop's complete installed-artifact/offline media smoke after replacing the runtime; this workflow does not perform installer integration.

<a id="verification-and-limitations"></a>
## Verification and limitations

The following keyless checks run locally without Docker or network and exercise lock validation, dependency-input selection, complete archive pairing, binary/manifest tamper detection, missing-source refusal and safe dependency-license copying:

```sh
python -B apps/desktop/scripts/ffmpeg-source-build/test_build.py
```

The native Windows smoke verifies paired hashes, GPL/x264/libass configure flags, H264/AAC output, visible SRT/ASS subtitle pixels and ffprobe. It uses system fonts and ASCII captions; the desktop release still needs its actual Chinese fonts and renderer smoke. The workflow does not promise identical rebuild bytes, continued third-party container availability, legal compliance, or codec patent clearance. Review the recorded toolchain, all dependency notices and applicable distribution terms before release; [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) and [FFmpeg's license page](https://ffmpeg.org/legal.html) are starting points, not a legal opinion.

<a id="dev-note"></a>
## Dev Note

The [source-pairing decision](../../../../.agents/notes/implemented/process/2026-09-23-muse-ffmpeg-source-pairing.md) explains the independent build and release barrier.
