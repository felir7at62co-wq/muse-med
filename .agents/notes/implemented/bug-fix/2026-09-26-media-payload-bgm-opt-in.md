# Agent Note: The packaged media payload carries the emotion runtime only when a build opts in

Status: implemented

English | [中文](2026-09-26-media-payload-bgm-opt-in.zh.md)

## Problem

The canonical Windows packaging command could not finish. Its media step in [`package-target.ts`](../../../../apps/desktop/scripts/package-target.ts) always passed `--bgm-cache`, and naming that cache is what asks [`prepare-media-runtime.ts`](../../../../apps/desktop/scripts/prepare-media-runtime.ts) to add the emotion runtime to the payload. The payload already on disk, and the payload the released installer ships, carries no emotion runtime, so reuse validation refused the build with `media reuse: BGM descriptor changed` and stopped before packaging. Installing anything meant running a local resume script that skipped the media step, so the command's own promise — one command produces the installer — was false.

The disagreement was between one script and the rest of the product. Every `media-runtime.json` in the repository has no `bgm` key, no `bgm/` directory and no `bgm*` manifest member. A deployment without the emotion runtime resolves `perception-bgm` to its catalogue alone, and [`desktop-bgm-config.spec.ts`](../../../../apps/desktop/tests/desktop-bgm-config.spec.ts) pins that: nothing may point the plugin at a model path the installer does not ship. Nothing failed while the two disagreed, because no test asserted what the default invocation passes to the media step.

## Decision

`--with-bgm` is the only way to request the emotion runtime. [`parseDesktopPackageInvocation()`](../../../../apps/desktop/scripts/package-target.ts) reads it and refuses it outside `win-x64`, mirroring `--unsigned`, and the resolved invocation carries `withBgm`.

[`desktopPrepareMediaRuntimeArguments()`](../../../../apps/desktop/scripts/package-target.ts) owns the media step's arguments. It returns `undefined` for a target with no media step; for `win-x64` it returns `--output` and `--cache` alone, and appends `--bgm-cache <downloads>/bgm` only for an invocation that asked for it. The default build therefore reuses the shipped no-BGM payload instead of contradicting it.

[`missingBgmRuntimeInputs()`](../../../../apps/desktop/scripts/package-target.ts) names the emotion-runtime lock and the emotion-model download cache an opt-in still needs. The packaging entry point checks them before the first long preparation step, so `--with-bgm` without its inputs fails in seconds rather than after a full build.

`package:win:x64:unsigned` in [`apps/desktop/package.json`](../../../../apps/desktop/package.json) remains the canonical no-BGM command, and `package:win:x64:unsigned:bgm` is the explicit variant. The repository-root script for the canonical command forwards to the desktop package, so the switch is defined once.

The reuse validation in `prepare-media-runtime.ts` is unchanged. Its refusal is correct — it exists to stop a build whose requested payload contradicts the one on disk — and the default path no longer contradicts it.

## Alternatives considered

**Select the payload with an environment variable.** A shell profile could then change what an installer contains without the command line or the build log saying so, and the flag behind a given payload would not be reconstructible. The command line already carries this kind of choice in `--dir`, `--prepare-only` and `--unsigned`.

**Discard the existing payload and rebuild it with the emotion runtime.** That throws away the verified interpreter, FFmpeg and Visual C++ redistributable and downloads them again. On this machine the emotion-runtime payload has never passed its own smoke test, so the command would fail later and leave nothing, and the product's shipped combination would change as a side effect of fixing a build break.

**Relax the reuse validation instead of the caller.** That refusal is what keeps a payload's recorded composition and a build's request from diverging. Weakening it would let a later default change overwrite a verified payload with different bytes.

**Keep the argument list inline and delete the flag.** That is the state that hid the defect: no exported owner of the media arguments, and no assertion about the default invocation that could fail. The resolver exists so the default can be pinned by a test.

**Put the opt-in in a packaging configuration file.** A second place to read "what is in this installer" splits the answer across a file and a command line, while the packaging target already resolves every other build choice from its arguments.

## Consequences

The canonical command completes and produces the combination the product already shipped: no emotion runtime, catalogue matching only. The emotion runtime is reachable only by naming it, and a missing lock or cache is reported before the build starts rather than at the media step.

The cost is one more flag and two exported helpers, and a package that wants the emotion runtime must prepare its cache and lock first. Building that payload has never passed its smoke test on this machine — a separate, still-open product problem that the opt-in exposes rather than fixes.

[`package-target.spec.ts`](../../../../apps/desktop/tests/package-target.spec.ts) pins the default media arguments without `--bgm-cache`, the opt-in with it, the refusal outside `win-x64`, and the absent-input check. The payload tests in `prepare-media-runtime.spec.ts` keep pinning the refusal that the fix preserves, including the `media reuse: BGM descriptor changed` case.
