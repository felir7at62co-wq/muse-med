# Agent Note: Pair self-built muse-med FFmpeg with source inputs

Status: implemented

English | [中文](2026-09-23-muse-ffmpeg-source-pairing.zh.md)

## Problem

A fully offline desktop installer distributes its media executables. A third-party binary plus an unrelated source tree cannot establish which source, dependency revisions or patches produced it. First-use downloading does not meet the selected offline-installation requirement.

## Decision

The dedicated [manual workflow](../../../../.github/workflows/muse-ffmpeg.yml) defines a Linux Docker cross-build with fixed BtbN/FFmpeg revisions and toolchain image digests. BtbN resolves a small x264/libass/zlib dependency graph; all selected dependency source caches and build scripts accompany the FFmpeg source. Compilation has no network access. Binary and source archives share one manifest and checksum inventory, and dependency notices also accompany the binaries. Native Windows smoke must pass before the desktop release consumes the pair.

## Alternatives considered

**Repackage Gyan with upstream FFmpeg sources alone.** Rejected because that does not account for the exact statically linked dependency sources, patches or build scripts.

**Download FFmpeg at first use.** Rejected because the user requires the complete runtime in the offline installer.

## Consequences

The workflow uploads temporary artifacts but cannot publish releases or change desktop runtime selection. The [owning README](../../../../apps/desktop/scripts/ffmpeg-source-build/README.md) defines the source-retention and installer-smoke handoff. Linux Docker is a dedicated build exception to the default Windows CI policy; product execution is checked on native Windows. Local fixture tests and a pinned upstream generator check do not establish a successful cross-build, legal compliance or installed-desktop compatibility. Maintainers must obtain that evidence before distribution.
