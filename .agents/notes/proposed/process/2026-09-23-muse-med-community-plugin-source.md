# Agent Note: Keep community plugin source in the muse-med fork

Status: proposed

English | [中文](2026-09-23-muse-med-community-plugin-source.zh.md)

## Problem

The operator's Web profile loads five community plugins whose installed packages do not consistently contain their original source. Copying the installed directory would include generated JavaScript and possibly user configuration, while a fork containing only npm dependencies would not satisfy the request to inspect and retain the plugin source. A Desktop release also cannot claim to load a plugin merely because its source appears in the repository.

## Proposal

Keep source-only snapshots under [`third_party/plugins`](../../../../third_party/plugins/README.md), with exact upstream commits in `sources.json` and each upstream license retained. Preserve the Codex notices and exclude installed packages, generated bundles, icons with separate rights, tokens, configuration, and user media. Verify retained files against the pinned upstream commits, accounting for text newline normalization. The five directories are outside the pnpm workspace until an installer build compiles and activates each compatible plugin through the Desktop shared-package rules owned by the [bundled-runtime decision](../../implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md).

## Build implementation

The [source build helper](../../../../third_party/plugins/build.mjs) compiles the five snapshots in isolated staging against the built checkout and a separate frozen toolchain lock. It retains licenses, records source pins in each tarball, and never copies a live profile. Artifact-only metadata adds the exact current Host version to peer alternatives; no upstream manifest or root workspace dependency range changes. This is a reviewed local compatibility addition, not a claim that arbitrary future Host releases work. The staged Codex runtime also pins both inspection and preparation to the approved provider version, retaining CLI 0.153.4 and mapping its manifest and wrapper to the unpacked archive tree. Peer metadata alone cannot override the upstream executable allowlist; leaving its installation target unchanged would permit a downgrade.

The keyless checks cover every built Host import, Codex model preparation and RPC validation against current APIs, and FFmpeg's tool behavior and byte-identical repeat builds. They do not replace the acceptance criterion for a real product Loader and Client. Preparation separately rejects missing native CLI packages, resolution outside the copied payload, and incorrect CLI output under bundled Node: npm tolerates optional download failures, so installation success alone cannot qualify the payload. Lark requires explicit activation because its no-credential path starts onboarding and its runtime opens a local control server. Market remains a packaged source dependency rather than a mounted HTTP UI in the portless Desktop product.

The retained files match the pinned public archives after CRLF-to-LF normalization; the existing snapshots are not all byte-identical to the archive text. Source and toolchain ownership replace installed-profile copying without asserting whole-installer or cross-platform byte identity. Translation discovery excludes only the five pinned source directories because their upstream prose must remain intact; parent documentation and new directories remain in the owned bilingual corpus.

The builder uses pnpm's native bounded fetch deadline for large platform packages rather than introducing a second downloader or binary-copy fallback. Pnpm 11.7.0 uses Undici with `AbortSignal.timeout`; numeric error 23 is Node's `TimeoutError`, not a libcurl write error. A measured official Codex tarball response was 141,495,386 bytes and delivered only 13,524,363 bytes after 87 seconds, exceeding pnpm's default 60-second whole-response deadline. Only the frozen production install receives the extended deadline; metadata resolution retains native deadlines and retries so stalled metadata cannot block for thirty minutes. The argument uses declared `--fetch-timeout`, not `--config.fetch-timeout`: pnpm's untyped configuration passthrough preserves a numeric value as a string, which makes `AbortSignal.timeout` fail before a request starts. An isolated cold-store remote install confirms the declared option reaches Node as a number and completes the fetch; local-tarball tests alone do not exercise that failure. The explicit build-only timeout keeps lockfile integrity verification and the fail-closed payload check intact; it does not certify a download that has not completed.

## Alternatives considered

**Copy the active Web installation.** Published packages may omit source, and the profile may contain credentials or state. It does not give a repeatable source revision.

**Keep npm dependencies only.** Exact dependency versions can install the plugins, but the fork does not contain their requested source.

**Use Git submodules.** A checkout without recursive initialization still lacks the source files and requires another Git fetch on the teammate's machine.

## Acceptance criteria

The repository contains the five complete original `src/` trees with their pinned repository revisions and license texts. A fresh Windows installer can build or include the vetted plugins, activate only explicitly configured capabilities, and pass a real Host/Client composition smoke without relying on Git, Node, or Python installed by the teammate. The installed Codex manifest difference and each transitive or asset license are accounted for before a release is published.

## Risks

Source snapshots alone do not make a usable plugin build or grant access to Feishu, ChatGPT, or a video encoder. Runtime activation can load incompatible peer instances or expose credentials unless it follows the Desktop plugin ownership and approval rules. The ffmpeg version has a pinned upstream commit rather than a release tag; binary equivalence and clean builds require separate checks.
