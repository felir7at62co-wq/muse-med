# Agent Note: Optional bounded Client builds

Status: implemented

English | [中文](2026-09-23-bounded-client-build.zh.md)

## Problem

Windows resource-exhaustion events confirmed system-wide commit pressure during repeated build failures, while no matching Node fault report identified a specific crashing native module. Tsdown 0.22.2 launches every resolved configuration concurrently; limiting Rayon threads does not limit those JavaScript jobs.

## Decision

`DSH_BUILD_CLIENT_CONCURRENCY` optionally bounds native bundles in the complete Client workspace build. Unset retains tsdown's default concurrency. The positive integer limit applies to all configurations selected by native workspace resolution, including custom worker configurations and Node companions. It does not change the selected entries, environment, artifacts, or complete-build record requirements. Watch mode rejects the option.

The root `build:prepare` hook acquires capacity. A final sequential Rolldown `closeBundle` hook releases it after other close hooks. Releasing in tsdown's `build:done` would deadlock a same-package multi-face build because tsdown waits for every package face before that hook. Native build and render errors reject queued configurations. The existing complete-build runner still writes its record only after all library and Web work succeeds.

Package-local plugins and unrelated hooks remain intact. New package-local `build:prepare` or `build:before` hooks must compose the root hooks in bounded mode; the focused check protects the current configuration set from overriding them. Native same-package two-face tests verify bounded overlap, full completion, preserved done hooks, failure rejection, and watch refusal.

## Alternatives considered

**Package-name filters.** These omit browser configurations whose names have a `/client` suffix. A separate roster or private tsdown resolver would duplicate ownership and risk incomplete artifacts. Public hooks retain native selection.

**Rayon limits alone.** These do not limit concurrent JavaScript build configurations. The bound limits those configurations without killing unrelated applications or changing ordinary build performance.

## Consequences

The optional bound requires no dependency or package-manager changes and preserves the full artifact set at the cost of elapsed build time. It is not a guarantee against memory exhaustion when one bundle or unrelated processes exhaust system resources. Custom same-name root hooks require composition rather than replacement.
