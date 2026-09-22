# Agent Note: Short-drama runtime source and BGM audio owned by maintained packages

Status: implemented

English | [中文](2026-09-22-short-drama-source-and-bgm-library-ownership.zh.md)

## Problem

The short-drama workflow ran out of a separate development root: its skills lived in a local `.dsh/skills` install, the BGM emotion plugin lived in an unrelated git worktree, the Python environment and model weights used by analysis sat inside that project, and the 60-track music library existed only as files on one machine. No package in this repository owned any of it, so a clean checkout could not reproduce the workflow and the music could not be reached elsewhere at all. The same separation let packaging defects survive: the plugin's npm allowlist omitted `lib/worker.js` and `lib/config.js` that `lib/index.js` imports at runtime, and the Python worker wrote chord and key intermediates into its own install directory.

## Decision

The maintained source of the BGM emotion plugin is [`packages/perception/perception-bgm`](../../../../packages/perception/perception-bgm/README.md). Its npm allowlist now names every runtime file, its worker writes intermediates to a private temporary directory, and both Hugging Face loaders freeze the MERT revision. Cloud configuration is optional and off by default: without `catalogUrl` the tool reads the local index, and `match` never downloads. `download` is the only method that fetches audio, and it verifies size and SHA-256 before publishing a cache entry.

[`packages/drama/skills`](../../../../packages/drama/skills/README.md) owns the short-drama skill resources as `@deepseek-ai/dsh-drama-skills`. It carries only the source, references, and static resources the current skills use; GUI front ends, the retired application's helpers and its separate state chain, executables, user media, credentials, and caches stay out, and `maintenance/excluded-sources.json` records each omission with its reason. The manifest lists distributable files individually, and a packaging check fails when a skill file exists without a manifest entry.

The 60 tracks the operator authorized for public distribution are content-addressed objects under one bucket origin, with a catalog at `/bgm/index.json`. Publishing validates every local source against the index before uploading, creates only missing objects, verifies each public download by size and SHA-256, and writes the catalog last. Credentials come from one DSH-managed credential record and never enter source or release inputs; an existing object with different bytes is refused rather than overwritten.

## Alternatives considered

**Leave the skills in the local install.** That is where they were maintained, and it needs no repository change. It also leaves them with no offline regression, no reviewable allowlist, and no way to separate a personal edit from maintained source.

**Ship the whole local skills tree.** Copying the install wholesale would carry credential files, browser login state, caches, executables, and user media, and would preserve retired helpers that import an application state chain this repository does not have.

**Keep the music local and commit only the index.** The index is small, but the audio is not, and pointing every consumer at one machine's disk makes the workflow unreproducible. Publishing the audio also needed an explicit distribution answer, which the operator gave for these tracks and which does not extend to the model.

**Bundle the Python analysis stack with the plugin.** Torch and the model weights are hundreds of megabytes, the MERT backbone is non-commercial, and ordinary matching needs neither. Shipping them by default would impose that size and that license on every installation.

## Consequences

Matching and audio download are plain Node work: no Python, no model weights, and no non-commercial dependency, reachable without an upload key. Emotion analysis stays an explicit optional path that still needs a Python environment with the pinned CPU dependencies, and the plugin ships source rather than an interpreter.

Three licensing facts stay separate in `SOURCES.md`: the adapter and Music2Emotion source are MIT with an upstream revision that the available copy cannot establish, the m-a-p/MERT-v1-95M backbone is CC-BY-NC-4.0 and limited to non-commercial use, and the published tracks are audio the operator confirmed may be distributed publicly. None of the three relicenses another.

The local development root stays the home of the operator's own data — projects, the historical asset library, and the reference dependency versions — and is no longer a runtime dependency of these packages.
